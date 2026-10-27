import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { encodeFunctionData, encodeParameters } from "./evmAbi.ts";
import { encodeCall0 } from "./work.ts";
import { encodeBalanceOf } from "./workBounty.ts";
import {
  AGREE,
  MAX_TEXT,
  OPEN_BOUNTY_SIGNATURES,
  RUN,
  TOPIC_POST_BOUNTY_FUNDED,
  TOPIC_POST_BOUNTY_OPENED,
  TOPIC_POST_CLAIM_FILED,
  backingPercent,
  decodePostBounty,
  decodePostBountyOpened,
  decodePostClaimFiled,
  encodeBackClaim,
  encodeFileClaim,
  encodeOpenPostBounty,
  encodePayPostBounty,
  encodeStartRun,
  encodeUnback,
  encodeWithdrawClaim,
  hasMajority,
  postBountyStage,
  postRefundsOpen,
  readPostBounties,
  readPostBountyIndex,
  walletCan,
  APPEAL_WINDOW,
  decodePostAppeal,
  encodeAppealPostBounty,
  NO_APPEAL,
  postAppealOpen,
  TOPIC_POST_APPEALED,
} from "./openBounty.ts";

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const words = (...values) => `0x${values.map(word).join("")}`;
const keccak = (text) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;
const POST = `0x${"aa".padStart(64, "0")}`;
const BOUNTY = "0x00000000000000000000000000000000000000b0";
const USDC = "0x00000000000000000000000000000000000000cc";
const BEN = "0x0000000000000000000000000000000000000be1";
const DEV = "0x0000000000000000000000000000000000000de7";

// ---- calls, pinned against `cast calldata` --------------------------------------------------------

test("the calls match cast calldata byte for byte", () => {
  assert.equal(
    encodeOpenPostBounty(POST, "Paint the lane", 1767225600, 50_000_000n),
    "0xacb573dd00000000000000000000000000000000000000000000000000000000000000aa0000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000006955b9000000000000000000000000000000000000000000000000000000000002faf080000000000000000000000000000000000000000000000000000000000000000e5061696e7420746865206c616e65000000000000000000000000000000000000",
  );
  assert.equal(
    encodeFileClaim(2n, "https://example.com/v"),
    "0x8a59041200000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000001568747470733a2f2f6578616d706c652e636f6d2f760000000000000000000000",
  );
  assert.equal(
    encodeBackClaim(2n, 3),
    "0x9bd8fcec00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003",
  );
  assert.equal(
    encodeStartRun(2n, 3),
    "0x5f48bcd600000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003",
  );
  assert.equal(encodeUnback(2n).slice(0, 10), "0x5fd6fbd7");
  assert.equal(encodeWithdrawClaim(2n).slice(0, 10), "0xa224dcb7");
  assert.equal(encodePayPostBounty(2n).slice(0, 10), "0xc290d691");
  assert.equal(
    TOPIC_POST_BOUNTY_OPENED,
    "0xacfa3463bb2a84a8a3acc849d1c0a8fe0316028647e5934e0ab79254fcfc0513",
  );
  assert.equal(
    TOPIC_POST_CLAIM_FILED,
    "0x5dce150386012b28b9431e8965f7d6b8954f62d4ee4d21ae293a51a8e070052a",
  );
});

test("empty or long text, a zero amount, a bad post or claim are refused before anything is signed", () => {
  assert.throws(() => encodeOpenPostBounty(POST, "", 1, 1n), /1 to 1000 bytes/);
  assert.throws(
    () => encodeOpenPostBounty(POST, "é".repeat(501), 1, 1n),
    /1 to 1000 bytes/,
  );
  assert.ok(encodeOpenPostBounty(POST, "x".repeat(MAX_TEXT), 1, 1n));
  assert.throws(() => encodeOpenPostBounty(POST, "w", 1, 0n), /above zero/);
  assert.throws(() => encodeOpenPostBounty("0x12", "w", 1, 1n), /post id/);
  assert.throws(() => encodeFileClaim(1n, ""), /1 to 1000 bytes/);
  assert.throws(() => encodeBackClaim(1n, 0), /claim number/);
  assert.throws(() => encodeStartRun(1n, 1.5), /claim number/);
});

