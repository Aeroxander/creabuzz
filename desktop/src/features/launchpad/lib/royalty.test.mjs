/**
 * Pure-logic tests for the royalty statement read model: ABI selector pins
 * (cross-checked against `cast sig`), return decoding, and every display/math
 * helper behind RoyaltyStatementCard. Imports the production module so the
 * seam under test is the shipped one.
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
  encodeClaimableOf,
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

const ADDRESS = `0x${"ab".repeat(20)}`;

/** One 32-byte ABI word (bare hex), like `evm_call` returns them. */
function word(value) {
  const n = typeof value === "boolean" ? (value ? 1n : 0n) : BigInt(value);
  return n.toString(16).padStart(64, "0");
}

function addressWord(address) {
  return word(BigInt(address));
}

test("selectors_match_cast_sig_golden_values", () => {
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
  for (const [expected, actual] of pins) {
    assert.equal(actual, expected);
  }
});

test("encode_claimable_of_is_selector_plus_address_word", () => {
  assert.equal(
    encodeClaimableOf(ADDRESS),
    `0x8903ab9d${"0".repeat(24)}${"ab".repeat(20)}`,
  );
});

test("encode_schedules_rejects_a_non_bytes32_claim_id", () => {
  assert.throws(() => encodeSchedules("0x1234"));
  assert.throws(() => encodeSchedules("not hex at all"));
});

test("build_royalty_claim_call_targets_the_distributor_with_empty_data", () => {
  const call = buildRoyaltyClaimCall(ADDRESS);
  assert.equal(call.to, ADDRESS);
  assert.equal(call.data, "0x4e71d92d");
  assert.equal(call.value, "0x0");
});

test("decode_address_word_reads_the_low_20_bytes_lowercase", () => {
  assert.equal(
    decodeAddressWord(`0x${"0".repeat(24)}${"AB".repeat(20)}`),
    `0x${"ab".repeat(20)}`,
  );
  assert.throws(() => decodeAddressWord("abcd"));
});

test("decode_schedule_result_parses_the_seven_word_return", () => {
  const returnData =
    "0x" +
    [
      addressWord(ADDRESS),
      word(1700000000), // start
      word(1731536000), // end
      word(2), // weight
      word(3), // band
      word(500n * 10n ** 18n), // allocation
      word(true), // suspended
    ].join("");
  const schedule = decodeScheduleResult(returnData);
  assert.equal(schedule.contributor, ADDRESS);
  assert.equal(schedule.start, 1700000000n);
  assert.equal(schedule.end, 1731536000n);
  assert.equal(schedule.weight, 2);
  assert.equal(schedule.band, 3);
  assert.equal(schedule.allocation, 500n * 10n ** 18n);
  assert.equal(schedule.suspended, true);
});

test("decode_schedule_result_accepts_bare_hex_and_rejects_short_returns", () => {
  const bare = [
    addressWord(ADDRESS),
    word(1),
    word(2),
    word(1),
    word(1),
    word(0),
    word(false),
  ].join("");
  const schedule = decodeScheduleResult(bare);
  assert.equal(schedule.contributor, ADDRESS);
  assert.equal(schedule.suspended, false);
  assert.throws(() => decodeScheduleResult(`0x${word(1)}`));
});

test("decode_royalty_req_result_parses_the_attested_request", () => {
  const returnData = `0x${[word(2), word(730 * 86400), word(2), word(250n)].join("")}`;
  const req = decodeRoyaltyReqResult(returnData);
  assert.equal(req.weight, 2);
  assert.equal(req.term, 730n * 86400n);
  assert.equal(req.band, 2);
  assert.equal(req.allocation, 250n);
});

test("average_held_is_the_trapezoid_sample_with_integer_floor", () => {
  assert.equal(averageHeld(0n, 100n), 50n);
  assert.equal(averageHeld(100n, 100n), 100n);
  assert.equal(averageHeld(3n, 4n), 3n);
  assert.equal(averageHeld(0n, 0n), 0n);
});

