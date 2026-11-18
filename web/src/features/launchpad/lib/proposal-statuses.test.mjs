import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { knownDaosOf, proposalStatuses } from "./proposal-statuses.ts";

const DAO = `0x${"ab".repeat(20)}`;
const STRANGER = `0x${"cd".repeat(20)}`;
const D1 = `0x${"01".repeat(32)}`;
const D2 = `0x${"02".repeat(32)}`;

const launch = {
  record: {
    id: "l",
    chainId: "31337",
    treasury: DAO,
    tokenPlan: { mode: "dao" },
  },
  bids: [],
  updates: [],
  proposals: [],
  receipts: [],
};
const post = (id, dao, decision, chain = 31337) => ({
  id,
  proposal: { chainId: chain, dao, id: decision },
});
const decision = (id, state) => ({
  id,
  state,
  proposer: "0x0",
  openedAt: 1,
  queuedAt: 0,
  rules: { delay: 86_400n, reviewEndsAt: 5n },
  support: { yes: 0n, no: 0n, abstain: 0n },
  action: null,
  openedBy: null,
});
const snapshots = new Map([
  [
    DAO,
    {
      chainTime: 100,
      decisions: [decision(D1, "Active"), decision(D2, "Executed")],
    },
  ],
]);

describe("proposalStatuses", () => {
  it("gives each post its decision's state, and whether it can still change", () => {
    const out = proposalStatuses(
      [post("a", DAO, D1), post("b", DAO, D2)],
      [launch],
      snapshots,
    );
    assert.deepEqual(out.get("a"), {
      label: "Collecting support",
      tone: "open",
      live: true,
    });
    assert.deepEqual(out.get("b"), {
      label: "Done",
      tone: "done",
      live: false,
    });
  });

  it("gives nothing for a DAO no known launch owns, a decision the DAO does not list, or a post with no decision", () => {
    const out = proposalStatuses(
      [
        post("a", STRANGER, D1),
        post("b", DAO, `0x${"09".repeat(32)}`),
        post("c", DAO, D1, 1),
        { id: "d", proposal: null },
      ],
      [launch],
      new Map([...snapshots, [STRANGER, snapshots.get(DAO)]]),
    );
    assert.equal(out.size, 0);
  });
});

describe("knownDaosOf", () => {
  it("lists each DAO a known launch owns once, and skips strangers", () => {
    assert.deepEqual(
      knownDaosOf(
        [
          post("a", DAO, D1),
          post("b", DAO, D2),
          post("c", STRANGER, D1),
          { id: "d", proposal: null },
        ],
        [launch],
      ),
      [DAO],
    );
  });
});
