import { object, textEstimate, textSliceEstimate, type TokenEstimate } from "./metrics.ts";

export interface InstructionPart {
  id: string;
  label: string;
  source: string;
  start: number;
  end: number;
  text: string;
  estimate: TokenEstimate;
  children?: InstructionPart[];
}
export interface SkillCost {
  name: string;
  path: string;
  source: string;
  characters: number;
  tokens: number;
  descriptionCharacters: number;
  descriptionTokens: number;
  nameTokens: number;
  pathTokens: number;
  framingTokens: number;
}
export interface InstructionProfile {
  characters: number;
  tokens: number;
  categories: Record<string, { characters: number; tokens: number }>;
  skills: SkillCost[];
  parts: InstructionPart[];
}
export const INSTRUCTION_NOTE = "Visible instruction text only; ~tokens use characters / 4, not provider billing. Slices allocate the original rounded text estimate (a slice can differ by one token from rounding independently). Parent/child views overlap: never add them together. Labels come from recognized prompt structure or exact supplied source matches, not file reads. Unknown text stays in Base / other instructions. Skill catalogs advertise names/descriptions/paths; full skills loaded later remain conversation/tool-result content.";

const labels: Record<string, string> = {
  tools: "Tool guidance / snippets", rules: "Behavior guidelines", docs: "Pi documentation guidance",
  addendum: "Appended instructions", cwd: "Environment / cwd", project_context: "Project instructions",
  skills: "Skill catalog", available_skills: "Skill catalog",
};
const decode = (s: string) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[name]!);
const intro = "The following skills provide specialized instructions for specific tasks.";

/** Pure partition of actual prompt text. Metadata is a matching hint, never proof of inclusion. */
export function analyzeInstructions(text: string, source = "system prompt", options?: unknown): InstructionProfile {
  const profile: InstructionProfile = { characters: text.length, tokens: textEstimate(text).tokens, categories: {}, skills: [], parts: [] };
  const opts = object(options);
  const add = (category: string, start: number, end: number) => {
    const value = profile.categories[category] ??= { characters: 0, tokens: 0 };
    value.characters += end - start;
    value.tokens += textSliceEstimate(start, end).tokens;
  };
  const part = (start: number, end: number, label: string, origin = source): InstructionPart => ({
    id: `${source}:${start}:${end}`, label, source: origin, start, end, text: text.slice(start, end), estimate: textSliceEstimate(start, end),
  });
  const regions: { start: number; end: number; kind: string }[] = [];
  const reserve = (start: number, end: number, kind: string) => {
    if (end <= start || regions.some((r) => r.start < end && start < r.end)) return;
    regions.push({ start, end, kind });
  };
  // Consume outer blocks before looking inside them: examples in instruction files must
  // not become a second skill catalog. Unknown custom section names require metadata.
  const names = [...new Set([...Object.keys(labels), ...Object.keys(object(opts.sections)).filter((s) => /^[a-z][a-z0-9_-]*$/.test(s))])];
  const blocks = new RegExp(`^<(${names.join("|")})>\\r?\\n[\\s\\S]*?^<\\/\\1>`, "gm");
  for (const match of text.matchAll(blocks)) {
    let start = match.index!;
    if (match[1] === "available_skills") {
      const preceding = text.slice(Math.max(0, start - 800), start);
      const at = preceding.lastIndexOf(intro);
      // Legacy Pi put routing guidance immediately before the catalog, without <skills>.
      if (at >= 0 && !preceding.slice(at).includes("<") && preceding.slice(at).split("\n").length <= 6) start -= preceding.length - at;
    }
    reserve(start, match.index! + match[0].length, match[1]);
  }
  // Exact, unambiguous source text on older Pi; never count merely configured sources.
  for (const [field, kind] of [["customPrompt", "custom"], ["appendSystemPrompt", "addendum"]]) {
    const value = opts[field];
    if (typeof value !== "string" || !value || text.indexOf(value) !== text.lastIndexOf(value)) continue;
    const at = text.indexOf(value);
    if (at >= 0) reserve(at, at + value.length, kind);
  }
  for (const [pattern, kind] of [
    [/^Available tools:\n[\s\S]*?(?=\n\n|$)/gm, "tools"],
    [/^Guidelines:\n[\s\S]*?(?=\n\n|$)/gm, "rules"],
    [/^Pi documentation \(read only[^\n]*\n[\s\S]*?(?=\n\n|$)/gm, "docs"],
    [/^Current working directory: [^\n]*$/gm, "cwd"],
  ] as const) for (const match of text.matchAll(pattern)) reserve(match.index!, match.index! + match[0].length, kind);

  regions.sort((a, b) => a.start - b.start);
  let cursor = 0;
  const gaps: typeof regions = [];
  for (const r of regions) { if (cursor < r.start) gaps.push({ start: cursor, end: r.start, kind: "other" }); cursor = r.end; }
  if (cursor < text.length) gaps.push({ start: cursor, end: text.length, kind: "other" });
  regions.push(...gaps); regions.sort((a, b) => a.start - b.start);

  for (const r of regions) {
    const category = labels[r.kind] ?? (r.kind === "custom" ? "Custom system instructions" : r.kind === "other" ? "Base / other instructions" : `Section · ${r.kind}`);
    const parent = part(r.start, r.end, category);
    profile.parts.push(parent);
    if (category === "Skill catalog") {
      const children: InstructionPart[] = [];
      let childCursor = r.start;
      const skillPattern = /^  <skill>\r?\n([\s\S]*?)^  <\/skill>/gm;
      for (const m of parent.text.matchAll(skillPattern)) {
        const start = r.start + m.index!, end = start + m[0].length;
        const field = (tag: string) => {
          const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(m[0]);
          if (!match) return undefined;
          const offset = start + match.index + tag.length + 2;
          return { text: match[1], start: offset, end: offset + match[1].length };
        };
        const name = field("name"), description = field("description"), path = field("location");
        if (!name || !description || !path || name.end > description.start || description.end > path.start) continue; // malformed catalog remains framing/unattributed
        if (childCursor < start) children.push(part(childCursor, start, "Skill catalog routing / framing"));
        const skill = part(start, end, `Skill · ${decode(name.text)}`, decode(path.text));
        children.push(skill); childCursor = end;
        const cost: SkillCost = {
          name: decode(name.text), path: decode(path.text), source,
          characters: end - start, tokens: skill.estimate.tokens,
          descriptionCharacters: description.end - description.start, descriptionTokens: textSliceEstimate(description.start, description.end).tokens,
          nameTokens: textSliceEstimate(name.start, name.end).tokens, pathTokens: textSliceEstimate(path.start, path.end).tokens,
          framingTokens: 0,
        };
        cost.framingTokens = cost.tokens - cost.descriptionTokens - cost.nameTokens - cost.pathTokens;
        profile.skills.push(cost);
        skill.children = [];
        let offset = start;
        for (const [label, value] of [["Name", name], ["Description", description], ["Location", path]] as const) {
          if (offset < value.start) skill.children.push(part(offset, value.start, "Skill entry framing"));
          skill.children.push(part(value.start, value.end, label, skill.source)); offset = value.end;
        }
        if (offset < end) skill.children.push(part(offset, end, "Skill entry framing"));
        add("Skill descriptions", description.start, description.end);
        add("Skill names, paths & framing", start, description.start);
        add("Skill names, paths & framing", description.end, end);
      }
      if (childCursor < r.end) children.push(part(childCursor, r.end, "Skill catalog routing / framing"));
      for (const c of children.filter((c) => !c.children)) add("Skill names, paths & framing", c.start, c.end);
      parent.children = children;
    } else {
      add(category, r.start, r.end);
      if (r.kind === "project_context") {
        parent.children = [];
        let offset = r.start;
        for (const m of parent.text.matchAll(/<project_instructions path="([^"]*)">\r?\n[\s\S]*?\r?\n<\/project_instructions>/g)) {
          const start = r.start + m.index!, end = start + m[0].length;
          if (offset < start) parent.children.push(part(offset, start, "Project context framing"));
          parent.children.push(part(start, end, `Instructions · ${m[1]}`, m[1])); offset = end;
        }
        if (offset < r.end) parent.children.push(part(offset, r.end, "Project context framing"));
      }
    }
  }
  return profile;
}

