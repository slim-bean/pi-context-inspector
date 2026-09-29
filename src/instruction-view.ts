import type { Section } from "./snapshots.ts";
import { INSTRUCTION_NOTE, type InstructionPart, type InstructionProfile } from "./instructions.ts";
import { formatEstimate, textEstimate } from "./metrics.ts";
import { joinRich, rich, shareBar, toned } from "./presentation.ts";

const estimate = (tokens: number) => ({ ...textEstimate(""), tokens });
const percent = (part: number, whole: number) => whole ? `${(100 * part / whole).toFixed(1)}%` : "0.0%";
export function instructionSummary(profile: InstructionProfile): string {
  const description = profile.categories["Skill descriptions"]?.tokens ?? 0;
  const overhead = profile.categories["Skill names, paths & framing"]?.tokens ?? 0;
  return `Instructions ${formatEstimate(estimate(profile.tokens))} · skill catalog ${formatEstimate(estimate(description + overhead))} (${percent(description + overhead, profile.tokens)}) · ${profile.skills.length} advertised skill entries`;
}

export function instructionSection(profile: InstructionProfile, id: string, title: string): Section {
  const toSection = (p: InstructionPart): Section => ({
    id: `${id}:${p.id}`, title: p.label, status: "reference", source: `${p.source} · text slice ${p.start}–${p.end}; already counted in parent`,
    estimate: p.estimate, sortTokens: p.estimate.tokens,
    text: p.text, raw: p, children: p.children?.map(toSection),
  });
  const categories = Object.entries(profile.categories).sort((a, b) => b[1].tokens - a[1].tokens);
  const skills = [...profile.skills].sort((a, b) => b.tokens - a.tokens);
  const total = profile.tokens;
  return {
    id, title, status: "reference", source: "Instruction attribution; duplicate/reference breakdown, not extra context",
    sortTokens: total,
    ...rich`${toned(instructionSummary(profile), "accent")}\n\n${joinRich(categories.map(([name, cost]) => rich`${shareBar(cost.tokens, total, name === "Skill descriptions" ? "warning" : "accent")} ${toned(formatEstimate(estimate(cost.tokens)), "accent")} · ${percent(cost.tokens, total)} · ${name}`))}\n\n${toned("Advertised skills (largest first)", "mdHeading")}\n${skills.length ? skills.map((s) => `${formatEstimate(estimate(s.tokens))} · ${s.name}\n  description ~${s.descriptionTokens} · name ~${s.nameTokens} · path ~${s.pathTokens} · entry framing ~${s.framingTokens}\n  ${s.path}`).join("\n") : "No recognized skill entries in this instruction text."}\n\nEnter a section to drill down, then Enter again for individual skills/files/fields. Backspace goes up; s sorts the current group by size. Skill routing/catalog framing is separate from per-entry framing.\n\n${INSTRUCTION_NOTE}`,
    raw: profile, children: profile.parts.map(toSection),
  };
}

export function instructionDelta(before: InstructionProfile, after: InstructionProfile): Section {
  const delta = (a: number, b: number) => `${b - a >= 0 ? "+" : ""}${(b - a).toLocaleString()}`;
  const rows = [...new Set([...Object.keys(before.categories), ...Object.keys(after.categories)])].map((name) => {
    const a = before.categories[name]?.tokens ?? 0, b = after.categories[name]?.tokens ?? 0;
    return `${name}: ~${a.toLocaleString()} → ~${b.toLocaleString()} (Δ ${delta(a, b)})`;
  });
  const groupSkills = (profile: InstructionProfile) => {
    const map = new Map<string, { name: string; tokens: number }>();
    for (const skill of profile.skills) {
      const key = JSON.stringify([skill.name, skill.path]);
      const prior = map.get(key);
      map.set(key, { name: `${skill.name} · ${skill.path}`, tokens: (prior?.tokens ?? 0) + skill.tokens });
    }
    return map;
  };
  const a = groupSkills(before), b = groupSkills(after);
  const changes = [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key)?.tokens !== b.get(key)?.tokens)
    .map((key) => `${(b.get(key) ?? a.get(key))!.name}: ~${a.get(key)?.tokens ?? 0} → ~${b.get(key)?.tokens ?? 0}`);
  return {
    id: "instruction-delta", title: "Instruction size changes", status: "reference", source: "Recognized captured instruction text; not total request growth or cache prediction",
    text: `Visible instructions: ~${before.tokens.toLocaleString()} → ~${after.tokens.toLocaleString()} (Δ ${delta(before.tokens, after.tokens)})\n\n${rows.join("\n")}\n\nSkill entry size changes (same-size text changes still appear in the payload diff):\n${changes.join("\n") || "No estimated size changes."}\n\n${INSTRUCTION_NOTE}`,
    raw: { before, after },
  };
}
