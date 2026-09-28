/**
 * Pure-logic tests for the royalty statement read model: ABI selector and
 * calldata pins (the exact `cast sig` / `cast calldata` commands are recorded
 * inline), return decoding, and every display/math helper behind
 * `ui/RoyaltyStatementCard.tsx`. Imports the production module so the seam
 * under test is the shipped one. Plain .mjs — `node --test` with
 * `--experimental-strip-types` loads the `.ts` module.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  accrualH,
  averageHeld,
  bandLabel,
  buildRoyaltyClaimCall,
  decodeAddressWord,
  decodeRoyaltyReqResult,
  decodeScheduleResult,
  encodeAllocOf,
  encodeBalanceOf,
  encodeBandOf,
  encodeCarry,
  encodeClaimableOf,
  encodeCurrency,
  encodeDecimals,
  encodeNextClose,
  encodeOpenBal,
  encodePendingRevenue,
  encodeProjectToken,
  encodeRoyaltyReq,
  encodeSchedules,
  formatH,
  formatUnits,
  H_SCALE,
  SELECTOR_ALLOC_OF,
  SELECTOR_BALANCE_OF,
  SELECTOR_BAND_OF,
  SELECTOR_CARRY,
  SELECTOR_CLAIM,
  SELECTOR_CLAIMABLE_OF,
  SELECTOR_CURRENCY,
  SELECTOR_DECIMALS,
  SELECTOR_NEXT_CLOSE,
  SELECTOR_OPEN_BAL,
  SELECTOR_PENDING_REVENUE,
  SELECTOR_PROJECT_TOKEN,
  SELECTOR_ROYALTY_REQ,
  SELECTOR_SCHEDULES,
  termCountdown,
} from "./royalty.ts";

// The address and claim id the `cast calldata` goldens below were made with.
const ADDRESS = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B";
const CLAIM_ID = `0x${"11".repeat(32)}`;

/** One 32-byte ABI word (bare hex), like `eth_call` returns them. */
function word(value) {
  const n = typeof value === "boolean" ? (value ? 1n : 0n) : BigInt(value);
  return n.toString(16).padStart(64, "0");
}

function addressWord(address) {
  return word(BigInt(address));
}

function words(...ws) {
  return `0x${ws.join("")}`;
}

// ---------------------------------------------------------------- selectors

test("selectors match the cast sig golden values", () => {
  // cast sig '<signature>' for each row (RoyaltyDistributor.sol / ClaimStake).
  const pins = [
    ["0x8903ab9d", SELECTOR_CLAIMABLE_OF],
    ["0x80627e3f", SELECTOR_ALLOC_OF],
    ["0x63baa3df", SELECTOR_OPEN_BAL],
    ["0xd1e16bfa", SELECTOR_SCHEDULES],
    ["0x8c6f511c", SELECTOR_BAND_OF],
    ["0x09038a56", SELECTOR_NEXT_CLOSE],
    ["0xf02ec765", SELECTOR_CARRY],
    ["0xf9a758e5", SELECTOR_PENDING_REVENUE],
    ["0x4e71d92d", SELECTOR_CLAIM],
    ["0x5c458d5d", SELECTOR_ROYALTY_REQ],
    ["0xe5a6b10f", SELECTOR_CURRENCY],
    ["0x4b60ce77", SELECTOR_PROJECT_TOKEN],
    ["0x313ce567", SELECTOR_DECIMALS],
    ["0x70a08231", SELECTOR_BALANCE_OF],
  ];
  for (const [golden, actual] of pins) {
    assert.equal(actual, golden);
  }
});

// ---------------------------------------------------------------- calldata

