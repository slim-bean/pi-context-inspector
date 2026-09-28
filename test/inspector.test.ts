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
  const reopened = new Inspector([snapshot, snapshot, snapshot], theme, kb, () => 30, () => {}, (value) => { action = value; });
  reopened.handleInput("2");
  assert.equal(reopened.state.tab, 1);
  reopened.handleInput("\x1b");
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

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[\d;]*m/g, "");
const numbered: Snapshot = { kind: "preview", title: "entries", description: "test", tailSectionId: "entry-39", sections: [
  ...Array.from({ length: 40 }, (_, i) => ({ id: `entry-${i}`, title: `Entry ${i}`, source: "session", status: "included" as const,
    text: Array.from({ length: 80 }, (_, n) => `entry ${i} line ${n + 1}`).join("\n"), raw: { index: i } })),
  { id: "omitted", title: "Summarized away", source: "history", status: "excluded", text: "not the tail", raw: {} },
] };

test("vim ends, half-pages and pane focus; gg prefix resets on intervening keys", () => {
  const inspector = new Inspector([numbered], theme, kb, () => 30, () => {}, () => {});
  inspector.render(130); // body = 19 rows
  inspector.handleInput("G"); assert.equal(inspector.state.sectionId, "omitted");
  inspector.handleInput("g"); assert.equal(inspector.state.sectionId, "omitted");
  inspector.handleInput("g"); assert.equal(inspector.state.sectionId, "entry-0");
  inspector.handleInput("\x04"); assert.equal(inspector.state.sectionId, "entry-9");
  inspector.handleInput("\x15"); assert.equal(inspector.state.sectionId, "entry-0");
  inspector.handleInput("g"); inspector.handleInput("j"); inspector.handleInput("g");
  assert.equal(inspector.state.sectionId, "entry-1");
  inspector.handleInput("l"); inspector.render(130);
  inspector.handleInput("G");
  assert.ok(plain(inspector.render(130)).includes("lines 62–80/80"));
  inspector.handleInput("gg");
  assert.ok(plain(inspector.render(130)).includes("lines 1–19/80"));
  inspector.handleInput("\x04");
  assert.ok(plain(inspector.render(130)).includes("lines 10–28/80"));
  inspector.handleInput("\x15");
  assert.ok(plain(inspector.render(130)).includes("lines 1–19/80"));
  inspector.handleInput("h"); inspector.handleInput("j");
  assert.equal(inspector.state.sectionId, "entry-2");
  inspector.handleInput("/");
  for (const char of "ggGFhl") inspector.handleInput(char);
  assert.equal(inspector.state.query, "ggGFhl", "navigation keys are literal in search");
});

test("live updates preserve selection, scroll, raw view and search; invalidate same-ID content", () => {
  const inspector = new Inspector([numbered], theme, kb, () => 30, () => {}, () => {});
  inspector.render(130);
  inspector.handleInput("l"); inspector.handleInput("\x04");
  const updated = { ...numbered, sections: numbered.sections.map((s) => ({ ...s, text: s.text.replaceAll("entry 0", "UPDATED") })) };
  inspector.updateSnapshots([updated]);
  const output = plain(inspector.render(130));
  assert.equal(inspector.state.sectionId, "entry-0");
  assert.ok(output.includes("UPDATED line 10"));
  assert.ok(output.includes("lines 10–28/80"));
  inspector.handleInput("r");
  inspector.updateSnapshots([{ ...updated, sections: updated.sections.map((s) => ({ ...s, raw: { fresh: true } })) }]);
  assert.ok(plain(inspector.render(130)).includes('"fresh": true'));
  inspector.handleInput("/");
  for (const char of "Entry 3") inspector.handleInput(char);
  inspector.render(130);
  inspector.updateSnapshots([updated]);
  inspector.handleInput("9"); // still searching after refresh
  inspector.render(130);
  assert.equal(inspector.state.query, "Entry 39");
  assert.equal(inspector.state.sectionId, "entry-39");
  inspector.handleInput("\r");
  inspector.updateSnapshots([{ ...updated, sections: [] }]);
  assert.ok(plain(inspector.render(130)).includes("No matching sections"));
  assert.equal(inspector.state.sectionId, undefined);
});

test("F follows latest Preview entry, not appendices; navigation pauses without stopping updates", () => {
  const inspector = new Inspector([numbered, snapshot], theme, kb, () => 30, () => {}, () => {}, { tab: 1, query: "none", sorted: true });
  inspector.render(130);
  inspector.handleInput("F");
  assert.ok(plain(inspector.render(130)).includes("FOLLOW"));
  assert.equal(inspector.state.tab, 0);
  assert.equal(inspector.state.query, "");
  assert.equal(inspector.state.sorted, false);
  assert.equal(inspector.state.sectionId, "entry-39");
  const next = { ...numbered, tailSectionId: "new", sections: [...numbered.sections.slice(0, -1),
    { ...numbered.sections[0], id: "new", text: "NEW ENTRY", raw: {} }, numbered.sections.at(-1)!] };
  inspector.updateSnapshots([next, snapshot]);
  for (const width of [130, 70, 10, 1]) {
    const lines = inspector.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.equal(inspector.state.sectionId, "new");
  }
  inspector.handleInput("k");
  assert.equal(inspector.state.following, false);
  inspector.updateSnapshots([numbered, snapshot]);
  inspector.render(130);
  assert.equal(inspector.state.sectionId, "entry-0", "removed selection falls back safely");
  inspector.handleInput("F"); inspector.render(130);
  inspector.handleInput("F");
  assert.equal(inspector.state.following, false);
  inspector.handleInput("F"); inspector.render(130);
  inspector.handleInput("2");
  assert.equal(inspector.state.following, false);
});

test("section title stays pinned in the content pane while scrolling in narrow and wide layouts", () => {
  const view: Snapshot = { ...numbered, sections: [{ ...numbered.sections[0], title: "Result · read" }] };
  const inspector = new Inspector([view], theme, kb, () => 30, () => {}, () => {});
  inspector.handleInput("l");
  for (const width of [130, 70]) {
    inspector.render(width); inspector.handleInput("G");
    const lines = inspector.render(width);
    assert.ok(plain([lines[4]]).includes("Result · read"));
    assert.ok(plain(lines).includes("entry 0 line 80"));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("live timer and manual refresh stop on close, action or host disposal", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const exit of ["q", "y", "x", "e", "u", "dispose"]) {
    let revision = 0;
    let reads = 0;
    const inspector = new Inspector([snapshot], theme, kb, () => 30, () => {}, () => {}, { sectionId: "compact" }, {
      revision: () => String(revision), read: () => { reads++; return [snapshot]; }, onError: (e) => { throw e; },
    });
    inspector.render(130);
    inspector.handleInput("f");
    assert.equal(reads, 1);
    revision++;
    t.mock.timers.tick(250);
    assert.equal(reads, 2);
    if (exit === "dispose") inspector.dispose(); else inspector.handleInput(exit);
    revision++;
    t.mock.timers.tick(1000);
    inspector.handleInput("f");
    assert.equal(reads, 2, exit);
  }
});

test("diff review can save or cancel, with bounded lines", () => {
  let saved: boolean | undefined;
  const review = new Review("-old\n+new\n日本語".repeat(50), theme, kb, () => 24, () => {}, (value) => { saved = value; });
  assert.ok(review.render(60).every((line) => visibleWidth(line) <= 60));
  review.handleInput("\r"); assert.equal(saved, true);
  review.handleInput("\x1b"); assert.equal(saved, false);
});
