import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BACKING_ERROR_NAMES,
  BACKING_ERROR_SELECTORS,
  BACKING_ERROR_SIGNATURES,
  BACKING_EVENT_SIGNATURES,
  BACKING_SIGNATURES,
  BACKING_STRUCT_TYPES,
  BACKING_TOPICS,
  MAX_POOL_EVENTS,
  PERMIT2,
  backingErrorIn,
  canLeaveNow,
  decodePoolLog,
  decodeRoundInfo,
  decodeSnapshot,
  encodeBuy,
  encodeLeave,
  encodeOpenPool,
  encodeOpenWithRound,
  encodePoolOf,
  encodePostMilestone,
  encodeRedeem,
  encodeSell,
  encodeSnapshot,
  exactDecimal,
  formatAmount,
  formatCurvePrice,
  formatRoundPrice,
  milestoneRecords,
  newestFirst,
  nextMilestone,
  parseAmount,
  poolPhase,
  poolTotals,
  priceMovePercent,
  readPool,
  readPoolAddress,
  readPoolEvents,
  recordRef,
  roundStage,
  snapRoundLimit,
  tradeDeadline,
  withSlippage,
} from "./backing.ts";
import { encodeParameters, selectorOf } from "./evmAbi.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

// ---- pinned to the contracts ---------------------------------------------------------------------

test("every selector is the one `cast sig` gives", () => {
  const pinned = {
    "snapshot(address)": "0x26512160",
    "roundInfo(address)": "0x94e710fb",
    "quoteBuy(uint256)": "0x4beb394c",
    "quoteSell(address,uint256)": "0xd98b2f5c",
    "quoteLeave(address)": "0x8aeae6a1",
    "buy(uint256,uint256,uint256)": "0x40993b26",
    "sell(uint256,uint256,uint256)": "0xd3c9727c",
    "leave(uint256,uint256)": "0xe02ae075",
    "postMilestone(bytes32)": "0xfb03aded",
    "resolveMilestone()": "0xe5863346",
    "seedFromAuction()": "0x54076e89",
    "redeem(uint256)": "0xdb006a75",
    "voteAbandon()": "0xe116ee9a",
    "declareAbandoned()": "0x00d1d0b9",
    "payTreasury()": "0x268bd3aa",
    "poolOf(address)": "0x988b1fa7",
    "open(address)": "0xb95460f8",
    "openWithRound(address,uint128)": "0x9e742407",
    "founder()": "0x4d853ee5",
    "dao()": "0x4162169f",
    "quote()": "0x999b93af",
    "roundFloorPriceX96()": "0xeaa2ea4c",
    "roundTickSpacingX96()": "0x2dde66d2",
    "founderOf(address)": "0x3a9c00e0",
    "auctionFactory()": "0xabf4fde4",
    "defaultMinimumRaise()": "0xf52d9b78",
  };
  const used = new Set(Object.values(BACKING_SIGNATURES));
  for (const [signature, selector] of Object.entries(pinned)) {
    assert.equal(selectorOf(signature), selector, signature);
    assert.ok(used.has(signature), `${signature} is not in BACKING_SIGNATURES`);
  }
});

test("calldata matches `cast calldata`", () => {
  assert.equal(
    encodeBuy(1000000n, 990000n, 1800000000n),
    "0x40993b2600000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000f1b30000000000000000000000000000000000000000000000000000000006b49d200",
  );
  assert.equal(
    encodeSell(5n, 4n, 1800000000n),
    "0xd3c9727c00000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000006b49d200",
  );
  assert.equal(
    encodeLeave(7n, 1800000000n),
    "0xe02ae0750000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000006b49d200",
  );
  assert.equal(
    encodePostMilestone("ab".repeat(32)),
    `0xfb03aded${"ab".repeat(32)}`,
  );
  const dao = `0x${"cd".repeat(20)}`;
  assert.equal(
    encodeOpenPool(dao),
    `0xb95460f8${"0".repeat(24)}${"cd".repeat(20)}`,
  );
  assert.equal(
    encodeOpenWithRound(dao, 25_000_000_000n),
    `0x9e742407${"0".repeat(24)}${"cd".repeat(20)}${"0".repeat(54)}5d21dba00`.replace(
      /0{54}5d21dba00$/,
      "00000000000000000000000000000000000000000000000000000005d21dba00",
    ),
  );
  assert.equal(
    encodeSnapshot(`0x${"11".repeat(20)}`),
    `0x26512160${"0".repeat(24)}${"11".repeat(20)}`,
  );
  assert.equal(
    encodePoolOf(dao),
    `0x988b1fa7${"0".repeat(24)}${"cd".repeat(20)}`,
  );
  assert.equal(encodeRedeem(42n), `0xdb006a75${"0".repeat(62)}2a`);
});

test("calldata refuses what the pool would refuse anyway, before anything is signed", () => {
  assert.throws(() => encodeBuy(0n, 0n, 1n), /above zero/);
  assert.throws(() => encodeSell(0n, 0n, 1n), /above zero/);
  assert.throws(() => encodePostMilestone("00".repeat(32)), /public record/);
  assert.throws(() => encodePostMilestone("abc"), /public record/);
  assert.throws(() => encodeOpenPool("0x12"), /not an address/);
  assert.throws(
    () => encodeOpenWithRound(`0x${"cd".repeat(20)}`, 1n << 128n),
    /128 bits/,
  );
});

