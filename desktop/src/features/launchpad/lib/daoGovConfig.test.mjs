/**
 * `daoGovConfig.ts` under `node --test`: the D6 getter selectors pinned to
 * `cast sig`, and `loadDaoGovParams`' per-slot honesty (an unread slot is
 * null -> "per DAO config", never a guessed number).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DAO_GOV_GETTERS,
  encodeMinYes,
  encodeProposalTtl,
  encodeQuorumAbsolute,
  encodeQuorumBps,
  encodeTimelockDelay,
  loadDaoGovParams,
  SELECTOR_MIN_YES,
  SELECTOR_PROPOSAL_TTL,
  SELECTOR_QUORUM_ABSOLUTE,
  SELECTOR_QUORUM_BPS,
  SELECTOR_TIMELOCK_DELAY,
} from "./daoGovConfig.ts";

function word(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

test("dao config selectors match cast sig golden values", () => {
  const pins = [
    ["0xcd2ddd0c", SELECTOR_QUORUM_BPS],
    ["0x6a34d91a", SELECTOR_QUORUM_ABSOLUTE],
    ["0x8ab8c683", SELECTOR_MIN_YES],
    ["0x59a342d6", SELECTOR_PROPOSAL_TTL],
    ["0xeef09bad", SELECTOR_TIMELOCK_DELAY],
  ];
  for (const [expected, actual] of pins) {
    assert.equal(actual, expected);
  }
});

test("no-arg getters encode as their bare selectors", () => {
  assert.equal(encodeQuorumBps(), "0xcd2ddd0c");
  assert.equal(encodeQuorumAbsolute(), "0x6a34d91a");
  assert.equal(encodeMinYes(), "0x8ab8c683");
  assert.equal(encodeProposalTtl(), "0x59a342d6");
  assert.equal(encodeTimelockDelay(), "0xeef09bad");
});

test("loadDaoGovParams decodes every getter slot", async () => {
  const answers = {
    "0xcd2ddd0c": word(600),
    "0x6a34d91a": word(1000),
    "0x8ab8c683": word(100),
    "0x59a342d6": word(172_800),
    "0xeef09bad": word(86_400),
  };
  const params = await loadDaoGovParams(async (data) => answers[data]);
  assert.deepEqual(params, {
    quorumBps: 600,
    quorumAbsolute: 1000n,
    minYesAbsolute: 100n,
    ttlSeconds: 172_800,
    timelockSeconds: 86_400,
  });
});

test("loadDaoGovParams leaves unread slots null (never invented)", async () => {
  // One getter answers; one reverts; one returns garbage.
  const params = await loadDaoGovParams(async (data) => {
    if (data === "0xcd2ddd0c") return word(500);
    if (data === "0x6a34d91a") throw new Error("revert");
    return "0xdeadbeef";
  });
  assert.equal(params.quorumBps, 500);
  assert.equal(params.quorumAbsolute, null);
  assert.equal(params.minYesAbsolute, null);
  assert.equal(params.ttlSeconds, null);
  assert.equal(params.timelockSeconds, null);
});

test("DAO_GOV_GETTERS covers every params slot", () => {
  const slots = DAO_GOV_GETTERS.map((getter) => getter.slot).sort();
  assert.deepEqual(slots, [
    "minYesAbsolute",
    "quorumAbsolute",
    "quorumBps",
    "timelockSeconds",
    "ttlSeconds",
  ]);
});
