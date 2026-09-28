# pi-context-inspector

A terminal-first pi extension for inspecting context, profiling token/tool usage, and correcting saved compaction summaries. Tested with pi **0.85.1**, Node 22.19+.

## Install

```sh
pi install git:github.com/slim-bean/pi-context-inspector
```

Then run `/reload` in an existing pi session (or start a new one), followed by `/context`.

## Try a local checkout

Run `npm ci --ignore-scripts`, then `pi -e ./src/index.ts` in the checkout and use `/context`. No global settings are changed. For an already-loaded extension, run `/reload` after changes.

To load a local checkout from elsewhere:

```sh
pi -e /absolute/path/to/pi-context/src/index.ts
# Or install the local package for future sessions:
pi install /absolute/path/to/pi-context
```

Avoid loading both an explicit extension path and the installed package in the same session.

## Commands and overlay

| Command | Purpose |
| --- | --- |
| `/context` | Current context preview |
| `/context request` | Last observed provider request |
| `/context diff` | Diff of the last two observed requests |
| `/context stats` | Tool usage, largest results, diagnostics, and call/result drill-down |
| `/context growth` | Request input growth from recorded assistant responses |
| `/context edit [entry-id]` | Edit the active compaction's Markdown, review, save and reopen |
| `/context undo` | Review and undo the latest still-applied summary edit on this branch |
| `/context export [path]` | Export preview and captures to a private JSON file; never overwrite |
| `/context help` | Quick reference |

