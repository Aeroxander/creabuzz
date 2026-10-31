import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTION_SIGNATURES } from "./daoActions.ts";
import { describeDecision } from "./decisionDescribe.ts";
import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import { votingRuleWatch } from "./voting-allocation.ts";
import { VOTING_RULE_SIGNATURES, votingRuleUnsafe } from "./votingRules.ts";

const DAO = "0x00000000000000000000000000000000000000d0";
const ELSEWHERE = "0x00000000000000000000000000000000000000e0";
const SHARE = 10n ** 18n;
const call = (key, value) =>
  encodeFunctionData(VOTING_RULE_SIGNATURES[key], ["uint256"], [value]);

test("the selectors are the DAO's (cast sig goldens)", () => {
  assert.equal(selectorOf(VOTING_RULE_SIGNATURES.quorumBps), "0x0527aab6");
  assert.equal(selectorOf(VOTING_RULE_SIGNATURES.minYes), "0xb83b4137");
  assert.equal(selectorOf(VOTING_RULE_SIGNATURES.quorumAbsolute), "0xcf9d6ed6");
  assert.equal(
    selectorOf(VOTING_RULE_SIGNATURES.proposalThreshold),
    "0x80ca42a1",
  );
});

test("a turnout share above 60% is unsafe, at or below it is not (funding review D2)", () => {
  const over = describeDecision(
    { to: DAO, data: call("quorumBps", 6_001n) },
    { dao: DAO },
  );
  assert.equal(over.kind, "voting-rules");
  assert.equal(over.unsafe, true);
  assert.match(over.title, /60\.01% of the Shares to take part/);
  assert.match(over.lines[0], /^Above the safe limit/);
  const at = describeDecision(
    { to: DAO, data: call("quorumBps", 6_000n) },
    { dao: DAO },
  );
  assert.equal(at.unsafe, false);
  assert.match(at.lines.at(-1), /Within the safe limit/);
});

test("a number of Shares is judged against the Shares that vote today, and said unknown without them", () => {
  const supply = 1_000_000n * SHARE;
  for (const key of ["minYes", "quorumAbsolute", "proposalThreshold"]) {
    const high = { to: DAO, data: call(key, 600_001n * SHARE) };
    const fine = { to: DAO, data: call(key, 600_000n * SHARE) };
    assert.equal(
      describeDecision(high, { dao: DAO, votingSupply: supply }).unsafe,
      true,
      key,
    );
    assert.equal(
      describeDecision(fine, { dao: DAO, votingSupply: supply }).unsafe,
      false,
      key,
    );
    const unknown = describeDecision(high, { dao: DAO });
    assert.equal(unknown.unsafe, null, key);
    assert.match(unknown.lines[1], /Check how many Shares vote/);
  }
  // The largest value the DAO accepts: every later decision would revert.
  const max = (1n << 96n) - 1n;
  assert.equal(votingRuleUnsafe("minYes", max, supply), true);
  assert.equal(votingRuleUnsafe("minYes", max, 0n), null);
});

test("only a call aimed at this DAO is read as a voting setting", () => {
  const sent = describeDecision(
    { to: ELSEWHERE, data: call("quorumBps", 10_000n) },
    { dao: DAO },
  );
  assert.equal(sent.kind, "unknown");
  assert.equal(
    describeDecision({ to: DAO, data: call("quorumBps", 10_000n) }, {}).kind,
    "unknown",
  );
});

test("a set of actions that hides a voting setting is flagged by its worst step", () => {
  const steps = [
    [DAO, 0n, call("quorumBps", 500n)],
    [DAO, 0n, call("minYes", 10n ** 30n)],
  ];
  const data = encodeFunctionData(
    ACTION_SIGNATURES.batchCalls,
    [{ array: { tuple: ["address", "uint256", "bytes"] } }],
    [steps],
  );
  const described = describeDecision(
    { to: DAO, data },
    { dao: DAO, votingSupply: 1_000n * SHARE },
  );
  assert.equal(described.kind, "voting-rules");
  assert.equal(described.unsafe, true);
  assert.match(
    described.title,
    /A set of 2 actions that changes how votes work/,
  );
});

test("voting against counts toward turnout, and the watch says so only while turnout is short (funding review D3)", () => {
  const rules = {
    quorum: 200n,
    votingSupply: 1_000n,
    approvalBps: 6_600n,
    minYes: 0n,
    bounded: false,
    hold: 0n,
    reviewEndsAt: 10n,
    expiresAt: 1_000n,
    delay: 0n,
  };
  const support = (yes, no) => ({
    yes,
    no,
    abstain: 0n,
    qualifiedSince: 0n,
  });
  assert.equal(
    votingRuleWatch(rules, support(140n, 0n), 5n).againstCounts,
    true,
  );
  // 140 for and 60 against: turnout is met, and 70% back it, so the votes against helped it over the bar.
  assert.equal(
    votingRuleWatch(rules, support(140n, 60n), 5n).againstCounts,
    false,
  );
  assert.equal(
    votingRuleWatch(rules, support(0n, 0n), 2_000n).againstCounts,
    false,
  );
});
