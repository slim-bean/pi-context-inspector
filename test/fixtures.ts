import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SUMMARY = "## Goal\nBuild a context inspector.\n\n## Decision\nUse the WRONG database.\n";
export const CORRECTED = SUMMARY.replace("WRONG", "correct");
export const EDIT_ERROR = "Could not find edits[1] in /project/README.md. The oldText must match exactly including all whitespace";
export const usage = { input: 30, output: 5, cacheRead: 10, cacheWrite: 0, totalTokens: 45, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export function fixtureEntries(cwd: string, withTools = false) {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const entry = (id: string, parentId: string | null, fields: object) => ({ id, parentId, timestamp, ...fields });
  const user = (content: string) => ({ role: "user", content, timestamp: 1 });
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], provider: "context-test", model: "fixture", api: "openai-completions", stopReason: "stop", timestamp: 2, usage });
  return [
    { type: "session", version: 3, id: randomUUID(), timestamp, cwd },
    entry("old-user", null, { type: "message", message: user("Old history") }),
    entry("old-assistant", "old-user", { type: "message", message: assistant("Old answer") }),
    entry("kept-user", "old-assistant", { type: "message", message: user("Continue the work") }),
    entry("kept-assistant", "kept-user", { type: "message", message: assistant("Working on it") }),
    entry("compact", "kept-assistant", { type: "compaction", summary: SUMMARY, firstKeptEntryId: "kept-user", tokensBefore: 90000, details: { readFiles: ["README.md"], custom: true }, usage }),
    entry("hidden", "compact", { type: "custom_message", customType: "fixture-injection", content: "Invisible in chat but sent to model", display: false }),
    entry("ui-state", "hidden", { type: "custom", customType: "fixture-state", data: { doNotSend: true } }),
    entry("excluded-bash", "ui-state", { type: "message", message: { role: "bashExecution", command: "echo SECRET", output: "SECRET", excludeFromContext: true, timestamp: 3 } }),
    ...(withTools ? [
      entry("tool-assistant-1", "excluded-bash", { type: "message", message: { ...assistant("Reading"), content: [{ type: "toolCall", id: "fixture-read-1", name: "read", arguments: { path: "README.md", offset: 1, limit: 1000 } }], stopReason: "toolUse" } }),
      entry("tool-result-1", "tool-assistant-1", { type: "message", message: { role: "toolResult", toolName: "read", toolCallId: "fixture-read-1", content: [{ type: "text", text: "Fixture text ".repeat(750) + "\nOutput truncated" }], details: { truncation: { truncated: true } }, isError: false, timestamp: 4 } }),
      entry("tool-assistant-2", "tool-result-1", { type: "message", message: { ...assistant("Narrowing read"), content: [{ type: "toolCall", id: "fixture-read-2", name: "read", arguments: { path: "README.md", offset: 20, limit: 10 } }], stopReason: "toolUse" } }),
      entry("tool-result-2", "tool-assistant-2", { type: "message", message: { role: "toolResult", toolName: "read", toolCallId: "fixture-read-2", content: [{ type: "text", text: "A smaller fixture result" }], isError: false, timestamp: 5 } }),
      entry("tool-assistant-error", "tool-result-2", { type: "message", message: { ...assistant("Editing"), content: [{ type: "toolCall", id: "fixture-edit-error", name: "edit", arguments: { path: "README.md", edits: [] } }], stopReason: "toolUse" } }),
      entry("tool-result-error", "tool-assistant-error", { type: "message", message: { role: "toolResult", toolName: "edit", toolCallId: "fixture-edit-error", content: [{ type: "text", text: EDIT_ERROR }], isError: true, timestamp: 6 } }),
    ] : []),
    entry("latest", withTools ? "tool-result-error" : "excluded-bash", { type: "message", message: assistant("Ready for inspection") }),
  ];
}
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-context-test-"));
  const path = join(dir, "session.jsonl");
  const entries = fixtureEntries(dir);
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(path, text, { mode: 0o600 });
  return { dir, path, entries, text, sessionId: entries[0].id, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