test("the structs, events and errors are the Solidity source's own, field for field", () => {
  const source = read("../../../../contracts/src/BackingPool.sol");
  const factory = read("../../../../contracts/src/BackingPoolFactory.sol");

  // Structs: flatten each to ABI types (an enum is a uint8, a struct is a tuple) and compare with the decoder's.
  const structBody = (name) => {
    const m = new RegExp(`struct ${name} \\{([\\s\\S]*?)\\n    \\}`).exec(
      source,
    );
    assert.ok(m, `struct ${name} in BackingPool.sol`);
    return [...m[1].matchAll(/^\s*(?!\/\/)([A-Za-z0-9_]+)\s+(\w+);/gm)].map(
      (f) => [f[1], f[2]],
    );
  };
  const toTypes = (name) =>
    structBody(name).map(([type]) => {
      if (type === "MilestoneStatus" || type === "RoundState") return "uint8";
      if (type === "Milestone" || type === "RoundView")
        return { tuple: toTypes(type) };
      return type;
    });
  for (const name of ["Milestone", "RoundView", "Snapshot"]) {
    assert.deepEqual(
      BACKING_STRUCT_TYPES[name].tuple,
      toTypes(name),
      `${name} differs from the contract`,
    );
  }
  // The enums, in the order the decoder reads them.
  assert.match(
    source,
    /enum MilestoneStatus \{\s*None,\s*Open,\s*Released,\s*Void\s*\}/,
  );
  assert.match(
    source,
    /enum RoundState \{\s*None,\s*Waiting,\s*Live,\s*Failed\s*\}/,
  );

  // Events: the signature without names or `indexed`.
  const signatureOf = (name) => {
    const m = new RegExp(`event ${name}\\(([\\s\\S]*?)\\);`).exec(source);
    assert.ok(m, `event ${name}`);
    const types = m[1]
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
    return `${name}(${types.join(",")})`;
  };
  for (const signature of Object.values(BACKING_EVENT_SIGNATURES)) {
    const name = signature.slice(0, signature.indexOf("("));
    assert.equal(signature, signatureOf(name));
  }

  // Errors: every name this app maps is a real error, with its real arguments.
  for (const name of BACKING_ERROR_NAMES) {
    const signature = BACKING_ERROR_SIGNATURES[name];
    if (name.startsWith("ERC20")) continue; // OpenZeppelin's, not the pool's
    const args = signature.slice(signature.indexOf("(") + 1, -1);
    const found = new RegExp(`error ${name}\\(([^)]*)\\);`);
    const m = found.exec(source) ?? found.exec(factory);
    assert.ok(m, `error ${name} is not in the pool or its factory`);
    const types = m[1]
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean)
      .join(",");
    assert.equal(types, args, name);
  }
});

test("topics and error selectors are what `cast` says", () => {
  assert.equal(
    BACKING_TOPICS.bought,
    "0x281eb98c54359b388539461afe675a5276d4a48546196ccb3f81f8d4b10622f9",
  );
  assert.equal(
    BACKING_TOPICS.sold,
    "0x8c40cdfab202070403f4ec0788de8a6c94d9e1ef50d4c506660e6c5019a9cb37",
  );
  assert.equal(
    BACKING_TOPICS.left,
    "0x9a9399623d08666d5491b3941e1574bdf1f9c2d149a915d40d690ae22ccbd174",
  );
  assert.equal(
    BACKING_TOPICS.milestonePosted,
    "0x86960e021117d3dde8fad554934f1e3b7518944fe9cb7a9926648bd6ca2b8d25",
  );
  assert.equal(
    BACKING_TOPICS.milestoneResolved,
    "0x2478473d0460ad936c37b50f6638e68c5e7e8c89d88dabaa4fe21c63221199f7",
  );
  assert.equal(
    BACKING_TOPICS.roundBound,
    "0x80ab30782460bc504dfb3e565b235182b9a28f7da19739f968d2e69e85f891d7",
  );
  assert.equal(
    BACKING_TOPICS.roundSeeded,
    "0x705e61236a2b5f80a767ccfc01602e7f8767413a70c8dda9387ef0a416e4f672",
  );
  assert.equal(
    BACKING_TOPICS.roundFailed,
    "0x228396fab9d6b2b4c9f3031c4cb2bd70908ba39dd543c452ecb8612ed003619e",
  );
  assert.equal(
    BACKING_TOPICS.abandoned,
    "0x31578b8759fc961e04c99cc0d28d747d299b87bf0962f0fa33cc3b50eaf5d631",
  );
  assert.equal(BACKING_ERROR_SELECTORS.get("0x7dd37f70"), "Slippage");
  assert.equal(BACKING_ERROR_SELECTORS.get("0x203d82d8"), "Expired");
  assert.equal(BACKING_ERROR_SELECTORS.get("0xe86f59ea"), "TooSoon");
  assert.equal(BACKING_ERROR_SELECTORS.get("0xcb81e583"), "WindowOver");
  assert.equal(BACKING_ERROR_SELECTORS.get("0x8e9e357c"), "NoSay");
  assert.equal(BACKING_ERROR_SELECTORS.get("0xd380978a"), "EarlyCapReached");
  assert.equal(BACKING_ERROR_SELECTORS.get("0x7823f05f"), "RoundNotOver");
  assert.equal(BACKING_ERROR_SELECTORS.get("0x71cd1941"), "AlreadyOpen");
  assert.equal(BACKING_ERROR_SELECTORS.get("0x7d7f56f9"), "MinimumTooLow");
  assert.equal(
    BACKING_ERROR_SELECTORS.get("0xe450d38c"),
    "ERC20InsufficientBalance",
  );
  assert.equal(PERMIT2, "0x000000000022d473030f116ddee9f6b43ac78ba3");
});