/** Replay persisted system-section patches without retrofitting today's configuration. */
export class RecordedInstructions {
  private content = "";
  private sections: Record<string, string> = Object.create(null);
  profile?: InstructionProfile;

  observe(message: unknown): void {
    const m = object(message);
    if (m.role !== "system") return;
    // Pi's transcript contract appends content, patches sections by name, and
    // leaves instructions unchanged on tool-only system entries.
    const content = typeof m.content === "string" ? m.content : Array.isArray(m.content)
      ? m.content.flatMap((b) => object(b).type === "text" && typeof object(b).text === "string" ? [object(b).text as string] : []).join("\n") : "";
    if (content) this.content = [this.content, content].filter(Boolean).join("\n\n");
    for (const [name, value] of Object.entries(object(m.sections))) {
      if (value === null) delete this.sections[name];
      else if (typeof value === "string") this.sections[name] = value;
    }
    // Pi renders the base plus ordered section values separated by blank lines.
    this.profile = analyzeInstructions([this.content, ...Object.values(this.sections)].filter(Boolean).join("\n\n"), "recorded system state");
  }
}

export function mergeInstructionProfiles(profiles: InstructionProfile[]): InstructionProfile {
  const result: InstructionProfile = { characters: 0, tokens: 0, categories: {}, skills: [], parts: [] };
  for (const profile of profiles) {
    result.characters += profile.characters; result.tokens += profile.tokens;
    result.skills.push(...profile.skills); result.parts.push(...profile.parts);
    for (const [name, cost] of Object.entries(profile.categories)) {
      const value = result.categories[name] ??= { characters: 0, tokens: 0 };
      value.characters += cost.characters; value.tokens += cost.tokens;
    }
  }
  return result;
}

/** Only explicit instruction fields/roles; never scan conversation or tool output for skills. */
export function capturedInstructions(payload: unknown): InstructionProfile | undefined {
  const p = object(payload), profiles: InstructionProfile[] = [];
  const collect = (value: unknown, source: string) => {
    if (typeof value === "string") profiles.push(analyzeInstructions(value, source));
    else if (Array.isArray(value)) value.forEach((block, i) => {
      const b = object(block);
      if (typeof block === "string") collect(block, `${source}[${i}]`);
      else if (["text", "input_text"].includes(String(b.type)) && typeof b.text === "string") collect(b.text, `${source}[${i}].text`);
    });
  };
  collect(p.system, "payload.system"); collect(p.instructions, "payload.instructions");
  for (const key of ["messages", "input"]) if (Array.isArray(p[key])) (p[key] as unknown[]).forEach((message, i) => {
    const m = object(message);
    if (m.role === "system" || m.role === "developer") collect(m.content, `payload.${key}[${i}].content`);
  });
  const parts = object(p.systemInstruction).parts;
  if (Array.isArray(parts)) parts.forEach((p, i) => collect(object(p).text, `payload.systemInstruction.parts[${i}].text`));
  return profiles.length ? mergeInstructionProfiles(profiles) : undefined;
}
