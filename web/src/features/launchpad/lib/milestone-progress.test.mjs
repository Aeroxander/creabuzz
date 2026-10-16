import assert from "node:assert/strict";
import test from "node:test";

import {
  claimForMilestone,
  milestoneClaimId,
  milestoneProgress,
} from "./milestone-progress.ts";

const WALLET = "0x00000000000000000000000000000000000000a1";
const CHECK = `0x${"cc".repeat(32)}`;
const WINDOW = 604_800;
const claim = (over = {}, record = {}) => ({
  id: `0x${"11".repeat(32)}`,
  record: {
    contributor: WALLET,
    checkHash: CHECK,
    status: "Open",
    releasedAt: 0,
    amount: 0n,
    ...record,
  },
  project: `0x${"22".repeat(32)}`,
  approvals: 0,
  objections: 0,
  quorum: 2,
  sharesAwarded: false,
  ...over,
});

test("a milestone nobody has submitted says so and has done nothing", () => {
  const p = milestoneProgress(null, 0, WINDOW, false);
  assert.equal(p.stage, "not-submitted");
  assert.equal(p.done, 0);
});

test("each state of a milestone claim is one stage with one plain sentence", () => {
  const at = (c, now = 0, unlocked = false) =>
    milestoneProgress(c, now, WINDOW, unlocked);
  assert.equal(at(claim({ project: null })).stage, "filed");
  assert.equal(at(claim()).stage, "reviewing");
  assert.match(at(claim({ approvals: 1 })).text, /1 of 2/);
  assert.equal(at(claim({ approvals: 2 })).stage, "reviewed");
  const approved = claim({}, { status: "Approved", releasedAt: 1000 });
  assert.equal(at(approved, 1000 + WINDOW - 1).stage, "waiting");
  assert.equal(at(approved, 1000 + WINDOW).stage, "finish");
  assert.equal(at(claim({}, { status: "Paid" })).stage, "ready");
  assert.equal(at(claim({}, { status: "Paid" }), 0, true).stage, "unlocked");
  assert.equal(at(claim({}, { status: "Frozen" })).stage, "frozen");
  assert.equal(at(claim({}, { status: "Rejected" })).stage, "turned-down");
  assert.equal(at(claim({}, { status: "Expired" })).stage, "turned-down");
});

test("the steps done only ever go forward as the claim does", () => {
  const order = [
    claim({ project: null }),
    claim(),
    claim({ approvals: 2 }),
    claim({}, { status: "Approved", releasedAt: 1000 }),
    claim({}, { status: "Paid" }),
  ];
  const done = order.map(
    (c, i) =>
      milestoneProgress(c, i === 3 ? 1000 + WINDOW + 1 : 0, WINDOW, false).done,
  );
  for (let i = 1; i < done.length; i += 1)
    assert.ok(done[i] >= done[i - 1], done.join());
});

test("a waiting period names the day it ends, and the unlock is for the lock to confirm, not the claim", () => {
  const approved = claim({}, { status: "Approved", releasedAt: 1_700_000_000 });
  assert.match(
    milestoneProgress(approved, 1_700_000_001, WINDOW, false).text,
    /until Nov 2[0-9], 2023|until Nov 2[0-9]/,
  );
  // Even a paid claim is "unlocked" only when the lock says so.
  assert.equal(
    milestoneProgress(claim({}, { status: "Paid" }), 0, WINDOW, false).stage,
    "ready",
  );
});

test("of several claims for one milestone the most advanced live one is shown, and only the wallet's own", () => {
  const stranger = claim(
    {},
    {
      contributor: "0x00000000000000000000000000000000000000b2",
      status: "Paid",
    },
  );
  const dead = claim({ id: "dead" }, { status: "Rejected" });
  const open = claim({ id: "open", project: null });
  const approved = claim({ id: "approved" }, { status: "Approved" });
  assert.equal(claimForMilestone([stranger, dead], WALLET, CHECK)?.id, "dead");
  assert.equal(
    claimForMilestone([dead, open, approved, stranger], WALLET, CHECK)?.id,
    "approved",
  );
  assert.equal(claimForMilestone([stranger], WALLET, CHECK), null);
  assert.equal(claimForMilestone([open], WALLET, `0x${"dd".repeat(32)}`), null);
});

test("a new milestone claim takes the next unused name", () => {
  assert.equal(milestoneClaimId(0, []), "milestone-1");
  assert.equal(milestoneClaimId(0, ["milestone-1"]), "milestone-1-2");
  assert.equal(
    milestoneClaimId(0, ["Milestone-1", "milestone-1-2"]),
    "milestone-1-3",
  );
  assert.equal(milestoneClaimId(2, ["milestone-1"]), "milestone-3");
});