// ---- the record and the events ----------------------------------------------------------------------

const record = (over = {}) => ({
  creator: BEN,
  openedAt: 1_000,
  deadline: 100_000,
  refundsFrom: 100_000 + RUN + 14 * 86_400,
  post: POST,
  wordsHash: keccak("Paint the lane"),
  total: 100n,
  refunded: 0n,
  counting: 100n,
  claimCount: 2,
  runClaim: 0,
  runSince: 0,
  paidClaim: 0,
  court: false,
  appeal: NO_APPEAL,
  ...over,
});

test("a bounty record decodes from its thirteen words, and an unknown one is null", () => {
  const r = record({ runClaim: 2, runSince: 5_000 });
  const hex = words(
    BigInt(BEN),
    r.openedAt,
    r.deadline,
    r.refundsFrom,
    BigInt(POST),
    BigInt(r.wordsHash),
    100n,
    0,
    100n,
    2,
    2,
    5_000,
    0,
  );
  assert.deepEqual(decodePostBounty(hex), r);
  assert.equal(decodePostBounty(words(...Array(13).fill(0))), null);
});

test("the opening and claim events give back their words and evidence", () => {
  const opened = decodePostBountyOpened({
    topics: [
      TOPIC_POST_BOUNTY_OPENED,
      `0x${word(4)}`,
      POST,
      `0x${word(BigInt(BEN))}`,
    ],
    data: encodeParameters(
      ["bytes32", "uint64", "uint64", "string"],
      [keccak("Paint the lane"), 9n, 10n, "Paint the lane"],
    ),
  });
  assert.deepEqual(opened, {
    id: 4n,
    post: POST,
    creator: BEN,
    words: "Paint the lane",
  });
  const filed = decodePostClaimFiled({
    topics: [
      TOPIC_POST_CLAIM_FILED,
      `0x${word(4)}`,
      `0x${word(3)}`,
      `0x${word(BigInt(DEV))}`,
    ],
    data: encodeParameters(
      ["bytes32", "string"],
      [keccak("v"), "https://example.com/v"],
    ),
  });
  assert.deepEqual(filed, {
    claim: 3,
    claimant: DEV,
    evidence: "https://example.com/v",
  });
  assert.equal(
    decodePostClaimFiled({ topics: [TOPIC_POST_CLAIM_FILED], data: "0x" }),
    null,
  );
});

// ---- stages and what a wallet can do ---------------------------------------------------------------

test("the stage follows the contract's order at every boundary", () => {
  // A run is nine days long and the deadline is at 100_000 s: one started at 10_000 is a day old at the deadline.
  const run = record({ runClaim: 2, runSince: 10_000 });
  const cases = [
    ["open before the deadline", record(), 99_999, "open"],
    [
      "refunds exactly at the deadline with no run",
      record(),
      100_000,
      "refunds",
    ],
    ["a run's first two days", run, 10_000 + AGREE - 1, "agreeing"],
    ["on hold from two days", run, 10_000 + AGREE, "holding"],
    ["one second before nine days", run, 10_000 + RUN - 1, "holding"],
    ["payable at exactly nine days", run, 10_000 + RUN, "payable"],
    ["a run keeps refunds shut after the deadline", run, 100_000, "agreeing"],
    [
      "and is payable after it once nine days old",
      record({ runClaim: 2, runSince: 99_000 }),
      99_000 + RUN,
      "payable",
    ],
    ["refunds at refundsFrom even with a run", run, run.refundsFrom, "refunds"],
    [
      "one second before refundsFrom, still payable",
      run,
      run.refundsFrom - 1,
      "payable",
    ],
    ["paid stays paid", record({ paidClaim: 2 }), 999_999, "paid"],
  ];
  for (const [what, b, now, kind] of cases) {
    assert.equal(postBountyStage(b, now).kind, kind, what);
  }
  assert.deepEqual(postBountyStage(run, 10_000), {
    kind: "agreeing",
    claim: 2,
    payableAt: 10_000 + RUN,
  });
  assert.equal(postRefundsOpen(record({ paidClaim: 1 }), 999_999), false);
});

