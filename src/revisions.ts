import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REVISION_TYPE = "pi-context.revision";
type RecordValue = Record<string, any>;
export interface SessionFile {
  text: string;
  lines: string[];
  header: RecordValue;
  entries: RecordValue[];
  byId: Map<string, RecordValue>;
}
export interface EditProposal {
  path: string;
  sessionId: string;
  leafId: string;
  entryId: string;
  before: string;
  after: string;
  baseline: string;
  action: "edit" | "undo";
  undoOf?: string;
}
export interface Revision {
  version: 1;
  id: string;
  sessionId: string;
  entryId: string;
  createdAt: string;
  action: "edit" | "undo";
  undoOf?: string;
  before: string;
  after: string;
  beforeHash: string;
  afterHash: string;
  backupPath: string;
}

export const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const revisionDirectory = (path: string): string => `${resolve(path)}.context-revisions`;

/** Unlike pi's permissive loader, editing must never silently drop malformed lines. */
export function parseSession(text: string): SessionFile {
  const lines = text.split("\n");
  const records: RecordValue[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error();
      records.push(record);
    } catch { throw new Error(`Invalid session JSON on line ${index + 1}; nothing was changed.`); }
  }
  const [header, ...entries] = records;
  if (!header || header.type !== "session" || header.version !== 3 || typeof header.id !== "string") {
    throw new Error("Editing requires a version 3 pi JSONL session. Nothing was changed.");
  }
  const byId = new Map<string, RecordValue>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id || byId.has(entry.id) || entry.type === "session") {
      throw new Error("Invalid or duplicate session entry ID; nothing was changed.");
    }
    if (entry.parentId !== null && (typeof entry.parentId !== "string" || !byId.has(entry.parentId))) {
      throw new Error(`Broken parent reference at ${entry.id}; nothing was changed.`);
    }
    byId.set(entry.id, entry);
  }
  return { text, lines, header, entries, byId };
}

export function readSession(path: string): SessionFile {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("Refusing to edit a non-regular, symlinked, or hard-linked session file.");
  }
  return parseSession(readFileSync(path, "utf8"));
}

export function branchAt(file: SessionFile, leafId: string): RecordValue[] {
  const path: RecordValue[] = [];
  let entry = file.byId.get(leafId);
  if (!entry) throw new Error("The selected session position no longer exists.");
  while (entry) {
    path.push(entry);
    entry = entry.parentId === null ? undefined : file.byId.get(entry.parentId);
  }
  return path.reverse();
}

export function proposeEdit(path: string, sessionId: string, leafId: string, entryId: string, expectedSummary: string, after: string): EditProposal {
  const file = readSession(path);
  if (file.header.id !== sessionId) throw new Error("Session identity changed on disk; reopen it before editing.");
  const compaction = branchAt(file, leafId).findLast((entry) => entry.type === "compaction");
  if (!compaction || compaction.id !== entryId) throw new Error("Only the active compaction on this branch can be edited.");
  if (compaction.summary !== expectedSummary) throw new Error("The summary changed on disk; reopen the session before editing.");
  if (expectedSummary === after) throw new Error("The summary is unchanged.");
  return { path: resolve(path), sessionId, leafId, entryId, before: expectedSummary, after, baseline: file.text, action: "edit" };
}

/** Revision stack is derived from the active branch, not directory timestamps. */
export function lastUndoableRevision(file: SessionFile, leafId: string): string | undefined {
  const stack: string[] = [];
  for (const entry of branchAt(file, leafId)) {
    if (entry.type !== "custom" || entry.customType !== REVISION_TYPE) continue;
    const data = entry.data;
    if (data?.action === "edit" && typeof data.revisionId === "string") stack.push(data.revisionId);
    else if (data?.action === "undo" && stack.at(-1) === data.undoOf) stack.pop();
  }
  return stack.at(-1);
}

