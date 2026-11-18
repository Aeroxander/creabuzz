import test from "node:test";
import assert from "node:assert/strict";

import {
  keepRemovals,
  removedByModerators,
  unfamiliarRemovers,
} from "./moderator-removals.ts";

const MOD = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const STRANGER = "c".repeat(64);

const message = (id, pubkey, kind = 9) => ({ id, pubkey, kind, tags: [] });
const removal = (id, sender, target) => ({
  id,
  pubkey: sender,
  kind: 9005,
  tags: [
    ["h", "room"],
    ["e", target],
  ],
});
const removers = new Set([MOD]);

test("a removal from an owner or admin takes away someone else's message", () => {
  const events = [message("m1", AUTHOR), removal("r1", MOD, "m1")];
  assert.deepEqual([...removedByModerators(events, removers)], ["m1"]);
});

test("a removal from anyone else is not applied, and its sender is named so the roster can be read again", () => {
  const events = [message("m1", AUTHOR), removal("r1", STRANGER, "m1")];
  assert.equal(removedByModerators(events, removers).size, 0);
  assert.deepEqual(unfamiliarRemovers(events, removers), [STRANGER]);
  // A known remover is never unfamiliar.
  assert.deepEqual(
    unfamiliarRemovers(
      [message("m1", AUTHOR), removal("r1", MOD, "m1")],
      removers,
    ),
    [],
  );
});

test("a moderator's own message is not a removal by a moderator", () => {
  const events = [message("m1", MOD), removal("r1", MOD, "m1")];
  assert.equal(removedByModerators(events, removers).size, 0);
  assert.deepEqual(unfamiliarRemovers(events, new Set()), []);
});

test("a removal only reaches a message in the room, never a reaction, an edit or a deletion", () => {
  const events = [
    message("m1", AUTHOR),
    message("react", AUTHOR, 7),
    message("edit", AUTHOR, 40003),
    message("gone", AUTHOR, 5),
    removal("r1", MOD, "react"),
    removal("r2", MOD, "edit"),
    removal("r3", MOD, "gone"),
    removal("r4", MOD, "not-loaded"),
  ];
  assert.equal(removedByModerators(events, removers).size, 0);
});

test("a removal stays in force for this reader after the moderator's role is withdrawn", () => {
  const events = [message("m1", AUTHOR), removal("r1", MOD, "m1")];
  const kept = keepRemovals(new Set(), events, removers);
  assert.deepEqual([...kept], ["m1"]);
  // The role is withdrawn: the same events no longer count on their own, but what was removed stays removed.
  assert.equal(removedByModerators(events, new Set()).size, 0);
  assert.deepEqual([...keepRemovals(kept, events, new Set())], ["m1"]);
  // Nothing new: the very same set comes back, so nothing downstream recomputes.
  assert.equal(keepRemovals(kept, events, removers), kept);
  // Something new from another moderator, after the first was demoted: it is added to what was kept, not put in its place.
  const NEXT = "d".repeat(64);
  const more = [...events, message("m2", AUTHOR), removal("r2", NEXT, "m2")];
  assert.deepEqual([...keepRemovals(kept, more, new Set([NEXT]))].sort(), [
    "m1",
    "m2",
  ]);
});