test("read calldata matches the cast calldata goldens", () => {
  // cast calldata '<signature>' <args> — one row per builder.
  assert.equal(
    encodeClaimableOf(ADDRESS),
    "0x8903ab9d000000000000000000000000ab5801a7d398351b8be11c439e05c5b3259aec9b",
  );
  assert.equal(
    encodeAllocOf(ADDRESS),
    "0x80627e3f000000000000000000000000ab5801a7d398351b8be11c439e05c5b3259aec9b",
  );
  assert.equal(
    encodeOpenBal(ADDRESS),
    "0x63baa3df000000000000000000000000ab5801a7d398351b8be11c439e05c5b3259aec9b",
  );
  assert.equal(
    encodeSchedules(CLAIM_ID),
    "0xd1e16bfa1111111111111111111111111111111111111111111111111111111111111111",
  );
  assert.equal(
    encodeBandOf(ADDRESS),
    "0x8c6f511c000000000000000000000000ab5801a7d398351b8be11c439e05c5b3259aec9b",
  );
  assert.equal(encodeNextClose(), "0x09038a56");
  assert.equal(encodeCarry(), "0xf02ec765");
  assert.equal(encodePendingRevenue(), "0xf9a758e5");
  assert.equal(
    encodeRoyaltyReq(CLAIM_ID),
    "0x5c458d5d1111111111111111111111111111111111111111111111111111111111111111",
  );
  assert.equal(encodeCurrency(), "0xe5a6b10f");
  assert.equal(encodeProjectToken(), "0x4b60ce77");
  assert.equal(encodeDecimals(), "0x313ce567");
  assert.equal(
    encodeBalanceOf(ADDRESS),
    "0x70a08231000000000000000000000000ab5801a7d398351b8be11c439e05c5b3259aec9b",
  );
});

test("the claim call is a zero-value, sender-agnostic claim()", () => {
  const call = buildRoyaltyClaimCall(ADDRESS);
  assert.equal(call.to, ADDRESS.toLowerCase());
  assert.equal(call.data, "0x4e71d92d");
  assert.equal(call.value, "0x0");
});

test("encoders reject garbage instead of composing bogus reads", () => {
  assert.throws(() => encodeClaimableOf("0x1234"), /must be a 0x address/);
  assert.throws(
    () => encodeBalanceOf("not-an-address"),
    /must be a 0x address/,
  );
  assert.throws(() => encodeSchedules(`0x${"11".repeat(31)}`), /32 bytes/);
  assert.throws(() => encodeRoyaltyReq("0x"), /32 bytes/);
  assert.throws(() => buildRoyaltyClaimCall(""), /must be a 0x address/);
  // Case is normalized away: machine values have one rendering.
  assert.equal(
    encodeSchedules(CLAIM_ID.toUpperCase().replace("0X", "0x")),
    encodeSchedules(CLAIM_ID),
  );
});

// ---------------------------------------------------------------- decoders

test("schedules(bytes32) decodes all seven words", () => {
  const decoded = decodeScheduleResult(
    words(
      addressWord(ADDRESS),
      word(1000),
      word(2000),
      word(2),
      word(3),
      word(500),
      word(1),
    ),
  );
  assert.deepEqual(decoded, {
    contributor: ADDRESS.toLowerCase(),
    start: 1000n,
    end: 2000n,
    weight: 2,
    band: 3,
    allocation: 500n,
    suspended: true,
  });
  const active = decodeScheduleResult(
    words(
      addressWord(ADDRESS),
      word(0),
      word(1),
      word(1),
      word(1),
      word(1),
      word(0),
    ),
  );
  assert.equal(active.suspended, false);
});

test("royaltyReq(bytes32) decodes its four attested words", () => {
  assert.deepEqual(
    decodeRoyaltyReqResult(words(word(2), word(31536000), word(1), word(700))),
    { weight: 2, term: 31536000n, band: 1, allocation: 700n },
  );
});

test("decoders reject short or garbled returns, never guess", () => {
  assert.throws(() => decodeScheduleResult(words(word(1))), /7 words/);
  assert.throws(
    () => decodeRoyaltyReqResult(words(word(1), word(2))),
    /4 words/,
  );
  assert.equal(
    decodeAddressWord(words(addressWord(ADDRESS))),
    ADDRESS.toLowerCase(),
  );
  assert.throws(() => decodeAddressWord("0x"), /ABI words/);
  // High bits set: not an address word.
  assert.throws(
    () => decodeAddressWord(words(word((1n << 160n) | 5n))),
    /not an address word/,
  );
});

// ------------------------------------------------------------------- h math

test("the trapezoid average floors exactly like the contract", () => {
  assert.equal(averageHeld(100n, 201n), 150n); // 301/2 floors to 150
  assert.equal(averageHeld(1n, 2n), 1n); // 3/2 floors to 1
  assert.equal(averageHeld(0n, 0n), 0n);
  assert.equal(averageHeld(250n, 250n), 250n);
});

