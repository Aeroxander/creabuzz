import assert from "node:assert/strict";
import test from "node:test";

import { checkFoundryLock, lockRevs } from "./check-foundry-lock.mjs";

test("lockRevs reads both rev and tag pins", () => {
  assert.deepEqual(
    lockRevs({ "lib/a": { rev: "aaa" }, "lib/b": { tag: { name: "v1", rev: "bbb" } } }),
    { "lib/a": "aaa", "lib/b": "bbb" },
  );
});

test("a matching lock is consistent", () => {
  assert.deepEqual(checkFoundryLock({ "lib/a": "aaa" }, { "lib/a": "aaa" }), []);
});

test("a stale rev, a missing gitlink and an unlocked gitlink are each reported", () => {
  const problems = checkFoundryLock(
    { "lib/a": "old", "lib/gone": "ccc" },
    { "lib/a": "new", "lib/extra": "ddd" },
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0], /lib\/a: foundry\.lock pins old but the gitlink is new/);
  assert.match(problems[1], /lib\/gone: in foundry\.lock but not a submodule/);
  assert.match(problems[2], /lib\/extra: gitlink has no foundry\.lock entry/);
});
