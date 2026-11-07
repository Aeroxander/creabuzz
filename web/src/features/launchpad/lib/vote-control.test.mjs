import assert from "node:assert/strict";
import test from "node:test";

import {
  controlOf,
  readVoteControl,
  sharesUntilShared,
  aloneUntil,
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
    // The DAO's own bars: quorumBps(), quorumAbsolute(), minYesVotesAbsolute(); off unless a test sets them.
    [`${DAO} 0xcd2ddd0c`]: w(0),
    [`${DAO} 0x6a34d91a`]: w(0),
    [`${DAO} 0x8ab8c683`]: w(0),
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
  assert.deepEqual(control.governor, {
    quorumBps: 0,
    quorumAbsolute: 0n,
    minYes: 0n,
  });
});

test("the DAO's own bars are read with the lanes'", async () => {
  const control = await readVoteControl(
    chain({
      [`${DAO} 0xcd2ddd0c`]: w(3000),
      [`${DAO} 0x6a34d91a`]: w(200n * WAD),
      [`${DAO} 0x8ab8c683`]: w(400n * WAD),
    }),
    DAO,
    POLICY,
    SHARES,
  );
  assert.deepEqual(control.governor, {
    quorumBps: 3000,
    quorumAbsolute: 200n * WAD,
    minYes: 400n * WAD,
  });
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
  governor: { quorumBps: 0, quorumAbsolute: 0n, minYes: 0n },
};

test("who can pass a decision alone: against everyone, only when nobody else votes, or not at all", () => {
  // 300 of 450 votes is 66.7%: at or above the two-thirds a decision needs, even if every other holder votes against.
  assert.equal(controlOf(300n * WAD, control), "alone");
  // 100 of 450 is 22%: above the 20% that must take part, below two-thirds.
  assert.equal(controlOf(100n * WAD, control), "unopposed");
  assert.equal(controlOf(50n * WAD, control), "shared");
  assert.equal(controlOf(0n, { ...control, votingSupply: 0n }), "shared");
});

test("every bar counts: the DAO's minimum in favour, its own turnout share, its turnout floor", () => {
  const withGovernor = (governor) => ({
    ...control,
    governor: { ...control.governor, ...governor },
  });
  // 300 of 450 clears two-thirds, but not a minimum of 400 votes in favour: it needs others.
  assert.equal(
    controlOf(300n * WAD, withGovernor({ minYes: 400n * WAD })),
    "shared",
  );
  // 100 of 450 clears the lane's 20% turnout, but not the DAO's own 30%...
  assert.equal(
    controlOf(100n * WAD, withGovernor({ quorumBps: 3000 })),
    "shared",
  );
  // ...nor a floor of 200 votes taking part.
  assert.equal(
    controlOf(100n * WAD, withGovernor({ quorumAbsolute: 200n * WAD })),
    "shared",
  );
  // A floor above every vote that counts: nothing of that kind can pass.
  assert.equal(
    controlOf(300n * WAD, withGovernor({ quorumAbsolute: 451n * WAD })),
    "nobody",
  );
  // Against everyone, votes for must be more than those against: exactly half is not enough even at a 50.01% bar.
  assert.equal(
    controlOf(225n * WAD, {
      ...control,
      full: { quorumBps: 2000, approvalBps: 5001 },
    }),
    "unopposed",
  );
  const lines = voteControlLines({
    who: "Alice",
    weight: 300n * WAD,
    control: withGovernor({ quorumBps: 3000, minYes: 400n * WAD }),
    kind: "contributors",
    shares: (v) => `${v / WAD}`,
  }).join(" ");
  assert.match(lines, /needs 30% of those votes to take part/);
  assert.match(lines, /Either needs at least 400 votes in favour/);
  assert.doesNotMatch(lines, /can pass any decision alone/);
  assert.match(
    voteControlLines({
      who: "Alice",
      weight: 300n * WAD,
      control: withGovernor({ quorumAbsolute: 451n * WAD }),
      kind: "contributors",
      shares: (v) => `${v / WAD}`,
    }).join(" "),
    /No decision that spends the project's money or changes the rules can pass now/,
  );
});

test("how many Shares others need before one holder no longer decides alone", () => {
  // 300 of 450: 300 must fall below 66% of all the votes, which takes more than 454.54… in all: about 4.55 more.
  assert.equal(sharesUntilShared(300n * WAD, control), 4545454545454545455n);
  assert.equal(sharesUntilShared(50n * WAD, control), 0n);
  // At the award bar (55%) the same holder keeps passing awards alone until the votes pass 300/0.55 = 545.45…
  assert.equal(
    sharesUntilShared(300n * WAD, control, control.bounded),
    95454545454545454546n,
  );
  // Below a 50% approval bar, holding more than half is what binds: 300 stops at 600 votes in all.
  assert.equal(
    sharesUntilShared(300n * WAD, control, { quorumBps: 0, approvalBps: 4000 }),
    150n * WAD,
  );
});

test("the numbers agree with controlOf: one Share fewer than the answer still leaves the holder alone, the answer does not", () => {
  for (const bars of [control.full, control.bounded]) {
    const weight = 300n * WAD;
    const more = sharesUntilShared(weight, control, bars);
    const at = (extra) =>
      controlOf(
        weight,
        { ...control, votingSupply: control.votingSupply + extra },
        bars,
      );
    assert.equal(at(more - 1n), "alone");
    assert.notEqual(at(more), "alone");
  }
});

test("each lane says how many more whole Shares others need, or nothing where the holder does not decide alone", () => {
  const until = aloneUntil(300n * WAD, control);
  assert.equal(until.full, 5n * WAD);
  assert.equal(until.bounded, 96n * WAD);
  // 260 of 450 is 57.8%: short of 66%, past 55%.
  const awardsOnly = aloneUntil(260n * WAD, control);
  assert.equal(awardsOnly.full, null);
  assert.equal(awardsOnly.bounded, 23n * WAD);
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
    /450 Shares bought in the sale are still waiting to be collected/,
  );
  assert.match(
    raise.join(" "),
    /with all of them collected, Alice would hold 33\.3%/,
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

  // 50 of 450 is 11.1%: short of the 20% for spending, but past the 10% an award or a work area needs.
  const awards = voteControlLines({
    who: "Alice",
    weight: 50n * WAD,
    control: { ...control, waiting: 0n },
    kind: "contributors",
    shares: (v) => `${v / WAD}`,
  });
  assert.match(
    awards.join(" "),
    /No single holder can pass a decision that spends the project's money or changes the rules alone, but Alice can pass an award or a work area that nobody else votes on/,
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
