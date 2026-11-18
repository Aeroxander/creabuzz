import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData } from "./evmAbi.ts";
import { addressTopic, encodeCall0 } from "./work.ts";
import {
  BOUNTY_SIGNATURES,
  MAX_BOUNTIES,
  TOPIC_BOUNTY_FUNDED,
  TOPIC_BOUNTY_OPENED,
  bountyStage,
  bountyTakesMoney,
  decodeBounty,
  encodeBalanceOf,
  encodeFundBounty,
  encodeOpenBounty,
  encodeRefundBounty,
  encodeSettleBounty,
  readWorkBounties,
} from "./workBounty.ts";

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const words = (...values) => `0x${values.map(word).join("")}`;
const MANDATE = "0x1111111111111111111111111111111111111111";
const OTHER_MANDATE = "0x3333333333333333333333333333333333333333";
const FUNDER = "0x2222222222222222222222222222222222222222";
const BOUNTY = "0x00000000000000000000000000000000000000b0";
const USDC = "0x00000000000000000000000000000000000000cc";
const DAVE = "0x00000000000000000000000000000000000000da";
const DOCS = `0x${Buffer.from("docs").toString("hex").padEnd(64, "0")}`;
const SITE = `0x${Buffer.from("site").toString("hex").padEnd(64, "0")}`;
const CLAIM_A = `0x${"aa".padStart(64, "0")}`;
const CLAIM_B = `0x${"bb".padStart(64, "0")}`;

// ---- calls, pinned against `cast calldata` -------------------------------------------------------

test("the calls match cast calldata byte for byte", () => {
  assert.equal(
    encodeOpenBounty(MANDATE, DOCS, 1767225600, 150_000_000n),
    "0x59f769c60000000000000000000000001111111111111111111111111111111111111111646f637300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006955b9000000000000000000000000000000000000000000000000000000000008f0d180",
  );
  assert.equal(
    encodeFundBounty(3n, 25_000_000n),
    "0xa65e2cfd000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000017d7840",
  );
  assert.equal(
    encodeSettleBounty(3n, CLAIM_A),
    "0xc54fc656000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000aa",
  );
  assert.equal(
    encodeRefundBounty(3n, FUNDER),
    "0x7ad226dc00000000000000000000000000000000000000000000000000000000000000030000000000000000000000002222222222222222222222222222222222222222",
  );
  assert.equal(
    TOPIC_BOUNTY_OPENED,
    "0xef5560bbdc32d25f9777db72bc9ab602d445493362b62a25484b4203dcd69d71",
  );
  assert.equal(
    TOPIC_BOUNTY_FUNDED,
    "0x9a98994924b3f454e430a7e3c884aa145467ff2913f30a4b4c428a25797c7975",
  );
});

test("a call with nothing in it, or a malformed id, is refused before anything is signed", () => {
  assert.throws(
    () => encodeOpenBounty(MANDATE, DOCS, 1767225600, 0n),
    /above zero/,
  );
  assert.throws(() => encodeFundBounty(1n, 0n), /above zero/);
  assert.throws(() => encodeFundBounty(1n, 1n << 128n), /above zero/);
  assert.throws(() => encodeOpenBounty("0x12", DOCS, 1, 1n), /address/);
  assert.throws(() => encodeOpenBounty(MANDATE, "0x12", 1, 1n), /32-byte/);
  assert.throws(() => encodeOpenBounty(MANDATE, DOCS, 1.5, 1n), /deadline/);
  assert.throws(() => encodeSettleBounty(1n, "docs"), /32-byte/);
  assert.throws(() => encodeRefundBounty(1n, "nobody"), /address/);
});

// ---- the record ----------------------------------------------------------------------------------

const record = (over = {}) => ({
  mandate: MANDATE,
  openedAt: 1_000,
  deadline: 10_000,
  projectId: DOCS,
  window: 700,
  refundsFrom: 10_000 + 700 + 1_400,
  total: 150_000_000n,
  refunded: 0n,
  paidClaim: null,
  contributor: null,
  ...over,
});

test("a bounty record decodes from its ten words, and an unknown one is null", () => {
  const hex = words(
    BigInt(MANDATE),
    1_000,
    10_000,
    BigInt(DOCS),
    700,
    12_100,
    150_000_000n,
    0,
    0,
    0,
  );
  assert.deepEqual(decodeBounty(hex), record());
  const paid = words(
    BigInt(MANDATE),
    1,
    2,
    BigInt(DOCS),
    3,
    4,
    5,
    0,
    BigInt(CLAIM_A),
    BigInt(DAVE),
  );
  assert.equal(decodeBounty(paid).paidClaim, CLAIM_A);
  assert.equal(decodeBounty(paid).contributor, DAVE);
  assert.equal(decodeBounty(words(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)), null);
  assert.equal(decodeBounty("0x"), null);
});

