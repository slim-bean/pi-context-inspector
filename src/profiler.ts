import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { convertToLlm, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { contentText, jsonText, type Section, type Snapshot } from "./snapshots.ts";
import { contentEstimate, emptyEstimate, ESTIMATE_NOTE, formatEstimate, hasUsage, inputTokens, object, sumEstimates, usageText, type TokenEstimate } from "./metrics.ts";

import { deltaTone, joinRich, rich, toned, type StyledText, type Tone } from "./presentation.ts";

type MessageEntry = Extract<SessionEntry, { type: "message" }>;
type Assistant = Extract<MessageEntry["message"], { role: "assistant" }>;
type ToolCall = Extract<Assistant["content"][number], { type: "toolCall" }>;
type Result = Extract<MessageEntry["message"], { role: "toolResult" }>;
interface Signal { kind: string; related?: string }
export interface ProfileCall {
  id: string;
  tool: string;
  callId: string;
  entryId?: string;
  resultEntryId?: string;
  call?: ToolCall;
  result?: Result;
  arguments: TokenEstimate;
  resultSize: TokenEstimate;
  retained: TokenEstimate;
  requestInput?: number;
  signals: Signal[];
}
export interface ToolStats {
  name: string;
  calls: number;
  results: number;
  missingResults: number;
  orphanResults: number;
  errors: number;
  arguments: TokenEstimate;
  resultSize: TokenEstimate;
  retained: TokenEstimate;
  largestResult: number;
  averageResult: number;
  medianResult: number;
  p95Result: number;
  requestInputMean?: number;
  requestInputSamples: number;
  signals: Record<string, number>;
}
export interface ToolProfile { calls: ProfileCall[]; tools: ToolStats[] }

const LARGE_RESULT = 2000;
const LOOKBACK = 20;
function fingerprint(value: unknown): string {
  // Canonical object keys, but preserve array order. Keep the index small even for large arguments.
  const stable = JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
  return createHash("sha256").update(stable ?? "").digest("hex");
}
function readRange(call: ProfileCall, cwd: string): { path: string; start: number; end: number } | undefined {
  if (!/(^|[._])read$/.test(call.tool) || !call.call) return;
  const args = object(call.call.arguments);
  if (typeof args.path !== "string") return;
  const start = typeof args.offset === "number" && args.offset >= 1 ? args.offset : 1;
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : Infinity;
  return { path: resolve(cwd, args.path), start, end: start + limit - 1 };
}
function target(call: ProfileCall, cwd: string): string | undefined {
  const args = object(call.call?.arguments);
  if (typeof args.path === "string") return resolve(cwd, args.path);
  if (typeof args.url === "string") return args.url;
  if (typeof args.command === "string") return args.command;
  return undefined;
}
function similarSearch(a: ProfileCall, b: ProfileCall): boolean {
  if (!/search/.test(a.tool)) return false;
  const aq = object(a.call?.arguments).query, bq = object(b.call?.arguments).query;
  if (typeof aq !== "string" || typeof bq !== "string" || aq === bq) return false;
  const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  const x = words(aq), y = words(bq);
  if (x.size < 2 || y.size < 2) return false;
  return [...x].filter((w) => y.has(w)).length / new Set([...x, ...y]).size >= 0.5;
}
function truncated(result: Result | undefined): boolean {
  if (!result) return false;
  const details = object(result.details);
  if (details.truncated === true || object(details.truncation).truncated === true) return true;
  return (Array.isArray(result.content) ? result.content : []).some((block) => block.type === "text" && /(?:output (?:is |was )?truncated|\[showing lines|full output (?:saved|is saved)|truncated to \d)/i.test(block.text));
}

/** Reconstruct only the active branch, including summarized-away calls, without runtime hooks or writes. */
export function analyzeTools(branch: readonly SessionEntry[], contextEntries: readonly SessionEntry[], cwd: string): ToolProfile {
  const retained = new Map(contextEntries.map((entry) => [entry.id, convertToLlm(sessionEntryToContextMessages(entry))]));
  const calls: ProfileCall[] = [];
  const pending = new Map<string, ProfileCall[]>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const [index, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
        if (block.type !== "toolCall") continue;
        const projected = retained.get(entry.id)?.flatMap((m) => m.role === "assistant" ? m.content : []).find((b) => b.type === "toolCall" && b.id === block.id);
        const call: ProfileCall = {
          id: `call:${entry.id}:${index}`, tool: block.name, callId: block.id, entryId: entry.id, call: block,
          arguments: contentEstimate(block), resultSize: emptyEstimate(), retained: projected ? contentEstimate(projected) : emptyEstimate(),
          requestInput: hasUsage(message.usage) ? inputTokens(message.usage) : undefined, signals: [],
        };
        calls.push(call);
        const key = JSON.stringify([block.id, block.name]);
        const queue = pending.get(key) ?? [];
        queue.push(call); pending.set(key, queue);
      }
    } else if (message.role === "toolResult") {
      const key = JSON.stringify([message.toolCallId, message.toolName]);
      const queue = pending.get(key);
      const call = queue?.shift() ?? {
        id: `result:${entry.id}`, tool: message.toolName, callId: message.toolCallId,
        arguments: emptyEstimate(), resultSize: emptyEstimate(), retained: emptyEstimate(), signals: [],
      } as ProfileCall;
      if (!queue?.length) pending.delete(key);
      if (!call.call) calls.push(call);
      call.result = message;
      call.resultEntryId = entry.id;
      call.resultSize = contentEstimate(message.content);
      call.retained = sumEstimates([call.retained, ...retained.get(entry.id)?.map((m) => contentEstimate(m.content)) ?? []]);
    }
  }

  const entryOrder = new Map(branch.map((entry, index) => [entry.id, index]));
  const previousByTool = new Map<string, ProfileCall[]>();
  const exact = new Map<string, string>();
  for (const call of calls) {
    if (call.result?.isError) call.signals.push({ kind: "Tool error" });
    if (truncated(call.result)) call.signals.push({ kind: "Truncation marker" });
    if (call.resultSize.tokens >= LARGE_RESULT) call.signals.push({ kind: "Large result (>= ~2k)" });
    if (!call.call) { call.signals.push({ kind: "Unmatched result" }); continue; }
    if (!call.result) call.signals.push({ kind: "No recorded result" });
    const key = `${call.tool}:${fingerprint(call.call.arguments)}`;
    const duplicate = exact.get(key);
    if (duplicate) call.signals.push({ kind: "Repeated arguments", related: duplicate });
    exact.set(key, call.id);
    const previous = previousByTool.get(call.tool) ?? [];
    const range = readRange(call, cwd);
    for (const prior of previous.slice().reverse()) {
      // No causal/retry claims about parallel siblings: earlier result must precede this call's assistant entry.
      if (!prior.resultEntryId || entryOrder.get(prior.resultEntryId)! >= entryOrder.get(call.entryId!)!) continue;
      const priorRange = readRange(prior, cwd);
      const sameTarget = target(call, cwd) !== undefined && target(call, cwd) === target(prior, cwd);
      const add = (kind: string) => { if (!call.signals.some((s) => s.kind === kind)) call.signals.push({ kind, related: prior.id }); };
      if (range && priorRange && range.path === priorRange.path) {
        add("Repeated file read");
        if (range.start <= priorRange.end && priorRange.start <= range.end) add("Overlapping requested ranges");
        if (prior.resultSize.tokens >= LARGE_RESULT && range.start >= priorRange.start && range.end <= priorRange.end && range.end - range.start < priorRange.end - priorRange.start) add("Large result then narrower read");
        if (truncated(prior.result) && range.start > priorRange.start) add("Pagination after truncation");
      }
      const searchRefinement = similarSearch(call, prior);
      const sameQuery = typeof object(call.call.arguments).query === "string" && object(call.call.arguments).query === object(prior.call?.arguments).query;
      if ((sameTarget || searchRefinement || sameQuery) && prior.result?.isError && call.result && !call.result.isError) add("Success after related error");
      if (searchRefinement) add("Similar search query");
    }
    previous.push(call);
    if (previous.length > LOOKBACK) previous.shift();
    previousByTool.set(call.tool, previous);
  }

  const groups = new Map<string, ProfileCall[]>();
  for (const call of calls) { const group = groups.get(call.tool) ?? []; group.push(call); groups.set(call.tool, group); }
  const tools = [...groups].map(([name, group]): ToolStats => {
    const sizes = group.filter((c) => c.result).map((c) => c.resultSize.tokens).sort((a, b) => a - b);
    const samples = group.flatMap((c) => c.requestInput === undefined ? [] : [c.requestInput]);
    const signals: Record<string, number> = {};
    for (const call of group) for (const signal of call.signals) signals[signal.kind] = (signals[signal.kind] ?? 0) + 1;
    return {
      name, calls: group.filter((c) => c.call).length, results: sizes.length,
      missingResults: group.filter((c) => c.call && !c.result).length, orphanResults: group.filter((c) => !c.call).length,
      errors: group.filter((c) => c.result?.isError).length,
      arguments: sumEstimates(group.map((c) => c.arguments)), resultSize: sumEstimates(group.map((c) => c.resultSize)),
      retained: sumEstimates(group.map((c) => c.retained)), largestResult: sizes.at(-1) ?? 0,
      averageResult: sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0,
      medianResult: sizes.length ? (sizes[Math.floor((sizes.length - 1) / 2)] + sizes[Math.floor(sizes.length / 2)]) / 2 : 0,
      p95Result: sizes[Math.max(0, Math.ceil(sizes.length * 0.95) - 1)] ?? 0,
      requestInputMean: samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : undefined,
      requestInputSamples: samples.length, signals,
    };
  }).sort((a, b) => b.retained.tokens - a.retained.tokens || b.resultSize.tokens - a.resultSize.tokens);
  return { calls, tools };
}