test("accrual h mirrors settle's integer math: trapezoid, floor, clamp", () => {
  // Proportional: avg 25 of alloc 100 → 0.25e18.
  assert.equal(accrualH(0n, 50n, 100n), 250000000000000000n);
  // Same average from unequal samples (the trapezoid, not a point read).
  assert.equal(accrualH(20n, 30n, 100n), 250000000000000000n);
  // Floor on the division: (1 * 1e18) / 7 truncates.
  assert.equal(accrualH(0n, 3n, 7n), 142857142857142857n);
  // Floor on the average first: 199/2 = 99, so h = 0.99e18.
  assert.equal(accrualH(0n, 199n, 100n), 990000000000000000n);
  // Clamp at full: avg >= alloc → 1e18 (over-holding earns nothing extra).
  assert.equal(accrualH(100n, 300n, 100n), H_SCALE);
  // The average's own floor feeds the clamp: 201/2 = 100 = alloc → full.
  assert.equal(accrualH(0n, 201n, 100n), H_SCALE);
});

test("an empty allocation reads as full — the contract can never divide by zero", () => {
  // settle(): `avg >= alloc ? 1e18 : …` — with alloc = 0 the comparison wins.
  assert.equal(accrualH(0n, 0n, 0n), H_SCALE);
  assert.equal(accrualH(5n, 7n, 0n), H_SCALE);
});

// ------------------------------------------------------------- formatting

test("h renders as an exact percent, clamped at 100%", () => {
  assert.equal(formatH(625000000000000000n), "62.5%");
  assert.equal(formatH(H_SCALE), "100%");
  assert.equal(formatH(0n), "0%");
  assert.equal(formatH(2n * H_SCALE), "100%"); // clamp, never "200%"
  assert.equal(formatH(999999999999999999n), "99.9%");
  assert.equal(formatH(333333333333333333n), "33.3%"); // truncates, not rounds
  assert.equal(formatH(10000000000000000n), "1%"); // no ".0" tail
  assert.equal(formatH(5n), "0%"); // dust is dust
});

test("band labels follow the band table and refuse to guess", () => {
  assert.equal(bandLabel(1), "Tier I");
  assert.equal(bandLabel(2), "Tier II");
  assert.equal(bandLabel(3), "Tier III");
  assert.equal(bandLabel(0), "—");
  assert.equal(bandLabel(4), "—");
  assert.equal(bandLabel(255), "—");
});

test("amounts render exactly — no floats, no grouping", () => {
  assert.equal(formatUnits(1500000n, 6), "1.5");
  assert.equal(formatUnits(1234567n, 6), "1.234567");
  assert.equal(formatUnits(1n, 6), "0.000001");
  assert.equal(formatUnits(1000000n, 6), "1"); // whole amounts lose the tail
  assert.equal(formatUnits(0n, 6), "0");
  assert.equal(formatUnits(123n, 0), "123");
  assert.equal(formatUnits(-1500000n, 6), "-1.5");
  assert.equal(formatUnits(10n ** 24n, 18), "1000000");
  assert.throws(() => formatUnits(1n, -1), /non-negative integer/);
  assert.throws(() => formatUnits(1n, 1.5), /non-negative integer/);
});

// --------------------------------------------------------------- countdown

test("the term countdown speaks plainly and ends cleanly", () => {
  assert.deepEqual(termCountdown(1000, 400), {
    ended: false,
    secondsRemaining: 600,
    daysRemaining: 1,
    label: "1 day left",
  });
  assert.equal(termCountdown(86500, 100).label, "1 day left"); // exactly 1 day
  assert.equal(termCountdown(86501, 100).label, "2 days left"); // ceil, not floor
  assert.equal(termCountdown(2000n, 500).daysRemaining, 1); // bigint end
  // Fractional inputs floor like clock seconds.
  assert.equal(termCountdown(1000.9, 400.2).secondsRemaining, 600);
});

test("an ended term says so and never carries seconds", () => {
  assert.deepEqual(termCountdown(1000, 1000), {
    ended: true,
    secondsRemaining: 0,
    daysRemaining: 0,
    label: "Term ended",
  });
  assert.equal(termCountdown(999, 1000).ended, true);
});
