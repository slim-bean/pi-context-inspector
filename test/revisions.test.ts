import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { appendFileSync, chmodSync, lstatSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { branchAt, commitRevision, lastUndoableRevision, parseSession, proposeEdit, proposeUndo, readSession, REVISION_TYPE, revisionDirectory } from "../src/revisions.ts";
import { CORRECTED, fixture, SUMMARY } from "./fixtures.ts";

function setup(t: TestContext) {
  const f = fixture();
  t.after(f.cleanup);
  return f;
}

test("edits only summary, preserves metadata/raw lines, backs up, and resumes edited context", (t) => {
  const f = setup(t);
  chmodSync(f.path, 0o644);
  const revision = commitRevision(proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED));
  assert.equal(readFileSync(revision.backupPath, "utf8"), f.text);
  const before = parseSession(f.text);
  const after = readSession(f.path);
  assert.deepEqual(after.byId.get("compact"), { ...before.byId.get("compact"), summary: CORRECTED });
  for (const line of before.lines.filter((line) => line && JSON.parse(line).id !== "compact")) assert.ok(after.lines.includes(line));
  assert.equal(after.entries.at(-1)?.customType, REVISION_TYPE);
  assert.equal(after.entries.at(-1)?.parentId, "latest");
  assert.equal(lstatSync(f.path).mode & 0o777, 0o600);
  assert.equal(lstatSync(revision.backupPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(revisionDirectory(f.path)).mode & 0o777, 0o700);
  const sm = SessionManager.open(f.path);
  const messages = sm.buildSessionContext().messages;
  assert.equal(messages[0].role, "compactionSummary");
  assert.equal((messages[0] as { summary: string }).summary, CORRECTED);
  assert.equal(messages.filter((message) => message.role === "compactionSummary").length, 1);
  assert.equal(messages.some((message) => JSON.stringify(message).includes(revision.id)), false);
});

test("preserves a navigated branch instead of reopening the last file branch", (t) => {
  const f = setup(t);
  appendFileSync(f.path, JSON.stringify({ type: "message", id: "alternate", parentId: "old-user", timestamp: "x", message: { role: "user", content: "other branch", timestamp: 4 } }) + "\n");
  commitRevision(proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED));
  const sm = SessionManager.open(f.path);
  assert.ok(sm.getEntry("alternate"));
  assert.equal(sm.getBranch().some((entry) => entry.id === "alternate"), false);
  assert.ok(sm.getBranch().some((entry) => entry.id === "latest"));
});

test("undo is branch-local, stacked, and preserves subsequent messages", (t) => {
  const f = setup(t);
  const first = commitRevision(proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED));
  let file = readSession(f.path);
  const second = commitRevision(proposeEdit(f.path, f.sessionId, file.entries.at(-1)!.id, "compact", CORRECTED, "Another revision"));
  file = readSession(f.path);
  appendFileSync(f.path, JSON.stringify({ type: "custom_message", id: "new-message", parentId: file.entries.at(-1)!.id, timestamp: "x", customType: "test", display: true, content: "New context must survive undo" }) + "\n");
  const undo = proposeUndo(f.path, f.sessionId, "new-message");
  assert.equal(undo.undoOf, second.id);
  commitRevision(undo);
  file = readSession(f.path);
  assert.equal(file.byId.get("compact")!.summary, CORRECTED);
  assert.ok(branchAt(file, file.entries.at(-1)!.id).some((entry) => entry.id === "new-message"));
  assert.equal(lastUndoableRevision(file, file.entries.at(-1)!.id), first.id);
  commitRevision(proposeUndo(f.path, f.sessionId, file.entries.at(-1)!.id));
  file = readSession(f.path);
  assert.equal(file.byId.get("compact")!.summary, SUMMARY);
  assert.equal(lastUndoableRevision(file, file.entries.at(-1)!.id), undefined);
  assert.throws(() => proposeUndo(f.path, f.sessionId, "latest"), /No summary edits/);
});