test("a refusal is found by its name or by the selector a node shows in its place", () => {
  assert.equal(backingErrorIn("execution reverted: Slippage()"), "Slippage");
  assert.equal(
    backingErrorIn("reverted with custom error 'TooSoon(1700)'"),
    "TooSoon",
  );
  assert.equal(
    backingErrorIn("execution reverted, data: 0x7dd37f70"),
    "Slippage",
  );
  assert.equal(backingErrorIn("revert 0xE86F59EA0000"), null); // not a whole selector word
  assert.equal(backingErrorIn("revert 0xe86f59ea"), "TooSoon");
  assert.equal(backingErrorIn("the node is busy"), null);
  assert.equal(backingErrorIn("Slippages are fine"), null);
});

// ---- decoding ------------------------------------------------------------------------------------

const ADDR_A = `0x${"aa".repeat(20)}`;
const ADDR_B = `0x${"bb".repeat(20)}`;

function snapshotHex(overrides = {}) {
  const s = {
    price: 25_000n * 10n ** 18n, // 0.000025 quote per unit at 18 decimals: 25000 * 1e18 / 1e18... see below
    buyPrice: 28_000n * 10n ** 18n,
    reserve: 2_000n * 10n ** 18n,
    escrow: 220n * 10n ** 18n,
    released: 40n * 10n ** 18n,
    refunded: 5n * 10n ** 18n,
    feesTaken: 25n * 10n ** 18n,
    treasuryOwed: 0n,
    totalSupply: 80_000_000n * 10n ** 18n,
    totalWeight: 220n * 10n ** 30n,
    abandoned: false,
    openedAt: 1_700_000_000n,
    nextClaimAt: 1_702_419_200n,
    abandonableAt: 1_715_552_000n,
    abandonVotes: 0n,
    milestoneId: 2n,
    milestone: [
      `0x${"12".repeat(32)}`,
      1_700_100_000n,
      1_700_704_800n,
      1_701_309_600n,
      1n,
      200n * 10n ** 18n,
      0n,
      0n,
    ],
    pending: 50n * 10n ** 18n,
    holderUnits: 1_000n * 10n ** 18n,
    holderWeight: 5n * 10n ** 30n,
    holderEscrow: 9n * 10n ** 18n,
    holderSellValue: 80n * 10n ** 18n,
    holderCanLeave: true,
    holderLeaveValue: 89n * 10n ** 18n,
    holderVotedAbandon: false,
    holderEarlyLeft: (1n << 256n) - 1n,
    round: [
      0n, // none
      ADDR_A,
      ADDR_B,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
    ],
    ...overrides,
  };
  return encodeParameters(
    [
      {
        tuple: BACKING_STRUCT_TYPES.Snapshot.tuple,
      },
    ],
    [
      [
        s.price,
        s.buyPrice,
        s.reserve,
        s.escrow,
        s.released,
        s.refunded,
        s.feesTaken,
        s.treasuryOwed,
        s.totalSupply,
        s.totalWeight,
        s.abandoned,
        s.openedAt,
        s.nextClaimAt,
        s.abandonableAt,
        s.abandonVotes,
        s.milestoneId,
        s.milestone,
        s.pending,
        s.holderUnits,
        s.holderWeight,
        s.holderEscrow,
        s.holderSellValue,
        s.holderCanLeave,
        s.holderLeaveValue,
        s.holderVotedAbandon,
        s.holderEarlyLeft,
        s.round,
      ],
    ],
  );
}

test("a snapshot decodes field for field", () => {
  const s = decodeSnapshot(snapshotHex());
  assert.equal(s.escrow, 220n * 10n ** 18n);
  assert.equal(s.released, 40n * 10n ** 18n);
  assert.equal(s.milestoneId, 2n);
  assert.equal(s.milestone.status, "open");
  assert.equal(s.milestone.windowEndsAt, 1_700_704_800);
  assert.equal(s.milestone.ref, `0x${"12".repeat(32)}`);
  assert.equal(s.holderUnits, 1_000n * 10n ** 18n);
  assert.equal(s.holderCanLeave, true);
  assert.equal(s.holderLeaveValue, 89n * 10n ** 18n);
  // "No limit now" is the contract's largest number.
  assert.equal(s.holderEarlyLeft, null);
  assert.equal(s.round.state, "none");
  assert.equal(
    decodeSnapshot(snapshotHex({ holderEarlyLeft: 500n })).holderEarlyLeft,
    500n,
  );
});

test("an answer that is not a whole snapshot is a read we do not have, never a default", () => {
  const good = snapshotHex();
  assert.throws(() => decodeSnapshot("0x"), /not 47/);
  assert.throws(() => decodeSnapshot(good.slice(0, -64)), /not 47/);
  assert.throws(() => decodeSnapshot(`${good}${"0".repeat(64)}`), /not 47/);
  // A state this app does not know is refused, not shown as the nearest one.
  assert.throws(
    () =>
      decodeSnapshot(
        snapshotHex({
          milestone: [`0x${"12".repeat(32)}`, 1n, 2n, 3n, 9n, 0n, 0n, 0n],
        }),
      ),
    /does not know/,
  );
});

