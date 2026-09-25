// Fund-flow math + receipt decoding + explorer honesty.
//
// Derivation (hermit env: `. ./bin/activate-hermit`, `cast 1.4.3-stable`):
//
//   cast sig 'fundsRecipient()'     -> 0x3b6fd2cf
//   cast sig 'currency()'           -> 0xe5a6b10f
//   cast sig 'graduations(address)' -> 0x62e3857f
//   cast sig 'reserveBps()'         -> 0x38925449
//   cast sig 'treasury()'           -> 0x61d027b3
//
// Split math binds `contracts/src/GraduationExecutor.sol:253-255`:
//   reserveShare = currencyRaised * reserveBps / 10_000   (floor)
//   treasuryShare = currencyRaised - reserveShare
// Receipt payloads bind the deploy's 47005 `sweep`/`lock` shapes
// (`desktop/src/features/launchpad/lib/graduationFlow.ts:296-341`,
// READ-ONLY reference) and survive the production launch-receipt parser.
import assert from "node:assert/strict";
import test from "node:test";

import { parseLaunchReceipt } from "../models.ts";
import {
  buildGraduationsView,
  decodeGraduationRecord,
  decodeLockReceipt,
  decodeSweepReceipt,
  explorerAddressUrl,
  explorerTxUrl,
  fundFlowReceiptRows,
  graduationSplit,
  SELECTOR_CURRENCY,
  SELECTOR_FUNDS_RECIPIENT,
  SELECTOR_GRADUATIONS,
  SELECTOR_RESERVE_BPS,
  SELECTOR_TREASURY,
  splitFromSweepReceipt,
} from "./fund-flow.ts";

const ALICE = "a".repeat(64);
const AUCTION = `0x${"55".repeat(20)}`;
const EXECUTOR = `0x${"ee".repeat(20)}`;
const POOL = `0x${"99".repeat(20)}`;
const TX = `0x${"b".repeat(64)}`;
const TX2 = `0x${"c".repeat(64)}`;

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function receiptEvent(parts, slug = "nebula", createdAt = 130) {
  return {
    id: `receipt-${parts.content.table}-${slug}`,
    pubkey: ALICE,
    created_at: createdAt,
    kind: 47005,
    tags: [["a", `37001:${ALICE}:${slug}`], ...parts.extraTags],
    content: JSON.stringify(parts.content),
    sig: "sig",
  };
}

// The deploy's published payload shapes (graduationFlow.ts:296-341).
function sweepParts(input) {
  return {
    extraTags: [
      ["kind", "sweep"],
      ["tx", input.tx],
    ],
    content: {
      table: "sweep",
      auction: input.auction,
      currencyRaised: input.currencyRaised.toString(),
      treasuryShare: input.treasuryShare.toString(),
      unsoldTokens: input.unsoldTokens.toString(),
    },
  };
}

function lockParts(input) {
  return {
    extraTags: [
      ["kind", "lock"],
      ["tx", input.tx],
    ],
    content: {
      table: "lock",
      auction: input.auction,
      reserveEscrow: input.reserveEscrow.toString(),
    },
  };
}

test("the GraduationExecutor read vocabulary matches cast sig goldens", () => {
  assert.equal(SELECTOR_FUNDS_RECIPIENT, "0x3b6fd2cf");
  assert.equal(SELECTOR_CURRENCY, "0xe5a6b10f");
  assert.equal(SELECTOR_GRADUATIONS, "0x62e3857f");
  assert.equal(SELECTOR_RESERVE_BPS, "0x38925449");
  assert.equal(SELECTOR_TREASURY, "0x61d027b3");
  assert.equal(
    buildGraduationsView(EXECUTOR, AUCTION).data,
    `0x${"62e3857f"}${AUCTION.slice(2).toLowerCase().padStart(64, "0")}`,
  );
});

test("the 8-word graduations(address) record decodes field-by-field", () => {
  const encoded = `0x${[
    word(2n ** 90n), // initialPriceX96
    word(30_000), // tokensSold
    word(1_234_567), // currencyRaised
    word(617_283), // reserveEscrow
    word(617_284), // treasuryShare
    word(30_000), // unsoldTokens
    word(BigInt(POOL)), // tokenMasterPool
    word(1), // executed
  ].join("")}`;
  const record = decodeGraduationRecord(encoded);
  assert.equal(record.initialPriceX96, 2n ** 90n);
  assert.equal(record.tokensSold, 30_000n);
  assert.equal(record.currencyRaised, 1_234_567n);
  assert.equal(record.reserveEscrow, 617_283n);
  assert.equal(record.treasuryShare, 617_284n);
  assert.equal(record.unsoldTokens, 30_000n);
  assert.equal(record.tokenMasterPool, POOL);
  assert.equal(record.executed, true);

  const zeroed = decodeGraduationRecord(`0x${word(0).repeat(8)}`);
  assert.equal(
    zeroed.executed,
    false,
    "an un-executed graduation decodes as zeros",
  );
  assert.throws(
    () => decodeGraduationRecord(`0x${word(0).repeat(7)}`),
    /8 words/,
  );
});