test("a majority is strictly more than half, and shares are whole percent", () => {
  assert.equal(hasMajority(50n, 100n), false);
  assert.equal(hasMajority(51n, 100n), true);
  assert.equal(hasMajority(0n, 0n), false);
  assert.equal(backingPercent(1n, 3n), 33);
  assert.equal(backingPercent(5n, 0n), 0);
});

test("what a wallet can do is exactly what the contract allows", () => {
  const funder = { funded: 40n, backs: 0, openClaim: 0 };
  const claimant = { funded: 0n, backs: 0, openClaim: 1 };
  const c1 = {
    claim: 1,
    claimant: DEV,
    evidence: "e",
    open: true,
    backing: 0n,
  };
  const c2 = {
    claim: 2,
    claimant: BEN,
    evidence: "e",
    open: false,
    backing: 0n,
  };
  const open = walletCan(record(), funder, 50_000);
  assert.equal(open.fund, true);
  assert.equal(open.file, true);
  assert.equal(open.back(c1), true);
  assert.equal(open.back(c2), false, "a withdrawn claim cannot be backed");
  assert.equal(open.unback, false);
  assert.equal(open.refund, false);
  assert.equal(
    walletCan(record(), { ...funder, backs: 1 }, 50_000).back(c1),
    false,
    "already backing it",
  );
  assert.equal(
    walletCan(record(), claimant, 50_000).back(c1),
    false,
    "a claimant has no weight",
  );
  assert.equal(
    walletCan(record(), claimant, 50_000).file,
    false,
    "one open claim per wallet",
  );
  assert.equal(walletCan(record(), claimant, 50_000).withdrawClaim, true);
  const running = walletCan(
    record({ runClaim: 1, runSince: 40_000 }),
    funder,
    50_000,
  );
  assert.equal(running.fund, false, "money pauses during a run");
  const after = walletCan(
    record({ runClaim: 1, runSince: 40_000 }),
    { ...funder, backs: 1 },
    100_000,
  );
  assert.equal(after.back(c1), false, "backing closes at the deadline");
  assert.equal(after.unback, true, "withdrawing it does not");
  assert.equal(after.file, false);
  assert.equal(walletCan(record(), funder, 100_000).refund, true);
  // A majority no run started can be started by anyone, before the deadline only.
  const strong = { ...c1, backing: 60n };
  assert.equal(walletCan(record(), funder, 50_000).start([c2, strong]), strong);
  assert.equal(walletCan(record(), funder, 100_000).start([strong]), null);
  assert.equal(
    walletCan(record({ runClaim: 1 }), funder, 50_000).start([strong]),
    null,
  );
});

// ---- the reader ------------------------------------------------------------------------------------

