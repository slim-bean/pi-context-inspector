import {
  convertToLlm,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createTwoFilesPatch } from "diff";
import { contentText, contentView, jsonText, parameterText, toolLabel, toolResultView } from "./content.ts";
import { pairToolCalls } from "./tool-pairs.ts";
import { analyzeInstructions, capturedInstructions } from "./instructions.ts";
import { instructionDelta, instructionSection, instructionSummary } from "./instruction-view.ts";
export { contentText, jsonText } from "./content.ts";
import { contentEstimate, emptyEstimate, ESTIMATE_NOTE, formatEstimate, jsonEstimate, object, sumEstimates, textEstimate, usageText, type TokenEstimate } from "./metrics.ts";

import { joinRich, rich, shareBar, toned, type Highlight, type Tone } from "./presentation.ts";

export interface Section {
  id: string;
  title: string;
  source: string;
  text: string;
  raw: unknown;
  status: "included" | "excluded" | "reference" | "captured";
  editableEntryId?: string;
  estimate?: TokenEstimate;
  /** Reference groups (Tools) can be expanded without adding model context. */
  children?: Section[];
  sortTokens?: number;
  highlights?: Highlight[];
  titleHighlights?: Highlight[];
  indicator?: { text: string; tone: Tone };
}

export interface Snapshot {
  kind: "preview" | "request" | "diff" | "tools" | "growth";
  title: string;
  description: string;
  sections: Section[];
  /** Latest reconstructed session entry, excluding overview/reference appendices. */
  tailSectionId?: string;
}

export interface Capture {
  capturedAt: string;
  sessionId: string;
  leafId: string | null;
  model: string;
  payload: unknown;
  json: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const CAPTURE_LIMIT = 16 * 1024 * 1024;

/** Bounded, extension-local snapshots. Never write prompts to the session or disk implicitly. */
export class RequestHistory {
  previous?: Capture;
  latest?: Capture;
  warning?: string;

  record(payload: unknown, metadata: Omit<Capture, "payload" | "json">): void {
    try {
      const json = JSON.stringify(payload, null, 2);
      if (!json || Buffer.byteLength(json) > CAPTURE_LIMIT) {
        this.clear("Latest request exceeds the 16 MiB capture limit; no request captured.");
        return;
      }
      this.previous = this.latest;
      this.latest = { ...metadata, payload: JSON.parse(json), json };
      this.warning = undefined;
    } catch {
      this.clear("Latest request could not be serialized; no request captured.");
    }
  }

