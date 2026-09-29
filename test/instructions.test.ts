import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSkillsForPrompt, type Skill, type ExtensionAPI, type ExtensionCommandContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { analyzeInstructions, capturedInstructions, RecordedInstructions, type InstructionPart } from "../src/instructions.ts";
import { buildPreview, diffSnapshot, requestSnapshot, RequestHistory } from "../src/snapshots.ts";
import { growthSnapshot } from "../src/profiler.ts";
import { textEstimate } from "../src/metrics.ts";
import { usage } from "./fixtures.ts";

const skills = [
  { name: "short", description: "Read a file & inspect <tags>.", filePath: "/skills/short/SKILL.md", disableModelInvocation: false },
  { name: "large", description: "A detailed workflow. ".repeat(50), filePath: "/skills/large/SKILL.md", disableModelInvocation: false },
  { name: "hidden", description: "NOT SENT", filePath: "/skills/hidden/SKILL.md", disableModelInvocation: true },
] as Skill[];
const catalog = formatSkillsForPrompt(skills);
const project = '<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\nProject rules\n</project_instructions>\n</project_context>';
const structured = `Base preamble\n\n<tools>\nread: Read files\n</tools>\n\n<rules>\n- Be careful\n</rules>\n\n<docs>\nDocumentation routing\n</docs>\n\n<addendum>\nUser additions\n</addendum>\n\n${project}\n\n<skills>\n${catalog.trim()}\n</skills>\n\n<cwd>\n/repo\n</cwd>`;

function checkPartition(text: string, parts: InstructionPart[]): void {
  let cursor = 0;
  for (const p of parts) {
    assert.equal(p.start, cursor);
    assert.equal(p.text, text.slice(p.start, p.end));
    assert.ok(p.estimate.tokens >= 0);
    if (p.children) {
      assert.equal(p.children.map((c) => c.text).join(""), p.text);
      assert.equal(p.children.reduce((n, c) => n + c.estimate.tokens, 0), p.estimate.tokens);
    }
    cursor = p.end;
  }
  assert.equal(cursor, text.length);
}

test("skill catalog has per-skill description/name/path/framing costs without inflating the system total", () => {
  for (const text of [structured, `Base${catalog}\nCurrent working directory: /repo`, "", "日本語🦜abc"]) {
    const p = analyzeInstructions(text);
    checkPartition(text, p.parts);
    assert.equal(p.tokens, textEstimate(text).tokens);
    assert.equal(p.parts.reduce((sum, s) => sum + s.estimate.tokens, 0), p.tokens);
    assert.equal(Object.values(p.categories).reduce((sum, s) => sum + s.tokens, 0), p.tokens);
    assert.equal(Object.values(p.categories).reduce((sum, s) => sum + s.characters, 0), text.length);
  }
  const profile = analyzeInstructions(structured);
  assert.equal(profile.skills.length, 2);
  assert.equal(profile.skills[0].name, "short");
  assert.equal(profile.skills[0].path, skills[0].filePath);
  assert.equal(profile.skills[0].descriptionCharacters, "Read a file &amp; inspect &lt;tags&gt;.".length, "measure serialized prompt text, not unescaped metadata");
  assert.ok(profile.skills[1].tokens > profile.skills[0].tokens);
  for (const s of profile.skills) assert.equal(s.tokens, s.descriptionTokens + s.nameTokens + s.pathTokens + s.framingTokens);
  assert.ok(profile.categories["Project instructions"].tokens > 0);
  assert.ok(profile.categories["Tool guidance / snippets"].tokens > 0);
  assert.ok(profile.categories["Appended instructions"].tokens > 0);
  assert.ok(profile.parts.find((p) => p.label === "Project instructions")?.children?.some((p) => p.source === "/repo/AGENTS.md"));
});

test("configured-but-absent skills/files aren't counted; nested examples and malformed catalogs stay conservative", () => {
  const absent = analyzeInstructions("Forced replacement", "test", { skills, contextFiles: [{ path: "AGENTS.md", content: "NOT PRESENT" }], appendSystemPrompt: "NOT PRESENT" });
  assert.equal(absent.skills.length, 0);
  assert.deepEqual(Object.keys(absent.categories), ["Base / other instructions"]);
  const custom = analyzeInstructions("Custom instructions\n\nAddendum", "test", { customPrompt: "Custom instructions", appendSystemPrompt: "Addendum" });
  assert.ok(custom.categories["Custom system instructions"].tokens > 0);
  assert.ok(custom.categories["Appended instructions"].tokens > 0);
  const nested = `<project_context>\n<project_instructions path="AGENTS.md">\nExample:${catalog}\n</project_instructions>\n</project_context>`;
  const p = analyzeInstructions(nested);
  assert.equal(p.skills.length, 0, "don't reclassify instruction-file examples as advertised skills");
  const malformed = catalog.replace("<description>", "<oops>");
  const bad = analyzeInstructions(malformed);
  assert.equal(bad.skills.length, 1);
  assert.equal(Object.values(bad.categories).reduce((n, s) => n + s.tokens, 0), bad.tokens);
});