test("accrual_h_is_the_held_share_of_the_allocation", () => {
  // Half held → half rate.
  assert.equal(accrualH(0n, 100n, 100n), H_SCALE / 2n);
  // Full held → full rate.
  assert.equal(accrualH(100n, 100n, 100n), H_SCALE);
  // Floor division, mirroring the contract's integer math.
  assert.equal(accrualH(1n, 2n, 3n), (1n * H_SCALE) / 3n);
});

test("accrual_h_clamps_at_one_when_held_exceeds_allocation", () => {
  assert.equal(accrualH(150n, 150n, 100n), H_SCALE);
  assert.equal(accrualH(150n, 150n, 1n), H_SCALE);
  // The contract's `avg >= alloc` guard also catches the boundary exactly.
  assert.equal(accrualH(200n, 0n, 100n), H_SCALE);
  // ... and the empty-allocation edge reads full (schedule allocations are
  // always > 0 in practice; this mirrors settle() verbatim).
  assert.equal(accrualH(0n, 0n, 0n), H_SCALE);
});

test("format_h_renders_exact_percents_with_one_decimal", () => {
  const cases = [
    [0n, "0%"],
    [H_SCALE, "100%"],
    [H_SCALE / 2n, "50%"],
    [625000000000000000n, "62.5%"],
    [999999999999999999n, "99.9%"],
    [123456789012345678n, "12.3%"],
    // Clamped: an out-of-range h never renders above 100%.
    [2n * H_SCALE, "100%"],
  ];
  for (const [h, expected] of cases) {
    assert.equal(formatH(h), expected, `h: ${h}`);
  }
});

test("band_label_maps_tiers_one_two_three", () => {
  const cases = [
    [1, "Tier I"],
    [2, "Tier II"],
    [3, "Tier III"],
    // Outside the band table: an em dash, never a guessed tier.
    [0, "—"],
    [4, "—"],
  ];
  for (const [band, expected] of cases) {
    assert.equal(bandLabel(band), expected, `band: ${band}`);
  }
});

test("format_units_renders_exact_decimals_without_grouping", () => {
  const cases = [
    [0n, 6, "0"],
    [42n, 0, "42"],
    [1500000n, 6, "1.5"],
    [1000000n, 6, "1"],
    [100000n, 6, "0.1"],
    [123456n, 4, "12.3456"],
    [1n, 18, "0.000000000000000001"],
    [-1500000n, 6, "-1.5"],
  ];
  for (const [value, decimals, expected] of cases) {
    assert.equal(
      formatUnits(value, decimals),
      expected,
      `value: ${value}, decimals: ${decimals}`,
    );
  }
  assert.throws(() => formatUnits(0n, -1));
  assert.throws(() => formatUnits(0n, 1.5));
});

test("term_countdown_counts_down_to_the_term_end", () => {
  const now = 1_800_000_000;
  const inThirtyDays = termCountdown(now + 30 * 86400, now);
  assert.deepEqual(inThirtyDays, {
    ended: false,
    secondsRemaining: 30 * 86400,
    daysRemaining: 30,
    label: "30 days left",
  });
  // A part of a day rounds up; the singular form reads "1 day left".
  const oneDay = termCountdown(BigInt(now + 86400), now);
  assert.equal(oneDay.daysRemaining, 1);
  assert.equal(oneDay.label, "1 day left");
  const justOverADay = termCountdown(now + 86401, now);
  assert.equal(justOverADay.label, "2 days left");
});

test("term_countdown_reports_an_ended_term_without_a_negative_countdown", () => {
  const now = 1_800_000_000;
  const past = termCountdown(now - 10, now);
  assert.deepEqual(past, {
    ended: true,
    secondsRemaining: 0,
    daysRemaining: 0,
    label: "Term ended",
  });
  // Exactly at the end boundary: the stream has stopped.
  assert.equal(termCountdown(now, now).ended, true);
});
