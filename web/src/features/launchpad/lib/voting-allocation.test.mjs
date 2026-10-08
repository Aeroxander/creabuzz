import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_VOTING_SHARES,
  parseVotingShares,
  formatVotingShares,
  encodeVotingAllocationFor,
  decodeVotingAllocation,
  encodeVotingRules,
  decodeVotingRules,
  encodeVotingSupport,
  decodeVotingSupport,
  votingRulesSummary,
  votingRuleWatch,
} from "./voting-allocation.ts";
import {
  encodeCastVote,
  encodeCastVoteFor,
  encodeOpenProposalWithAction,
} from "./vote-tx.ts";
const owner = "0x1111111111111111111111111111111111111111";
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const response = (...n) => `0x${n.map(word).join("")}`;
test("exact allocation and withdrawal calldata use the canonical Solidity selectors", () => {
  const amount = parseVotingShares("1.5");
  assert.equal(amount, 1500000000000000000n);
  assert.equal(formatVotingShares(amount), "1.5");
  assert.equal(parseVotingShares("0"), 0n);
  assert.equal(parseVotingShares("0.000000000000000001"), 1n);
  assert.equal(
    encodeCastVote(1n, 1, 0n),
    `0x9c028176${word(1)}${word(1)}${word(0)}`,
  );
  assert.equal(
    encodeCastVoteFor(owner, 1n, 0, ALL_VOTING_SHARES),
    `0x87906434${owner.slice(2).padStart(64, "0")}${word(1)}${word(0)}${word(ALL_VOTING_SHARES)}`,
  );
  assert.equal(
    encodeVotingAllocationFor("1", owner),
    `0x54b31217${word(1)}${owner.slice(2).padStart(64, "0")}`,
  );
  assert.equal(encodeVotingSupport("1"), `0x4bcaf6aa${word(1)}`);
  assert.equal(
    encodeOpenProposalWithAction({
      op: 0,
      to: owner,
      value: 0n,
      data: "0x1234",
      nonce: `0x${word(0)}`,
    }).slice(0, 10),
    "0xe1d5ec31",
  );
});
test("replacing an existing allocation includes its Shares in eligibility", () => {
  assert.deepEqual(decodeVotingAllocation(response(30, 100, 100, 70, 1, 100)), {
    available: 30n,
    owned: 100n,
    eligible: 100n,
    amount: 70n,
    side: 1,
    opposable: 100n,
  });
  // Opposition is free: a fully committed holder can still oppose with everything they own.
  assert.equal(
    decodeVotingAllocation(response(0, 100, 0, 0, 0, 100)).opposable,
    100n,
  );
  for (const invalid of [
    "-1",
    "1e18",
    "1.",
    "1.0000000000000000001",
    (1n << 96n).toString(),
  ])
    assert.throws(() => parseVotingShares(invalid));
  for (const invalid of [
    "0x",
    response(101, 100, 1, 0, 1, 0),
    response(30, 100, 101, 70, 1, 0),
    response(30, 100, 50, 10, 1, 0),
    response(30, 100, 20, 70, 3, 0),
    response(30, 100, 20, 70, 1, 101),
  ])
    assert.throws(() => decodeVotingAllocation(invalid));
});
test("the bars are quorum and approval, and support has to hold", () => {
  // votingSupply 100, quorum 20, minYes 0, approval 66%, review ends 1000, expires 200000, delay 100, hold 50, unrestricted
  const rules = decodeVotingRules(
    response(100, 20, 0, 6600, 1000, 200000, 100, 50, 0),
  );
  assert.equal(encodeVotingRules("1"), `0xb1f792c9${word(1)}`);
  assert.match(
    votingRulesSummary(rules),
    /66% of the votes cast must be in favour/,
  );
  assert.match(votingRulesSummary(rules), /Treasury-level action/);
  assert.match(
    votingRulesSummary({ ...rules, bounded: true }),
    /funded budget/,
  );
  // 70 in favour, 30 against: 70% clears 66%, held since 900, review ends 1000
  const support = decodeVotingSupport(response(70, 30, 0, 900));
  assert.equal(votingRuleWatch(rules, support, 1000n).status, "leading");
  assert.equal(
    votingRuleWatch(rules, support, 999n).status,
    "holding",
    "the bars hold but review is not over",
  );
  assert.equal(
    votingRuleWatch(rules, { ...support, qualifiedSince: 990n }, 1010n).status,
    "holding",
    "review is over but the support arrived ten seconds ago and must hold 50",
  );
  assert.equal(
    votingRuleWatch(rules, { ...support, qualifiedSince: 990n }, 1040n).status,
    "leading",
  );
  // 62 of 100 cast is under 66%: opposition counts at once and says how many more Shares fix it
  const short = decodeVotingSupport(response(62, 38, 0, 0));
  const watch = votingRuleWatch(rules, short, 1000n);
  assert.equal(watch.status, "needs-votes");
  assert.match(watch.detail, /^In favour 0\.000000000000000062/);
  assert.match(watch.detail, /more Shares needed to meet the bars/);
  assert.equal(
    votingRuleWatch(rules, short, 1500n).status,
    "needs-votes",
    "plenty of time left",
  );
  assert.equal(votingRuleWatch(rules, short, 190000n).status, "at-risk");
  assert.equal(votingRuleWatch(rules, support, 200000n).status, "expired");
  // quorum: 15 cast is under 20 even at 100% approval
  assert.equal(
    votingRuleWatch(rules, decodeVotingSupport(response(15, 0, 0, 0)), 1500n)
      .status,
    "needs-votes",
  );
  assert.equal(decodeVotingRules(response(0, 0, 0, 0, 0, 0, 0, 0, 0)), null);
  assert.throws(
    () => decodeVotingRules(response(1, 1, 0, 6600, 900, 900, 1, 0, 0)),
    "expiry before review end",
  );
  assert.throws(
    () => decodeVotingRules(response(1, 1, 0, 5000, 100, 900, 1, 0, 0)),
    "approval must exceed half",
  );
  assert.throws(() => decodeVotingSupport(response(1, 0, 0, 1n << 64n)));
});
