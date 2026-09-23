import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readFileSync } from "node:fs";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveAndReopen } from "../src/editing.ts";
import { commitRevision, proposeEdit, readSession } from "../src/revisions.ts";
import { CORRECTED, fixture, SUMMARY } from "./fixtures.ts";

function mockRuntime(path: string, options: { cancelPark?: boolean; cancelResume?: boolean; conflict?: boolean } = {}) {
  let generation = 0;
  let draft = "unsent user draft";
  const notices: string[] = [];
  const stages: string[] = [];
  const ui = { getEditorText: () => draft, setEditorText: (text: string) => { draft = text; }, notify: (text: string) => notices.push(text) };
  const make = (label: string): ExtensionCommandContext => {
    const mine = generation;
    const assertLive = () => assert.equal(generation, mine, `Stale ${label} context used`);
    return {
      get ui() { assertLive(); return ui; },
      isIdle: () => { assertLive(); return true; },
      hasPendingMessages: () => { assertLive(); return false; },
      get sessionManager() { assertLive(); return SessionManager.open(path); },
      newSession: async (args: any) => {
        assertLive();
        if (options.cancelPark) return { cancelled: true };
        stages.push("shutdown-original");
        appendFileSync(path, JSON.stringify({ type: options.conflict ? "custom_message" : "custom", id: "shutdown", parentId: "latest", timestamp: "x", customType: "test", content: "new conversation", display: false }) + "\n");
        generation++;
        draft = "";
        await args.withSession(make("parking"));
        return { cancelled: false };
      },
      switchSession: async (target: string, args: any) => {
        assertLive();
        assert.equal(target, path);
        stages.push("reopen-original");
        if (options.cancelResume) return { cancelled: true };
        generation++;
        await args.withSession(make("resumed"));
        // The interactive host posts this after the replacement callback returns.
        notices.push("Resumed session");
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;
  };
  return { ctx: make("original"), notices, stages, getDraft: () => draft };
}

test("detaches before writing, includes shutdown writes, resumes using fresh contexts and restores draft", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const runtime = mockRuntime(f.path);
  const proposal = proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED);
  await saveAndReopen(runtime.ctx, proposal, (p) => {
    assert.deepEqual(runtime.stages, ["shutdown-original"]);
    runtime.stages.push("commit");
    return commitRevision(p);
  });
  assert.deepEqual(runtime.stages, ["shutdown-original", "commit", "reopen-original"]);
  assert.equal(runtime.getDraft(), "unsent user draft");
  assert.ok(runtime.notices.at(-1)?.startsWith("Saved summary"));
  assert.equal(readSession(f.path).byId.get("compact")!.summary, CORRECTED);
});

test("refuses a branch that changed while the review was open", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const runtime = mockRuntime(f.path);
  const proposal = proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED);
  appendFileSync(f.path, JSON.stringify({ type: "custom_message", id: "arrived", parentId: "latest", timestamp: "x", customType: "background", content: "new context", display: true }) + "\n");
  await assert.rejects(saveAndReopen(runtime.ctx, proposal), /Session position changed/);
  assert.deepEqual(runtime.stages, []);
  assert.equal(readSession(f.path).byId.get("compact")!.summary, SUMMARY);
});

test("cancelled detachment does not change the session", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const runtime = mockRuntime(f.path, { cancelPark: true });
  await saveAndReopen(runtime.ctx, proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED));
  assert.equal(readFileSync(f.path, "utf8"), f.text);
  assert.ok(runtime.notices.some((notice) => notice.includes("file unchanged")));
});

test("cancelled resume reports that the edit IS saved, with recovery path", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const runtime = mockRuntime(f.path, { cancelResume: true });
  await saveAndReopen(runtime.ctx, proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED));
  assert.equal(readSession(f.path).byId.get("compact")!.summary, CORRECTED);
  assert.ok(runtime.notices.some((notice) => notice.includes("Summary saved, but resuming was cancelled") && notice.includes(f.path)));
});

test("commit conflict still reopens the original session, without modifying its summary", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const runtime = mockRuntime(f.path, { conflict: true });
  await saveAndReopen(runtime.ctx, proposeEdit(f.path, f.sessionId, "latest", "compact", SUMMARY, CORRECTED));
  assert.equal(readSession(f.path).byId.get("compact")!.summary, SUMMARY);
  assert.ok(runtime.stages.includes("reopen-original"));
  assert.ok(runtime.notices.some((notice) => notice.includes("Edit not applied")));
});
