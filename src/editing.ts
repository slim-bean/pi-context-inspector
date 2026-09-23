import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { commitRevision, type EditProposal, type Revision } from "./revisions.ts";

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Do not mutate a file owned by the active SessionManager. switchSession opens
 * its destination BEFORE old shutdown hooks finish, so a direct edit/reopen can
 * miss writes from those hooks. Park first; use only replacement contexts.
 */
export async function saveAndReopen(
  ctx: ExtensionCommandContext,
  proposal: EditProposal,
  commit: (proposal: EditProposal) => Revision = commitRevision,
): Promise<void> {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for pi to finish before editing a summary.");
  if (ctx.sessionManager.getSessionId() !== proposal.sessionId
    || ctx.sessionManager.getSessionFile() !== proposal.path
    || ctx.sessionManager.getLeafId() !== proposal.leafId) {
    throw new Error("Session position changed while reviewing the edit; reopen the inspector and try again.");
  }
  const draft = ctx.ui.getEditorText();
  // UI notifications are a host service, not a session state handle. Keep this
  // function for failures that tear down a runtime before withSession can run.
  const notify = ctx.ui.notify.bind(ctx.ui);
  let revision: Revision | undefined;
  let detached = false;
  let restored = false;
  try {
    const result = await ctx.newSession({
      withSession: async (parking) => {
        detached = true;
        if (!parking.isIdle() || parking.hasPendingMessages()) {
          throw new Error("An extension started work in the temporary session. Original file was not changed.");
        }
        let failure: string | undefined;
        try { revision = commit(proposal); }
        catch (error) { failure = errorText(error); }
        let verified = false;
        const resumed = await parking.switchSession(proposal.path, {
          withSession: async (fresh) => {
            restored = true;
            fresh.ui.setEditorText(draft);
            const entry = fresh.sessionManager.getEntry(proposal.entryId);
            verified = entry?.type === "compaction" && entry.summary === proposal.after;
          },
        });
        // Pi writes its own "Resumed session" status after withSession returns.
        // Report through the host UI only after that, or it erases our notice.
        if (resumed.cancelled) {
          notify(`${revision ? "Summary saved, but" : "Edit not applied, and"} resuming was cancelled. Resume ${proposal.path} manually.${revision ? ` Backup: ${revision.backupPath}` : ""}`, "warning");
        } else if (revision && !verified) {
          notify(`Summary verification failed after resume. Stop and inspect ${proposal.path}. Backup: ${revision.backupPath}`, "error");
        } else if (failure) {
          notify(`Edit not applied: ${failure}`, "error");
        } else if (revision) {
          notify(`${proposal.action === "undo" ? "Undid summary edit" : "Saved summary"} and reopened session. Backup: ${revision.backupPath}`, "info");
        }
      },
    });
    if (result.cancelled) notify("Summary edit cancelled; file unchanged.", "info");
  } catch (error) {
    notify(`${errorText(error)}${detached && !restored ? ` Resume ${proposal.path} manually.` : ""}${revision ? ` Summary was saved. Backup: ${revision.backupPath}` : " Summary was not saved."}`, "error");
  }
}