test("a round info decodes, in each state", () => {
  const word = (v) => v.toString(16).padStart(64, "0");
  const round = (state) =>
    `0x${[
      BigInt(state),
      BigInt(ADDR_A),
      BigInt(ADDR_B),
      100_000_000n * 10n ** 18n,
      1_234_567n,
      2_500n * 10n ** 18n,
      1_900n * 10n ** 18n,
      (79n * (1n << 96n)) / 1_000_000n,
      0n,
      0n,
      0n,
      0n,
      0n,
      3n,
    ]
      .map(word)
      .join("")}`;
  const waiting = decodeRoundInfo(round(1));
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.auction, ADDR_A);
  assert.equal(waiting.endBlock, 1_234_567);
  assert.equal(waiting.minimumRaise, 2_500n * 10n ** 18n);
  assert.equal(waiting.holderClaimTokens, 3n);
  assert.equal(decodeRoundInfo(round(3)).state, "failed");
  assert.throws(() => decodeRoundInfo(round(4)), /does not know/);
  assert.throws(() => decodeRoundInfo("0x00"), /not 14/);
});

// ---- amounts and prices --------------------------------------------------------------------------

test("amounts are parsed strictly and shown without losing a non-zero figure", () => {
  assert.equal(parseAmount("12.5", 6), 12_500_000n);
  assert.equal(parseAmount("1,000", 18), 1000n * 10n ** 18n);
  assert.equal(parseAmount("0.000001", 6), 1n);
  assert.equal(parseAmount("0.0000001", 6), null);
  assert.equal(parseAmount("1e3", 6), null);
  assert.equal(parseAmount("-1", 6), null);
  assert.equal(parseAmount("", 6), null);
  assert.equal(parseAmount(".5", 6), null);
  assert.equal(parseAmount("5.", 6), 5_000_000n);

  assert.equal(formatAmount(0n, 6), "0");
  assert.equal(formatAmount(2_500_000_000n, 6), "2,500");
  assert.equal(formatAmount(12_345_678n, 6), "12.34");
  assert.equal(formatAmount(1_999_999n, 6), "1.99");
  assert.equal(formatAmount(4_200n, 6), "0.0042");
  assert.equal(formatAmount(1n, 6), "0.000001");
  assert.equal(formatAmount(1n, 18), "less than 0.000001");
  assert.equal(exactDecimal(1_500_000n, 6), "1.5");
  assert.equal(exactDecimal(-1_500_000n, 6), "-1.5");
});

test("a curve price is quote base units per whole unit times 1e18, whatever the quote's decimals", () => {
  // The opening price 0.000025: 25_000 * 1e18 quote-with-18-decimals ... per whole unit is 0.000025 * 1e18 base units,
  // times 1e18 for the fixed point.
  const open18 = 25n * 10n ** 12n * 10n ** 18n; // 0.000025 * 1e18 base units * 1e18
  assert.equal(formatCurvePrice(open18, 18), "0.000025");
  // The same price in a 6-decimal quote is 25 base units per whole unit.
  const open6 = 25n * 10n ** 18n;
  assert.equal(formatCurvePrice(open6, 6), "0.000025");
  // After the curve has moved 7.7 times.
  assert.equal(formatCurvePrice((open6 * 77n) / 10n, 6), "0.0001925");
  assert.equal(formatCurvePrice(1_250_000n * 10n ** 18n, 6), "1.25");
});

test("a round's price is the auction's own: base units per base unit, times 2^96", () => {
  const q96 = 1n << 96n;
  // 0.000025 quote per whole claim token, in an 18-decimal quote: 0.000025 base per base unit.
  const price = (q96 * 25n) / 1_000_000n;
  assert.equal(formatRoundPrice(price, 18), "0.000025");
  // In a 6-decimal quote the same whole-token price is 0.000025 * 1e6 / 1e18 base per base unit.
  const price6 = (q96 * 25n) / 10n ** 18n;
  assert.equal(formatRoundPrice(price6, 6), "0.000025");
  assert.equal(formatRoundPrice(0n, 6), "0");
});

test("a round's price limit is snapped up onto the tick grid, never below what was asked", () => {
  const q96 = 1n << 96n;
  const spacing = (q96 * 25n) / 1_000_000n / 100n; // a hundredth of the opening price
  const snapped = snapRoundLimit("0.00003", 18, spacing);
  assert.ok(snapped !== null && snapped % spacing === 0n);
  assert.ok(snapped >= (q96 * 3n) / 100_000n, "not below what was asked");
  assert.ok(
    snapped - (q96 * 3n) / 100_000n < spacing,
    "and at most one step above it",
  );
  assert.equal(snapRoundLimit("0", 18, spacing), null);
  assert.equal(snapRoundLimit("abc", 18, spacing), null);
  assert.equal(snapRoundLimit("0.00003", 18, 0n), null);
});

test("a round's limit snaps the same way for a 6-decimal quote", () => {
  const q96 = 1n << 96n;
  // 0.000025 whole quote per whole claim token with a 6-decimal quote: 25e-6 * 1e6 / 1e18 = 2.5e-17 base per base unit.
  const spacing = (q96 * 25n) / 10n ** 18n / 100n;
  const snapped = snapRoundLimit("0.00003", 6, spacing);
  assert.ok(snapped !== null && snapped % spacing === 0n);
  const asked = (q96 * 3n) / 10n ** 17n;
  assert.ok(snapped >= asked && snapped - asked <= spacing);
  // What the limit would display as is the grid price at or just above what was typed.
  assert.equal(formatRoundPrice(snapped, 6).startsWith("0.00003"), true);
});

