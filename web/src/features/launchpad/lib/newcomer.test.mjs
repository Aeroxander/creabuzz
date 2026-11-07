import assert from "node:assert/strict";
import test from "node:test";

import { newcomerSteps } from "./newcomer.ts";

const base = {
  me: "a".repeat(64),
  founder: "f".repeat(64),
  holdsShares: false,
  read: false,
  myTakings: [],
  notes: [],
};

test("a newcomer sees three steps, ticked by what they did, until they took work on and a check note followed", () => {
  assert.deepEqual(newcomerSteps(base), {
    show: true,
    done: { read: false, take: false, check: false },
  });
  // A check note from before they took anything on does not count.
  const took = newcomerSteps({
    ...base,
    read: true,
    myTakings: [20, 10],
    notes: [5],
  });
  assert.deepEqual(took, {
    show: true,
    done: { read: true, take: true, check: false },
  });
  const finished = newcomerSteps({ ...base, myTakings: [10], notes: [5, 11] });
  assert.equal(finished.show, false);
  assert.equal(finished.done.check, true);
});

test("the card is not for the founder, for holders, for someone signed out, or before holdings are read", () => {
  assert.equal(newcomerSteps({ ...base, me: base.founder }).show, false);
  assert.equal(newcomerSteps({ ...base, holdsShares: true }).show, false);
  assert.equal(newcomerSteps({ ...base, holdsShares: null }).show, false);
  assert.equal(newcomerSteps({ ...base, me: null }).show, false);
});
