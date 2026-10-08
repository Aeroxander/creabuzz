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
const scale = 10n ** 18n;
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
  assert.deepEqual(decodeVotingAllocation(response(30, 100, 100, 70, 1)), {
    available: 30n,
    owned: 100n,
    eligible: 100n,
    amount: 70n,
    side: 1,
  });
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
    response(101, 100, 1, 0, 1),
    response(30, 100, 101, 70, 1),
    response(30, 100, 50, 10, 1),
    response(30, 100, 20, 70, 3),
  ])
    assert.throws(() => decodeVotingAllocation(invalid));
});
test("current backing and conviction are separate gates and support never closes early", () => {
  const rules = decodeVotingRules(
    response(50, 51, 25n * scale, 1000, 2000, 100, 0),
  );
  assert.equal(encodeVotingRules("1"), `0xb1f792c9${word(1)}`);
  assert.match(votingRulesSummary(rules), /Current FOR ≥/);
  const support = decodeVotingSupport(
    response(60, 10, 0, 30n * scale, 5n * scale, 0),
  );
  assert.equal(votingRuleWatch(rules, support, 1000n).status, "leading");
  const changedMajority = decodeVotingSupport(
    response(60, 40, 0, 30n * scale, 39n * scale, 0),
  );
  assert.equal(
    votingRuleWatch(rules, changedMajority, 1000n).status,
    "leading",
    "older opposition cannot veto a current majority",
  );
  assert.match(
    votingRuleWatch(rules, support, 1000n).detail,
    /Support remains movable/,
  );
  assert.equal(
    votingRuleWatch(rules, { ...support, yes: 20n }, 1500n).status,
    "at-risk",
  );
  assert.equal(
    votingRuleWatch(rules, { ...support, convictionYes: 10n * scale }, 1000n)
      .status,
    "at-risk",
  );
  assert.equal(votingRuleWatch(rules, support, 2000n).status, "expired");
  assert.equal(decodeVotingRules(response(0, 0, 0, 0, 0, 0, 0)), null);
  assert.throws(() => decodeVotingRules(response(1, 1, 1, 1000, 900, 1, 0)));
  assert.throws(() => decodeVotingSupport(response(5, 0, 0, 6n * scale, 0, 0)));
});