test("allows shutdown metadata appends without dropping them", (t) => {
  const f = setup(t);
  const proposal = proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED);
  appendFileSync(f.path, JSON.stringify({ type: "custom", id: "shutdown", parentId: "latest", timestamp: "x", customType: "saved-state", data: { counter: 2 } }) + "\n");
  commitRevision(proposal);
  const file = readSession(f.path);
  assert.equal(file.entries.at(-1)?.parentId, "shutdown");
  assert.ok(branchAt(file, file.entries.at(-1)!.id).some((entry) => entry.id === "shutdown"));
});

test("rejects conflicting edits and new conversation during shutdown", (t) => {
  const f = setup(t);
  const proposal = proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED);
  writeFileSync(f.path, f.text.replace("WRONG", "externally changed"));
  const conflict = readFileSync(f.path, "utf8");
  assert.throws(() => commitRevision(proposal), /Session changed/);
  assert.equal(readFileSync(f.path, "utf8"), conflict);
  writeFileSync(f.path, f.text);
  appendFileSync(f.path, JSON.stringify({ type: "message", id: "during-shutdown", parentId: "latest", timestamp: "x", message: { role: "user", content: "new prompt", timestamp: 4 } }) + "\n");
  const appended = readFileSync(f.path, "utf8");
  assert.throws(() => commitRevision(proposal), /Conversation or branch changed/);
  assert.equal(readFileSync(f.path, "utf8"), appended);
});

test("refuses malformed JSON, duplicate IDs, broken trees, unsupported versions, and symlinks", (t) => {
  const f = setup(t);
  assert.throws(() => parseSession(f.text + "{broken\n"), /Invalid session JSON/);
  assert.throws(() => parseSession(f.text + JSON.stringify(f.entries[1]) + "\n"), /duplicate/);
  assert.throws(() => parseSession(f.text.replace('"parentId":"latest"', '"parentId":"absent"') + JSON.stringify({ type: "custom", id: "broken", parentId: "absent" }) + "\n"), /Broken parent/);
  assert.throws(() => parseSession(f.text.replace('"version":3', '"version":99')), /version 3/);
  const link = join(f.dir, "link.jsonl");
  symlinkSync(f.path, link);
  assert.throws(() => readSession(link), /non-regular/);
});

test("empty summary changes text only, not the compaction boundary", (t) => {
  const f = setup(t);
  commitRevision(proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, ""));
  const file = readSession(f.path);
  assert.equal(file.byId.get("compact")!.firstKeptEntryId, "kept-user");
  assert.equal(file.byId.get("compact")!.summary, "");
});

test("refuses stale expected summary and stale undo after another compaction", (t) => {
  const f = setup(t);
  assert.throws(() => proposeEdit(f.path, f.sessionId, "latest", "compact", "stale", CORRECTED), /changed on disk/);
  commitRevision(proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED));
  const file = readSession(f.path);
  appendFileSync(f.path, JSON.stringify({ type: "compaction", id: "new-compaction", parentId: file.entries.at(-1)!.id, timestamp: "x", summary: "new", firstKeptEntryId: "latest", tokensBefore: 1000 }) + "\n");
  assert.throws(() => proposeUndo(f.path, f.sessionId, "new-compaction"), /Only the active compaction/);
});

test("existing write lock leaves the source untouched", (t) => {
  const f = setup(t);
  commitRevision(proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED));
  const file = readSession(f.path);
  const proposal = proposeUndo(f.path, f.sessionId, file.entries.at(-1)!.id);
  writeFileSync(join(revisionDirectory(f.path), "write.lock"), "busy");
  assert.throws(() => commitRevision(proposal), /Another edit/);
  assert.equal(readFileSync(f.path, "utf8"), file.text);
  assert.equal(readdirSync(revisionDirectory(f.path)).filter((name) => name.endsWith(".before.jsonl")).length, 1);
});