  clear(warning?: string): void {
    this.latest = this.previous = undefined;
    this.warning = warning;
  }
}

export function makeDiff(before: string, after: string, beforeName = "previous", afterName = "current"): string {
  if (before === after) return "No changes.";
  // Keep synchronous rendering bounded even for huge, entirely different prompts.
  if (before.length + after.length > 1_000_000) {
    return "Diff exceeds the 1M-character display limit. Export both versions to compare externally.";
  }
  return createTwoFilesPatch(beforeName, afterName, before, after, "", "", {
    context: 4,
    timeout: 150,
    maxEditLength: 10_000,
  }) ?? "Diff calculation exceeded its budget. Export to compare externally.";
}

export function activeCompaction(entries: readonly SessionEntry[]): Extract<SessionEntry, { type: "compaction" }> | undefined {
  return entries.findLast((entry) => entry.type === "compaction") as Extract<SessionEntry, { type: "compaction" }> | undefined;
}

export function buildPreview(ctx: ExtensionCommandContext, pi: ExtensionAPI): Snapshot {
  const sections: Section[] = [];
  const options = ctx.getSystemPromptOptions();
  const categories = new Map<string, TokenEstimate>();
  const add = (category: string, value: TokenEstimate) => categories.set(category, sumEstimates([categories.get(category) ?? emptyEstimate(), value]));
  const system = ctx.getSystemPrompt();
  const instructions = analyzeInstructions(system, "ctx.getSystemPrompt()", options);
  for (const [name, cost] of Object.entries(instructions.categories)) add(name, { ...emptyEstimate(), tokens: cost.tokens });
  sections.push({
    id: "system", title: "System instructions", source: "ctx.getSystemPrompt() — current pi prompt",
    status: "included", text: system, raw: system, estimate: textEstimate(system),
  });
  sections.push(instructionSection(instructions, "instruction-breakdown", "Instruction costs · skills, files & rules"));
  sections.push({
    id: "prompt-inputs", title: "System prompt sources", source: "Base construction inputs (reference, not extra messages)",
    status: "reference", text: jsonText(options), raw: options,
  });
  const active = new Set(pi.getActiveTools());
  for (const tool of pi.getAllTools().filter((t) => active.has(t.name))) {
    const estimate = jsonEstimate({ name: tool.name, description: tool.description, parameters: tool.parameters });
    add("Tool definitions", estimate);
    sections.push({
      id: `tool:${tool.name}`, title: `Tool · ${tool.name}`, status: "included",
      source: tool.sourceInfo.path,
      text: `${tool.description}\n\nParameters:\n${jsonText(tool.parameters)}`,
      raw: tool, estimate,
    });
  }
  const branch = ctx.sessionManager.getBranch();
  const contextEntries = ctx.sessionManager.buildContextEntries();
  const selected = new Set(contextEntries.map((e) => e.id));
  const currentCompaction = activeCompaction(branch);
  const resultPairs = new Map(pairToolCalls(branch).filter((p) => p.resultEntryId).map((p) => [p.resultEntryId!, p]));
  for (const entry of contextEntries) {
    // Newer Pi persists system state/deltas. The current rendered prompt above
    // already accounts for them; don't charge their storage representation again.
    if (entry.type === "message" && object(entry.message).role === "system") {
      sections.push({
        id: entry.id, title: "Recorded system instructions", status: "reference",
        source: `Session entry ${entry.id} · current rendered instructions counted in System instructions`,
        text: `Recorded system state/update (reference only). Preview measures the current rendered prompt, not cumulative historical system updates. Last request shows the captured provider representation.\n\n${jsonText(entry.message)}`,
        raw: entry,
      });
      continue;
    }
    const messages = sessionEntryToContextMessages(entry);
    const llm = convertToLlm(messages);
    const role = entry.type === "message" ? entry.message.role : entry.type;
    const estimates: TokenEstimate[] = [];
    for (const message of llm) {
      if (message.role === "assistant") {
        for (const block of message.content) {
          const estimate = contentEstimate(block);
          estimates.push(estimate);
          add(block.type === "toolCall" ? "Tool-call arguments + names" : block.type === "thinking" ? "Visible reasoning" : "Assistant text", estimate);
        }
      } else {
        const estimate = contentEstimate(message.content);
        estimates.push(estimate);
        add(entry.type === "compaction" ? "Compaction summary" : entry.type === "branch_summary" ? "Branch summary"
          : message.role === "toolResult" ? "Tool results" : entry.type === "custom_message" ? "Extension messages" : "User / shell messages", estimate);
      }
    }
    const hidden = entry.type === "custom_message" && !entry.display;
    const tool = entry.type === "message" ? toolLabel(entry.message) : undefined;
    const title = tool?.title ?? (entry.type === "compaction" ? "Compaction summary"
      : entry.type === "branch_summary" ? "Branch summary"
      : entry.type === "custom_message" ? `Extension · ${entry.customType}${hidden ? " (hidden in chat)" : ""}`
      : entry.type === "custom" ? `UI/state · ${entry.customType}`
      : role === "toolResult" && entry.type === "message" ? `Result · ${entry.message.role === "toolResult" ? entry.message.toolName : "tool"}`
      : role);
    const isToolError = entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError === true;
    sections.push({
      id: entry.id, title, source: `Session entry ${entry.id}`,
      titleHighlights: tool ? toned(title, tool.tone).highlights : undefined,
      indicator: isToolError ? { text: "!", tone: "error" } : undefined,
      status: llm.length > 0 ? "included" : "excluded",
      // Show the actual compaction wrapper and its user role, not just summary text.
      ...(llm.length > 0
        ? joinRich(llm.map((m) => {
          if (m.role === "toolResult") {
            const pair = resultPairs.get(entry.id);
            const reference = rich`${toned("Originating call parameters (reference only):", "dim")}\n${pair?.call
              ? `Recorded call entry: ${pair.entryId}\n${parameterText(pair.call.arguments)}` : "No matching call on this branch."}`;
            return toolResultView(m.toolName, m.toolCallId, contentText(m.content), m.isError === true, reference);
          }
          return toolLabel(m) ? contentView(m) : rich`[${m.role}]\n${contentView(m.content)}`;
        }), "\n\n")
        : rich`Not sent by pi's message conversion.\n\n${jsonText(entry)}`),
      raw: entry,
      estimate: llm.length ? sumEstimates(estimates) : undefined,
      editableEntryId: entry.type === "compaction" && entry.id === currentCompaction?.id ? entry.id : undefined,
    });
  }
  const omitted = branch.filter((entry) => !selected.has(entry.id));
  if (omitted.length > 0) sections.push({
    id: "omitted", title: `Summarized away · ${omitted.length} entries`, status: "excluded",
    source: "Active branch history before the kept boundary",
    text: omitted.map((entry) => `${entry.id}  ${entry.type}${entry.type === "message" ? ` · ${entry.message.role}` : ""}`).join("\n"),
    raw: omitted,
  });
  const usage = ctx.getContextUsage();
  const total = sumEstimates([...categories.values()]);
  const contextLabel = usage?.tokens != null ? `Pi context: ~${usage.tokens.toLocaleString()}${usage.contextWindow ? ` / ${usage.contextWindow.toLocaleString()} (${(usage.tokens / usage.contextWindow * 100).toFixed(1)}%)` : ""}` : "Pi context: unknown";
  const breakdown = [...categories].sort((a, b) => b[1].tokens - a[1].tokens);
  const largest = sections.filter((s) => s.estimate).sort((a, b) => b.estimate!.tokens - a.estimate!.tokens).slice(0, 10);
  const categoryTones: Record<string, Tone> = {
    "Base / other instructions": "accent", "Skill descriptions": "warning", "Skill names, paths & framing": "mdCode", "Project instructions": "success", "Tool definitions": "mdCode", "User / shell messages": "success",
    "Assistant text": "mdHeading", "Visible reasoning": "thinkingText", "Tool-call arguments + names": "mdCode",
    "Tool results": "accent", "Compaction summary": "success", "Branch summary": "success", "Extension messages": "thinkingText",
  };
  const bars = joinRich(breakdown.map(([name, value]) => rich`${shareBar(value.tokens, total.tokens, categoryTones[name] ?? "accent")} ${toned(formatEstimate(value).padStart(18), "accent")}  ${total.tokens ? (value.tokens / total.tokens * 100).toFixed(1) : "0.0"}%  ${name}`));
  sections.unshift({
    id: "context-overview", title: "Context usage & legend", status: "reference", source: "Local measurements; not extra model context",
    ...rich`${toned(contextLabel, "accent")}\nVisible-content estimate: ${toned(formatEstimate(total), "accent")}\n${instructionSummary(instructions)}\nSee Instruction costs for per-skill descriptions, paths, files and rules.\n\n${toned("+", "success")} Included in reconstructed context\n${toned("·", "dim")} Reference only (not additional context)\n${toned("−", "muted")} Excluded from context\nRaw JSON includes storage metadata; display labels are not sent.\n\nBreakdown (share of estimated visible tokens):\n${bars}\n\nLargest included sections:\n${largest.map((s) => `${formatEstimate(s.estimate!)}  ${s.title} · ${s.id}`).join("\n")}\n\n${ESTIMATE_NOTE}\nImages: ${total.images}; opaque/unknown blocks: ${total.opaque}. Pi's overall estimate may use response usage and a different estimation method; these totals need not match.\nPreview is not a final request: hooks, image settings and provider conversion may change it.`,
    raw: { contextUsage: usage, estimate: total, categories: Object.fromEntries(categories), method: ESTIMATE_NOTE },
  });
  return {
    kind: "preview", title: "Current context preview",
    description: `${contextLabel} · visible ${formatEstimate(total)} · preview, not final request`,
    sections, tailSectionId: contextEntries.at(-1)?.id,
  };
}

export function requestSnapshot(history: RequestHistory): Snapshot {
  const capture = history.latest;
  const description = history.warning ?? (capture
    ? `${capture.model} · ${capture.capturedAt} · observed at this extension's hook; later hooks may change it. Not a prediction of the next request.`
    : "No requests captured since this extension loaded. Send a prompt first. Captures are memory-only and clear on reload/resume.");
  const sections: Section[] = [];
  if (capture) {
    sections.push({
      id: "request-info", title: "Request information", source: "Capture metadata; not sent to the provider", status: "reference",
      text: `${usageText(capture.usage)}\n\n${jsonText({ capturedAt: capture.capturedAt, model: capture.model, leafId: capture.leafId })}\n\nCaptured at this extension's hook; later hooks may change it. Settings are not conversation tokens. Full provider payload repeats the sections below; do not count it twice. Provider-specific payload sections are not assigned misleading JSON token counts.`,
      raw: { ...capture, payload: undefined, json: undefined },
    });
    const instructionProfile = capturedInstructions(capture.payload);
    if (instructionProfile) sections.push(instructionSection(instructionProfile, "request-instructions", "Instruction costs · captured text"));
    const payload = capture.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      for (const [key, value] of Object.entries(payload)) {
        if ((key === "messages" || key === "input" || key === "tools") && Array.isArray(value)) {
          value.forEach((item, index) => {
            const tool = key === "tools" ? undefined : toolLabel(item);
            const title = tool ? `${tool.title} · ${key} ${index + 1}` : `${key} ${index + 1} · ${item?.role ?? item?.name ?? item?.type ?? "item"}`;
            sections.push({
              id: `${key}:${index}`, title, titleHighlights: tool ? toned(title, tool.tone).highlights : undefined,
              source: `payload.${key}[${index}]`, status: "captured", ...contentView(item), raw: item,
            });
          });
        } else {
          sections.push({ id: key, title: key, source: `payload.${key}`, status: "captured", text: contentText(value), raw: value });
        }
      }
    }
    sections.push({ id: "payload", title: "Full provider payload", source: "Duplicate view of the sections above, not additional context", status: "reference", text: capture.json, raw: capture.payload });
  }
  return { kind: "request", title: "Last captured request", description, sections };
}

export function diffSnapshot(history: RequestHistory): Snapshot {
  const { previous, latest } = history;
  const before = previous && capturedInstructions(previous.payload), after = latest && capturedInstructions(latest.payload);
  return {
    kind: "diff", title: "Request changes",
    description: "Diff of the last two captured provider payloads. A changed prefix may reduce cache reuse; this is not a token-level cache prediction.",
    sections: previous && latest ? [{
      id: "diff", title: "Previous → latest request", source: `${previous.capturedAt} → ${latest.capturedAt}`,
      status: "reference", text: makeDiff(previous.json, latest.json),
      raw: { previous: previous.payload, latest: latest.payload },
    }, ...(before && after ? [instructionDelta(before, after)] : [])] : [],
  };
}