function fakeChain({ tamperWords = false } = {}) {
  const calls = [];
  return {
    calls,
    now: async () => 5_000,
    call: async (to, data) => {
      calls.push(data);
      if (
        to === BOUNTY &&
        data === encodeCall0(OPEN_BOUNTY_SIGNATURES.currency)
      )
        return words(BigInt(USDC));
      if (to === USDC && data === encodeCall0("decimals()")) return words(6);
      if (to === USDC && data === encodeCall0("symbol()")) {
        return `0x${word(32)}${word(4)}${Buffer.from("USDC").toString("hex").padEnd(64, "0")}`;
      }
      if (to === USDC && data === encodeBalanceOf(BEN)) return words(7_000);
      if (
        data ===
        encodeFunctionData(OPEN_BOUNTY_SIGNATURES.bounties, ["uint256"], [1n])
      ) {
        return words(
          BigInt(BEN),
          1,
          100_000,
          200_000,
          BigInt(POST),
          BigInt(keccak("Paint the lane")),
          100,
          0,
          100,
          2,
          1,
          3_000,
          0,
        );
      }
      if (
        data ===
        encodeFunctionData(
          OPEN_BOUNTY_SIGNATURES.claims,
          ["uint256", "uint32"],
          [1n, 1n],
        )
      ) {
        return words(BigInt(DEV), 1, 60, BigInt(keccak("a")));
      }
      if (
        data ===
        encodeFunctionData(
          OPEN_BOUNTY_SIGNATURES.claims,
          ["uint256", "uint32"],
          [1n, 2n],
        )
      ) {
        return words(BigInt(BEN), 0, 0, BigInt(keccak("b")));
      }
      for (const [sig, value] of [
        [OPEN_BOUNTY_SIGNATURES.funded, 40],
        [OPEN_BOUNTY_SIGNATURES.backs, 1],
        [OPEN_BOUNTY_SIGNATURES.openClaim, 0],
      ]) {
        if (data === encodeFunctionData(sig, ["uint256", "address"], [1n, BEN]))
          return words(value);
      }
      throw new Error(`unexpected call ${to} ${data}`);
    },
    logs: async ({ address, topics }) => {
      assert.equal(address, BOUNTY);
      if (topics[0] === TOPIC_POST_BOUNTY_OPENED) {
        assert.equal(topics[2], POST);
        return [
          {
            topics: [
              TOPIC_POST_BOUNTY_OPENED,
              `0x${word(1)}`,
              POST,
              `0x${word(BigInt(BEN))}`,
            ],
            data: encodeParameters(
              ["bytes32", "uint64", "uint64", "string"],
              [
                keccak("Paint the lane"),
                100_000n,
                200_000n,
                tamperWords ? "Paint the road" : "Paint the lane",
              ],
            ),
          },
        ];
      }
      if (topics[0] === TOPIC_POST_CLAIM_FILED) {
        return [1, 2].map((claim) => ({
          topics: [
            TOPIC_POST_CLAIM_FILED,
            topics[1],
            `0x${word(claim)}`,
            `0x${word(BigInt(claim === 1 ? DEV : BEN))}`,
          ],
          data: encodeParameters(
            ["bytes32", "string"],
            [keccak("x"), `evidence ${claim}`],
          ),
        }));
      }
      if (topics[0] === TOPIC_POST_BOUNTY_FUNDED) {
        return [BEN, BEN, DEV].map((f) => ({
          topics: [TOPIC_POST_BOUNTY_FUNDED, topics[1], `0x${word(BigInt(f))}`],
          data: words(1, 1),
        }));
      }
      return [];
    },
  };
}

test("the reader finds a post's bounty with its words, claims, funders and the wallet's position", async () => {
  const read = await readPostBounties(fakeChain(), BOUNTY, POST, BEN, keccak);
  assert.equal(read.currency.symbol, "USDC");
  assert.equal(read.walletBalance, 7_000n);
  assert.equal(read.bounties.length, 1);
  const [b] = read.bounties;
  assert.equal(b.words, "Paint the lane");
  assert.equal(b.funders, 2);
  assert.deepEqual(b.wallet, { funded: 40n, backs: 1, openClaim: 0 });
  assert.deepEqual(
    b.claims.map((c) => [c.claim, c.claimant, c.evidence, c.open, c.backing]),
    [
      [1, DEV, "evidence 1", true, 60n],
      [2, BEN, "evidence 2", false, 0n],
    ],
  );
  assert.equal(b.record.runClaim, 1);
  assert.equal(b.firstRunSince, null, "no run event was served");
});

