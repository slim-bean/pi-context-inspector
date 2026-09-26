import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { copyToClipboard, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Inspector, type InspectorAction, type ViewState } from "./inspector.ts";
import { Review } from "./review.ts";
import { activeCompaction, buildPreview, diffSnapshot, jsonText, makeDiff, requestSnapshot, RequestHistory } from "./snapshots.ts";
import { proposeEdit, proposeUndo, type EditProposal } from "./revisions.ts";
import { errorText, saveAndReopen } from "./editing.ts";
import { growthSnapshot, toolSnapshot } from "./profiler.ts";

const OVERLAY = { overlay: true, overlayOptions: { width: "96%" as const, maxHeight: "96%" as const, margin: 1 } };

export default function contextInspector(pi: ExtensionAPI): void {
  const history = new RequestHistory();
  let commandOpen = false;
  pi.on("session_start", () => { history.clear(); });
  pi.on("session_shutdown", () => { history.clear(); });
  pi.on("before_provider_request", (event, ctx) => {
    history.record(event.payload, {
      capturedAt: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(), model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
    });
    // Observation only: never return a replacement payload.
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant" && history.latest) {
      const { input, output, cacheRead, cacheWrite } = event.message.usage;
      history.latest.usage = { input, output, cacheRead, cacheWrite };
    }
  });

  async function exportContext(ctx: ExtensionCommandContext, requestedPath?: string): Promise<void> {
    const defaultPath = join(tmpdir(), "pi-context-exports", `${ctx.sessionManager.getSessionId()}-${randomUUID()}.context-export.json`);
    const path = resolve(ctx.cwd, requestedPath || defaultPath);
    if (!await ctx.ui.confirm("Export sensitive context?", `Writes instructions, conversation, tool schemas, current/historical branch tool content, profiler statistics, and captured payloads to ${path}. This may include secrets and images. Nothing is uploaded.`)) return;
    const document = {
      version: 2, exportedAt: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(), sessionFile: ctx.sessionManager.getSessionFile(),
      warning: "Preview is reconstructed; captures reflect this extension's hook, not necessarily later hooks or provider-private instructions.",
      preview: buildPreview(ctx, pi),
      tools: toolSnapshot(ctx.sessionManager.getBranch(), ctx.sessionManager.buildContextEntries(), ctx.cwd),
      growth: growthSnapshot(ctx.sessionManager.getBranch()),
      requests: [history.previous, history.latest].filter(Boolean).map((capture) => ({ ...capture, json: undefined })),
      captureWarning: history.warning,
    };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, jsonText(document) + "\n", { flag: "wx", mode: 0o600 });
    ctx.ui.notify(`Context exported (private file): ${path}`, "info");
  }

  function editTarget(ctx: ExtensionCommandContext): { path: string; sessionId: string; leafId: string; entryId: string; summary: string } {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for pi to finish before editing a summary.");
    const path = ctx.sessionManager.getSessionFile();
    const leafId = ctx.sessionManager.getLeafId();
    const entry = activeCompaction(ctx.sessionManager.getBranch());
    if (!path) throw new Error("This session is ephemeral; saved-summary editing requires a session file.");
    if (!leafId || !entry) throw new Error("No active compaction summary on this branch.");
    return { path, sessionId: ctx.sessionManager.getSessionId(), leafId, entryId: entry.id, summary: entry.summary };
  }

  async function reviewAndSave(ctx: ExtensionCommandContext, proposal: EditProposal): Promise<void> {
    const diff = makeDiff(proposal.before, proposal.after, "saved summary", proposal.action === "undo" ? "restored summary" : "edited summary");
    const confirmed = await ctx.ui.custom<boolean>((tui, theme, kb, done) =>
      new Review(`${proposal.after.trim() ? "" : "WARNING: the edited summary is empty.\n\n"}${diff}`, theme, kb, () => tui.terminal.rows, () => tui.requestRender(), done), OVERLAY);
    if (!confirmed) return;
    // This may invalidate this entire extension instance; no session-bound work afterward.
    await saveAndReopen(ctx, proposal);
  }

  async function editSummary(ctx: ExtensionCommandContext, requestedId?: string): Promise<void> {
    const target = editTarget(ctx);
    if (requestedId && requestedId !== target.entryId) throw new Error("Only the active compaction can be edited; select it in Preview.");
    const text = await ctx.ui.editor(`Edit compaction ${target.entryId} (Markdown)`, target.summary);
    if (text === undefined || text === target.summary) return;
    const proposal = proposeEdit(target.path, target.sessionId, target.leafId, target.entryId, target.summary, text);
    await reviewAndSave(ctx, proposal);
  }

  async function undoSummary(ctx: ExtensionCommandContext): Promise<void> {
    const target = editTarget(ctx);
    await reviewAndSave(ctx, proposeUndo(target.path, target.sessionId, target.leafId));
  }

  pi.registerCommand("context", {
    description: "Inspect context, profile tokens/tools and request growth, and edit saved summaries",
    getArgumentCompletions: (prefix) => ["request", "diff", "stats", "growth", "edit", "undo", "export", "help"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") throw new Error("/context requires interactive TUI mode.");
      if (commandOpen) { ctx.ui.notify("Context inspector is already open.", "warning"); return; }
      commandOpen = true;
      // Host UI notification function remains usable if a failed runtime replacement
      // invalidates the command's original session context.
      const notify = ctx.ui.notify.bind(ctx.ui);
      try {
        const input = args.trim();
        const [command] = input.split(/\s+/);
        const rest = input.slice(command.length).trim();
        if (command === "help") {
          ctx.ui.notify("/context [request|diff|stats|growth|edit [entry-id]|undo|export [path]]\nOverlay: 1–5 tabs, Tab list/content, Enter drill, Backspace up, s size sort, / search, r raw, y copy, x export, e edit, u undo. ~tokens are local estimates, not billing. Tool diagnostics are heuristics. Captures are memory-only. Edits save backups and reopen the session.", "info");
          return;
        }
        if (command === "edit") { await editSummary(ctx, rest || undefined); return; }
        if (command === "undo") { await undoSummary(ctx); return; }
        if (command === "export") { await exportContext(ctx, rest || undefined); return; }
        if (command && !["request", "diff", "stats", "growth"].includes(command)) throw new Error("Unknown /context command. Try /context help.");
        let state: Partial<ViewState> = { tab: command === "request" ? 1 : command === "diff" ? 2 : command === "stats" ? 3 : command === "growth" ? 4 : 0 };
        for (;;) {
          const branch = ctx.sessionManager.getBranch();
          const snapshots = [buildPreview(ctx, pi), requestSnapshot(history), diffSnapshot(history),
            toolSnapshot(branch, ctx.sessionManager.buildContextEntries(), ctx.cwd), growthSnapshot(branch)];
          const action = await ctx.ui.custom<InspectorAction>((tui, theme, kb, done) =>
            new Inspector(snapshots, theme, kb, () => tui.terminal.rows, () => tui.requestRender(), done, state), OVERLAY);
          if (!action || action.kind === "close") return;
          state = action.state;
          if (action.kind === "edit") { await editSummary(ctx, action.section?.editableEntryId); return; }
          if (action.kind === "undo") { await undoSummary(ctx); return; }
          if (action.kind === "export") await exportContext(ctx);
          if (action.kind === "copy" && action.section) {
            await copyToClipboard(action.state.raw ? jsonText(action.section.raw) : action.section.text);
            ctx.ui.notify("Copied section to clipboard.", "info");
          }
        }
      } catch (error) { notify(errorText(error), "error"); }
      finally { commandOpen = false; }
    },
  });
}