test("the split math matches GraduationExecutor.sol:253-255", () => {
  const { reserveShare, treasuryShare } = graduationSplit({
    currencyRaised: 1_234_567n,
    reserveBps: 5_000n,
  });
  assert.equal(reserveShare, 617_283n, "1234567 * 5000 / 10000 floors");
  assert.equal(treasuryShare, 617_284n, "the treasury takes the remainder");
  assert.equal(reserveShare + treasuryShare, 1_234_567n);
});

test("the two shares always sum to the raise (floor stays with the treasury)", () => {
  for (const [raised, bps] of [
    [0n, 5_000n],
    [1n, 3_333n],
    [999n, 1n],
    [10_000n, 10_000n],
    [7n, 0n],
  ]) {
    const { reserveShare, treasuryShare } = graduationSplit({
      currencyRaised: raised,
      reserveBps: bps,
    });
    assert.equal(reserveShare + treasuryShare, raised);
    assert.equal(reserveShare, (raised * bps) / 10_000n);
    assert.ok(treasuryShare >= 0n);
  }
  assert.throws(
    () => graduationSplit({ currencyRaised: 1n, reserveBps: 10_001n }),
    /out of range/,
  );
});

test("a sweep mirror survives the production parser and decodes the split", () => {
  const receipt = parseLaunchReceipt(
    receiptEvent(
      sweepParts({
        auction: AUCTION,
        tx: TX,
        currencyRaised: 1_234_567n,
        treasuryShare: 617_284n,
        unsoldTokens: 30_000n,
      }),
    ),
  );
  assert.ok(receipt, "a sweep mirror must not be dropped by the feed parser");
  assert.equal(receipt.table, "sweep");
  assert.equal(receipt.tx, TX);
  const sweep = decodeSweepReceipt(receipt);
  assert.equal(sweep.currencyRaised, 1_234_567n);
  assert.equal(sweep.treasuryShare, 617_284n);
  assert.equal(sweep.unsoldTokens, 30_000n);
  // The recorded split: reserve is the remainder of the raise
  // (GraduationExecutor.sol:254 reads the same onchain).
  assert.deepEqual(splitFromSweepReceipt(sweep), {
    reserveShare: 617_283n,
    treasuryShare: 617_284n,
  });
});

test("a lock mirror survives the production parser and decodes the escrow", () => {
  const receipt = parseLaunchReceipt(
    receiptEvent(
      lockParts({ auction: AUCTION, tx: TX2, reserveEscrow: 617_283n }),
    ),
  );
  assert.ok(receipt);
  assert.equal(receipt.table, "lock");
  const lock = decodeLockReceipt(receipt);
  assert.equal(lock.reserveEscrow, 617_283n);
  assert.equal(lock.tx, TX2);
});

test("a malformed receipt payload is a named decode error, not silent zeros", () => {
  const bad = parseLaunchReceipt(
    receiptEvent({
      extraTags: [
        ["kind", "sweep"],
        ["tx", TX],
      ],
      content: { table: "sweep", auction: AUCTION, currencyRaised: "lots" },
    }),
  );
  assert.ok(bad);
  assert.throws(() => decodeSweepReceipt(bad), /currencyRaised/);
});

test("money-movement rows keep only sweep/lock/summon/ragequit, in time order", () => {
  const sweep = parseLaunchReceipt(
    receiptEvent(
      sweepParts({
        auction: AUCTION,
        tx: TX,
        currencyRaised: 10n,
        treasuryShare: 5n,
        unsoldTokens: 1n,
      }),
      "s",
    ),
  );
  const lock = parseLaunchReceipt(
    receiptEvent(
      lockParts({ auction: AUCTION, tx: TX2, reserveEscrow: 5n }),
      "l",
      140,
    ),
  );
  const claim = parseLaunchReceipt(
    receiptEvent({
      extraTags: [
        ["kind", "claim"],
        ["tx", TX],
      ],
      content: { table: "claim", claimId: "m1", evidenceHash: "c".repeat(64) },
    }),
  );
  const rows = fundFlowReceiptRows([lock, sweep, claim]);
  assert.deepEqual(
    rows.map((r) => r.table),
    ["sweep", "lock"],
    "claim/verdict receipts are other surfaces' history",
  );
  assert.equal(rows[0].tx, TX);
});

test("explorer links exist for known chains and never fabricate for unknown ones", () => {
  assert.equal(
    explorerTxUrl(11155111, TX),
    `https://sepolia.etherscan.io/tx/${TX}`,
  );
  assert.equal(
    explorerAddressUrl(1, AUCTION),
    `https://etherscan.io/address/${AUCTION}`,
  );
  assert.equal(explorerTxUrl(31337, TX), null, "dev anvil has no explorer");
  assert.equal(explorerAddressUrl(31337, AUCTION), null);
});