test("words that do not hash to the record are not shown as the bounty's words", async () => {
  const read = await readPostBounties(
    fakeChain({ tamperWords: true }),
    BOUNTY,
    POST,
    null,
    keccak,
  );
  assert.equal(read.bounties[0].words, null);
  assert.equal(read.walletBalance, null);
  assert.deepEqual(read.bounties[0].wallet, {
    funded: 0n,
    backs: 0,
    openClaim: 0,
  });
});

test("a timeline's money chips come from one log read and a call per bounty, the newest first kept", async () => {
  const OTHER = `0x${"bb".padStart(64, "0")}`;
  // id: [post, total, refunded, paidClaim]
  const bounties = {
    1: [POST, 100, 0, 0],
    2: [OTHER, 80, 0, 1],
    3: [POST, 50, 20, 0],
    4: [OTHER, 20, 0, 0],
  };
  const chain = {
    call: async (to, data) => {
      if (
        to === BOUNTY &&
        data === encodeCall0(OPEN_BOUNTY_SIGNATURES.currency)
      )
        return words(BigInt(USDC));
      if (to === USDC && data === encodeCall0("decimals()")) return words(6);
      if (to === USDC && data === encodeCall0("symbol()")) {
        return `0x${word(32)}${word(4)}${Buffer.from("USDC").toString("hex").padEnd(64, "0")}`;
      }
      for (const [id, [post, total, refunded, paid]] of Object.entries(
        bounties,
      )) {
        if (
          data ===
          encodeFunctionData(
            OPEN_BOUNTY_SIGNATURES.bounties,
            ["uint256"],
            [BigInt(id)],
          )
        ) {
          return words(
            BigInt(BEN),
            1,
            100_000,
            200_000,
            BigInt(post),
            1,
            total,
            refunded,
            0,
            0,
            0,
            0,
            paid,
          );
        }
      }
      throw new Error(`unexpected call ${to} ${data}`);
    },
    logs: async ({ address, topics }) => {
      assert.equal(address, BOUNTY);
      // Every bounty on every post: no post in the filter.
      assert.deepEqual(topics, [TOPIC_POST_BOUNTY_OPENED]);
      return Object.entries(bounties).map(([id, [post]]) => ({
        topics: [
          TOPIC_POST_BOUNTY_OPENED,
          `0x${word(BigInt(id))}`,
          post,
          `0x${word(BigInt(BEN))}`,
        ],
        data: encodeParameters(
          ["bytes32", "uint64", "uint64", "string"],
          [keccak("w"), 100_000n, 200_000n, "w"],
        ),
      }));
    },
  };
  const all = await readPostBountyIndex(chain, BOUNTY);
  assert.equal(all.currency.symbol, "USDC");
  assert.equal(all.truncated, false);
  // Post one: 100 held, plus 50 less the 20 taken back, nothing paid.
  assert.deepEqual(all.posts.get(POST), { paid: 0n, held: 130n, bounties: 2 });
  // Post two: 80 paid by one bounty and 20 still held by a later one, never added together.
  assert.deepEqual(all.posts.get(OTHER), { paid: 80n, held: 20n, bounties: 2 });
  // Only the newest two (bounties 3 and 4): the read says it left some out.
  const newest = await readPostBountyIndex(chain, BOUNTY, 2);
  assert.equal(newest.truncated, true);
  assert.deepEqual(newest.posts.get(POST), {
    paid: 0n,
    held: 30n,
    bounties: 1,
  });
  assert.deepEqual(newest.posts.get(OTHER), {
    paid: 0n,
    held: 20n,
    bounties: 1,
  });
});

// ---- appeals (N7) -----------------------------------------------------------------------------------