Overlay keys: **1–5** tabs, **↑↓ / j k** select or scroll, **Tab** switch list/content focus, **h / l** focus list/content, **Enter** drill into a tool/group (otherwise switch focus), **Backspace** return to groups, **s** toggle size sorting, **PgUp/PgDn**, **Ctrl+u / Ctrl+d** half-page up/down, **Home / gg** beginning, **End / G** end, **/** full-text filter (including nested calls), **r** raw JSON, **F** toggle follow, **f** refresh, **y** copy section, **x** export, **e** edit selected compaction, **u** undo, **Esc / q** close. Movement applies to the focused pane; **G** moves once, whereas **F** keeps following. Narrow terminals show one pane at a time. Search Enter/Esc leaves search mode; clear the search text to reset the filter. Navigation letters are ordinary text during search. Switching tabs clears the filter.

### Live updates and following

Open `/context` while the agent or background work is running: all views refresh in place as session entries and observed requests arrive. **LIVE** keeps your selection, scroll, filter, and pane focus. Press **Shift+F** (`F`) to enter **FOLLOW**: switch to Preview, clear filtering/sorting, and follow the newest reconstructed session entry at the bottom of its content (not the summarized-history appendix). Press **F** again, navigate/scroll, search, sort, or switch tabs to stop following; live data updates continue.

Updates check in-memory session/capture revisions every 250 ms while the overlay is open, coalescing bursts without rebuilding unchanged snapshots. This tails **completed session entries**, not in-progress assistant tokens, partial tool output, or arbitrary subprocess stdout. A background process becomes visible here only when its output/notification is recorded in this session. No model calls or disk watchers are started; polling stops on close or session shutdown.

Editing uses pi's multiline editor, including **Ctrl+G** for an external editor. Enter submits to a separate diff review; **Enter there saves**, **Esc cancels**. Edits require an idle agent with no queued messages. Viewing never sends a model request or adds model context.

## What the views mean

- **Preview** combines pi's current system prompt, base prompt sources, active tool schemas, and compaction-aware branch entries. **`+` included**, **`·` reference only**, **`−` excluded**: not everything displayed in the right pane is sent. Hidden extension messages are included; UI-only state, `!!` output, and summarized-away history are labeled separately. Sources are shown where pi exposes them. This is **not a final-request prediction**: hooks, image settings and provider conversion can change it.
- **Last request** records `before_provider_request` without changing its payload. Later-loaded hooks can still modify it. Load this extension last when practical. Provider-private instructions and opaque reasoning cannot be decoded. Response token/cache usage is shown when observed.
- **Changes** compares the last two captured payloads, not arbitrary historic requests. It is not an exact cache-hit forecast.

Captures are memory-only, limited to the last two requests and **16 MiB each**. They clear on reload/resume (including summary edits). Oversized captures are explicitly skipped, never silently truncated. Large/expensive diffs fall back to an export suggestion. Text view abbreviates images; raw view and export retain the captured object. Raw terminal control characters are escaped for safe display.

## Token and tool profiling

**Preview** starts with a usage overview: pi's overall context estimate/window, a visible-content breakdown and percentages, and the largest included sections. Included rows have `~token` badges; **s** sorts largest first. Categories separate instructions, tool definitions, user/extension messages, assistant text, visible reasoning, call arguments/names, results, and summaries. Reference views and excluded history are not added to totals; raw storage metadata is not counted.

**Color is semantic and follows your pi theme.** Included `+` markers use success color; reference `·` and excluded `−` stay muted. Token badges use accent, with warning color for values at least half the largest badge in the current group (a relative size cue, not a capacity alarm). Breakdown bars show each category's share of estimated visible tokens. Tool rows show `!` for recorded errors, `?` for diagnostic signals, and `…` for missing/unmatched results; only actual errors use error color. Growth increases use warning color, decreases use success color, and zero/unknown deltas are dim—direction, not a quality rating. In Preview and Tools drill-down, failed tool-result labels and result text use error color (normally red) with a `!` marker, based on the recorded `isError` flag—not words such as “error” in the output. Arguments, successful results, raw JSON, and provider-specific Last request payloads stay neutral. Selection remains marked by an arrow and bold text; exports and clipboard text contain no generated ANSI.

**Estimates are not exact token counts.** They use visible text characters / 4, rounded per block; tool definitions and arguments use compact JSON. This local, model-independent heuristic can differ substantially by language/model. Images and opaque blocks/signatures have unknown costs (`+ ?`), not base64-as-text costs. Provider framing and conversion are excluded. Pi's overall estimate uses a different method and need not equal this breakdown. Last request shows normalized **provider-reported input/cache/output** separately; arbitrary provider JSON is not assigned a misleading token total. Input includes uncached input + cache read + cache write; output is separate. Cached tokens still occupy context.

**Tools** profiles the **active branch**, including summarized-away calls, not abandoned branches:
- Per tool: call/result/error counts, generated arguments/results, currently retained call/result content, and mean/median/p95/largest result size. Tool schemas remain separate in Preview.
- **Enter** a tool, Largest results, or Diagnostics to inspect individual call/result pairs; **Backspace** returns. Within call lists, **s** sorts by result size. Search finds nested calls too.
- Each pair includes arguments, result, entry IDs, retained size, and provider request input **at call issuance**. This is the input that produced the call, before its result existed. Parallel calls share it: it is not a marginal tool cost.
- Diagnostics flag exact repeated arguments, repeated/overlapping requested file ranges, large results (at least ~2k visible tokens), narrower follow-up reads, truncation/pagination, related errors followed by success, and similar search queries. Related-call checks look back 20 calls per tool and require an earlier completed result. Paths are compared lexically without reading files; read/query checks recognize common `path`/`offset`/`limit` and `query` arguments. Missing calls/results remain explicitly unmatched, not silently dropped.

Signals are **investigation aids, not accuracy scores**. Re-reads may be necessary; text can falsely suggest truncation; a later successful call need not be a correction. Actual accuracy requires outcome checks. Nested calls hidden inside MCP scripts or shell commands cannot be individually attributed. Retained results can recur in later requests; these estimates do not invent cumulative billing costs.

**Growth** reconstructs provider input/cache/output usage and input deltas from existing assistant responses on the active branch. Select a response for intervening tool-result estimates; **s** sorts by absolute input change. Comparisons reset across compaction, model changes, and missing/all-zero usage. Deltas include more than tool results and are not a causal attribution. This is not a log of every network retry, nested model call, or summarization request.

Profiling makes no model calls, reads no extra files, and writes no telemetry or session entries. Tool/Growth views survive reload by recomputing from existing session data; wire captures still retain only two requests in memory. Confirmed JSON exports (format version 2) include the new views and may contain summarized-away tool content as well as current context.

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

Unit tests use temporary fixtures and do not create an authenticated runtime. The real-TUI smoke test uses a pseudo-terminal, a loopback-only fake provider, a temporary HOME and `PI_CODING_AGENT_DIR`, an empty auth file, an environment allowlist, and offline mode. It never reads your normal pi auth file or invokes 1Password. It exercises live follow while a request is in flight, vim navigation, estimates, tool profiling/drill-down/resize, growth, capture/diff/export, editing, cancellation, undo, and subsequent compaction. No real model calls or API charges.

For manual isolated testing, use a temporary `PI_CODING_AGENT_DIR` **and** disable resource discovery or use a temporary working directory. `--offline` alone does not isolate credentials or prevent explicit model calls.
