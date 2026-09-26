import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { Inspector, terminalText, type InspectorAction } from "../src/inspector.ts";
import { Review } from "../src/review.ts";
import type { Snapshot } from "../src/snapshots.ts";

const theme = {
  fg: (_: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  bg: (_: string, text: string) => text,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
} as Theme;
const kb = { matches: (data: string, id: string) => {
  const keys: Record<string, string> = { "tui.select.up": "up", "tui.select.down": "down", "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown", "tui.select.confirm": "enter", "tui.select.cancel": "escape" };
  return keys[id] ? matchesKey(data, keys[id] as any) : false;
} } as KeybindingsManager;
const snapshot: Snapshot = { kind: "preview", title: "test", description: "test preview", sections: [
  { id: "system", title: "System instructions", source: "system", status: "included", text: "long 日本語 text ".repeat(1000), raw: { text: "system" } },
  { id: "compact", title: "Compaction summary", source: "compact", status: "included", text: "find-this-needle", raw: { summary: "find-this-needle" }, editableEntryId: "compact" },
] };

test("overlay lines fit narrow, wide, tiny, resized and Unicode terminals", () => {
  let rows = 38;
  const inspector = new Inspector([snapshot, snapshot, snapshot], theme, kb, () => rows, () => {}, () => {});
  for (const width of [130, 100, 80, 40, 10, 2, 1]) {
    const lines = inspector.render(width);
    assert.ok(lines.length <= rows - 2);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `Overflow at width ${width}: ${visibleWidth(line)}`);
    inspector.invalidate();
  }
  for (const height of [4, 8, 15, 50]) {
    rows = height;
    assert.ok(inspector.render(80).length <= Math.max(1, height - 2));
  }
});

test("full-text search finds a section and editing returns the entry ID", () => {
  let action: InspectorAction | undefined;
  const inspector = new Inspector([snapshot, snapshot, snapshot], theme, kb, () => 30, () => {}, (value) => { action = value; });
  inspector.focused = true;
  inspector.render(120);
  inspector.handleInput("/");
  for (const char of "needle") inspector.handleInput(char);
  inspector.render(120);
  inspector.handleInput("\r");
  inspector.handleInput("e");
  assert.equal(action?.kind, "edit");
  assert.equal(action?.section?.editableEntryId, "compact");
});

test("content scrolling, raw toggle, copy, tab switching, and close", () => {
  let action: InspectorAction | undefined;
  const inspector = new Inspector([snapshot, snapshot, snapshot], theme, kb, () => 30, () => {}, (value) => { action = value; });
  inspector.render(120);
  inspector.handleInput("\t");
  inspector.handleInput("\x1b[6~");
  assert.ok(inspector.render(120).some((line) => /lines 2[0-9]/.test(line)));
  inspector.handleInput("r");
  inspector.handleInput("y");
  assert.equal(action?.kind, "copy");
  assert.equal(action?.state.raw, true);
  inspector.handleInput("2");
  assert.equal(inspector.state.tab, 1);
  inspector.handleInput("\x1b");
  assert.equal(action?.kind, "close");
});

test("size sorting, tool drilldown/back navigation and nested search preserve refresh state", () => {
  const tools: Snapshot = { kind: "tools", title: "Tools", description: "Local analysis", sections: [
    { id: "overview", title: "Overview", status: "reference", source: "local", text: "Overview", raw: {} },
    { id: "group", title: "Tool stats · read", status: "reference", source: "local", text: "Tool group", raw: {}, sortTokens: 500, children: [
      { id: "small", title: "small read", status: "reference", source: "call", text: "small", raw: {}, estimate: { tokens: 10, images: 0, opaque: 0 }, sortTokens: 10 },
      { id: "large", title: "large 日本語 read", status: "reference", source: "call", text: "nested-needle\x1b]52;evil\x07", raw: {}, estimate: { tokens: 10000, images: 1, opaque: 0 }, sortTokens: 10000 },
    ] },
  ] };
  let action: InspectorAction | undefined;
  const views = [snapshot, snapshot, snapshot, tools, { ...tools, kind: "growth" as const }];
  const inspector = new Inspector(views, theme, kb, () => 30, () => {}, (value) => { action = value; });
  inspector.render(130);
  inspector.handleInput("4"); inspector.render(130);
  inspector.handleInput("s"); inspector.render(130);
  assert.equal(inspector.state.sectionId, "group");
  inspector.handleInput("\r"); inspector.render(130);
  assert.equal(inspector.state.drillId, "group");
  assert.equal(inspector.state.sectionId, "large");
  inspector.handleInput("f");
  assert.equal(action?.state.sorted, true);
  assert.equal(action?.state.drillId, "group");
  const reopened = new Inspector(views, theme, kb, () => 30, () => {}, () => {}, action!.state);
  assert.ok(reopened.render(130).some((line) => line.includes("nested-needle")));
  assert.ok(reopened.render(130).every((line) => !line.includes("\x1b]52")));
  reopened.handleInput("\x7f"); reopened.render(130);
  assert.equal(reopened.state.drillId, undefined);
  assert.equal(reopened.state.sectionId, "group");
  reopened.handleInput("/");
  for (const char of "nested-needle") reopened.handleInput(char);
  reopened.render(130);
  assert.equal(reopened.state.sectionId, "large");
  reopened.handleInput("\r");
  for (const width of [140, 90, 45, 10, 1]) {
    assert.ok(reopened.render(width).every((line) => visibleWidth(line) <= width));
    reopened.invalidate();
  }
  reopened.handleInput("5"); reopened.render(130);
  assert.equal(reopened.state.query, "");
  assert.equal(reopened.state.tab, 4);
});

test("hostile control sequences are shown literally, not executed", () => {
  const output = terminalText("before\x1b]52;c;CLIPBOARD\x07after\r\n\tend");
  assert.equal(output.includes("\x1b"), false);
  assert.equal(output.includes("\x07"), false);
  assert.ok(output.includes("\\x1b]52;c;CLIPBOARD\\x07"));
});

test("untrusted titles, sources and descriptions cannot inject terminal rows", () => {
  const view: Snapshot = { kind: "tools", title: "tools", description: "bad\nheader\x1b]52;evil\x07", sections: [
    { id: "call", title: "tool\nname", status: "reference", source: "bad\nsource", text: "safe\ncontent", raw: {} },
  ] };
  const inspector = new Inspector([view], theme, kb, () => 30, () => {}, () => {});
  const lines = inspector.render(130);
  assert.ok(lines.every((line) => !line.includes("\n") && !line.includes("\x1b]52")));
  assert.ok(lines.some((line) => line.includes("tool\\nname")));
  assert.ok(lines.some((line) => line.includes("bad\\nsource")));
});

test("diff review can save or cancel, with bounded lines", () => {
  let saved: boolean | undefined;
  const review = new Review("-old\n+new\n日本語".repeat(50), theme, kb, () => 24, () => {}, (value) => { saved = value; });
  assert.ok(review.render(60).every((line) => visibleWidth(line) <= 60));
  review.handleInput("\r"); assert.equal(saved, true);
  review.handleInput("\x1b"); assert.equal(saved, false);
});
