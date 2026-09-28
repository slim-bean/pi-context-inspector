import assert from "node:assert/strict";
import { test } from "node:test";
import { contentView, parameterText, toolLabel } from "../src/content.ts";
import { RequestHistory, requestSnapshot } from "../src/snapshots.ts";

const metadata = { capturedAt: "test", sessionId: "session", leafId: "leaf", model: "fixture" };

test("Chat Completions calls retain parameters even with null or nonempty content", () => {
  for (const content of [null, "I will read those files."]) {
    const message = { role: "assistant", content, tool_calls: [
      { id: "a", type: "function", function: { name: "read", arguments: '{"path":"a.ts","offset":4}' } },
      { id: "b", type: "function", function: { name: "edit", arguments: '{"path":"b.ts","edits":[]}' } },
    ] };
    const history = new RequestHistory();
    history.record({ messages: [message, { role: "tool", tool_call_id: "a", content: "file data" }] }, metadata);
    const before = history.latest!.json;
    const snapshot = requestSnapshot(history);
    const call = snapshot.sections.find((s) => s.id === "messages:0")!;
    const result = snapshot.sections.find((s) => s.id === "messages:1")!;
    assert.ok(call.title.startsWith("Calls (2) · read, edit"));
    assert.ok(call.text.startsWith("▶ TOOL CALL · read\nCall ID: a\nParameters:\n{\n"));
    assert.ok(call.text.includes('  "path": "a.ts",\n  "offset": 4'));
    assert.ok(call.text.includes("▶ TOOL CALL · edit"));
    if (content) assert.ok(call.text.endsWith(content));
    assert.ok(result.title.startsWith("Result · tool"));
    assert.ok(result.text.includes("Call ID: a\n\nOutput:\nfile data"));
    assert.deepEqual(call.raw, message);
    assert.equal(history.latest!.json, before);
    assert.equal(JSON.stringify(snapshot).includes("\\u001b"), false);
  }
});

test("Responses and Anthropic block formats distinguish calls/results; unknown items stay intact", () => {
  const cases = [
    { value: { type: "function_call", call_id: "r1", name: "read", arguments: '{"path":"response.ts"}' }, title: "Call · read", text: '"path": "response.ts"' },
    { value: { type: "function_call_output", call_id: "r1", output: "response data" }, title: "Result · function", text: "Output:\nresponse data" },
    { value: { role: "assistant", content: [{ type: "tool_use", id: "a1", name: "read", input: { path: "anthropic.ts" } }] }, title: "Call · read", text: '"path": "anthropic.ts"' },
    { value: { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: [{ type: "text", text: "anthropic data" }] }] }, title: "Result · tool", text: "Output:\nanthropic data" },
    { value: { role: "assistant", content: null, function_call: { name: "read", arguments: '{"path":"legacy.ts"}' } }, title: "Call · read", text: '"path": "legacy.ts"' },
  ];
  const history = new RequestHistory();
  history.record({ input: cases.map((c) => c.value) }, metadata);
  const sections = requestSnapshot(history).sections;
  for (const [index, c] of cases.entries()) {
    const section = sections.find((s) => s.id === `input:${index}`)!;
    assert.ok(section.title.startsWith(c.title));
    assert.ok(section.text.includes(c.text));
    assert.deepEqual(section.raw, c.value);
  }
  const unknown = { type: "future_call_format", payload: { args: ["keep me"] } };
  assert.equal(contentView(unknown).text, JSON.stringify(unknown, null, 2));
  assert.equal(toolLabel(unknown), undefined);
});

test("partial arguments, empty arguments and schemas are not confused with function calls", () => {
  assert.equal(parameterText('{"path":'), '{"path":');
  assert.equal(parameterText("not JSON"), "not JSON");
  assert.equal(parameterText({}), "{}");
  assert.equal(parameterText(undefined), "Parameters not recorded.");
  const schema = { type: "function", function: { name: "read", description: "read files", parameters: { type: "object" } } };
  assert.equal(toolLabel(schema), undefined);
  assert.equal(contentView(schema).text, JSON.stringify(schema, null, 2));
  assert.equal(toolLabel({ role: "user", content: "TOOL CALL · read\nParameters: {}" }), undefined);
});

test("provider error flags color result content, not text mentioning errors or call parameters", () => {
  const parameters = { role: "assistant", tool_calls: [{ id: "id", type: "function", function: { name: "edit", arguments: '{"text":"error"}' } }] };
  const c = contentView(parameters);
  const start = c.text.indexOf("{\n");
  assert.ok(c.highlights.every((h) => h.end <= start));
  for (const is_error of [false, true]) {
    const v = contentView({ type: "tool_result", tool_use_id: "id", is_error, content: "Error in source file" });
    assert.equal(v.highlights.some((h) => h.tone === "error" && v.text.slice(h.start, h.end) === "Error in source file"), is_error);
  }
});
