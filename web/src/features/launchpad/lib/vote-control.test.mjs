import assert from "node:assert/strict";
import test from "node:test";

import {
  controlOf,
  readVoteControl,
  sharesUntilShared,
  voteControlLines,
} from "./vote-control.ts";

const DAO = `0x${"d0".repeat(20)}`;
const POLICY = `0x${"90".repeat(20)}`;
const SHARES = `0x${"5a".repeat(20)}`;
const AUCTION = `0x${"ac".repeat(20)}`;
const WAD = 10n ** 18n;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const w = (n) => `0x${word(n)}`;
const addr = (a) => a.slice(2).padStart(64, "0");

/** `lanes(i)`: quorum, approval, review, hold, exclusive. */
const lane = (quorum, approval) =>
  `0x${[quorum, approval, 172800, 43200, 1].map(word).join("")}`;

function chain(over = {}) {
  const answers = {
    [`${SHARES} 0x18160ddd`]: w(1000n * WAD), // totalSupply
    [`${SHARES} 0x70a08231${addr(DAO)}`]: w(100n * WAD), // the DAO's own
    [`${SHARES} 0x70a08231${addr(AUCTION)}`]: w(450n * WAD), // still waiting to be claimed
    [`${POLICY} 0x713c311a${word(0)}`]: lane(2000, 6600),
    [`${POLICY} 0x713c311a${word(1)}`]: lane(1000, 5500),
    // excludedHolders(): one address, the auction
    [`${POLICY} 0x38f66048`]: `0x${word(32)}${word(1)}${addr(AUCTION)}`,
    ...over,
  };
  return async (to, data) => {
    const answer = answers[`${to.toLowerCase()} ${data}`];
    if (answer === undefined) throw new Error("execution reverted");
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

test("the votes that count leave out the DAO's own Shares and those still waiting in the auction", async () => {
  const control = await readVoteControl(chain(), DAO, POLICY, SHARES);
  assert.equal(control.votingSupply, 450n * WAD);
  assert.equal(control.waiting, 450n * WAD);
  assert.deepEqual(control.excluded, [AUCTION]);
  assert.deepEqual(control.full, { quorumBps: 2000, approvalBps: 6600 });
  assert.deepEqual(control.bounded, { quorumBps: 1000, approvalBps: 5500 });
});

test("a network failure is an error, never a share of the votes", async () => {
  await assert.rejects(
    readVoteControl(
      chain({ [`${SHARES} 0x18160ddd`]: new Error("rpc http 503") }),
      DAO,
      POLICY,
      SHARES,
    ),
  );
});

const control = {
  votingSupply: 450n * WAD,
  waiting: 450n * WAD,
  excluded: [AUCTION],
  full: { quorumBps: 2000, approvalBps: 6600 },
  bounded: { quorumBps: 1000, approvalBps: 5500 },
};

test("who can pass a decision alone: against everyone, only when nobody else votes, or not at all", () => {
  // 300 of 450 votes is 66.7%: at or above the two-thirds a decision needs, even if every other holder votes against.
  assert.equal(controlOf(300n * WAD, control), "alone");
  // 100 of 450 is 22%: above the 20% that must take part, below two-thirds.
  assert.equal(controlOf(100n * WAD, control), "unopposed");
  assert.equal(controlOf(50n * WAD, control), "shared");
  assert.equal(controlOf(0n, { ...control, votingSupply: 0n }), "shared");
});

test("how many Shares others need before one holder no longer decides alone", () => {
  // 300 of 450: 300 must fall below 66% of all the votes, which takes more than 454.54… in all: about 4.55 more.
  assert.equal(sharesUntilShared(300n * WAD, control), 4545454545454545455n);
  assert.equal(sharesUntilShared(50n * WAD, control), 0n);
});

test("the words say who decides now and what changes it, for a raise and for a contributor project", () => {
  const raise = voteControlLines({
    who: "Alice",
    weight: 300n * WAD,
    control,
    kind: "raise",
    shares: (v) => `${v / WAD}`,
  });
  assert.match(
    raise.join(" "),
    /Alice holds 66\.7% of the votes that count today/,
  );
  assert.match(
    raise.join(" "),
    /can pass any decision alone, even if every other holder votes against it/,
  );
  assert.match(
    raise.join(" "),
    /450 Shares bought in the sale are still waiting to be claimed/,
  );
  assert.match(
    raise.join(" "),
    /with all of them claimed, Alice would hold 33\.3%/,
  );

  const project = voteControlLines({
    who: "Alice",
    weight: 100n * WAD,
    control: { ...control, waiting: 0n, excluded: [] },
    kind: "contributors",
    shares: (v) => `${v / WAD}`,
  });
  assert.match(
    project.join(" "),
    /can pass a decision alone when nobody else votes/,
  );
  assert.match(
    project.join(" "),
    /changes only as Shares are awarded for accepted work, and as holders leave/,
  );

  // 50 of 450 is 11.1%: short of the 20% for spending, but past the 10% an award or a project needs.
  const awards = voteControlLines({
    who: "Alice",
    weight: 50n * WAD,
    control: { ...control, waiting: 0n },
    kind: "contributors",
    shares: (v) => `${v / WAD}`,
  });
  assert.match(
    awards.join(" "),
    /No single holder can pass a decision that spends the treasury or changes the rules alone, but Alice can pass an award or a project that nobody else votes on/,
  );
  const shared = voteControlLines({
    who: "Alice",
    weight: 40n * WAD,
    control: { ...control, waiting: 0n },
    kind: "contributors",
    shares: (v) => `${v / WAD}`,
  });
  assert.match(shared.join(" "), /No single holder can pass a decision alone/);
});
