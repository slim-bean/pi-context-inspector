import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contentEstimate, formatEstimate, hasUsage, inputTokens, usageText } from "../src/metrics.ts";
import { analyzeTools, growthSnapshot, toolSnapshot } from "../src/profiler.ts";
import { usage } from "./fixtures.ts";

const timestamp = "2026-01-01T00:00:00Z";
const call = (id: string, name = "read", args: object = { path: "file.ts" }) => ({ type: "toolCall", id, name, arguments: args });
function assistant(id: string, content: unknown[] = [], overrides: object = {}): SessionEntry {
  return { type: "message", id, parentId: null, timestamp, message: { role: "assistant", content, usage, provider: "local", model: "fixture", api: "openai-completions", timestamp: 1, stopReason: "toolUse", ...overrides } } as SessionEntry;
}
function result(id: string, toolCallId: string, text = "result", overrides: object = {}): SessionEntry {
  return { type: "message", id, parentId: null, timestamp, message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], timestamp: 1, isError: false, ...overrides } } as SessionEntry;
}
function kinds(profile: ReturnType<typeof analyzeTools>, id: string) {
  return profile.calls.find((c) => c.callId === id)!.signals.map((s) => s.kind);
}

test("estimates exclude binary/signatures; visible thinking and arguments are separate from metadata", () => {
  assert.deepEqual(contentEstimate("12345"), { tokens: 2, images: 0, opaque: 0 });
  assert.deepEqual(contentEstimate([{ type: "image", data: "x".repeat(10000) }, { type: "thinking", thinking: "1234", thinkingSignature: "x".repeat(10000) }]), { tokens: 1, images: 1, opaque: 1 });
  assert.equal(contentEstimate({ type: "toolCall", name: "read", arguments: { path: "a" }, details: "x".repeat(10000) }).tokens, 4);
  assert.equal(contentEstimate({ type: "unrecognized", data: "secret" }).opaque, 1);
  assert.equal(contentEstimate({ ...call("signed"), thoughtSignature: "opaque-provider-data" }).opaque, 1);
  assert.equal(formatEstimate({ tokens: 0, images: 1, opaque: 0 }), "~0 tok + ?");
  assert.equal(inputTokens(usage), 40);
  assert.ok(usageText(usage).includes("request input: 40"));
  assert.ok(usageText(usage).includes("Response output: 5"));
  assert.equal(hasUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), false);
  assert.equal(hasUsage({ ...usage, input: NaN }), false);
});

test("pair by call ID/name, not adjacency; count branch totals and retained components independently", () => {
  const entries = [assistant("a", [call("x"), call("y", "bash", { command: "echo hi" })]),
    result("b", "y", "hello", { toolName: "bash" }), result("c", "x", "12345678"),
    assistant("d", [call("z")]), result("e", "orphan", "1234")];
  const before = JSON.stringify(entries);
  const profile = analyzeTools(entries, [entries[2], entries[3], entries[4]], "/project");
  assert.equal(JSON.stringify(entries), before, "analysis must not mutate session messages");
  const read = profile.tools.find((t) => t.name === "read")!;
  assert.equal(read.calls, 2);
  assert.equal(read.results, 2);
  assert.equal(read.orphanResults, 1);
  assert.equal(read.missingResults, 1);
  assert.equal(read.resultSize.tokens, 3);
  assert.equal(read.retained.tokens, 3 + contentEstimate(call("z")).tokens);
  assert.equal(profile.calls.find((c) => c.callId === "y")?.resultEntryId, "b");
  assert.equal(profile.tools.find((t) => t.name === "bash")?.retained.tokens, 0);
  assert.equal(read.requestInputMean, 40);
  assert.equal(read.requestInputSamples, 2);
  assert.equal(read.medianResult, 1.5);
  assert.equal(read.p95Result, 2);
});

test("compacted calls remain generated totals; retained totals use supplied projection, with unknown images", () => {
  const old = assistant("a", [call("x")]);
  const output = result("b", "x", "old", { content: [{ type: "image", mimeType: "image/png", data: "massive-base64" }], details: { uiOnly: "x".repeat(5000) } });
  const profile = analyzeTools([old, output], [], "/project");
  assert.equal(profile.tools[0].resultSize.tokens, 0);
  assert.equal(profile.tools[0].resultSize.images, 1);
  assert.deepEqual(profile.tools[0].retained, { tokens: 0, images: 0, opaque: 0 });
  assert.equal(profile.tools[0].calls, 1);
});