test("the appeal call and its event are the contract's (cast goldens)", () => {
  assert.equal(
    encodeAppealPostBounty(7n),
    "0x7e69b7b00000000000000000000000000000000000000000000000000000000000000007",
  );
  assert.equal(
    TOPIC_POST_APPEALED,
    "0xe6f546e60f7c7a030212e579e5f3724bb089bd631914ee869f79e9d19e3d61b9",
  );
  assert.deepEqual(decodePostAppeal(words(50, 2, 1, 70)), {
    runEndedAt: 50,
    state: "upheld",
    claim: 1,
    ruledAt: 70,
    dispute: null,
  });
  assert.deepEqual(decodePostAppeal("0x"), NO_APPEAL);
});

const withCourt = (over = {}) => record({ court: true, ...over });
const appealed = (state, over = {}) => ({
  ...NO_APPEAL,
  state,
  claim: 1,
  ...over,
});

test("with a court, refunds wait for the appeal window after the deadline, or after a later run ended", () => {
  const b = withCourt();
  assert.equal(postRefundsOpen(b, b.deadline), false);
  assert.equal(postAppealOpen(b, b.deadline), true);
  assert.equal(postAppealOpen(b, b.deadline - 1), false);
  assert.equal(postRefundsOpen(b, b.deadline + APPEAL_WINDOW - 1), false);
  assert.equal(postRefundsOpen(b, b.deadline + APPEAL_WINDOW), true);
  assert.equal(postAppealOpen(b, b.deadline + APPEAL_WINDOW), false);
  assert.deepEqual(postBountyStage(b, b.deadline + 1), {
    kind: "window",
    until: b.deadline + APPEAL_WINDOW,
  });
  const late = withCourt({
    appeal: { ...NO_APPEAL, runEndedAt: b.deadline + 86_400 },
  });
  assert.equal(postRefundsOpen(late, b.deadline + APPEAL_WINDOW), false);
  assert.equal(
    postRefundsOpen(late, b.deadline + 86_400 + APPEAL_WINDOW),
    true,
  );
  // Nobody filed a claim, so nobody can appeal: refunds open at the deadline.
  assert.equal(postRefundsOpen(withCourt({ claimCount: 0 }), b.deadline), true);
  // Without a court, refunds open at the deadline as before.
  assert.equal(postRefundsOpen(record(), record().deadline), true);
  assert.equal(postAppealOpen(record(), record().deadline), false);
});

test("an open appeal holds the money, an upheld one is paid for fourteen days, a refused one opens refunds", () => {
  const open = withCourt({ appeal: appealed("open", { ruledAt: 0 }) });
  assert.equal(postRefundsOpen(open, open.refundsFrom + 1), false);
  assert.equal(postBountyStage(open, open.deadline + 10).kind, "appealing");
  assert.equal(
    postAppealOpen(open, open.deadline),
    false,
    "one appeal per bounty",
  );
  const ruledAt = open.deadline + 5 * 86_400;
  const upheld = withCourt({ appeal: appealed("upheld", { ruledAt }) });
  assert.deepEqual(postBountyStage(upheld, ruledAt + 1), {
    kind: "upheld",
    claim: 1,
    payUntil: ruledAt + 14 * 86_400,
  });
  assert.equal(postRefundsOpen(upheld, ruledAt + 14 * 86_400 - 1), false);
  assert.equal(postRefundsOpen(upheld, ruledAt + 14 * 86_400), true);
  const refused = withCourt({ appeal: appealed("refused", { ruledAt }) });
  assert.equal(postRefundsOpen(refused, ruledAt), true);
});

test("only a claimant appeals, and not while their claim is with the court", () => {
  const b = withCourt();
  const claimant = { funded: 0n, backs: 0, openClaim: 1 };
  const funder = { funded: 10n, backs: 0, openClaim: 0 };
  assert.equal(walletCan(b, claimant, b.deadline).appeal, true);
  assert.equal(walletCan(b, funder, b.deadline).appeal, false);
  const open = withCourt({ appeal: appealed("open") });
  assert.equal(walletCan(open, claimant, open.deadline).withdrawClaim, false);
  assert.equal(walletCan(open, claimant, open.deadline).appeal, false);
});
