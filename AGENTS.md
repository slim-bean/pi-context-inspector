# pi-context-inspector

- Read `README.md` before changing behavior. Extension entry: `src/index.ts`; dev loader: `.pi/extensions/context.ts`.
- Run `npm run check`, `npm test`, and `npm run test:tui` after changes.
- Never launch tests against the user's normal pi HOME/config/auth. Auth may invoke 1Password and block on biometrics. Use temporary HOME + `PI_CODING_AGENT_DIR`, offline mode, disabled resource discovery, and a fake local provider. Never read real credentials.
- Viewing/capturing must not mutate outgoing requests, inject messages, invoke a model, or implicitly log sensitive context.
- Keep preview and observed request semantics distinct. Captures must be bounded and must not claim visibility into later hooks or provider-private instructions.
- Session edits must detach the original runtime first, validate strict JSONL, preserve branch position/metadata, back up, check conflicts, atomically replace, and reopen using fresh contexts. Never mutate live SessionManager objects or use stale extension contexts.
- Undo replaces summary text, not the whole file. Respect branch ancestry and refuse superseded compactions. Pi itself does not honor the extension's write lock: document the single-writer requirement.
- Use injected TUI themes/keybindings; escape untrusted terminal controls and test narrow/wide terminals.
