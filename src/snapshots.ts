import {
  convertToLlm,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createTwoFilesPatch } from "diff";

export interface Section {
  id: string;
  title: string;
  source: string;
  text: string;
  raw: unknown;
  status: "included" | "excluded" | "reference" | "captured";
  editableEntryId?: string;
}

export interface Snapshot {
  kind: "preview" | "request" | "diff";
  title: string;
  description: string;
  sections: Section[];
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

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** Human-readable representation; raw view/export always retains the original object. */
export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).join("\n\n");
  if (!value || typeof value !== "object") return String(value ?? "");
  const v = value as Record<string, unknown>;
  if (v.type === "image" || v.type === "image_url" || v.type === "input_image") {
    return `[image: ${v.mimeType ?? v.mediaType ?? "see raw view"}]`;
  }
  if (v.type === "thinking") {
    return `[thinking]\n${v.thinking || "Opaque/signed reasoning; see raw view."}`;
  }
  if (v.type === "toolCall") return `[tool call: ${v.name}]\n${jsonText(v.arguments)}`;
  if (typeof v.text === "string") return v.text;
  if (v.content !== undefined) return contentText(v.content);
  if (typeof v.summary === "string") return v.summary;
  return jsonText(value);
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
  sections.push({
    id: "system", title: "System instructions", source: "ctx.getSystemPrompt() — current pi prompt",
    status: "included", text: ctx.getSystemPrompt(), raw: ctx.getSystemPrompt(),
  });
  sections.push({
    id: "prompt-inputs", title: "System prompt sources", source: "Base construction inputs (reference, not extra messages)",
    status: "reference", text: jsonText(options), raw: options,
  });
  const active = new Set(pi.getActiveTools());
  for (const tool of pi.getAllTools().filter((t) => active.has(t.name))) {
    sections.push({
      id: `tool:${tool.name}`, title: `Tool · ${tool.name}`, status: "included",
      source: tool.sourceInfo.path,
      text: `${tool.description}\n\nParameters:\n${jsonText(tool.parameters)}`,
      raw: tool,
    });
  }
  const branch = ctx.sessionManager.getBranch();
  const contextEntries = ctx.sessionManager.buildContextEntries();
  const selected = new Set(contextEntries.map((e) => e.id));
  const currentCompaction = activeCompaction(branch);
  for (const entry of contextEntries) {
    const messages = sessionEntryToContextMessages(entry);
    const llm = convertToLlm(messages);
    const role = entry.type === "message" ? entry.message.role : entry.type;
    const hidden = entry.type === "custom_message" && !entry.display;
    const title = entry.type === "compaction" ? "Compaction summary"
      : entry.type === "branch_summary" ? "Branch summary"
      : entry.type === "custom_message" ? `Extension · ${entry.customType}${hidden ? " (hidden in chat)" : ""}`
      : entry.type === "custom" ? `UI/state · ${entry.customType}`
      : role === "toolResult" && entry.type === "message" ? `Result · ${entry.message.role === "toolResult" ? entry.message.toolName : "tool"}`
      : role;
    sections.push({
      id: entry.id, title, source: `Session entry ${entry.id}`,
      status: llm.length > 0 ? "included" : "excluded",
      // Show the actual compaction wrapper and its user role, not just summary text.
      text: llm.length > 0
        ? llm.map((m) => `[${m.role}]\n${contentText(m.content)}`).join("\n\n")
        : `Not sent by pi's message conversion.\n\n${jsonText(entry)}`,
      raw: entry,
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
  return {
    kind: "preview", title: "Current context preview",
    description: `Stored branch + current instructions/tools. Not a final request; hooks and provider conversion may change it. ${usage?.tokens != null ? `Pi context estimate: ${usage.tokens.toLocaleString()} tokens.` : "Token usage unknown."}`,
    sections,
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
      text: jsonText({ capturedAt: capture.capturedAt, model: capture.model, leafId: capture.leafId, usage: capture.usage ?? "No response usage observed yet" }),
      raw: { ...capture, payload: undefined, json: undefined },
    });
    const payload = capture.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      for (const [key, value] of Object.entries(payload)) {
        if ((key === "messages" || key === "input" || key === "tools") && Array.isArray(value)) {
          value.forEach((item, index) => sections.push({
            id: `${key}:${index}`, title: `${key} ${index + 1} · ${item?.role ?? item?.name ?? item?.type ?? "item"}`,
            source: `payload.${key}[${index}]`, status: "captured", text: contentText(item), raw: item,
          }));
        } else {
          sections.push({ id: key, title: key, source: `payload.${key}`, status: "captured", text: contentText(value), raw: value });
        }
      }
    }
    sections.push({ id: "payload", title: "Full provider payload", source: "Unmodified payload observed by this extension", status: "captured", text: capture.json, raw: capture.payload });
  }
  return { kind: "request", title: "Last captured request", description, sections };
}

export function diffSnapshot(history: RequestHistory): Snapshot {
  const { previous, latest } = history;
  return {
    kind: "diff", title: "Request changes",
    description: "Diff of the last two captured provider payloads. A changed prefix may reduce cache reuse; this is not a token-level cache prediction.",
    sections: previous && latest ? [{
      id: "diff", title: "Previous → latest request", source: `${previous.capturedAt} → ${latest.capturedAt}`,
      status: "reference", text: makeDiff(previous.json, latest.json),
      raw: { previous: previous.payload, latest: latest.payload },
    }] : [],
  };
}