test("a price move is a percent with one place, or null with nothing to compare", () => {
  assert.equal(priceMovePercent(100n, 112n), 12);
  assert.equal(priceMovePercent(1000n, 995n), -0.5);
  assert.equal(priceMovePercent(0n, 5n), null);
  assert.equal(priceMovePercent(5n, 0n), null);
});

test("a limit takes basis points off and rounds down; a deadline is never earlier than either clock", () => {
  assert.equal(withSlippage(1_000_000n, 100), 990_000n);
  assert.equal(withSlippage(999n, 100), 989n);
  assert.equal(withSlippage(1_000n, 0), 1_000n);
  assert.equal(withSlippage(1_000n, 10_000), 0n);
  assert.throws(() => withSlippage(1n, -1), /percent/);
  assert.throws(() => withSlippage(1n, 10_001), /percent/);
  assert.throws(() => withSlippage(1n, 1.5), /percent/);
  assert.equal(tradeDeadline(1000, 500, 60), 1060n);
  assert.equal(tradeDeadline(500, 1000, 60), 1060n);
});

// ---- where a pool stands -------------------------------------------------------------------------

const decoded = (overrides, roundState = 0n) => {
  const round = [
    roundState,
    ADDR_A,
    ADDR_B,
    0n,
    1_000n,
    2_500n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    7n,
  ];
  return decodeSnapshot(snapshotHex({ round, ...overrides }));
};

test("a pool is in exactly one of five states", () => {
  assert.equal(poolPhase(null), "none");
  assert.equal(poolPhase(decoded({}, 0n)), "live"); // opened without a round
  assert.equal(poolPhase(decoded({}, 2n)), "live"); // round settled
  assert.equal(poolPhase(decoded({}, 1n)), "waiting");
  assert.equal(poolPhase(decoded({}, 3n)), "failed");
  assert.equal(poolPhase(decoded({ abandoned: true }, 2n)), "abandoned");
  assert.equal(poolPhase(decoded({ abandoned: true }, 0n)), "abandoned");
  // A closed round is reported as failed whatever else the snapshot says.
  assert.equal(poolPhase(decoded({ abandoned: true }, 3n)), "failed");
  assert.equal(poolPhase(decoded({ abandoned: true }, 1n)), "waiting");
});

test("a waiting round is bidding until its end block and ended after", () => {
  const s = decoded({}, 1n);
  assert.equal(roundStage(s.round, 999), "bidding");
  assert.equal(roundStage(s.round, 1000), "ended");
  assert.equal(roundStage(s.round, 5000), "ended");
});