const SIGNAL_NOTE = "Signals are heuristics, not accuracy scores or proof of wasted work. Exact repeats scan this branch; related-call checks look back 20 calls per tool and require a completed earlier result. Paths are resolved lexically (no filesystem access); ranges are requested, not observed. Truncation text can be a false positive. Search similarity uses >=50% word overlap. Success after an error does not prove the arguments were corrected.";
function signalTone(kind: string): Tone {
  return kind === "Tool error" ? "error" : kind === "No recorded result" || kind === "Unmatched result" ? "muted" : "warning";
}
function signalText(call: ProfileCall): StyledText {
  return call.signals.length ? joinRich(call.signals.map((s) => rich`${toned(s.kind, signalTone(s.kind))}${s.related ? ` ← ${s.related}` : ""}`)) : toned("None detected.", "dim");
}
function signalCounts(signals: Record<string, number>): StyledText {
  const counts = Object.entries(signals);
  return counts.length ? joinRich(counts.map(([kind, n]) => toned(`${kind}: ${n}`, signalTone(kind)))) : toned("None detected.", "dim");
}
function indicator(errors: number, signals: number, missing: number): Section["indicator"] {
  return errors ? { text: "!", tone: "error" } : signals ? { text: "?", tone: "warning" } : missing ? { text: "…", tone: "muted" } : undefined;
}
function callSection(call: ProfileCall): Section {
  const title = `${call.tool} · ${call.callId}`;
  return {
    titleHighlights: call.result?.isError === true ? toned(title, "error").highlights : undefined,
    id: call.id, title, status: "reference", source: `Branch call/result analysis · ${call.entryId ?? "no call"} → ${call.resultEntryId ?? "no result"}`,
    estimate: sumEstimates([call.arguments, call.resultSize]), sortTokens: call.resultSize.tokens,
    indicator: indicator(call.result?.isError ? 1 : 0, call.signals.filter((s) => signalTone(s.kind) === "warning").length, !call.result || !call.call ? 1 : 0),
    ...rich`Tool: ${call.tool}\nCall ID: ${call.callId}\nCall entry: ${call.entryId ?? toned("unmatched result", "muted")}\nResult entry: ${call.resultEntryId ?? toned("not recorded", "muted")}\nArguments + name: ${toned(formatEstimate(call.arguments), "accent")}\nResult: ${toned(formatEstimate(call.resultSize), call.resultSize.tokens >= LARGE_RESULT ? "warning" : "accent")}\nCurrently retained call + result: ${toned(formatEstimate(call.retained), "accent")}\nProvider request input at call issuance: ${call.requestInput?.toLocaleString() ?? "unknown"} tokens\nThis input produced the call, before its result existed. Shared by parallel calls; NOT a per-tool charge.\n\nSignals:\n${signalText(call)}\n\nArguments:\n${call.call ? jsonText(call.call.arguments) : "No matching call on this branch."}\n\nResult${call.result?.isError ? toned(" (error)", "error") : ""}:\n${call.result ? (call.result.isError === true ? toned(contentText(call.result.content), "error") : contentText(call.result.content)) : toned("No recorded result (possibly pending or interrupted).", "muted")}\n\n${ESTIMATE_NOTE}`,
    raw: call,
  };
}
export function toolSnapshot(branch: readonly SessionEntry[], contextEntries: readonly SessionEntry[], cwd: string): Snapshot {
  const profile = analyzeTools(branch, contextEntries, cwd);
  const callSections = new Map(profile.calls.map((call) => [call.id, callSection(call)]));
  const sectionFor = (call: ProfileCall) => callSections.get(call.id)!;
  const byTool = new Map<string, Section[]>();
  for (const call of profile.calls) { const group = byTool.get(call.tool) ?? []; group.push(sectionFor(call)); byTool.set(call.tool, group); }
  const retained = sumEstimates(profile.tools.map((t) => t.retained));
  const generated = sumEstimates(profile.tools.map((t) => t.resultSize));
  const table = joinRich(profile.tools.map((t) => rich`${t.name}: ${t.calls} calls · ${t.results} results · ${toned(`${t.errors} errors`, t.errors ? "error" : "dim")}\n  Args ${toned(formatEstimate(t.arguments), "accent")} · results ${toned(formatEstimate(t.resultSize), "accent")} · retained ${toned(formatEstimate(t.retained), "accent")} · largest ~${t.largestResult.toLocaleString()}`));
  const ranked = [...profile.calls].filter((c) => c.result).sort((a, b) => b.resultSize.tokens - a.resultSize.tokens).slice(0, 20);
  const sections: Section[] = [{
    id: "tools-overview", title: "Tool usage overview", status: "reference", source: "Active branch, not all session branches; analysis is not extra context",
    ...rich`Tool usage on the active branch\n${profile.tools.length} tools · ${profile.calls.filter((c) => c.call).length} calls\nGenerated result content: ${toned(formatEstimate(generated), "accent")}\nCurrently retained calls + results: ${toned(formatEstimate(retained), "accent")}\n\n${table.text ? table : "No recorded tool calls/results on this branch."}\n\nSelect a tool and Enter to drill into its calls; Backspace returns. Search also finds nested calls. s sorts by size (results in call lists).\n\nGenerated includes summarized-away history on this branch. Retained uses pi's reconstructed current context, not the last captured wire request. Tool schemas are separate in Preview and occupy context even without calls. Nested calls hidden inside a tool (MCP scripts, shell commands) cannot be individually attributed.\n\nA retained result can be sent in many future requests. Caching reduces cost, not context footprint. No cumulative billing cost is inferred from these content estimates.\n\n${ESTIMATE_NOTE}\n\n${SIGNAL_NOTE}`,
    raw: { tools: profile.tools, method: ESTIMATE_NOTE, diagnostics: SIGNAL_NOTE },
  }, {
    id: "largest-results", title: "Largest tool results", status: "reference", source: "Top 20 on the active branch; Enter to inspect",
    ...joinRich(ranked.length ? ranked.map((c) => rich`${toned(formatEstimate(c.resultSize), c.resultSize.tokens >= LARGE_RESULT ? "warning" : "accent")} · ${c.tool} · ${c.callId}\n  retained call+result ${formatEstimate(c.retained)} · ${joinRich(c.signals.map((s) => toned(s.kind, signalTone(s.kind))), ", ")}`) : [rich`No results yet.`]),
    raw: ranked.map((c) => ({ id: c.id, tool: c.tool, result: c.resultSize, retained: c.retained })), children: ranked.map(sectionFor),
  }, {
    id: "tool-diagnostics", title: "Tool-use diagnostics", status: "reference", source: "Heuristic signals, not an accuracy score; Enter to inspect",
    ...rich`${SIGNAL_NOTE}\n\n${joinRich(profile.tools.map((t) => rich`${t.name}\n${signalCounts(t.signals)}`))}`,
    raw: profile.tools.map((t) => ({ name: t.name, signals: t.signals })), children: profile.calls.filter((c) => c.signals.length).map(sectionFor),
  }];
  for (const tool of profile.tools) {
    sections.push({
      id: `tool-stats:${tool.name}`, title: `Tool stats · ${tool.name}`, status: "reference", source: "Enter: call/result pairs · Backspace: overview",
      estimate: tool.retained, sortTokens: tool.retained.tokens,
      indicator: indicator(tool.errors, Object.entries(tool.signals).filter(([kind]) => signalTone(kind) === "warning").reduce((sum, [, count]) => sum + count, 0), tool.missingResults + tool.orphanResults),
      ...rich`${tool.name}\nCalls: ${tool.calls} · results: ${tool.results} · ${toned(`errors: ${tool.errors}`, tool.errors ? "error" : "dim")}\n${toned(`Missing results: ${tool.missingResults} · unmatched results: ${tool.orphanResults}`, "muted")}\n\nGenerated arguments + names: ${toned(formatEstimate(tool.arguments), "accent")}\nGenerated results: ${toned(formatEstimate(tool.resultSize), "accent")}\nCurrently retained calls + results: ${toned(formatEstimate(tool.retained), "accent")}\nResult tokens (visible estimate): mean ~${tool.averageResult.toLocaleString()} · median ~${tool.medianResult.toLocaleString()} · p95 ~${tool.p95Result.toLocaleString()} · max ~${tool.largestResult.toLocaleString()}\n\nMean provider request input at call issuance: ${tool.requestInputMean?.toLocaleString() ?? "unknown"} tokens (${tool.requestInputSamples} calls with usage). Parallel calls share this context; not a marginal per-tool cost.\n\nSignals:\n${signalCounts(tool.signals)}\n\nEnter to inspect individual calls. ${ESTIMATE_NOTE}`,
      raw: tool, children: byTool.get(tool.name),
    });
  }
  return { kind: "tools", title: "Tool context profiler", description: `Retained ${formatEstimate(retained)} · generated results ${formatEstimate(generated)} · active branch`, sections };
}

