import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";
import { TOPIC_TRANSFER } from "./contributions.ts";
import { claimKey } from "./record-read.ts";
import { MAX_RUNWAY_LOGS, readRunwayInputs } from "./runway-read.ts";
import { encodeBalanceOf } from "@creaton/core/launchpad/workBounty.ts";
import { addressTopic, encodeCall0 } from "@creaton/core/launchpad/work.ts";

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const DAO = `0x${"d0".repeat(20)}`;
const USDC = `0x${"cc".repeat(20)}`;
const OTHER = `0x${"0c".repeat(20)}`;
const SHARES = `0x${"5e".repeat(20)}`;
const LOOT = `0x${"10".repeat(20)}`;
const BUDGET = `0x${"b1".repeat(20)}`;
const FOREIGN_BUDGET = `0x${"b2".repeat(20)}`;
const CLAIMS = `0x${"c1".repeat(20)}`;
const LEAVER = `0x${"1e".repeat(20)}`;
const VENDOR = `0x${"7e".repeat(20)}`;
const tx = (n) => `0x${word(n)}`;
const ZERO = `0x${"0".repeat(64)}`;

const claim = (id, status, amount) => ({
  id: `0x${word(id)}`,
  record: {
    contributor: VENDOR,
    amount,
    stake: 0n,
    status,
    evidenceHash: ZERO,
    checkHash: ZERO,
    expiresAt: 0,
    releasedAt: 0,
  },
  project: `0x${word(1)}`,
  approvals: 0,
  objections: 0,
  quorum: 2,
  sharesAwarded: false,
});

const work = (over = {}) => ({
  dao: DAO,
  milestonePanel: null,
  chainTime: 10_000,
  truncated: false,
  mandates: [
    {
      address: BUDGET,
      created: { currency: USDC },
      claimsAddress: CLAIMS,
      claims: [
        claim(1, "Paid", 40n),
        claim(2, "Approved", 25n),
        claim(3, "Open", 10n),
        claim(4, "Paid", 0n),
      ],
    },
    // A budget in another currency is left out of every figure.
    {
      address: FOREIGN_BUDGET,
      created: { currency: OTHER },
      claimsAddress: CLAIMS,
      claims: [claim(5, "Paid", 999n)],
    },
  ],
  ...over,
});

const record = (over = {}) => ({
  filedAt: new Map(),
  paidAt: new Map([[claimKey(BUDGET, `0x${word(1)}`), 9_000]]),
  paidTx: new Map(),
  verdicts: new Map(),
  promises: [],
  lock: null,
  truncated: false,
  ...over,
});

function chainWith({ outflows = 3 } = {}) {
  return {
    now: async () => 10_000,
    call: async (to, data) => {
      if (to === USDC && data === encodeBalanceOf(DAO)) return `0x${word(900)}`;
      if (to === USDC && data === encodeBalanceOf(BUDGET))
        return `0x${word(200)}`;
      if (to === DAO && data === encodeCall0("loot()"))
        return `0x${word(BigInt(LOOT))}`;
      if (to === CLAIMS) {
        // Reserved for the approved claim (2) and the open one (3).
        if (
          data ===
          encodeFunctionData("funded(bytes32)", ["bytes32"], [`0x${word(2)}`])
        )
          return `0x${word(25)}`;
        if (
          data ===
          encodeFunctionData("funded(bytes32)", ["bytes32"], [`0x${word(3)}`])
        )
          return `0x${word(10)}`;
      }
      throw new Error(`unexpected call ${to} ${data}`);
    },
    logs: async ({ address, topics }) => {
      assert.equal(topics[0], TOPIC_TRANSFER);
      if (address === USDC) {
        assert.equal(topics[1], addressTopic(DAO));
        const base = [
          { to: BUDGET, amount: 300, n: 1, block: 10 },
          { to: LEAVER, amount: 30, n: 2, block: 11 },
          { to: VENDOR, amount: 20, n: 3, block: 12 },
        ];
        const many = Array.from(
          { length: Math.max(0, outflows - 3) },
          (_, i) => ({ to: VENDOR, amount: 1, n: 100 + i, block: 13 }),
        );
        return [...base, ...many].slice(0, outflows).map((o) => ({
          topics: [TOPIC_TRANSFER, addressTopic(DAO), addressTopic(o.to)],
          data: `0x${word(o.amount)}`,
          blockNumber: `0x${o.block.toString(16)}`,
          transactionHash: tx(o.n),
        }));
      }
      if (address === SHARES) {
        // The leaver burned Shares in the transaction that paid them.
        return [
          {
            topics: [TOPIC_TRANSFER, addressTopic(LEAVER), ZERO],
            data: `0x${word(5)}`,
            blockNumber: "0xb",
            transactionHash: tx(2),
          },
        ];
      }
      if (address === LOOT) return [];
      throw new Error(`unexpected logs ${address}`);
    },
    blockTimes: async (blocks) => new Map(blocks.map((b) => [b, b * 100])),
  };
}

test("the treasury, the budgets with their reservations, and only real spending are read", async () => {
  const read = await readRunwayInputs(chainWith(), {
    dao: DAO,
    currency: USDC,
    shares: SHARES,
    work: work(),
    record: record(),
  });
  assert.equal(read.free, 900n);
  // 200 held by the budget + 25 + 10 reserved for the approved and the open claims.
  assert.equal(read.setAside, 235n);
  // 20 straight out to a vendor (block 12, time 1,200), and 40 paid to approved work at 9,000. The 300 into the budget
  // and the 30 to the leaver are not spending; the zero-money claim and the other currency's budget add nothing.
  assert.deepEqual(read.spends, [
    { amount: 20n, at: 1_200 },
    { amount: 40n, at: 9_000 },
  ]);
  assert.equal(read.incomplete, false);
});

test("missing payout times, a cut history or more outflows than the bound make the figures incomplete", async () => {
  const input = { dao: DAO, currency: USDC, shares: SHARES };
  const noRecord = await readRunwayInputs(chainWith(), {
    ...input,
    work: work(),
    record: undefined,
  });
  assert.equal(noRecord.incomplete, true);
  assert.deepEqual(noRecord.spends.at(-1), { amount: 40n, at: null });
  const cut = await readRunwayInputs(chainWith(), {
    ...input,
    work: work({ truncated: true }),
    record: record(),
  });
  assert.equal(cut.incomplete, true);
  const many = await readRunwayInputs(
    chainWith({ outflows: MAX_RUNWAY_LOGS + 5 }),
    { ...input, work: work(), record: record() },
  );
  assert.equal(many.incomplete, true);
});