test("the next milestone step follows the post's windows to the second", () => {
  const open = decoded({});
  const ends = open.milestone.windowEndsAt;
  const by = open.milestone.resolveBy;
  assert.deepEqual(nextMilestone(open, ends - 1), {
    kind: "window",
    leaveBy: ends,
    releasableFrom: ends,
  });
  assert.deepEqual(nextMilestone(open, ends), { kind: "release", until: by });
  assert.deepEqual(nextMilestone(open, by - 1), { kind: "release", until: by });
  assert.deepEqual(nextMilestone(open, by), { kind: "cancel" });
  const released = decoded({
    milestone: [`0x${"12".repeat(32)}`, 1n, 2n, 3n, 2n, 0n, 0n, 0n],
    nextClaimAt: 5_000n,
  });
  assert.deepEqual(nextMilestone(released, 4_999), {
    kind: "wait",
    from: 5000,
  });
  assert.deepEqual(nextMilestone(released, 5_000), { kind: "ready" });
  // No post yet: the first is the opening plus the interval.
  const fresh = decoded({
    milestoneId: 0n,
    milestone: [`0x${"00".repeat(32)}`, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
    nextClaimAt: 9_000n,
  });
  assert.deepEqual(nextMilestone(fresh, 100), { kind: "wait", from: 9000 });
});

test("leaving is offered only while the window runs and the contract says this wallet may", () => {
  const open = decoded({});
  const ends = open.milestone.windowEndsAt;
  assert.equal(canLeaveNow(open, ends - 1), true);
  assert.equal(canLeaveNow(open, ends), false);
  assert.equal(
    canLeaveNow({ ...open, holderCanLeave: false }, ends - 1),
    false,
  );
});

// ---- events --------------------------------------------------------------------------------------

const topicAddress = (a) => `0x${"0".repeat(24)}${a.slice(2)}`;
const topicNumber = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const log = (topics, types, values, block = 100, index = 0) => ({
  topics,
  data: encodeParameters(types, values),
  blockNumber: `0x${block.toString(16)}`,
  logIndex: `0x${index.toString(16)}`,
  transactionHash: `0x${"ee".repeat(32)}`,
});
const U = "uint256";

const boughtLog = (buyer, quoteIn, priceAfter, block = 100, index = 0) =>
  log(
    [BACKING_TOPICS.bought, topicAddress(buyer)],
    Array(7).fill(U),
    [quoteIn, quoteIn * 10n, 1n, 9n, priceAfter, 5n, 6n],
    block,
    index,
  );

test("each pool event decodes to the fields the page shows", () => {
  const bought = decodePoolLog(boughtLog(ADDR_A, 500n, 777n));
  assert.deepEqual(
    {
      kind: bought.kind,
      buyer: bought.buyer,
      quoteIn: bought.quoteIn,
      priceAfter: bought.priceAfter,
    },
    { kind: "bought", buyer: ADDR_A, quoteIn: 500n, priceAfter: 777n },
  );
  const sold = decodePoolLog(
    log([BACKING_TOPICS.sold, topicAddress(ADDR_B)], Array(7).fill(U), [
      3n,
      90n,
      1n,
      0n,
      600n,
      5n,
      6n,
    ]),
  );
  assert.deepEqual(
    {
      kind: sold.kind,
      seller: sold.seller,
      unitsIn: sold.unitsIn,
      quoteOut: sold.quoteOut,
      priceAfter: sold.priceAfter,
    },
    {
      kind: "sold",
      seller: ADDR_B,
      unitsIn: 3n,
      quoteOut: 90n,
      priceAfter: 600n,
    },
  );
  const left = decodePoolLog(
    log(
      [BACKING_TOPICS.left, topicNumber(2n), topicAddress(ADDR_A)],
      Array(8).fill(U),
      [10n, 95n, 80n, 15n, 1n, 650n, 5n, 6n],
    ),
  );
  assert.deepEqual(
    {
      kind: left.kind,
      id: left.id,
      backer: left.backer,
      quoteOut: left.quoteOut,
      fromEscrow: left.fromEscrow,
      priceAfter: left.priceAfter,
    },
    {
      kind: "left",
      id: 2n,
      backer: ADDR_A,
      quoteOut: 95n,
      fromEscrow: 15n,
      priceAfter: 650n,
    },
  );
  const ref = `0x${"12".repeat(32)}`;
  const posted = decodePoolLog(
    log(
      [
        BACKING_TOPICS.milestonePosted,
        topicNumber(1n),
        ref,
        topicAddress(ADDR_A),
      ],
      Array(4).fill(U),
      [1_700_700_000n, 1_701_300_000n, 220n, 55n],
    ),
  );
  assert.deepEqual(
    {
      kind: posted.kind,
      id: posted.id,
      ref: posted.ref,
      by: posted.by,
      windowEndsAt: posted.windowEndsAt,
      tranche: posted.tranche,
    },
    {
      kind: "milestone-posted",
      id: 1n,
      ref,
      by: ADDR_A,
      windowEndsAt: 1_700_700_000,
      tranche: 55n,
    },
  );
  const resolved = decodePoolLog(
    log(
      [BACKING_TOPICS.milestoneResolved, topicNumber(1n)],
      ["bool", U],
      [true, 50n],
    ),
  );
  assert.deepEqual(
    {
      kind: resolved.kind,
      released: resolved.released,
      amount: resolved.amount,
    },
    { kind: "milestone-resolved", released: true, amount: 50n },
  );
  const opened = decodePoolLog(
    log(
      [BACKING_TOPICS.roundBound, topicAddress(ADDR_A), topicAddress(ADDR_B)],
      [U, U, U],
      [100n, 2_500n, 999n],
    ),
  );
  assert.deepEqual(
    {
      kind: opened.kind,
      auction: opened.auction,
      minimumRaise: opened.minimumRaise,
      endBlock: opened.endBlock,
    },
    {
      kind: "round-opened",
      auction: ADDR_A,
      minimumRaise: 2_500n,
      endBlock: 999,
    },
  );
  const settled = decodePoolLog(
    log([BACKING_TOPICS.roundSeeded], Array(8).fill(U), [
      3_000n,
      30n,
      297n,
      2_673n,
      90n,
      123n,
      456n,
      7n,
    ]),
  );
  assert.deepEqual(
    {
      kind: settled.kind,
      received: settled.received,
      unitsSold: settled.unitsSold,
      openingPrice: settled.openingPrice,
    },
    {
      kind: "round-settled",
      received: 3_000n,
      unitsSold: 90n,
      openingPrice: 456n,
    },
  );
  const failed = decodePoolLog(
    log(
      [BACKING_TOPICS.roundFailed, topicAddress(ADDR_A)],
      [U, U],
      [900n, 2_500n],
    ),
  );
  assert.deepEqual(
    {
      kind: failed.kind,
      raised: failed.raised,
      minimumRaise: failed.minimumRaise,
    },
    { kind: "round-failed", raised: 900n, minimumRaise: 2_500n },
  );
  const gone = decodePoolLog(
    log(
      [BACKING_TOPICS.abandoned, topicAddress(ADDR_A)],
      ["bool", U, U],
      [false, 12n, 1n],
    ),
  );
  assert.deepEqual(
    { kind: gone.kind, by: gone.by, byVote: gone.byVote, escrow: gone.escrow },
    { kind: "abandoned", by: ADDR_A, byVote: false, escrow: 12n },
  );
  assert.equal(
    decodePoolLog({
      topics: [`0x${"01".repeat(32)}`],
      data: "0x",
      blockNumber: "0x1",
    }),
    null,
  );
});

test("a log with a pool topic and the wrong shape throws rather than shows a wrong figure", () => {
  assert.throws(() =>
    decodePoolLog({
      topics: [BACKING_TOPICS.bought],
      data: "0x00",
      blockNumber: "0x1",
    }),
  );
  assert.throws(() =>
    decodePoolLog({ ...boughtLog(ADDR_A, 1n, 1n), blockNumber: "banana" }),
  );
});

test("the events read is one OR over the pool's topics, newest first, bounded, and counts what it could not read", async () => {
  const calls = [];
  const logs = [
    boughtLog(ADDR_A, 100n, 10n, 10, 0),
    boughtLog(ADDR_B, 200n, 12n, 12, 1),
    boughtLog(ADDR_A, 300n, 15n, 12, 0),
    { topics: [BACKING_TOPICS.sold], data: "0x", blockNumber: "0x13" }, // right topic, no body
  ];
  const result = await readPoolEvents(async (filter) => {
    calls.push(filter);
    return logs;
  }, ADDR_A);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, ADDR_A);
  assert.equal(calls[0].topics.length, 1);
  assert.ok(
    Array.isArray(calls[0].topics[0]) &&
      calls[0].topics[0].includes(BACKING_TOPICS.milestonePosted),
  );
  assert.deepEqual(
    result.events.map((e) => [e.block, e.logIndex]),
    [
      [12, 1],
      [12, 0],
      [10, 0],
    ],
  );
  assert.equal(result.cut, false);
  assert.equal(result.unreadable, 1);

  const many = Array.from({ length: MAX_POOL_EVENTS + 5 }, (_, i) =>
    boughtLog(ADDR_A, 1n, 1n, i + 1),
  );
  const cut = await readPoolEvents(async () => many, ADDR_A);
  assert.equal(cut.events.length, MAX_POOL_EVENTS);
  assert.equal(cut.cut, true);
  assert.equal(cut.events[0].block, MAX_POOL_EVENTS + 5, "the newest are kept");

  // A node that fails is the caller's failure, never an empty history.
  await assert.rejects(
    readPoolEvents(async () => {
      throw new Error("node down");
    }, ADDR_A),
    /node down/,
  );
});