/** Persisted main assistant responses provide a timeline across reloads, without extra request capture. */
export function growthSnapshot(branch: readonly SessionEntry[]): Snapshot {
  const sections: Section[] = [];
  let previous: { input: number; model: string } | undefined;
  let boundary = "Start of branch";
  let results = emptyEstimate();
  let resultCount = 0;
  for (const entry of branch) {
    if (entry.type === "compaction") { previous = undefined; boundary = "Compaction boundary"; results = emptyEstimate(); resultCount = 0; }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult") { results = sumEstimates([results, contentEstimate(message.content)]); resultCount++; }
    if (message.role !== "assistant") continue;
    const model = `${message.provider}/${message.model}`;
    const input = hasUsage(message.usage) ? inputTokens(message.usage) : undefined;
    const delta = input !== undefined && previous?.model === model ? input - previous.input : undefined;
    const reason = input === undefined ? "Missing/all-zero usage" : previous && previous.model !== model ? "Model changed" : boundary;
    const change = delta === undefined ? `not compared (${reason})` : `${delta >= 0 ? "+" : ""}${delta.toLocaleString()} tokens`;
    const outputCalls = (Array.isArray(message.content) ? message.content : []).filter((b) => b.type === "toolCall");
    const title = rich`${sections.length + 1} · input ${input?.toLocaleString() ?? "?"} · ${toned(`Δ ${delta === undefined ? "—" : `${delta >= 0 ? "+" : ""}${delta.toLocaleString()}`}`, deltaTone(delta))}`;
    sections.push({
      id: `growth:${entry.id}`, title: title.text, titleHighlights: title.highlights,
      status: "reference", source: `${entry.timestamp} · ${model} · ${entry.id}`, sortTokens: Math.abs(delta ?? 0),
      ...rich`${model}\n${entry.timestamp}\nSession entry: ${entry.id}\nStop reason: ${message.stopReason}\n\n${usageText(message.usage)}\n\nInput growth since previous recorded response: ${toned(change, deltaTone(delta))}\nTool results recorded in the intervening gap: ${resultCount}, ${formatEstimate(results)}\nThis response issued ${outputCalls.length} tool calls: ${outputCalls.map((c) => c.name).join(", ") || "none"}\n\nGrowth includes intervening assistant output, user messages, tools, hooks, and other changes. The gap's tool results are not an exact explanation of the delta. Compaction/model changes and missing usage break comparisons. Error/aborted responses may report partial usage. Nested tool model usage and summarization usage are not main-request context.`,
      raw: { entryId: entry.id, model, timestamp: entry.timestamp, usage: message.usage, delta, comparison: change, interveningToolResults: { count: resultCount, estimate: results } },
    });
    previous = input === undefined ? undefined : { input, model };
    boundary = "Previous response usage unavailable";
    results = emptyEstimate(); resultCount = 0;
  }
  const count = sections.length;
  const recent = joinRich(sections.slice(-20).reverse().map((s) => ({ text: s.title, highlights: s.titleHighlights ?? [] })));
  sections.unshift({
    id: "growth-overview", title: "Request input growth", status: "reference", source: "Persisted assistant responses on active branch; not additional context",
    ...rich`Request input growth\n${count} recorded assistant responses on this branch\n\nRecent responses (newest first):\n${recent.text ? recent : "No assistant responses yet."}\n\nInput = uncached input + cache read + cache write, from pi-normalized provider usage. Response output is separate. Comparisons are between consecutive recorded responses of the same model, reset at compaction or unknown usage.\n\nThis timeline survives reload via existing session data. It does not capture every network retry, stream update, nested call, or summary request. It neither stores extra prompts nor calls a model. Use Last request/Changes for the last two observed payloads.\n\ns sorts by absolute input change. Select a response to see input/cache/output and intervening tool-result estimates. Input changes can be negative; they are not an accuracy or cache-hit forecast.`,
    raw: { responses: count },
  });
  return { kind: "growth", title: "Request input growth", description: `${count} recorded responses · provider usage, not per-tool billing · active branch`, sections };
}
