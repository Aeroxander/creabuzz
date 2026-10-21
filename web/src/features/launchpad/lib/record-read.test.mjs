import assert from "node:assert/strict";
import { test } from "node:test";

import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";

import { LOCK_SIGNATURES } from "./milestone-lock.ts";
import {
  claimKey,
  MAX_RECORD_LOGS,
  readRecordEvents,
  readTeamPromises,
} from "./record-read.ts";
import { TOPIC_CLAIM_SUBMITTED, topicOf } from "./work.ts";

const DAO = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHARES = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LOCK = "0xcccccccccccccccccccccccccccccccccccccccc";
const FOUNDER = "0x1111111111111111111111111111111111111111";
const EXECUTOR = "0x5555555555555555555555555555555555555555";
const REVIEWER = "0x7777777777777777777777777777777777777777";
const MANDATE = "0x2222222222222222222222222222222222222222";
const CLAIMS = "0x4444444444444444444444444444444444444444";
const VERIFIERS = "0x6666666666666666666666666666666666666666";
const CLAIM = `0x${"33".repeat(32)}`;
const CHECK_A = `0x${"a1".repeat(32)}`;
const CHECK_B = `0x${"b2".repeat(32)}`;
const WAD = 10n ** 18n;

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const hex = (...words) => `0x${words.map(word).join("")}`;
const topicAddress = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const at = (block) => `0x${block.toString(16)}`;

const TRANSFER = topicOf("Transfer(address,address,uint256)");
const UNLOCKED = topicOf("Unlocked(address,uint256,uint96,bytes32,uint256)");
const ATTESTED = topicOf("Attested(bytes32,address,bool)");
const PAID = topicOf("ClaimPaid(bytes32)");

/** A fake chain answering calls by selector and logs by address and first topic. */
function chain({
  lockGuard = LOCK,
  tranches = {
    [FOUNDER]: [
      { check: CHECK_A, amount: 100n * WAD, unlocked: true, forfeited: false },
      { check: CHECK_B, amount: 60n * WAD, unlocked: false, forfeited: false },
    ],
  },
  logs = [],
  blocks = {},
} = {}) {
  return {
    async now() {
      return 2_000_000;
    },
    async call(to, data) {
      const sel = data.slice(0, 10);
      if (to === DAO && sel === selectorOf("shares()")) return hex(SHARES);
      if (to === SHARES && sel === selectorOf("lockGuard()")) {
        return hex(lockGuard);
      }
      const holder = `0x${data.slice(34, 74)}`;
      const list = tranches[holder] ?? [];
      if (to === LOCK && sel === selectorOf(LOCK_SIGNATURES.lockedOf)) {
        return hex(
          list
            .filter((t) => !t.unlocked && !t.forfeited)
            .reduce((a, t) => a + t.amount, 0n),
        );
      }
      if (to === LOCK && sel === selectorOf(LOCK_SIGNATURES.trancheCount)) {
        return hex(list.length);
      }
      if (to === LOCK && sel === selectorOf(LOCK_SIGNATURES.trancheOf)) {
        const t = list[Number(BigInt(`0x${data.slice(-64)}`))];
        return hex(t.check, t.amount, t.unlocked ? 1 : 0, t.forfeited ? 1 : 0);
      }
      throw new Error(`unexpected call ${to} ${sel}`);
    },
    async logs({ address, topics }) {
      return logs.filter(
        (l) =>
          l.address === address &&
          l.topics[0] === topics[0] &&
          (topics[1] == null || l.topics[1] === topics[1]),
      );
    },
    async blockTimes(wanted) {
      return new Map(
        wanted.filter((b) => b in blocks).map((b) => [b, blocks[b]]),
      );
    },
  };
}

const mint = (to) => ({
  address: SHARES,
  topics: [TRANSFER, topicAddress("0x" + "0".repeat(40)), topicAddress(to)],
  data: hex(1n),
  blockNumber: at(5),
});