test("totals and milestone records come from the events and are lower bounds when the read was cut", () => {
  const events = [
    boughtLog(ADDR_A, 100n, 10n, 10),
    boughtLog(ADDR_A, 50n, 11n, 11),
    boughtLog(ADDR_B, 25n, 12n, 12),
    log(
      [BACKING_TOPICS.roundSeeded],
      Array(8).fill(U),
      [1_000n, 10n, 99n, 891n, 90n, 1n, 2n, 7n],
      5,
    ),
  ].map(decodePoolLog);
  assert.deepEqual(poolTotals(events), { paidIn: 1_175n, backers: 2 });

  const ref = `0x${"12".repeat(32)}`;
  const milestones = [
    log(
      [
        BACKING_TOPICS.milestonePosted,
        topicNumber(1n),
        ref,
        topicAddress(ADDR_A),
      ],
      Array(4).fill(U),
      [10n, 20n, 220n, 55n],
      20,
    ),
    log(
      [BACKING_TOPICS.left, topicNumber(1n), topicAddress(ADDR_B)],
      Array(8).fill(U),
      [1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n],
      21,
    ),
    log(
      [BACKING_TOPICS.milestoneResolved, topicNumber(1n)],
      ["bool", U],
      [true, 50n],
      30,
    ),
    log(
      [
        BACKING_TOPICS.milestonePosted,
        topicNumber(2n),
        ref,
        topicAddress(ADDR_A),
      ],
      Array(4).fill(U),
      [10n, 20n, 220n, 55n],
      40,
    ),
  ].map(decodePoolLog);
  // The events come newest first, as `readPoolEvents` gives them.
  const records = milestoneRecords(newestFirst(milestones));
  assert.deepEqual(
    records.map((r) => [r.id, r.outcome, r.releasedAmount, r.leavers]),
    [
      [1n, "released", 50n, 1],
      [2n, "open", 0n, 0],
    ],
  );
});

// ---- reading -------------------------------------------------------------------------------------

const FACTORY = `0x${"fa".repeat(20)}`;
const POOL = `0x${"90".repeat(20)}`;
const QUOTE = `0x${"c0".repeat(20)}`;
const DAO = `0x${"da".repeat(20)}`;
const ME = `0x${"1e".repeat(20)}`;
const wordOf = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
const stringHex = (text) => encodeParameters(["string"], [text]);

function fakeChain(overrides = {}) {
  const calls = [];
  const sel = (signature) => selectorOf(signature);
  const handlers = {
    [`${FACTORY}:${sel("poolOf(address)")}`]: () => wordOf(POOL),
    [`${FACTORY}:${sel("quote()")}`]: () => wordOf(QUOTE),
    [`${FACTORY}:${sel("roundFloorPriceX96()")}`]: () => wordOf(2500n),
    [`${FACTORY}:${sel("roundTickSpacingX96()")}`]: () => wordOf(25n),
    [`${FACTORY}:${sel("founderOf(address)")}`]: () => wordOf(ME),
    [`${FACTORY}:${sel("auctionFactory()")}`]: () =>
      wordOf(`0x${"af".repeat(20)}`),
    [`${FACTORY}:${sel("defaultMinimumRaise()")}`]: () =>
      wordOf(2_500_000_000n),
    [`${POOL}:${sel("snapshot(address)")}`]: () => snapshotHex(),
    [`${POOL}:${sel("founder()")}`]: () => wordOf(ME),
    [`${POOL}:${sel("quote()")}`]: () => wordOf(QUOTE),
    [`${QUOTE}:${sel("decimals()")}`]: () => wordOf(6),
    [`${QUOTE}:${sel("symbol()")}`]: () => stringHex("TEST"),
    [`${QUOTE}:${sel("balanceOf(address)")}`]: () => wordOf(5_000_000n),
    [`${QUOTE}:${sel("allowance(address,address)")}`]: () => wordOf(1_000n),
    ...overrides,
  };
  return {
    calls,
    async call(to, data) {
      calls.push([to, data.slice(0, 10)]);
      const handler = handlers[`${to.toLowerCase()}:${data.slice(0, 10)}`];
      if (!handler) throw new Error(`no answer for ${to} ${data.slice(0, 10)}`);
      return handler(data);
    },
    now: async () => 1_700_000_500,
    blockNumber: async () => 777,
  };
}

