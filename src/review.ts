import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { terminalText } from "./inspector.ts";

export class Review implements Component {
  private scroll = 0;
  private height = 12;
  private lines: string[] = [];
  private width = 0;
  constructor(
    private text: string,
    private theme: Theme,
    private kb: KeybindingsManager,
    private rows: () => number,
    private renderAgain: () => void,
    private done: (save: boolean) => void,
  ) {}
  handleInput(data: string): void {
    if (this.kb.matches(data, "tui.select.cancel")) { this.done(false); return; }
    if (this.kb.matches(data, "tui.select.confirm")) { this.done(true); return; }
    if (this.kb.matches(data, "tui.select.up")) this.scroll--;
    if (this.kb.matches(data, "tui.select.down")) this.scroll++;
    if (this.kb.matches(data, "tui.select.pageUp")) this.scroll -= this.height;
    if (this.kb.matches(data, "tui.select.pageDown")) this.scroll += this.height;
    this.renderAgain();
  }
  render(width: number): string[] {
    width = Math.max(1, width);
    const inner = Math.max(1, width - 2);
    const height = Math.max(1, Math.min(40, this.rows() - 2));
    this.height = Math.max(1, height - 7);
    if (this.width !== width) {
      this.lines = terminalText(this.text).split("\n").flatMap((line) => wrapTextWithAnsi(line, inner));
      this.width = width;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, this.lines.length - this.height));
    const row = (text: string) => {
      const clipped = truncateToWidth(text, inner);
      return truncateToWidth(`${this.theme.fg("border", "│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${this.theme.fg("border", "│")}`, width);
    };
    const body = this.lines.slice(this.scroll, this.scroll + this.height).map((line) =>
      this.theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "text", line));
    while (body.length < this.height) body.push("");
    return [
      this.theme.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
      row(this.theme.bold(this.theme.fg("accent", "Review compaction summary edit"))),
      row(this.theme.fg("warning", "Mutates shared history. A backup is saved; pi briefly switches away and reopens.")),
      row(this.theme.fg("muted", "Changed summary and later context may lose cache reuse. This extension makes no model calls.")),
      ...body.map(row),
      row(this.theme.fg("dim", `Lines ${this.scroll + 1}–${Math.min(this.lines.length, this.scroll + this.height)}/${this.lines.length} · ↑↓ PgUp/PgDn scroll`)),
      row(this.theme.fg("accent", "Enter SAVE AND REOPEN · Esc CANCEL")),
      this.theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ].slice(0, height).map((line) => truncateToWidth(line, width));
  }
  invalidate(): void { this.width = 0; }
}
