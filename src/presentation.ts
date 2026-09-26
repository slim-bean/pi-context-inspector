import type { Theme } from "@earendil-works/pi-coding-agent";

/** Semantic metadata only. Snapshots, exports and clipboard text never contain generated ANSI. */
export type Tone = "accent" | "warning" | "error" | "success" | "muted" | "dim" | "mdCode" | "mdHeading" | "thinkingText";
export interface Highlight { start: number; end: number; tone: Tone }
export interface StyledText { text: string; highlights: Highlight[] }
export const toned = (text: string, tone: Tone): StyledText => ({ text, highlights: text ? [{ start: 0, end: text.length, tone }] : [] });

/** Compose exact ranges at the producer, never infer diagnostic meaning from arbitrary result text. */
export function rich(strings: TemplateStringsArray, ...values: (string | number | StyledText)[]): StyledText {
  let text = strings[0];
  const highlights: Highlight[] = [];
  values.forEach((value, i) => {
    if (typeof value === "object") {
      for (const h of value.highlights) highlights.push({ ...h, start: text.length + h.start, end: text.length + h.end });
      text += value.text;
    } else text += String(value);
    text += strings[i + 1];
  });
  return { text, highlights };
}
export function joinRich(values: StyledText[], separator = "\n"): StyledText {
  const highlights: Highlight[] = [];
  let offset = 0;
  values.forEach((value, index) => {
    if (index) offset += separator.length;
    for (const h of value.highlights) highlights.push({ ...h, start: offset + h.start, end: offset + h.end });
    offset += value.text.length;
  });
  return { text: values.map((value) => value.text).join(separator), highlights };
}
export function terminalText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
export function terminalLine(text: string): string { return terminalText(text).replace(/\n/g, "\\n"); }

/** Escape data before applying trusted theme colors. Reopen colors on every source line. */
export function paint(text: string, highlights: readonly Highlight[], theme: Theme, singleLine = false): string {
  const escape = singleLine ? terminalLine : terminalText;
  let cursor = 0, output = "";
  for (const highlight of highlights) {
    if (highlight.start < cursor || highlight.end > text.length || highlight.end <= highlight.start) continue;
    output += escape(text.slice(cursor, highlight.start));
    output += escape(text.slice(highlight.start, highlight.end)).split("\n").map((line) => theme.fg(highlight.tone, line)).join("\n");
    cursor = highlight.end;
  }
  return output + escape(text.slice(cursor));
}
export function tokenTone(tokens: number, largest: number): Tone {
  return tokens > 0 && tokens >= largest / 2 ? "warning" : "accent";
}
export function deltaTone(delta: number | undefined): Tone {
  return delta === undefined || delta === 0 ? "dim" : delta > 0 ? "warning" : "success";
}
export function shareBar(part: number, total: number, tone: Tone): StyledText {
  const filled = total > 0 ? Math.round(Math.max(0, Math.min(1, part / total)) * 12) : 0;
  return rich`${toned("█".repeat(filled), tone)}${toned("░".repeat(12 - filled), "dim")}`;
}
