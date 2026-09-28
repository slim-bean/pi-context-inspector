import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeybindingsManager, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { Inspector, type InspectorAction } from "../src/inspector.ts";
import { deltaTone, joinRich, paint, rich, shareBar, tokenTone, toned } from "../src/presentation.ts";
import type { Snapshot } from "../src/snapshots.ts";
import { toolSnapshot } from "../src/profiler.ts";
import { EDIT_ERROR, fixtureEntries } from "./fixtures.ts";

const colors: Record<string, number> = { accent: 36, warning: 33, error: 31, success: 32, dim: 90, muted: 37, border: 34 };
const theme = {
  fg: (tone: string, text: string) => `\x1b[${colors[tone] ?? 35}m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;
const kb = { matches: (data: string, id: string) => id === "tui.select.confirm" && matchesKey(data, "enter") } as KeybindingsManager;
const strip = (text: string) => text.replace(/\x1b\[[\d;]*m/g, "");

test("semantic spans compose exact offsets; colors are applied after escaping untrusted data", () => {
  const body = rich`Heading\n${toned("2 errors", "error")}\n${joinRich([toned("Repeated arguments", "warning"), rich`related: evil\x1b]52;x\x07`])}\nResult:\nTool error\n~999 tok`;
  assert.equal(body.text.includes("\x1b[31m"), false);
  const rendered = paint(body.text, body.highlights, theme);
  assert.ok(rendered.includes("\x1b[31m2 errors\x1b[39m"));
  assert.ok(rendered.includes("\x1b[33mRepeated arguments\x1b[39m"));
  assert.ok(rendered.includes("related: evil\\x1b]52;x\\x07"));
  assert.ok(rendered.endsWith("Result:\nTool error\n~999 tok"), "raw result content must not acquire diagnostic colors");
  const multiline = toned("one\ntwo", "error");
  assert.equal(paint(multiline.text, multiline.highlights, theme), "\x1b[31mone\x1b[39m\n\x1b[31mtwo\x1b[39m");
  assert.equal(strip(paint("a\nb\x1b", [], theme, true)), "a\\nb\\x1b");
});

test("size and delta colors do not classify zero, unknown or reductions as errors", () => {
  assert.equal(tokenTone(0, 0), "accent");
  assert.equal(tokenTone(49, 100), "accent");
  assert.equal(tokenTone(50, 100), "warning");
  assert.equal(tokenTone(100, 100), "warning");
  assert.deepEqual([undefined, 0, 5, -5].map(deltaTone), ["dim", "dim", "warning", "success"]);
});

test("bars are proportional, bounded, empty for zero totals, and plain in snapshots", () => {
  assert.equal(shareBar(25, 100, "accent").text, "███░░░░░░░░░");
  assert.equal(shareBar(0, 0, "accent").text, "░".repeat(12));
  assert.equal(shareBar(200, 100, "accent").text, "█".repeat(12));
  assert.equal(shareBar(-1, 100, "accent").text, "░".repeat(12));
  const bar = shareBar(50, 100, "accent");
  assert.equal(visibleWidth(paint(bar.text, bar.highlights, theme)), 12);
  assert.equal(JSON.stringify(bar).includes("\\u001b"), false);
});

test("selected rows retain semantic colors; colored content wraps and invalidates with the theme", () => {
  let palette = 0;
  const changingTheme = {
    ...theme,
    fg: (tone: string, text: string) => `\x1b[${(colors[tone] ?? 35) + palette}m${text}\x1b[39m`,
  } as Theme;
  const body = rich`${toned("Tool error", "error")}\n${shareBar(50, 100, "accent")} 50% 日本語\n${toned("Long diagnostic 日本語 ".repeat(40), "warning")}\nNeutral result\n`;
  const snapshot: Snapshot = { kind: "tools", title: "Tools", description: "test", sections: [
    { id: "call", title: "read", source: "reference", status: "reference", raw: { errors: 1 }, ...body,
      estimate: { tokens: 500, images: 1, opaque: 0 }, indicator: { text: "!", tone: "error" } },
    { id: "small", title: "small", source: "reference", status: "included", text: "small", raw: {}, estimate: { tokens: 10, images: 0, opaque: 0 } },
    { id: "excluded", title: "excluded", source: "reference", status: "excluded", text: "excluded", raw: {} },
  ] };
  let action: InspectorAction | undefined;
  let inspector = new Inspector([snapshot], changingTheme, kb, () => 38, () => {}, (value) => { action = value; });
  const first = inspector.render(140).join("\n");
  assert.ok(first.includes("\x1b[31m!\x1b[39m"));
  assert.ok(first.includes("\x1b[33m~500 tok + ?\x1b[39m"));
  assert.ok(first.includes("\x1b[36m~10 tok\x1b[39m"));
  assert.ok(first.includes("\x1b[32m+\x1b[39m"));
  assert.ok(first.includes("\x1b[37m−\x1b[39m"));
  assert.ok(first.includes("\x1b[90m·\x1b[39m"));
  assert.ok(first.includes("\x1b[31mTool error\x1b[39m"));
  inspector.handleInput("y");
  assert.equal(action?.section?.text, body.text);
  assert.equal(action?.section?.text.includes("\x1b"), false);
  inspector = new Inspector([snapshot], changingTheme, kb, () => 38, () => {}, () => {}, action!.state);
  palette = 60;
  inspector.invalidate();
  const updated = inspector.render(140).join("\n");
  assert.ok(updated.includes("\x1b[91mTool error\x1b[39m"));
  assert.ok(!updated.includes("\x1b[31m"), "stale theme colors must be discarded");
  inspector.handleInput("\t");
  for (const width of [140, 100, 70, 30, 10, 2, 1]) {
    assert.ok(inspector.render(width).every((line) => visibleWidth(line) <= width), `width ${width}`);
    inspector.invalidate();
  }
  inspector.handleInput("r");
  const raw = inspector.render(140).join("\n");
  assert.ok(strip(raw).includes('"errors": 1'));
  assert.ok(!raw.includes("\x1b[91mTool error"), "raw JSON has no semantic content styles");
  inspector.handleInput("/");
  for (const char of "small") inspector.handleInput(char);
  inspector.handleInput("\r");
  assert.ok(inspector.render(140).join("\n").includes("\x1b[96m~10 tok\x1b[39m"), "filtering must not promote a small badge to warning color");
});

test("failed edit result renders red, wraps safely, and stays plain in raw/copy data", () => {
  const entries = fixtureEntries("/project", true).slice(1) as SessionEntry[];
  const view = toolSnapshot(entries, entries, "/project");
  const group = view.sections.find((s) => s.id === "tool-stats:edit")!;
  const section = group.children![0];
  const painted = paint(section.text, section.highlights!, theme);
  assert.ok(painted.includes(`\x1b[31m${EDIT_ERROR}\x1b[39m`));
  assert.equal(strip(painted), section.text);
  const inspector = new Inspector([view], theme, kb, () => 50, () => {}, () => {}, { drillId: group.id });
  assert.ok(inspector.render(180).join("\n").includes(`\x1b[31m${section.title}\x1b[39m`));
  inspector.handleInput("l");
  for (const width of [180, 100, 70, 30, 10, 1]) {
    assert.ok(inspector.render(width).every((line) => visibleWidth(line) <= width));
  }
  inspector.handleInput("r"); inspector.render(180);
  inspector.handleInput("G");
  const raw = inspector.render(180).join("\n");
  assert.ok(strip(raw).includes('"isError": true'));
  assert.ok(!raw.includes("\x1b[31mCould not find"), "raw content has no error styling");
  let action: InspectorAction | undefined;
  const copy = new Inspector([view], theme, kb, () => 50, () => {}, (value) => { action = value; }, { drillId: group.id });
  copy.render(180); copy.handleInput("y");
  assert.ok(action?.section?.text.includes(EDIT_ERROR));
  assert.equal(action?.section?.text.includes("\x1b"), false);
  const hostile = toned("failure\n日本語\x1b]52;c;bad\x07", "error");
  const safe = paint(hostile.text, hostile.highlights, theme);
  assert.ok(safe.includes("\x1b[31m日本語\\x1b]52;c;bad\\x07\x1b[39m"));
  assert.equal(safe.includes("\x1b]52"), false);
});

test("growth colors survive selection and filtering while text remains searchable", () => {
  const title = rich`input 100 · ${toned("Δ +40", "warning")}`;
  const view: Snapshot = { kind: "growth", title: "growth", description: "", sections: [
    { id: "row", title: title.text, titleHighlights: title.highlights, source: "usage", status: "reference", text: "response", raw: {} },
  ] };
  const inspector = new Inspector([view], theme, kb, () => 30, () => {}, () => {});
  assert.ok(inspector.render(140).join("\n").includes("\x1b[33mΔ +40\x1b[39m"));
  inspector.handleInput("/");
  for (const char of "+40") inspector.handleInput(char);
  inspector.handleInput("\r");
  assert.ok(inspector.render(140).join("\n").includes("\x1b[33mΔ +40\x1b[39m"));
});