export function proposeUndo(path: string, sessionId: string, leafId: string): EditProposal {
  const file = readSession(path);
  const id = lastUndoableRevision(file, leafId);
  if (!id) throw new Error("No summary edits to undo on this branch.");
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid revision ID.");
  const revision = JSON.parse(readFileSync(join(revisionDirectory(path), `${id}.json`), "utf8")) as Revision;
  if (revision.version !== 1 || revision.id !== id || revision.sessionId !== sessionId || revision.action !== "edit"
    || typeof revision.entryId !== "string" || typeof revision.before !== "string" || typeof revision.after !== "string") {
    throw new Error("Invalid revision record; restore from a backup manually.");
  }
  const proposal = proposeEdit(path, sessionId, leafId, revision.entryId, revision.after, revision.before);
  return { ...proposal, action: "undo", undoOf: id };
}

function writePrivate(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); }
  finally { closeSync(fd); }
}

/**
 * Call only after detaching the original session. Synchronous critical section:
 * backup + journal first, compare-before-rename, atomic replacement. The lock only
 * coordinates this extension; pi itself does not honor it. One pi writer is required.
 */
export function commitRevision(proposal: EditProposal): Revision {
  const directory = revisionDirectory(proposal.path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Unsafe revision directory.");
  const lockPath = join(directory, "write.lock");
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch { throw new Error(`Another edit may be in progress. Inspect ${lockPath} before retrying.`); }
  let temporary: string | undefined;
  try {
    const file = readSession(proposal.path);
    if (file.header.id !== proposal.sessionId || !file.text.startsWith(proposal.baseline)) {
      throw new Error("Session changed while editing; nothing was changed. Reopen and try again.");
    }
    // Shutdown hooks may append metadata. Preserve it, but never hide newly arrived
    // conversation messages or switch away from a concurrently created branch.
    const baseline = parseSession(proposal.baseline);
    let leafId = proposal.leafId;
    for (const entry of file.entries.slice(baseline.entries.length)) {
      if (!["custom", "label", "session_info"].includes(entry.type) || entry.parentId !== leafId) {
        throw new Error("Conversation or branch changed during shutdown; edit cancelled without changing the file.");
      }
      leafId = entry.id;
    }
    const branch = branchAt(file, leafId);
    const target = branch.findLast((entry) => entry.type === "compaction");
    if (!target || target.id !== proposal.entryId || target.summary !== proposal.before) {
      throw new Error("The active summary changed; nothing was changed.");
    }
    const id = randomUUID();
    let markerId: string;
    do { markerId = randomBytes(4).toString("hex"); } while (file.byId.has(markerId));
    const marker = {
      type: "custom", id: markerId, parentId: leafId, timestamp: new Date().toISOString(),
      customType: REVISION_TYPE,
      data: { revisionId: id, entryId: proposal.entryId, action: proposal.action, undoOf: proposal.undoOf },
    };
    const lines = file.lines.map((line) => {
      if (!line.trim()) return line;
      const record = JSON.parse(line);
      return record.id === target.id && record.type === "compaction"
        ? JSON.stringify({ ...record, summary: proposal.after }) : line;
    });
    let next = lines.join("\n");
    if (!next.endsWith("\n")) next += "\n";
    next += `${JSON.stringify(marker)}\n`;
    parseSession(next);
    const revision: Revision = {
      version: 1, id, sessionId: proposal.sessionId, entryId: target.id, createdAt: marker.timestamp,
      action: proposal.action, undoOf: proposal.undoOf, before: proposal.before, after: proposal.after,
      beforeHash: hash(file.text), afterHash: hash(next), backupPath: join(directory, `${id}.before.jsonl`),
    };
    writePrivate(revision.backupPath, file.text);
    // Prepared records without a matching session marker are never offered for undo.
    writePrivate(join(directory, `${id}.json`), JSON.stringify(revision, null, 2) + "\n");
    temporary = `${proposal.path}.${id}.tmp`;
    writePrivate(temporary, next);
    if (readSession(proposal.path).text !== file.text) throw new Error("Concurrent session write detected; edit cancelled.");
    renameSync(temporary, proposal.path);
    temporary = undefined;
    return revision;
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* Already removed or failed before creation. */ } }
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