// ---- where a bounty stands -------------------------------------------------------------------------

const claim = (over = {}) => ({
  id: CLAIM_A,
  project: DOCS,
  approvals: 2,
  objections: 0,
  quorum: 2,
  sharesAwarded: false,
  ...over,
  record: {
    contributor: DAVE,
    amount: 0n,
    stake: 0n,
    status: "Approved",
    evidenceHash: CLAIM_A,
    checkHash: CLAIM_A,
    expiresAt: 99_999,
    releasedAt: 5_000,
    ...(over.record ?? {}),
  },
});

test("the stage follows the contract's order over every combination that matters", () => {
  const cases = [
    // [what, bounty, claims, now, expected kind]
    ["nothing yet, before the deadline", record(), [], 5_000, "open"],
    ["nothing in time, after the deadline", record(), [], 10_000, "waiting"],
    [
      "nothing in time, refunds open exactly at refundsFrom",
      record(),
      [],
      12_100,
      "refunds",
    ],
    ["one second before refunds", record(), [claim()], 12_099, "payable"],
    [
      "a qualifying submission still in its window",
      record(),
      [claim()],
      5_699,
      "in-window",
    ],
    [
      "the window ends exactly at release + window",
      record(),
      [claim()],
      5_700,
      "payable",
    ],
    [
      "a paid-out submission still pays the bounty",
      record(),
      [claim({ record: { status: "Paid" } })],
      6_000,
      "payable",
    ],
    [
      "a frozen submission does not count",
      record(),
      [claim({ record: { status: "Frozen" } })],
      6_000,
      "open",
    ],
    [
      "a rejected submission does not count",
      record(),
      [claim({ record: { status: "Rejected" } })],
      6_000,
      "open",
    ],
    [
      "an open submission does not count",
      record(),
      [claim({ record: { status: "Open", releasedAt: 0 } })],
      6_000,
      "open",
    ],
    [
      "another work area does not count",
      record(),
      [claim({ project: SITE })],
      6_000,
      "open",
    ],
    [
      "an unbound submission does not count",
      record(),
      [claim({ project: null })],
      6_000,
      "open",
    ],
    [
      "released before the bounty opened",
      record(),
      [claim({ record: { releasedAt: 999 } })],
      6_000,
      "open",
    ],
    [
      "released the second it opened",
      record(),
      [claim({ record: { releasedAt: 1_000 } })],
      6_000,
      "payable",
    ],
    [
      "released at the deadline",
      record(),
      [claim({ record: { releasedAt: 10_000 } })],
      10_700,
      "payable",
    ],
    [
      "released a second after the deadline",
      record(),
      [claim({ record: { releasedAt: 10_001 } })],
      10_701,
      "waiting",
    ],
    [
      "refunds win over a late qualifying submission",
      record(),
      [claim()],
      12_100,
      "refunds",
    ],
    [
      "paid stays paid, even past refundsFrom",
      record({ paidClaim: CLAIM_A, contributor: DAVE }),
      [],
      99_000,
      "paid",
    ],
  ];
  for (const [what, bounty, claims, now, kind] of cases) {
    assert.equal(bountyStage(bounty, claims, now).kind, kind, what);
  }
});

test("the earliest qualifying submission is the one offered, with when it can be paid", () => {
  const early = claim({
    id: CLAIM_B,
    record: { releasedAt: 4_000, contributor: FUNDER },
  });
  const late = claim({ record: { releasedAt: 6_000 } });
  assert.deepEqual(bountyStage(record(), [late, early], 4_500), {
    kind: "in-window",
    claimId: CLAIM_B,
    contributor: FUNDER,
    payableAt: 4_700,
  });
  assert.deepEqual(bountyStage(record(), [late, early], 4_700), {
    kind: "payable",
    claimId: CLAIM_B,
    contributor: FUNDER,
  });
  // Once the earliest is ready it is offered, even while a later one is still waiting.
  assert.equal(bountyStage(record(), [late, early], 6_100).claimId, CLAIM_B);
});

test("a bounty takes money until its deadline and never after it paid", () => {
  assert.equal(bountyTakesMoney(record(), 9_999), true);
  assert.equal(bountyTakesMoney(record(), 10_000), false);
  assert.equal(bountyTakesMoney(record({ paidClaim: CLAIM_A }), 5_000), false);
});

// ---- the reader ------------------------------------------------------------------------------------

