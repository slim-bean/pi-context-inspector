import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildPreview, CAPTURE_LIMIT, contentText, diffSnapshot, makeDiff, RequestHistory, requestSnapshot } from "../src/snapshots.ts";
import { fixture } from "./fixtures.ts";

const metadata = { capturedAt: "2026-01-01", sessionId: "session", leafId: "leaf", model: "test/model" };
test("preview includes hidden messages and wrapped summary, distinguishes UI-only and omitted history", (t) => {
  const f = fixture(); t.after(f.cleanup);
  const ctx = {
    sessionManager: SessionManager.open(f.path),
    getSystemPrompt: () => "SYSTEM CONTENT",
    getSystemPromptOptions: () => ({ contextFiles: [{ path: "/test/AGENTS.md", content: "Loaded instruction" }] }),
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
  } as unknown as ExtensionCommandContext;
  const pi = {
    getActiveTools: () => ["read"],
    getAllTools: () => [
      { name: "read", description: "read files", parameters: { type: "object" }, sourceInfo: { path: "<builtin:read>" } },
      { name: "disabled", description: "not in context", parameters: {}, sourceInfo: { path: "test" } },
    ],
  } as unknown as ExtensionAPI;
  const snapshot = buildPreview(ctx, pi);
  assert.equal(snapshot.sections.find((s) => s.id === "system")?.text, "SYSTEM CONTENT");
  assert.ok(snapshot.sections.find((s) => s.id === "prompt-inputs")?.text.includes("/test/AGENTS.md"));
  assert.ok(snapshot.sections.find((s) => s.id === "tool:read"));
  assert.equal(snapshot.sections.some((s) => s.id === "tool:disabled"), false);
  const compact = snapshot.sections.find((s) => s.id === "compact")!;
  assert.ok(compact.text.startsWith("[user]\nThe conversation history"));
  assert.equal(compact.editableEntryId, "compact");
  assert.equal(snapshot.sections.find((s) => s.id === "hidden")?.status, "included");
  assert.ok(snapshot.sections.find((s) => s.id === "hidden")?.title.includes("hidden in chat"));
  assert.equal(snapshot.sections.find((s) => s.id === "ui-state")?.status, "excluded");
  assert.equal(snapshot.sections.find((s) => s.id === "excluded-bash")?.status, "excluded");
  assert.ok(snapshot.sections.find((s) => s.id === "omitted")?.text.includes("old-user"));
  assert.ok(snapshot.description.startsWith("Pi context: ~100 / 1,000 (10.0%)"));
  assert.equal(snapshot.sections[0].id, "context-overview");
  assert.ok(snapshot.sections[0].text.includes("Reference only (not additional context)"));
  assert.equal(snapshot.sections.find((s) => s.id === "prompt-inputs")?.estimate, undefined);
  assert.equal(snapshot.sections.find((s) => s.id === "omitted")?.estimate, undefined);
  assert.equal(snapshot.sections.find((s) => s.id === "excluded-bash")?.estimate, undefined);
  const raw = snapshot.sections[0].raw as any;
  assert.equal(raw.estimate.tokens, snapshot.sections.reduce((sum, section) => sum + (section.estimate?.tokens ?? 0), 0));
  assert.equal(raw.categories["System instructions"].tokens, 4);
  assert.ok(raw.categories["Tool definitions"].tokens > 0);
  assert.ok(raw.categories["Compaction summary"].tokens > 0);
});

test("captures snapshot payloads without mutation; only last two are retained", () => {
  const history = new RequestHistory();
  const payload = { messages: [{ role: "user", content: "one" }], system: "system" };
  history.record(payload, metadata);
  payload.messages[0].content = "two";
  assert.ok(history.latest?.json.includes("one"));
  history.record(payload, metadata);
  const request = requestSnapshot(history);
  assert.ok(request.sections.some((s) => s.id === "messages:0" && s.text === "two"));
  assert.ok(request.sections.some((s) => s.id === "system"));
  assert.equal(request.sections.find((s) => s.id === "payload")?.status, "reference");
  assert.ok(request.sections[0].text.includes("unavailable"));
  const diff = diffSnapshot(history);
  assert.ok(diff.sections[0].text.includes('-      "content": "one"'));
  assert.ok(diff.sections[0].text.includes('+      "content": "two"'));
  history.record({ input: "three" }, metadata);
  assert.ok(history.previous?.json.includes("two"));
  history.clear();
  assert.equal(history.latest, undefined);
  assert.equal(history.previous, undefined);
});

test("a skipped oversized or unserializable request is never mislabeled as the latest", () => {
  const history = new RequestHistory();
  history.record({ input: "old" }, metadata);
  history.record({ input: "x".repeat(CAPTURE_LIMIT) }, metadata);
  assert.equal(history.latest, undefined);
  assert.ok(history.warning?.includes("16 MiB"));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  history.record(cyclic, metadata);
  assert.ok(history.warning?.includes("serialized"));
});

test("diff is bounded and image display does not dump base64", () => {
  assert.equal(makeDiff("same", "same"), "No changes.");
  assert.ok(makeDiff("a".repeat(600_000), "b".repeat(600_000)).includes("display limit"));
  assert.equal(contentText([{ type: "image", mimeType: "image/png", data: "secretbase64" }]), "[image: image/png]");
});