const work = (overrides = {}) => ({
  dao: DAO,
  chainTime: 2_000_000,
  truncated: false,
  mandates: [
    {
      address: MANDATE,
      claimsAddress: CLAIMS,
      verifiersAddress: VERIFIERS,
    },
  ],
  ...overrides,
});

test("the team's milestones are found from who was minted Shares, and the others are left out", async () => {
  const result = await readTeamPromises(
    chain({
      logs: [
        mint(FOUNDER),
        mint(EXECUTOR),
        {
          address: LOCK,
          topics: [
            UNLOCKED,
            topicAddress(FOUNDER),
            topicAddress("0x" + "0".repeat(39) + "0"),
          ],
          data: hex(100n * WAD, BigInt(CLAIM), 1),
          blockNumber: at(50),
        },
      ],
    }),
    DAO,
  );
  assert.equal(result.lock, LOCK);
  assert.equal(result.promises.length, 1);
  const [founder] = result.promises;
  assert.equal(founder.holder, FOUNDER);
  assert.equal(founder.locked, 60n * WAD);
  assert.equal(founder.tranches[0].unlocked, true);
  assert.equal(founder.tranches[0].claimId, CLAIM);
  assert.equal(founder.tranches[1].claimId, null);
  assert.equal(result.unlockBlocks.get(`${FOUNDER}:0`), 50);
});

test("a DAO with no lock has no promises, and says there is no lock", async () => {
  const result = await readTeamPromises(
    chain({ lockGuard: "0x" + "0".repeat(40), logs: [mint(FOUNDER)] }),
    DAO,
  );
  assert.deepEqual(result.promises, []);
  assert.equal(result.lock, null);
});

test("when a claim was filed and paid, and who said what, come from the logs", async () => {
  const events = await readRecordEvents(
    chain({
      logs: [
        {
          address: CLAIMS,
          topics: [TOPIC_CLAIM_SUBMITTED, CLAIM],
          data: hex(BigInt(FOUNDER), 10n, 0n, 0n),
          blockNumber: at(10),
        },
        {
          address: CLAIMS,
          topics: [PAID, CLAIM],
          data: "0x",
          blockNumber: at(20),
          transactionHash: `0x${"9a".repeat(32)}`,
        },
        {
          address: VERIFIERS,
          topics: [ATTESTED, CLAIM, topicAddress(REVIEWER)],
          data: hex(1n),
          blockNumber: at(15),
        },
      ],
      blocks: { 10: 1_000, 20: 3_000 },
    }),
    work(),
  );
  const key = claimKey(MANDATE, CLAIM);
  assert.equal(events.filedAt.get(key), 1_000);
  assert.equal(events.paidAt.get(key), 3_000);
  // The payout's own transaction, so the page can link it.
  assert.equal(events.paidTx.get(key), `0x${"9a".repeat(32)}`);
  assert.deepEqual(events.verdicts.get(key), [
    { reviewer: REVIEWER, approve: true },
  ]);
  assert.equal(events.truncated, false);
});

test("a block whose time cannot be read leaves no date, never a guessed one", async () => {
  const events = await readRecordEvents(
    chain({
      logs: [
        {
          address: CLAIMS,
          topics: [TOPIC_CLAIM_SUBMITTED, CLAIM],
          data: hex(BigInt(FOUNDER), 10n, 0n, 0n),
          blockNumber: at(10),
        },
      ],
      blocks: {},
    }),
    work(),
  );
  assert.equal(events.filedAt.size, 0);
});

test("more history than the bound is read newest-first and reported as cut", async () => {
  const many = Array.from({ length: MAX_RECORD_LOGS + 5 }, (_, i) => ({
    address: CLAIMS,
    topics: [PAID, `0x${word(i + 1)}`],
    data: "0x",
    blockNumber: at(i + 1),
  }));
  const events = await readRecordEvents(chain({ logs: many }), work());
  assert.equal(events.truncated, true);
  assert.equal(events.paidAt.size, 0); // no block times were given
});
