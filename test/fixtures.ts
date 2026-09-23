import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SUMMARY = "## Goal\nBuild a context inspector.\n\n## Decision\nUse the WRONG database.\n";
export const CORRECTED = SUMMARY.replace("WRONG", "correct");
export const usage = { input: 30, output: 5, cacheRead: 10, cacheWrite: 0, totalTokens: 45, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export function fixtureEntries(cwd: string) {
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
    entry("latest", "excluded-bash", { type: "message", message: assistant("Ready for inspection") }),
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