test("Preview categories partition the system root; reference itemization doesn't add tokens", () => {
  const systemEntry = { id: "recorded-system", type: "message", message: { role: "system", content: structured } };
  const ctx = { getSystemPrompt: () => structured, getSystemPromptOptions: () => ({ skills }), getContextUsage: () => undefined,
    sessionManager: { getBranch: () => [systemEntry], buildContextEntries: () => [systemEntry] } } as unknown as ExtensionCommandContext;
  const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
  const preview = buildPreview(ctx, pi);
  const raw = preview.sections[0].raw as any;
  assert.equal(raw.estimate.tokens, textEstimate(structured).tokens);
  assert.equal(preview.sections.reduce((n, s) => n + (s.estimate?.tokens ?? 0), 0), raw.estimate.tokens);
  assert.ok(raw.categories["Skill descriptions"].tokens > 0);
  const detail = preview.sections.find((s) => s.id === "instruction-breakdown")!;
  assert.equal(detail.status, "reference");
  assert.equal(detail.estimate, undefined);
  assert.equal(preview.sections.find((s) => s.id === "recorded-system")?.status, "reference");
  assert.equal(preview.sections.find((s) => s.id === "recorded-system")?.estimate, undefined);
  assert.ok(detail.text.includes("description ~"));
  assert.ok(detail.children?.find((c) => c.title === "Skill catalog")?.children?.some((c) => c.title === "Skill · large"));
});

test("capture attribution reads only instruction fields and Changes compares actual captures", () => {
  const representations = [
    { system: structured }, { system: [{ type: "text", text: structured }, { type: "image", data: "do not count" }] },
    { instructions: structured }, { messages: [{ role: "developer", content: structured }, { role: "user", content: catalog }] },
    { input: [{ role: "system", content: [{ type: "input_text", text: structured }] }] },
    { systemInstruction: { parts: [{ text: structured }] } },
  ];
  for (const payload of representations) {
    const before = JSON.stringify(payload);
    const p = capturedInstructions(payload)!;
    assert.equal(p.skills.length, 2);
    assert.equal(p.tokens, textEstimate(structured).tokens);
    assert.equal(JSON.stringify(payload), before);
  }
  assert.equal(capturedInstructions({ messages: [{ role: "user", content: catalog }] }), undefined);
  assert.equal(capturedInstructions({ unknownSystem: catalog }), undefined);
  const history = new RequestHistory();
  const meta = { capturedAt: "test", sessionId: "test", leafId: null, model: "test/model" };
  history.record({ system: "No skills" }, meta);
  history.record({ system: structured }, meta);
  const request = requestSnapshot(history).sections.find((s) => s.id === "request-instructions")!;
  assert.ok(request.text.includes("2 advertised skill entries"));
  const change = diffSnapshot(history).sections.find((s) => s.id === "instruction-delta")!;
  assert.ok(change.text.includes("Skill descriptions: ~0 →"));
  assert.ok(change.text.includes("large · /skills/large/SKILL.md"));
  assert.equal(JSON.stringify(request).includes("\\u001b"), false);
});

test("historical instruction accounting replays patches and never assigns current skills to older responses", () => {
  const replay = new RecordedInstructions();
  assert.equal(Boolean(replay.profile), false);
  replay.observe({ role: "system", content: "", sections: { preamble: "base", skills: `<skills>\n${catalog.trim()}\n</skills>` } });
  assert.equal(replay.profile?.skills.length, 2);
  replay.observe({ role: "system", content: "", sections: { rules: "<rules>\nNew rules\n</rules>" } });
  assert.equal(replay.profile?.skills.length, 2);
  replay.observe({ role: "system", content: "", sections: { skills: null } });
  assert.equal(replay.profile?.skills.length, 0);
  const beforeTools = replay.profile!.tokens;
  replay.observe({ role: "system", content: "", toolsAdded: [{ name: "another-tool" }] });
  assert.equal(replay.profile!.tokens, beforeTools, "tool-only system entries do not erase the prompt");
  replay.observe({ role: "system", content: [{ type: "text", text: "Additional instructions" }] });
  assert.ok(replay.profile!.tokens > beforeTools);
  assert.ok(replay.profile!.categories["Behavior guidelines"].tokens > 0, "content appends instead of replacing sections");
  const response = (id: string) => ({ id, type: "message", message: { role: "assistant", content: [], provider: "fixture", model: "test", usage } });
  const branch = [response("before"), { id: "s", type: "message", message: { role: "system", content: structured } }, response("after") ] as unknown as SessionEntry[];
  const growth = growthSnapshot(branch);
  assert.equal((growth.sections.find((s) => s.id === "growth:before")!.raw as any).instructionCosts, undefined);
  assert.equal((growth.sections.find((s) => s.id === "growth:after")!.raw as any).instructionCosts.skillCount, 2);
});
