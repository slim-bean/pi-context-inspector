import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import { jsonText, type Section, type Snapshot } from "./snapshots.ts";
import { formatEstimate } from "./metrics.ts";
import { LiveRefresh, type LiveSource } from "./live.ts";
import { paint, terminalLine, tokenTone } from "./presentation.ts";
export { terminalText } from "./presentation.ts";

export interface ViewState {
  tab: number;
  sectionId?: string;
  query: string;
  raw: boolean;
  sorted: boolean;
  drillId?: string;
  following: boolean;
}
export type InspectorAction = {
  kind: "close" | "refresh" | "copy" | "export" | "edit" | "undo";
  section?: Section;
  state: ViewState;
};

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
  private largestEstimate = 0;
  private pendingG = false;
  private live?: LiveRefresh<Snapshot[]>;
  private disposed = false;
  readonly state: ViewState;

  constructor(
    private snapshots: Snapshot[],
    private theme: Theme,
    private kb: KeybindingsManager,
    private terminalRows: () => number,
    private requestRender: () => void,
    private done: (action: InspectorAction) => void,
    initial?: Partial<ViewState>,
    source?: LiveSource<Snapshot[]>,
  ) {
    this.state = { tab: 0, query: "", raw: false, sorted: false, following: false, ...initial };
    this.search.setValue(this.state.query);
    if (source) this.live = new LiveRefresh(source, (snapshots) => this.updateSnapshots(snapshots));
  }

  /** Replace data in place; browsing/search/focus survive updates. */
  updateSnapshots(snapshots: Snapshot[]): void {
    if (this.disposed) return;
    const selectedId = this.state.sectionId;
    this.snapshots = snapshots;
    this.invalidate();
    this.ensureList();
    if (this.state.sectionId !== selectedId) this.scroll = 0;
    this.requestRender();
  }

  close(): void { this.finish("close"); }

  dispose(): void {
    this.disposed = true;
    this.live?.dispose();
  }

  private follow(): void {
    this.state.following = !this.state.following;
    if (!this.state.following) return;
    this.state.tab = 0;
    this.state.query = "";
    this.state.sorted = false;
    this.state.drillId = undefined;
    this.search.setValue("");
    this.focus = "content";
    this.invalidate();
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.search.focused = value && this.searching; }
  private get snapshot(): Snapshot { return this.snapshots[this.state.tab] ?? this.snapshots[0]; }
  private get selected(): Section | undefined { return this.filtered[this.index]; }

  private ensureList(): void {
    const key = `${this.state.tab}:${this.state.query}:${this.bodyHeight}:${this.state.sorted}:${this.state.drillId}`;
    if (this.list && key === this.listKey) return;
    const query = this.state.query.toLowerCase();
    const flatten = (sections: Section[]): Section[] => sections.flatMap((s) => [s, ...flatten(s.children ?? [])]);
    const group = this.snapshot.sections.find((s) => s.id === this.state.drillId);
    const sections = group?.children ?? this.snapshot.sections;
    // Stable within a group: filtering/sorting must not change the size-color scale.
    this.largestEstimate = sections.reduce((largest, s) => Math.max(largest, s.estimate?.tokens ?? 0), 0);
    const candidates = query ? [...new Map(flatten(sections).map((s) => [s.id, s])).values()] : sections;
    this.filtered = candidates.filter((section) =>
      `${section.title}\n${section.source}\n${section.text}`.toLowerCase().includes(query));
    if (this.state.sorted) this.filtered.sort((a, b) => (b.sortTokens ?? b.estimate?.tokens ?? -1) - (a.sortTokens ?? a.estimate?.tokens ?? -1));
    this.index = Math.max(0, this.filtered.findIndex((section) => section.id === this.state.sectionId));
    this.list = new SelectList(this.filtered.map((section) => ({
      value: section.id,
      label: `${this.statusMarker(section)} ${section.indicator ? this.theme.fg(section.indicator.tone, terminalLine(section.indicator.text)) + " " : ""}${section.estimate ? this.theme.fg(tokenTone(section.estimate.tokens, this.largestEstimate), formatEstimate(section.estimate)) + " " : ""}${paint(section.title, section.titleHighlights ?? [], this.theme, true)}${section.children?.length ? " ▸" : ""}`,
    })), this.bodyHeight, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      // Bold + the selection arrow preserve semantic foreground colors.
      selectedText: (s) => this.theme.bold(s),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("muted", s),
    });
    this.list.setSelectedIndex(this.index);
    this.listKey = key;
    this.state.sectionId = this.selected?.id;
  }

  private statusMarker(section: Section): string {
    const status = section.status;
    return this.theme.fg(status === "included" ? "success" : status === "captured" ? "accent" : status === "excluded" ? "muted" : "dim",
      status === "excluded" ? "−" : status === "reference" ? "·" : "+");
  }

  private move(amount: number): void {
    this.state.following = false;
    if (this.focus === "content") this.scroll = Math.max(0, Math.min(Math.max(0, this.wrapped.length - this.bodyHeight), this.scroll + amount));
    else {
      this.index = Math.max(0, Math.min(this.filtered.length - 1, this.index + amount));
      this.list?.setSelectedIndex(this.index);
      this.state.sectionId = this.selected?.id;
      this.scroll = 0;
    }
  }

  private finish(kind: InspectorAction["kind"]): void {
    if (this.disposed) return;
    this.dispose();
    this.done({ kind, section: this.selected, state: { ...this.state } });
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    this.ensureList();
    const wasG = this.pendingG;
    this.pendingG = false;
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
    } else if (["1", "2", "3", "4", "5"].includes(data) && Number(data) <= this.snapshots.length) {
      this.state.following = false;
      this.state.tab = Number(data) - 1;
      this.state.sectionId = undefined;
      this.state.drillId = undefined;
      this.state.query = "";
      this.search.setValue("");
      this.scroll = 0;
    } else if (data === "/") {
      this.state.following = false;
      this.searching = true;
      this.search.focused = this.focused;
    } else if (matchesKey(data, "backspace") && this.state.drillId) {
      this.state.following = false;
      this.state.sectionId = this.state.drillId;
      this.state.drillId = undefined;
      this.state.query = "";
      this.search.setValue("");
      this.focus = "list";
      this.scroll = 0;
    } else if (this.kb.matches(data, "tui.select.confirm") && this.selected?.children?.length) {
      this.state.following = false;
      this.state.drillId = this.selected.id;
      this.state.sectionId = undefined;
      this.state.query = "";
      this.search.setValue("");
      this.focus = "list";
      this.scroll = 0;
    } else if (matchesKey(data, "tab") || this.kb.matches(data, "tui.select.confirm")) {
      this.focus = this.focus === "list" ? "content" : "list";
    } else if (this.kb.matches(data, "tui.select.up") || data === "k") this.move(-1);
    else if (this.kb.matches(data, "tui.select.down") || data === "j") this.move(1);
    else if (this.kb.matches(data, "tui.select.pageUp")) this.move(-this.bodyHeight);
    else if (this.kb.matches(data, "tui.select.pageDown")) this.move(this.bodyHeight);
    else if (matchesKey(data, "home") || (matchesKey(data, "g") && wasG) || data === "gg") this.move(-Number.MAX_SAFE_INTEGER);
    else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) this.move(Number.MAX_SAFE_INTEGER);
    else if (matchesKey(data, "g")) this.pendingG = true;
    else if (matchesKey(data, "ctrl+u")) this.move(-Math.max(1, Math.floor(this.bodyHeight / 2)));
    else if (matchesKey(data, "ctrl+d")) this.move(Math.max(1, Math.floor(this.bodyHeight / 2)));
    else if (matchesKey(data, "h")) this.focus = "list";
    else if (matchesKey(data, "l")) this.focus = "content";
    else if (matchesKey(data, "shift+f")) this.follow();
    else if (data === "s") { this.state.following = false; this.state.sorted = !this.state.sorted; this.state.sectionId = undefined; this.scroll = 0; }
    else if (data === "r") { this.state.raw = !this.state.raw; this.scroll = 0; }
    else if (data === "f") {
      if (this.live) this.live.refresh(true);
      else { this.finish("refresh"); return; }
    }
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
    if (this.state.following && this.snapshot.tailSectionId !== this.state.sectionId) {
      this.state.sectionId = this.snapshot.tailSectionId;
      this.list = undefined;
    }
    this.ensureList();
    const split = inner >= 90;
    const leftWidth = split ? Math.min(44, Math.floor(inner * 0.36)) : inner;
    const contentWidth = split ? inner - leftWidth - 3 : inner;
    const section = this.selected;
    const key = `${this.state.tab}:${section?.id}:${this.state.raw}:${contentWidth}`;
    if (key !== this.wrappedKey) {
      const text = section ? (this.state.raw ? jsonText(section.raw) : section.text)
        : this.snapshot.kind === "diff" ? "Two captured requests are needed to show a diff." : "No matching sections.";
      this.wrapped = paint(text, this.state.raw ? [] : section?.highlights ?? [], this.theme).split("\n").flatMap((line) => wrapTextWithAnsi(line, contentWidth));
      this.wrappedKey = key;
    }
    const bottom = Math.max(0, this.wrapped.length - this.bodyHeight);
    this.scroll = this.state.following ? bottom : Math.min(this.scroll, bottom);
    const th = this.theme;
    const pad = (text: string, w: number) => {
      const clipped = truncateToWidth(text, w);
      return clipped + " ".repeat(Math.max(0, w - visibleWidth(clipped)));
    };
    const row = (text: string) => truncateToWidth(`${th.fg("border", "│")}${pad(text, inner)}${th.fg("border", "│")}`, width);
    const labels = ["1 Preview", "2 Last request", "3 Changes", "4 Tools", "5 Growth"].slice(0, this.snapshots.length);
    const tabs = inner >= 110
      ? labels.map((label, i) => i === this.state.tab ? th.bold(th.fg("accent", label)) : th.fg("muted", label)).join("   ")
      : `${th.bold(th.fg("accent", labels[this.state.tab] ?? labels[0]))} · 1–${labels.length} tabs`;
    const lines = [
      th.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
      row(` ${th.bold("Context inspector")} · ${this.state.following ? "FOLLOW" : "LIVE"}   ${tabs}`),
      row(` ${th.fg("muted", terminalLine(this.snapshot.description))}`),
      row(this.searching ? this.search.render(inner)[0] : ` / Search: ${terminalLine(this.state.query || "(all)")} · ${this.filtered.length} sections · ${this.state.sorted ? "size ↓" : "default order"} · ${this.focus} · ${this.state.raw ? "raw" : "text"}${this.state.drillId ? " · Backspace: up" : ""}`),
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
      row(this.note ? th.fg("muted", terminalLine(this.note)) : `${section ? this.statusMarker(section) : ""} ${section?.status ?? ""}${section?.estimate ? " " + th.fg(tokenTone(section.estimate.tokens, this.largestEstimate), formatEstimate(section.estimate)) : ""}${th.fg("muted", terminalLine(` · ${section?.source ?? ""} · lines ${Math.min(this.scroll + 1, this.wrapped.length)}–${Math.min(this.scroll + this.bodyHeight, this.wrapped.length)}/${this.wrapped.length}`))}`),
      row(th.fg("dim", "j k · gg/G ends · ^u/^d half-page · h/l panes · Tab · Enter drill · Backspace up · / search")),
      row(th.fg("dim", "F follow · f refresh · s size · r raw · y copy · x export · e edit · u undo · Esc/q close")),
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
