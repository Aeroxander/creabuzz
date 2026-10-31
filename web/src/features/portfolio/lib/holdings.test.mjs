import assert from "node:assert/strict";
import { test } from "node:test";

import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";

import { LOCK_SIGNATURES } from "@creaton/core/launchpad/milestoneLock.ts";
import { describeAge, readHoldings } from "./holdings.ts";

const DAO = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_DAO = "0xdddddddddddddddddddddddddddddddddddddddd";
const BROKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const POLICY = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OLD_POLICY = "0xcccccccccccccccccccccccccccccccccccccccc";
const SHARES = "0x9999999999999999999999999999999999999999";
const LOCK = "0x8888888888888888888888888888888888888888";
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const WAD = 10n ** 18n;
const DAY = 86_400;

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const hex = (...words) => `0x${words.map(word).join("")}`;

/** A fake chain answering by address and selector. `held` is the policy's (balance, age) per wallet. */
function chain({ held = {}, locked = {}, brokenRpc = false } = {}) {
  return {
    async now() {
      return 1_000_000;
    },
    async logs() {
      return [];
    },
    async call(to, data) {
      const sel = data.slice(0, 10);
      if (to === BROKEN) throw new Error("rpc http 502");
      if (to === DAO && sel === selectorOf("votingWeight()"))
        return hex(POLICY);
      if (to === OLD_DAO && sel === selectorOf("votingWeight()"))
        return hex(OLD_POLICY);
      if (to === POLICY && sel === selectorOf("holdingAge(address)")) {
        if (brokenRpc) throw new Error("rpc http 500");
        const who = `0x${data.slice(-40)}`;
        const [balance, age] = held[who] ?? [0n, 0];
        return hex(balance, age);
      }
      if (to === OLD_POLICY) throw new Error("execution reverted");
      if (to === DAO && sel === selectorOf("shares()")) return hex(SHARES);
      if (
        to === SHARES &&
        sel === selectorOf(LOCK_SIGNATURES.sharesLockGuard)
      ) {
        return hex(Object.keys(locked).length ? LOCK : 0);
      }
      if (to === LOCK && sel === selectorOf(LOCK_SIGNATURES.lockedOf)) {
        return hex(locked[`0x${data.slice(-40)}`] ?? 0n);
      }
      if (to === LOCK && sel === selectorOf(LOCK_SIGNATURES.trancheCount)) {
        return hex(0);
      }
      throw new Error(`unexpected call ${to} ${sel}`);
    },
  };
}

test("what a wallet holds and for how long is read from the policy, with the chain's own clock", async () => {
  const result = await readHoldings(
    chain({ held: { [ME]: [200n * WAD, 45 * DAY] } }),
    [DAO],
    [ME],
  );
  assert.deepEqual(result.failed, []);
  assert.equal(result.holdings.length, 1);
  const [h] = result.holdings;
  assert.equal(h.balance, 200n * WAD);
  assert.equal(h.age, 45 * DAY);
  assert.equal(h.since, 1_000_000 - 45 * DAY);
  assert.equal(h.locked, 0n);
});

test("a wallet that holds nothing in a DAO is simply not listed", async () => {
  const result = await readHoldings(chain({ held: {} }), [DAO], [ME, OTHER]);
  assert.deepEqual(result, { holdings: [], failed: [] });
});

test("each wallet is read, and the longest holding comes first", async () => {
  const result = await readHoldings(
    chain({
      held: { [ME]: [10n * WAD, 5 * DAY], [OTHER]: [20n * WAD, 90 * DAY] },
    }),
    [DAO],
    [ME, OTHER],
  );
  assert.deepEqual(
    result.holdings.map((h) => h.owner),
    [OTHER, ME],
  );
});

test("Shares still locked behind milestones are reported beside the holding", async () => {
  const result = await readHoldings(
    chain({ held: { [ME]: [200n * WAD, DAY] }, locked: { [ME]: 120n * WAD } }),
    [DAO],
    [ME],
  );
  assert.equal(result.holdings[0].balance, 200n * WAD);
  assert.equal(result.holdings[0].locked, 120n * WAD);
});

test("a DAO made before the ledger existed is left out, not called a failure", async () => {
  const result = await readHoldings(chain(), [OLD_DAO], [ME]);
  assert.deepEqual(result, { holdings: [], failed: [] });
});

test("a read that fails is reported as failed, never as holding nothing", async () => {
  const unreachable = await readHoldings(chain(), [BROKEN], [ME]);
  assert.deepEqual(unreachable.failed, [BROKEN]);
  assert.deepEqual(unreachable.holdings, []);
  const brokenPolicy = await readHoldings(
    chain({ brokenRpc: true }),
    [DAO],
    [ME],
  );
  assert.deepEqual(brokenPolicy.failed, [DAO]);
});

test("one DAO failing does not hide another", async () => {
  const result = await readHoldings(
    chain({ held: { [ME]: [5n * WAD, 3 * DAY] } }),
    [BROKEN, DAO],
    [ME],
  );
  assert.deepEqual(result.failed, [BROKEN]);
  assert.equal(result.holdings.length, 1);
});

test("how long is said the way a person says it", () => {
  assert.equal(describeAge(0), "less than a day");
  assert.equal(describeAge(DAY - 1), "less than a day");
  assert.equal(describeAge(DAY), "1 day");
  assert.equal(describeAge(12 * DAY), "12 days");
  assert.equal(describeAge(59 * DAY), "59 days");
  assert.equal(describeAge(60 * DAY), "2 months");
  assert.equal(describeAge(400 * DAY), "13 months");
  assert.equal(describeAge(800 * DAY), "2 years");
});