test("detect repeats, overlap, large-then-narrow reads, pagination and related success after error", () => {
  const entries = [
    assistant("a", [call("one", "read", { path: "./file.ts", offset: 1, limit: 1000 })]),
    result("b", "one", "x".repeat(9000), { isError: true, details: { truncation: { truncated: true } } }),
    assistant("c", [call("two", "read", { path: "file.ts", offset: 20, limit: 10 })]), result("d", "two"),
    assistant("e", [call("three", "read", { limit: 10, offset: 20, path: "file.ts" })]), result("f", "three"),
  ];
  const profile = analyzeTools(entries, entries, "/project");
  assert.ok(kinds(profile, "one").includes("Large result (>= ~2k)"));
  for (const kind of ["Repeated file read", "Overlapping requested ranges", "Large result then narrower read", "Pagination after truncation", "Success after related error"]) assert.ok(kinds(profile, "two").includes(kind), kind);
  assert.ok(kinds(profile, "three").includes("Repeated arguments"), "object key order should not defeat exact repeats");
  assert.equal(profile.tools[0].errors, 1);
});

test("parallel siblings are not interpreted as retries or completed prior reads", () => {
  const entries = [assistant("a", [call("one"), call("two")]), result("b", "one", "oops", { isError: true }), result("c", "two")];
  const profile = analyzeTools(entries, entries, "/project");
  assert.deepEqual(kinds(profile, "two"), ["Repeated arguments"]);
});

test("search refinement signals, non-overlapping ranges, and same-tool unrelated errors", () => {
  const entries = [assistant("a", [call("q1", "web_search", { query: "pi tool accuracy" })]), result("b", "q1", "text", { toolName: "web_search" }),
    assistant("c", [call("q2", "web_search", { query: "pi tool accuracy tokens" })]), result("d", "q2", "text", { toolName: "web_search" }),
    assistant("e", [call("r1", "read", { path: "a", offset: 1, limit: 10 })]), result("f", "r1", "error", { isError: true }),
    assistant("g", [call("r2", "read", { path: "a", offset: 11, limit: 10 })]), result("h", "r2"),
    assistant("i", [call("r3", "read", { path: "b" })]), result("j", "r3")];
  const profile = analyzeTools(entries, entries, "/project");
  assert.ok(kinds(profile, "q2").includes("Similar search query"));
  assert.ok(!kinds(profile, "r2").includes("Overlapping requested ranges"));
  assert.ok(!kinds(profile, "r3").includes("Success after related error"));
});

test("missing content is tolerated and unknown usage never becomes measured context", () => {
  const entries = [assistant("a", [], { content: null, usage: undefined }), result("b", "orphan", "", { content: null })];
  const profile = analyzeTools(entries, entries, "/project");
  assert.equal(profile.tools[0].resultSize.tokens, 0);
  assert.equal(profile.tools[0].requestInputMean, undefined);
  assert.ok(growthSnapshot(entries).sections[1].text.includes("unavailable"));
});

test("error followed by a refined search is a related success, not a measured accuracy score", () => {
  const entries = [assistant("a", [call("one", "web_search", { query: "pi extension tokens" })]), result("b", "one", "error", { toolName: "web_search", isError: true }),
    assistant("c", [call("two", "web_search", { query: "pi extension token counts" })]), result("d", "two", "answer", { toolName: "web_search" })];
  // Distinct word forms are not stemmed: this pair falls below the similarity threshold.
  assert.ok(!kinds(analyzeTools(entries, entries, "/project"), "two").includes("Success after related error"));
  const refined = assistant("c", [call("two", "web_search", { query: "pi extension tokens counts" })]);
  const related = [entries[0], entries[1], refined, entries[3]];
  assert.ok(kinds(analyzeTools(related, related, "/project"), "two").includes("Success after related error"));
});

test("duplicate IDs with different tools and repeated IDs are paired without overwriting calls", () => {
  const entries = [assistant("a", [call("id", "read"), call("id", "bash")]), result("b", "id", "bash", { toolName: "bash" }), result("c", "id", "read"),
    assistant("d", [call("id")]), result("e", "id", "new")];
  const profile = analyzeTools(entries, entries, "/project");
  assert.deepEqual(profile.calls.map((c) => c.resultEntryId), ["c", "b", "e"]);
});

