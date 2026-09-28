import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveRefresh } from "../src/live.ts";

test("live polling checks cheap revisions, coalesces changes, forces refresh and disposes", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let revision = 0;
  let reads = 0;
  const seen: number[] = [];
  const live = new LiveRefresh({
    revision: () => String(revision), read: () => ++reads,
    onError: (error) => { throw error; },
  }, (value) => seen.push(value));
  t.mock.timers.tick(1000);
  assert.equal(reads, 0, "no expensive rebuilding when nothing changed");
  revision += 3;
  t.mock.timers.tick(250);
  assert.deepEqual(seen, [1]);
  live.refresh(true);
  assert.deepEqual(seen, [1, 2]);
  live.dispose(); live.dispose();
  revision++;
  t.mock.timers.tick(1000);
  live.refresh(true);
  assert.equal(reads, 2, "no access to stale contexts after disposal");
});

test("live refresh errors stop polling and are reported once", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let fail = false;
  let errors = 0;
  const live = new LiveRefresh({
    revision: () => { if (fail) throw new Error("stale context"); return "initial"; },
    read: () => 1, onError: () => errors++,
  }, () => assert.fail("must not update"));
  fail = true;
  t.mock.timers.tick(250);
  t.mock.timers.tick(1000);
  live.refresh(true);
  assert.equal(errors, 1);
});
