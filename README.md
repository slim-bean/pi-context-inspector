# pi-context-inspector

A terminal-first pi extension for seeing session context and correcting saved compaction summaries. Tested with pi **0.85.1**, Node 22.19+.

## Install

```sh
pi install git:github.com/slim-bean/pi-context-inspector
```

Then run `/reload` in an existing pi session (or start a new one), followed by `/context`.

## Try a local checkout

Run `npm ci --ignore-scripts`, start pi in the checkout, then use `/context`. In an existing session, run `/reload` first. The project-local `.pi/extensions/context.ts` entry point loads the extension; no global settings are changed.

To load a local checkout from elsewhere:

```sh
pi -e /absolute/path/to/pi-context/src/index.ts
# Or install the local package for future sessions:
pi install /absolute/path/to/pi-context
```

Avoid loading both the project entry point and the installed package in the same session.

## Commands and overlay

| Command | Purpose |
| --- | --- |
| `/context` | Current context preview |
| `/context request` | Last observed provider request |
| `/context diff` | Diff of the last two observed requests |
| `/context edit [entry-id]` | Edit the active compaction's Markdown, review, save and reopen |
| `/context undo` | Review and undo the latest still-applied summary edit on this branch |
| `/context export [path]` | Export preview and captures to a private JSON file; never overwrite |
| `/context help` | Quick reference |

Overlay keys: **1/2/3** tabs, **↑↓ / j k** select or scroll, **Tab / Enter** switch list/content focus, **PgUp/PgDn**, **Home/End**, **/** full-text filter, **r** raw JSON, **f** refresh, **y** copy section, **x** export, **e** edit selected compaction, **u** undo, **Esc / q** close. Narrow terminals show one pane at a time. Search Enter/Esc leaves search mode; clear the search text to reset the filter.

Editing uses pi's multiline editor, including **Ctrl+G** for an external editor. Enter submits to a separate diff review; **Enter there saves**, **Esc cancels**. Edits require an idle agent with no queued messages. Viewing never sends a model request or adds model context.

## What the views mean

- **Preview** combines pi's current system prompt, base prompt sources, active tool schemas, and compaction-aware branch entries. Hidden extension messages are included; UI-only state, `!!` output, and summarized-away history are labeled separately. Sources are shown where pi exposes them. This is **not a final-request prediction**: hooks, image settings and provider conversion can change it.
- **Last request** records `before_provider_request` without changing its payload. Later-loaded hooks can still modify it. Load this extension last when practical. Provider-private instructions and opaque reasoning cannot be decoded. Response token/cache usage is shown when observed.
- **Changes** compares the last two captured payloads, not arbitrary historic requests. It is not an exact cache-hit forecast.

Captures are memory-only, limited to the last two requests and **16 MiB each**. They clear on reload/resume (including summary edits). Oversized captures are explicitly skipped, never silently truncated. Large/expensive diffs fall back to an export suggestion. Text view abbreviates images; raw view and export retain the captured object. Raw terminal control characters are escaped for safe display.

## Editing, backups, and undo

The extension changes only the target compaction's `summary` field, preserving its ID, retained boundary, metadata, and other JSONL lines. A non-model-visible `pi-context.revision` entry records the revision and anchors the current branch position. Summary removal means clearing text, **not deleting the compaction entry** or resurrecting old history.

Before writing, pi briefly switches to an empty session so the original session's shutdown hooks finish. The extension validates the file, saves a full backup and revision record, performs a compare-before-rename atomic replacement, and reopens the original file. Metadata appended during shutdown is preserved; new conversation or conflicting branch writes cancel the edit. The unsent editor draft is restored. Normal session lifecycle hooks run during these switches; no model call is requested by this extension. Reopening uses your normal model/auth configuration.

Backups and revision records live next to the original session:

```text
<session>.jsonl.context-revisions/
  <revision-id>.before.jsonl   # complete pre-edit backup
  <revision-id>.json          # before/after summary and file hashes
```

Files are created with mode `0600`, directories with `0700`; rewritten session files also use `0600`. Undo changes only the summary, retaining subsequent conversation. It refuses stale summaries and edits superseded by another compaction. Revision history follows branch ancestry. A changed summary affects every branch sharing that compaction; later summaries and assistant replies are not regenerated.

**Single-writer operation only:** do not open the same session in another pi process or edit its JSONL concurrently. The extension's lock coordinates its own writers, not pi or external programs. Conflict checks reduce risk but are not a cross-process transaction. Symlinked/hard-linked files, invalid JSON, broken trees, and non-v3 sessions are refused.

If resume is cancelled or fails after saving, the edit is still on disk; the notification gives the original path and backup. Resume manually with `pi --session <path>`. For full-file recovery, first close every pi process using that session, then restore the desired `.before.jsonl` backup. A crash can leave `write.lock`; inspect it before removing. Prepared revision files without an applied session marker are ignored by undo. `/reload` alone does **not** reread edited session JSONL.

Prompt caching reuses prefixes: editing a summary can prevent reuse from that point onward, even for unchanged later messages. Stable earlier instructions/tools may still be reusable. This changes cost/latency, not whether the corrected summary takes effect.

## Privacy

Requests, exports, backups, and the clipboard can contain secrets, instructions, images, and private conversation. Nothing is uploaded. Exports require confirmation and default to a unique file under the OS temporary directory. Backups/exports are not automatically deleted; remove them when no longer needed. HTTP auth headers are not captured, but credentials embedded in conversation or payload content are not redacted.

## Development and safe testing

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:tui
```

Unit tests use temporary fixtures and do not create an authenticated runtime. The real-TUI smoke test uses a pseudo-terminal, a loopback-only fake provider, a temporary HOME and `PI_CODING_AGENT_DIR`, an empty auth file, an environment allowlist, and offline mode. It never reads your normal pi auth file or invokes 1Password. It exercises inspection, capture/diff/export, editing, cancellation, undo, and subsequent compaction. No real model calls or API charges.

For manual isolated testing, use a temporary `PI_CODING_AGENT_DIR` **and** disable resource discovery or use a temporary working directory. `--offline` alone does not isolate credentials or prevent explicit model calls.
