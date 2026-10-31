import assert from "node:assert/strict";
import { test } from "node:test";

import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";

import { LOCK_SIGNATURES } from "@creaton/core/launchpad/milestoneLock.ts";
import {
  balancesFromTransfers,
  MAX_TRANSFERS,
  percentOfSupply,
  readHolders,
  SHOWN_HOLDERS,
} from "./holders-read.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";

const DAO = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHARES = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const POLICY = "0xdddddddddddddddddddddddddddddddddddddddd";
const LOCK = "0xcccccccccccccccccccccccccccccccccccccccc";
const ZERO = `0x${"0".repeat(40)}`;
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const WAD = 10n ** 18n;

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const hex = (...words) => `0x${words.map(word).join("")}`;
const topic = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const TRANSFER = topicOf("Transfer(address,address,uint256)");
const transfer = (from, to, value) => ({
  topics: [TRANSFER, topic(from), topic(to)],
  data: hex(value),
  blockNumber: "0x1",
});

/** A fake chain: the Shares' history, a voting policy that keeps holding times (or reverts), and a milestone lock. */
function chain({
  history,
  supply,
  ages = {},
  policyReverts = false,
  locked = {},
  failBalances = false,
}) {
  return {
    async now() {
      return 2_000_000;
    },
    async logs() {
      if (failBalances) throw new Error("rpc down");
      return history;
    },
    async call(to, data) {
      const sel = data.slice(0, 10);
      if (to === DAO && sel === selectorOf("shares()")) return hex(SHARES);
      if (to === DAO && sel === selectorOf("votingWeight()"))
        return hex(POLICY);
      if (to === SHARES && sel === selectorOf("totalSupply()"))
        return hex(supply);
      if (
        to === SHARES &&
        sel === selectorOf(LOCK_SIGNATURES.sharesLockGuard)
      ) {
        return hex(LOCK);
      }
      const holder = `0x${data.slice(34, 74)}`;
      if (to === POLICY && sel === selectorOf("holdingAge(address)")) {
        if (policyReverts) throw new Error("execution reverted");
        const age = ages[holder];
        if (age === undefined) return hex(0, 0);
        return hex(age.balance, age.seconds);
      }
      if (to === LOCK && sel === selectorOf(LOCK_SIGNATURES.lockedOf)) {
        return hex(locked[holder] ?? 0n);
      }
      if (to === LOCK && sel === selectorOf(LOCK_SIGNATURES.trancheCount)) {
        return hex(0);
      }
      throw new Error(`unexpected call ${to} ${sel}`);
    },
  };
}

test("balances are the transfer history added up, with mints from the zero address and burns to it", () => {
  const balances = balancesFromTransfers([
    { from: ZERO, to: A, value: 100n },
    { from: A, to: B, value: 30n },
    { from: B, to: C, value: 10n },
    { from: C, to: ZERO, value: 4n },
  ]);
  assert.deepEqual([...balances.entries()].sort(), [
    [A, 70n],
    [B, 20n],
    [C, 6n],
  ]);
  // A wallet that sent everything is no longer a holder.
  assert.equal(
    balancesFromTransfers([
      { from: ZERO, to: A, value: 5n },
      { from: A, to: B, value: 5n },
    ]).has(A),
    false,
  );
});

test("the biggest holders come biggest first, with their share of the supply, how long they have held and what is locked", async () => {
  const history = [
    transfer(ZERO, A, 600n * WAD),
    transfer(ZERO, B, 300n * WAD),
    transfer(ZERO, C, 100n * WAD),
  ];
  const result = await readHolders(
    chain({
      history,
      supply: 1000n * WAD,
      ages: {
        [A]: { balance: 600n * WAD, seconds: 90 * 86400 },
        [B]: { balance: 300n * WAD, seconds: 3 * 86400 },
        [C]: { balance: 100n * WAD, seconds: 0 },
      },
      locked: { [A]: 400n * WAD },
    }),
    DAO,
  );
  assert.deepEqual(
    result.holders.map((h) => [h.holder, h.balance, h.locked, h.age]),
    [
      [A, 600n * WAD, 400n * WAD, 90 * 86400],
      [B, 300n * WAD, 0n, 3 * 86400],
      [C, 100n * WAD, 0n, 0],
    ],
  );
  assert.equal(result.found, 3);
  assert.equal(result.accounted, true);
  assert.equal(result.tracked, true);
  assert.equal(result.tooMany, false);
  assert.equal(percentOfSupply(600n * WAD, result.supply), "60.0");
});

test("a history that does not add up to the supply is said to be incomplete, not presented as the whole", async () => {
  const result = await readHolders(
    chain({
      history: [transfer(ZERO, A, 600n * WAD)],
      supply: 1000n * WAD,
      ages: { [A]: { balance: 600n * WAD, seconds: 1 } },
    }),
    DAO,
  );
  assert.equal(result.accounted, false);
  assert.equal(result.holders.length, 1);
});

test("a DAO made before holding times were kept is listed without times, not as a failure", async () => {
  const result = await readHolders(
    chain({
      history: [transfer(ZERO, A, 10n * WAD)],
      supply: 10n * WAD,
      policyReverts: true,
    }),
    DAO,
  );
  assert.equal(result.tracked, false);
  assert.deepEqual(
    result.holders.map((h) => [h.holder, h.balance, h.age]),
    [[A, 10n * WAD, null]],
  );
});

test("only the largest holders are listed, and the count says how many there are", async () => {
  const history = Array.from({ length: SHOWN_HOLDERS + 5 }, (_, i) =>
    transfer(
      ZERO,
      `0x${(i + 1).toString(16).padStart(40, "0")}`,
      BigInt(100 + i) * WAD,
    ),
  );
  const supply = history.reduce((sum, t) => sum + BigInt(t.data), 0n);
  const result = await readHolders(
    chain({ history, supply, policyReverts: true }),
    DAO,
  );
  assert.equal(result.holders.length, SHOWN_HOLDERS);
  assert.equal(result.found, SHOWN_HOLDERS + 5);
  assert.ok(result.holders[0].balance > result.holders[1].balance);
  assert.equal(result.accounted, true);
});

test("a history too long to add up lists nobody, and says so", async () => {
  const history = Array.from({ length: MAX_TRANSFERS + 1 }, () =>
    transfer(ZERO, A, 1n),
  );
  const result = await readHolders(chain({ history, supply: 1n }), DAO);
  assert.equal(result.tooMany, true);
  assert.deepEqual(result.holders, []);
});

test("a read that fails is an error, never an empty list", async () => {
  await assert.rejects(
    readHolders(chain({ history: [], supply: 0n, failBalances: true }), DAO),
    /rpc down/,
  );
});

test("a share of the supply is written to one decimal, and not at all when the supply is unknown", () => {
  assert.equal(percentOfSupply(1n, 3n), "33.3");
  assert.equal(percentOfSupply(0n, 5n), "0.0");
  assert.equal(percentOfSupply(5n, 5n), "100.0");
  assert.equal(percentOfSupply(5n, 0n), null);
});
