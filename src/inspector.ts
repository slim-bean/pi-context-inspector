import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import { jsonText, type Section, type Snapshot } from "./snapshots.ts";

export interface ViewState {
  tab: number;
  sectionId?: string;
  query: string;
  raw: boolean;
}
export type InspectorAction = {
  kind: "close" | "refresh" | "copy" | "export" | "edit" | "undo";
  section?: Section;
  state: ViewState;
};

/** Do not replay escape sequences from tool results or files into the terminal. */
export function terminalText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export class Inspector implements Component, Focusable {
  private search = new Input({ prompt: "/ ", placeholder: "Search titles and full text" });
  private searching = false;
  private focus: "list" | "content" = "list";
  private _focused = false;
  private list?: SelectList;
  private filtered: Section[] = [];
  private index = 0;
  private scroll = 0;
  private bodyHeight = 12;
  private listKey = "";
  private wrappedKey = "";
  private wrapped: string[] = [];
  private note = "";
  readonly state: ViewState;

  constructor(
    private snapshots: Snapshot[],
    private theme: Theme,
    private kb: KeybindingsManager,
    private terminalRows: () => number,
    private requestRender: () => void,
    private done: (action: InspectorAction) => void,
    initial?: Partial<ViewState>,
  ) {
    this.state = { tab: 0, query: "", raw: false, ...initial };
    this.search.setValue(this.state.query);
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.search.focused = value && this.searching; }
  private get snapshot(): Snapshot { return this.snapshots[this.state.tab] ?? this.snapshots[0]; }
  private get selected(): Section | undefined { return this.filtered[this.index]; }

  private ensureList(): void {
    const key = `${this.state.tab}:${this.state.query}:${this.bodyHeight}`;
    if (this.list && key === this.listKey) return;
    const query = this.state.query.toLowerCase();
    this.filtered = this.snapshot.sections.filter((section) =>
      `${section.title}\n${section.source}\n${section.text}`.toLowerCase().includes(query));
    this.index = Math.max(0, this.filtered.findIndex((section) => section.id === this.state.sectionId));
    this.list = new SelectList(this.filtered.map((section) => ({
      value: section.id,
      label: `${section.status === "excluded" ? "−" : section.status === "reference" ? "·" : "+"} ${terminalText(section.title)}`,
    })), this.bodyHeight, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("muted", s),
    });
    this.list.setSelectedIndex(this.index);
    this.listKey = key;
    this.state.sectionId = this.selected?.id;
  }

  private move(amount: number): void {
    if (this.focus === "content") this.scroll = Math.max(0, Math.min(Math.max(0, this.wrapped.length - this.bodyHeight), this.scroll + amount));
    else {
      this.index = Math.max(0, Math.min(this.filtered.length - 1, this.index + amount));
      this.list?.setSelectedIndex(this.index);
      this.state.sectionId = this.selected?.id;
      this.scroll = 0;
    }
  }

  private finish(kind: InspectorAction["kind"]): void {
    this.done({ kind, section: this.selected, state: { ...this.state } });
  }

  handleInput(data: string): void {
    this.ensureList();
    if (this.searching) {
      if (this.kb.matches(data, "tui.select.cancel") || this.kb.matches(data, "tui.select.confirm")) {
        this.searching = false;
        this.search.focused = false;
      } else {
        this.search.handleInput(data);
        this.state.query = this.search.getValue();
        this.scroll = 0;
        this.state.sectionId = undefined;
      }
    } else if (this.kb.matches(data, "tui.select.cancel") || data === "q") {
      this.finish("close"); return;
    } else if (["1", "2", "3"].includes(data)) {
      this.state.tab = Number(data) - 1;
      this.state.sectionId = undefined;
      this.scroll = 0;
    } else if (data === "/") {
      this.searching = true;
      this.search.focused = this.focused;
    } else if (matchesKey(data, "tab") || this.kb.matches(data, "tui.select.confirm")) {
      this.focus = this.focus === "list" ? "content" : "list";
    } else if (this.kb.matches(data, "tui.select.up") || data === "k") this.move(-1);
    else if (this.kb.matches(data, "tui.select.down") || data === "j") this.move(1);
    else if (this.kb.matches(data, "tui.select.pageUp")) this.move(-this.bodyHeight);
    else if (this.kb.matches(data, "tui.select.pageDown")) this.move(this.bodyHeight);
    else if (matchesKey(data, "home")) this.move(-Number.MAX_SAFE_INTEGER);
    else if (matchesKey(data, "end")) this.move(Number.MAX_SAFE_INTEGER);
    else if (data === "r") { this.state.raw = !this.state.raw; this.scroll = 0; }
    else if (data === "f") { this.finish("refresh"); return; }
    else if (data === "y") { this.finish("copy"); return; }
    else if (data === "x") { this.finish("export"); return; }
    else if (data === "u") { this.finish("undo"); return; }
    else if (data === "e") {
      if (this.selected?.editableEntryId) { this.finish("edit"); return; }
      this.note = "Select the active compaction in Preview to edit. Historical/raw request snapshots are read-only.";
    }
    this.requestRender();
  }

  render(width: number): string[] {
    // No assumptions about terminal size; every line is clipped by display width.
    width = Math.max(1, width);
    const height = Math.max(1, Math.min(42, this.terminalRows() - 2));
    const inner = Math.max(1, width - 2);
    this.bodyHeight = Math.max(1, height - 9);
    this.ensureList();
    const split = inner >= 90;
    const leftWidth = split ? Math.min(38, Math.floor(inner * 0.32)) : inner;
    const contentWidth = split ? inner - leftWidth - 3 : inner;
    const section = this.selected;
    const key = `${this.state.tab}:${section?.id}:${this.state.raw}:${contentWidth}`;
    if (key !== this.wrappedKey) {
      const text = section ? (this.state.raw ? jsonText(section.raw) : section.text)
        : this.snapshot.kind === "diff" ? "Two captured requests are needed to show a diff." : "No matching sections.";
      this.wrapped = terminalText(text).split("\n").flatMap((line) => wrapTextWithAnsi(line, contentWidth));
      this.wrappedKey = key;
    }
    this.scroll = Math.min(this.scroll, Math.max(0, this.wrapped.length - this.bodyHeight));
    const th = this.theme;
    const pad = (text: string, w: number) => {
      const clipped = truncateToWidth(text, w);
      return clipped + " ".repeat(Math.max(0, w - visibleWidth(clipped)));
    };
    const row = (text: string) => truncateToWidth(`${th.fg("border", "│")}${pad(text, inner)}${th.fg("border", "│")}`, width);
    const tabs = ["1 Preview", "2 Last request", "3 Changes"].map((label, i) => i === this.state.tab ? th.bold(th.fg("accent", label)) : th.fg("muted", label)).join("   ");
    const lines = [
      th.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
      row(` ${th.bold("Context inspector")}   ${tabs}`),
      row(` ${th.fg("muted", terminalText(this.snapshot.description))}`),
      row(this.searching ? this.search.render(inner)[0] : ` / Search: ${terminalText(this.state.query || "(all)")}   ${this.filtered.length} sections · focus: ${this.focus} · ${this.state.raw ? "raw JSON" : "text"}`),
      row(th.fg("dim", "─".repeat(inner))),
    ];
    const left = this.list!.render(leftWidth);
    const right = this.wrapped.slice(this.scroll, this.scroll + this.bodyHeight);
    for (let i = 0; i < this.bodyHeight; i++) {
      let content = right[i] ?? "";
      if (this.snapshot.kind === "diff") {
        if (content.startsWith("+")) content = th.fg("toolDiffAdded", content);
        if (content.startsWith("-")) content = th.fg("toolDiffRemoved", content);
      }
      lines.push(row(split ? `${pad(left[i] ?? "", leftWidth)} ${th.fg("border", "│")} ${pad(content, contentWidth)}` : this.focus === "list" ? left[i] ?? "" : content));
    }
    lines.push(
      row(th.fg("muted", terminalText(this.note || `${section?.status ?? ""} · ${section?.source ?? ""} · lines ${Math.min(this.scroll + 1, this.wrapped.length)}–${Math.min(this.scroll + this.bodyHeight, this.wrapped.length)}/${this.wrapped.length}`))),
      row(th.fg("dim", "↑↓/j k navigate · Tab read/list · PgUp/Dn scroll · / search · r raw · f refresh")),
      row(th.fg("dim", "y copy · x export · e edit summary · u undo · Esc close")),
      th.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
    );
    return lines.slice(0, height).map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    this.list = undefined;
    this.wrappedKey = "";
    this.search.invalidate();
  }
}