test("a project's pool is found by its DAO through the factory, and the zero address alone says there is none", async () => {
  assert.equal(await readPoolAddress(fakeChain(), FACTORY, DAO), POOL);
  const none = fakeChain({
    [`${FACTORY}:${selectorOf("poolOf(address)")}`]: () => wordOf(0),
  });
  assert.equal(await readPoolAddress(none, FACTORY, DAO), null);
  const read = await readPool(none, {
    factory: FACTORY,
    dao: DAO,
    holder: ME,
    expectedQuote: QUOTE,
  });
  assert.equal(read.kind, "none");
  assert.equal(read.founder, ME);
  assert.deepEqual(read.quote, { address: QUOTE, decimals: 6, symbol: "TEST" });
  assert.equal(read.quoteMatchesFactory, true);
  assert.deepEqual(read.round, { defaultMinimum: 2_500_000_000n });
  // A factory with no auction factory offers no round.
  const noRounds = await readPool(
    fakeChain({
      [`${FACTORY}:${selectorOf("poolOf(address)")}`]: () => wordOf(0),
      [`${FACTORY}:${selectorOf("auctionFactory()")}`]: () => wordOf(0),
    }),
    { factory: FACTORY, dao: DAO, holder: null },
  );
  assert.equal(noRounds.round, null);
  // A node that does not answer, or answers with nonsense, is a failed read and never "no pool".
  const down = fakeChain({
    [`${FACTORY}:${selectorOf("poolOf(address)")}`]: () => {
      throw new Error("node down");
    },
  });
  await assert.rejects(readPoolAddress(down, FACTORY, DAO), /node down/);
  const odd = fakeChain({
    [`${FACTORY}:${selectorOf("poolOf(address)")}`]: () => "0x",
  });
  await assert.rejects(
    readPoolAddress(odd, FACTORY, DAO),
    /not 1 32-byte words/,
  );
  const wide = fakeChain({
    [`${FACTORY}:${selectorOf("poolOf(address)")}`]: () => wordOf(1n << 200n),
  });
  await assert.rejects(readPoolAddress(wide, FACTORY, DAO), /not an address/);
});

test("reading a pool gives its snapshot, its token's own decimals and the wallet's money, in a fixed number of calls", async () => {
  const chain = fakeChain();
  const view = await readPool(chain, {
    factory: FACTORY,
    dao: DAO,
    holder: ME,
    expectedQuote: QUOTE,
  });
  assert.equal(view.kind, "pool");
  assert.equal(view.pool, POOL);
  assert.equal(view.founder, ME);
  assert.equal(view.phase, "live");
  assert.deepEqual(view.quote, { address: QUOTE, decimals: 6, symbol: "TEST" });
  assert.equal(view.quoteMatchesFactory, true);
  assert.deepEqual(view.walletMoney, {
    balance: 5_000_000n,
    allowance: 1_000n,
  });
  assert.equal(view.now, 1_700_000_500);
  assert.equal(view.block, 777);
  assert.equal(view.round, null);
  assert.ok(chain.calls.length <= 12, `calls: ${chain.calls.length}`);
});

test("a pool whose token is not the one the build names is flagged, not trusted", async () => {
  const view = await readPool(fakeChain(), {
    factory: FACTORY,
    dao: DAO,
    holder: null,
    expectedQuote: `0x${"77".repeat(20)}`,
  });
  assert.equal(view.quoteMatchesFactory, false);
  assert.equal(view.walletMoney, null);
});

test("a waiting round also reads its tick grid and what Permit2 may already take", async () => {
  const round = [
    1n,
    ADDR_A,
    ADDR_B,
    100n,
    5_000n,
    2_500n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
  ];
  const view = await readPool(
    fakeChain({
      [`${POOL}:${selectorOf("snapshot(address)")}`]: () =>
        snapshotHex({ round }),
      [`${QUOTE}:${selectorOf("allowance(address,address)")}`]: () =>
        wordOf(77n),
    }),
    { factory: FACTORY, dao: DAO, holder: ME },
  );
  assert.equal(view.phase, "waiting");
  assert.deepEqual(view.round, {
    floorPriceX96: 2500n,
    tickSpacingX96: 25n,
    permit2Allowance: 77n,
  });
});

test("a token that will not say its symbol still reads; one that will not say its decimals does not", async () => {
  const noSymbol = await readPool(
    fakeChain({
      [`${QUOTE}:${selectorOf("symbol()")}`]: () => {
        throw new Error("no symbol");
      },
    }),
    { factory: FACTORY, dao: DAO, holder: null },
  );
  assert.equal(noSymbol.quote.symbol, null);
  await assert.rejects(
    readPool(
      fakeChain({
        [`${QUOTE}:${selectorOf("decimals()")}`]: () => {
          throw new Error("no decimals");
        },
      }),
      { factory: FACTORY, dao: DAO, holder: null },
    ),
    /no decimals/,
  );
});

test("a record id is a whole 64-character id and nothing else", () => {
  assert.equal(recordRef(`0x${"AB".repeat(32)}`), `0x${"ab".repeat(32)}`);
  assert.throws(() => recordRef("zz".repeat(32)), /public record/);
  assert.throws(() => recordRef(""), /public record/);
});