function fakeChain({ opened = 1, mandates = [MANDATE] } = {}) {
  const calls = [];
  return {
    calls,
    now: async () => 5_000,
    call: async (to, data) => {
      calls.push([to, data]);
      if (to === BOUNTY && data === encodeCall0(BOUNTY_SIGNATURES.currency)) {
        return words(BigInt(USDC));
      }
      if (to === USDC && data === encodeCall0("decimals()")) return words(6);
      if (to === USDC && data === encodeBalanceOf(FUNDER)) return words(1_234);
      if (to === USDC && data === encodeCall0("symbol()")) {
        return `0x${word(32)}${word(4)}${Buffer.from("USDC").toString("hex").padEnd(64, "0")}`;
      }
      for (let id = 1; id <= opened; id++) {
        if (
          data ===
          encodeFunctionData(
            BOUNTY_SIGNATURES.bounties,
            ["uint256"],
            [BigInt(id)],
          )
        ) {
          return words(
            BigInt(MANDATE),
            1_000,
            10_000,
            BigInt(DOCS),
            700,
            12_100,
            100n * BigInt(id),
            0,
            0,
            0,
          );
        }
        if (
          data ===
          encodeFunctionData(
            BOUNTY_SIGNATURES.fundedBy,
            ["uint256", "address"],
            [BigInt(id), FUNDER],
          )
        ) {
          return words(40);
        }
      }
      throw new Error(`unexpected call ${to} ${data}`);
    },
    logs: async ({ address, topics }) => {
      assert.equal(address, BOUNTY);
      if (topics[0] === TOPIC_BOUNTY_OPENED) {
        if (!mandates.some((m) => addressTopic(m) === topics[2])) return [];
        return Array.from({ length: opened }, (_, i) => ({
          topics: [
            TOPIC_BOUNTY_OPENED,
            `0x${word(i + 1)}`,
            addressTopic(MANDATE),
            DOCS,
          ],
          data: words(BigInt(FUNDER), 10_000, 12_100),
        }));
      }
      if (topics[0] === TOPIC_BOUNTY_FUNDED) {
        // Two funders, one of them twice: counted once each.
        return [FUNDER, FUNDER, DAVE].map((f) => ({
          topics: [TOPIC_BOUNTY_FUNDED, topics[1], addressTopic(f)],
          data: words(1, 1),
        }));
      }
      return [];
    },
  };
}

test("the reader finds a work budget's bounties with their funders and the wallet's own share", async () => {
  const chain = fakeChain({ opened: 2 });
  const read = await readWorkBounties(
    chain,
    BOUNTY,
    [MANDATE, OTHER_MANDATE],
    FUNDER,
  );
  assert.equal(read.currency.symbol, "USDC");
  assert.equal(read.currency.decimals, 6);
  assert.equal(read.walletBalance, 1_234n);
  assert.equal(read.truncated, false);
  assert.equal(read.bounties.length, 2);
  assert.deepEqual(
    read.bounties.map((b) => [
      b.id,
      b.record.total,
      b.funders,
      b.walletFunded,
      b.opener,
    ]),
    [
      [1n, 100n, 2, 40n, FUNDER],
      [2n, 200n, 2, 40n, FUNDER],
    ],
  );
});

test("without a wallet nothing is read for one", async () => {
  const chain = fakeChain({ opened: 1 });
  const read = await readWorkBounties(chain, BOUNTY, [MANDATE], null);
  assert.equal(read.bounties[0].walletFunded, 0n);
  assert.equal(read.walletBalance, null);
  assert.equal(
    chain.calls.some(([, data]) =>
      data.startsWith(encodeCall0(BOUNTY_SIGNATURES.fundedBy).slice(0, 10)),
    ),
    false,
  );
});

test("a bounty whose record does not decode is left out", async () => {
  const chain = fakeChain({ opened: 1 });
  const broken = {
    ...chain,
    call: async (to, data) =>
      data === encodeFunctionData(BOUNTY_SIGNATURES.bounties, ["uint256"], [1n])
        ? words(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        : chain.call(to, data),
  };
  const read = await readWorkBounties(broken, BOUNTY, [MANDATE], null);
  assert.deepEqual(read.bounties, []);
});

test("more bounties than the bound are reported as truncated and the newest are kept", async () => {
  const chain = fakeChain({ opened: MAX_BOUNTIES + 2 });
  const read = await readWorkBounties(chain, BOUNTY, [MANDATE], null);
  assert.equal(read.truncated, true);
  assert.equal(read.bounties.length, MAX_BOUNTIES);
  assert.equal(read.bounties[0].id, 3n);
  assert.equal(read.bounties.at(-1).id, BigInt(MAX_BOUNTIES + 2));
});
