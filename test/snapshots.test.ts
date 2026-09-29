import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildPreview, CAPTURE_LIMIT, contentText, diffSnapshot, makeDiff, RequestHistory, requestSnapshot } from "../src/snapshots.ts";
import { EDIT_ERROR, fixture, usage } from "./fixtures.ts";

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
  assert.equal(snapshot.sections.at(-1)?.id, "omitted");
  assert.equal(snapshot.tailSectionId, ctx.sessionManager.buildContextEntries().at(-1)?.id);
  assert.ok(snapshot.sections.some((s) => s.id === snapshot.tailSectionId));
  assert.notEqual(snapshot.tailSectionId, "omitted");
  assert.ok(snapshot.sections[0].text.includes("Reference only (not additional context)"));
  assert.equal(snapshot.sections.find((s) => s.id === "prompt-inputs")?.estimate, undefined);
  assert.equal(snapshot.sections.find((s) => s.id === "omitted")?.estimate, undefined);
  assert.equal(snapshot.sections.find((s) => s.id === "excluded-bash")?.estimate, undefined);
  const raw = snapshot.sections[0].raw as any;
  assert.equal(raw.estimate.tokens, snapshot.sections.reduce((sum, section) => sum + (section.estimate?.tokens ?? 0), 0));
  assert.equal(raw.categories["Base / other instructions"].tokens, 4);
  assert.ok(raw.categories["Tool definitions"].tokens > 0);
  assert.ok(raw.categories["Compaction summary"].tokens > 0);
});

test("Preview colors failed tool results from metadata, never from their wording", (t) => {
  const f = fixture(); t.after(f.cleanup);
  const manager = SessionManager.open(f.path);
  const ctx = {
    sessionManager: manager, getSystemPrompt: () => "", getSystemPromptOptions: () => ({}), getContextUsage: () => undefined,
  } as unknown as ExtensionCommandContext;
  const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
  const before = buildPreview(ctx, pi);
  const ids = [true, false].map((isError) => manager.appendMessage({ role: "toolResult", toolName: "edit", toolCallId: `edit-${isError}`,
    content: [{ type: "text", text: EDIT_ERROR }], timestamp: 1, isError }));
  const preview = buildPreview(ctx, pi);
  const [failed, successful] = ids.map((id) => preview.sections.find((s) => s.id === id)!);
  assert.ok(failed.text.startsWith("◀ TOOL RESULT · edit (error)"));
  assert.ok(failed.text.endsWith(`Output:\n${EDIT_ERROR}`));
  assert.ok(failed.text.includes("No matching call on this branch."));
  assert.deepEqual(failed.indicator, { text: "!", tone: "error" });
  assert.deepEqual(failed.titleHighlights, [{ start: 0, end: failed.title.length, tone: "error" }]);
  assert.ok(failed.highlights?.some((h) => h.tone === "error" && failed.text.slice(h.start, h.end) === EDIT_ERROR));
  assert.ok(successful.text.endsWith(EDIT_ERROR));
  assert.ok(successful.highlights?.every((h) => h.end <= successful.text.indexOf(EDIT_ERROR)));
  assert.deepEqual(successful.titleHighlights, [{ start: 0, end: successful.title.length, tone: "mdHeading" }]);
  assert.equal(successful.indicator, undefined);
  assert.deepEqual(failed.estimate, successful.estimate, "styling must not add model-visible content or token costs");
  assert.equal(preview.sections.length, before.sections.length + 2);
  assert.equal(JSON.stringify(preview).includes("\\u001b"), false);
});

test("Preview shows parameters beside matched results without double counting or matching parallel siblings by position", (t) => {
  const f = fixture(); t.after(f.cleanup);
  const manager = SessionManager.open(f.path);
  const ctx = { sessionManager: manager, getSystemPrompt: () => "", getSystemPromptOptions: () => ({}), getContextUsage: () => undefined } as unknown as ExtensionCommandContext;
  const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
  const callId = manager.appendMessage({ role: "assistant", content: [
    { type: "text", text: "Narration before the calls" },
    { type: "toolCall", id: "one", name: "read", arguments: { path: "first.ts", offset: 7 } },
    { type: "toolCall", id: "two", name: "read", arguments: { path: "second.ts", limit: 3 } },
  ], provider: "context-test", model: "fixture", api: "openai-completions", stopReason: "toolUse", timestamp: 1, usage });
  const resultId = manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "two", content: [{ type: "text", text: "second result" }], timestamp: 2, isError: false });
  const firstResult = manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "one", content: [{ type: "text", text: "first result" }], timestamp: 3, isError: false });
  const original = JSON.stringify(manager.getBranch());
  const preview = buildPreview(ctx, pi);
  const call = preview.sections.find((s) => s.id === callId)!;
  const result = preview.sections.find((s) => s.id === resultId)!;
  assert.equal(call.title, "Calls (2) · read, read");
  assert.ok(call.text.startsWith("▶ TOOL CALL · read\nCall ID: one\nParameters:\n"));
  assert.ok(call.text.includes('"offset": 7'));
  assert.ok(call.text.includes('"limit": 3'));
  assert.ok(call.text.endsWith("Narration before the calls"));
  assert.equal(result.title, "Result · read");
  assert.ok(result.text.startsWith("◀ TOOL RESULT · read\nCall ID: two"));
  assert.ok(result.text.includes("Originating call parameters (reference only):"));
  assert.ok(result.text.includes('"path": "second.ts"'));
  assert.ok(!result.text.includes("first.ts"));
  assert.ok(preview.sections.find((s) => s.id === firstResult)!.text.includes("first.ts"));
  assert.equal(result.estimate?.tokens, Math.ceil("second result".length / 4));
  const total = (preview.sections[0].raw as any).estimate.tokens;
  assert.equal(total, preview.sections.reduce((sum, s) => sum + (s.estimate?.tokens ?? 0), 0));
  assert.equal(JSON.stringify(manager.getBranch()), original);
  assert.ok(!JSON.stringify(result.raw).includes("second.ts"), "raw result remains the result, not the reference call");
  const compactedContext = {
    ...ctx, sessionManager: { getBranch: () => manager.getBranch(), buildContextEntries: () => manager.getBranch().filter((e) => e.id === resultId) },
  } as unknown as ExtensionCommandContext;
  const compacted = buildPreview(compactedContext, pi);
  assert.ok(compacted.sections.find((s) => s.id === resultId)!.text.includes('"path": "second.ts"'));
  assert.equal((compacted.sections[0].raw as any).estimate.tokens, result.estimate!.tokens, "a historical call reference is not retained context");
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