test("tool snapshots expose ranking, groups, diagnostic drilldown and untrusted text without writes", () => {
  const entries = [assistant("a", [call("one")]), result("b", "one", "\x1b]52;malicious\x07")];
  const snapshot = toolSnapshot(entries, entries, "/project");
  assert.equal(snapshot.kind, "tools");
  const group = snapshot.sections.find((s) => s.id === "tool-stats:read")!;
  assert.equal(group.children?.length, 1);
  assert.ok(group.children![0].text.includes("malicious"));
  assert.equal(snapshot.sections.find((s) => s.id === "largest-results")?.children?.length, 1);
  assert.ok(snapshot.sections[0].text.includes("not accuracy scores"));
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  assert.ok(toolSnapshot([], [], "/project").sections[0].text.includes("No recorded tool"));
});

test("production tool highlights color error results, not successful result prose or arguments", () => {
  const entries = [assistant("a", [call("one")]), result("b", "one", "Tool error\nRepeated arguments", { isError: true }),
    assistant("c", [call("two")]), result("d", "two", "Tool error\nRepeated arguments"), assistant("e", [call("pending", "other")])];
  const snapshot = toolSnapshot(entries, entries, "/project");
  const group = snapshot.sections.find((s) => s.id === "tool-stats:read")!;
  assert.deepEqual(group.indicator, { text: "!", tone: "error" });
  const first = group.children![0];
  const highlights = first.highlights!.map((h) => ({ text: first.text.slice(h.start, h.end), tone: h.tone }));
  assert.equal(highlights.filter((h) => h.text === "Tool error").length, 1);
  assert.ok(highlights.some((h) => h.text === "Tool error" && h.tone === "error"));
  assert.ok(highlights.some((h) => h.text === "Tool error\nRepeated arguments" && h.tone === "error"));
  assert.deepEqual(first.titleHighlights, [{ start: 0, end: first.title.length, tone: "error" }]);
  const argumentStart = first.text.indexOf("Parameters:\n") + "Parameters:\n".length;
  const argumentEnd = first.text.indexOf("\n\n◀ TOOL RESULT", argumentStart);
  assert.ok(argumentEnd > argumentStart);
  assert.ok(first.highlights!.every((h) => h.end <= argumentStart || h.start >= argumentEnd));
  assert.ok(first.text.startsWith("▶ TOOL CALL"), "parameters precede statistics and diagnostics");
  const second = group.children![1];
  const resultStart = second.text.indexOf("Output:\n") + "Output:\n".length;
  const resultEnd = resultStart + "Tool error\nRepeated arguments".length;
  assert.ok(second.highlights!.every((h) => h.end <= resultStart || h.start >= resultEnd), "successful result text remains neutral even if it mentions errors");
  assert.equal(second.titleHighlights, undefined);
  assert.deepEqual(second.indicator, { text: "?", tone: "warning" });
  const missing = snapshot.sections.find((s) => s.id === "tool-stats:other")!;
  assert.deepEqual(missing.indicator, { text: "…", tone: "muted" });
  assert.deepEqual(missing.children![0].indicator, { text: "…", tone: "muted" });
  assert.equal(JSON.stringify(snapshot).includes("\\u001b"), false);
});

test("growth uses provider input including cache, not output; resets for missing usage, model changes, compaction", () => {
  const entries = [assistant("a"), result("b", "x", "12345678"),
    assistant("c", [], { usage: { ...usage, input: 50, output: 1000, cacheWrite: 5 } }),
    assistant("d", [], { model: "other" }),
    assistant("e", [], { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistant("f"),
    { type: "compaction", id: "compact", parentId: "f", timestamp, summary: "summary", firstKeptEntryId: "f", tokensBefore: 100 } as SessionEntry,
    assistant("g"), assistant("h", [], { usage: { ...usage, input: 10 } })];
  const snapshot = growthSnapshot(entries);
  assert.equal(snapshot.sections.length, 8);
  const growth = (id: string) => snapshot.sections.find((s) => s.id === `growth:${id}`)!;
  assert.equal((growth("c").raw as any).delta, 25);
  assert.equal((growth("c").raw as any).interveningToolResults.estimate.tokens, 2);
  assert.ok(growth("d").text.includes("not compared (Model changed)"));
  assert.ok(growth("e").text.includes("Missing/all-zero usage"));
  assert.ok(growth("f").text.includes("Previous response usage unavailable"));
  assert.ok(growth("g").text.includes("Compaction boundary"));
  assert.equal((growth("h").raw as any).delta, -20);
  assert.ok(growth("c").highlights?.some((h) => h.tone === "warning" && growth("c").text.slice(h.start, h.end) === "+25 tokens"));
  assert.ok(growth("h").titleHighlights?.some((h) => h.tone === "success"));
  assert.ok(growth("g").titleHighlights?.some((h) => h.tone === "dim"));
});
