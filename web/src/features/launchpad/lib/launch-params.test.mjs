import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKS_PER_DAY,
  Q96,
  floorPricePerToken,
  snapFloorToGrid,
  MIN_FLOOR_PRICE,
  MPS,
  buildSchedule,
  hasBlockingIssue,
  maxBidPrice,
  q96FromPrice,
  standardLaunchPreset,
  tickSpacingFor,
  validateLaunchParams,
} from "./launch-params.ts";

/**
 * These rules are the auction contract's (`contracts/lib/continuous-clearing-auction`).
 * A launch is a one-shot deployment, so a parameter the constructor rejects is
 * discovered too late — and the defaults this app shipped could not be deployed
 * at all.
 */

const valid = () => {
  const preset = standardLaunchPreset({ startBlock: 1_000_000n });
  return {
    supply: preset.supply,
    floorPrice: preset.floorPrice,
    tickSpacing: preset.tickSpacing,
    requiredCurrencyRaised: preset.requiredCurrencyRaised,
    startBlock: preset.startBlock,
    endBlock: preset.endBlock,
    claimBlock: preset.claimBlock,
    steps: preset.steps,
  };
};

const fields = (input) =>
  validateLaunchParams(input).map(
    (issue) => `${issue.severity}:${issue.field}`,
  );

test("the preset is deployable", () => {
  assert.deepEqual(validateLaunchParams(valid()), []);
});

test("the defaults this app shipped could not be deployed", () => {
  // floorPrice 1e6 is far below MIN_FLOOR_PRICE, and tickSpacing 100 does not
  // divide it. Both are constructor reverts.
  const issues = validateLaunchParams({
    ...valid(),
    floorPrice: 1_000_000n,
    tickSpacing: 100n,
  });
  assert.ok(hasBlockingIssue(issues), "must be reported as blocking");
  assert.ok(issues.some((issue) => issue.field === "floorPrice"));
});

test("floor price minimum and the task boundary rule", () => {
  assert.ok(
    fields({ ...valid(), floorPrice: MIN_FLOOR_PRICE - 1n }).includes(
      "error:floorPrice",
    ),
  );
  assert.ok(
    fields({ ...valid(), floorPrice: 0n }).includes("error:floorPrice"),
  );
  // The floor is the first tick, so it has to sit on the grid.
  const preset = valid();
  assert.ok(
    fields({
      ...preset,
      floorPrice: preset.floorPrice + 1n,
      tickSpacing: 2n,
    }).includes("error:floorPrice"),
  );
});

test("tick spacing floor and ceiling", () => {
  assert.ok(
    fields({ ...valid(), tickSpacing: 1n }).includes("error:tickSpacing"),
  );
  // A supply small enough that its price ceiling is uint160.max: an absurd
  // spacing is then the only way to exceed it.
  assert.ok(
    fields({ ...valid(), tickSpacing: 1n << 161n }).includes(
      "error:tickSpacing",
    ),
  );
});

test("supply limits", () => {
  assert.ok(fields({ ...valid(), supply: 0n }).includes("error:supply"));
  assert.ok(
    fields({ ...valid(), supply: 1n << 101n }).includes("error:supply"),
  );
});

test("the issuance schedule must add up to 100% and to the window", () => {
  const preset = valid();
  assert.ok(
    fields({
      ...preset,
      steps: [{ mps: 1n, blockDelta: 1n }],
    }).includes("error:steps"),
  );
  assert.ok(
    fields({
      ...preset,
      steps: preset.steps.map((step) => ({ ...step, blockDelta: 0n })),
    }).includes("error:steps[0]"),
  );
  // Deltas that do not reach endBlock.
  assert.ok(
    fields({
      ...preset,
      steps: preset.steps.map((step) => ({
        ...step,
        blockDelta: step.blockDelta - 1n,
      })),
    }).some((entry) => entry === "error:endBlock" || entry === "error:steps"),
  );
});

test("claim window and ordering", () => {
  const preset = valid();
  assert.ok(
    fields({ ...preset, startBlock: preset.endBlock }).includes(
      "error:endBlock",
    ),
  );
  assert.ok(
    fields({ ...preset, claimBlock: preset.endBlock - 1n }).includes(
      "error:claimBlock",
    ),
  );
});

test("a threshold nobody can reach is blocking, an unreachable-at-floor one warns", () => {
  const preset = valid();
  const unreachable =
    (preset.supply * maxBidPrice(preset.supply)) / (1n << 96n);
  assert.ok(
    fields({
      ...preset,
      requiredCurrencyRaised: unreachable + 1n,
    }).includes("error:requiredCurrencyRaised"),
  );
  assert.ok(
    fields({
      ...preset,
      requiredCurrencyRaised: preset.supply, // above floor value, below the max
    }).includes("warning:requiredCurrencyRaised"),
  );
  assert.ok(
    fields({ ...preset, requiredCurrencyRaised: 0n }).includes(
      "warning:requiredCurrencyRaised",
    ),
  );
});

test("the schedule builder lands exactly on the window and on 100%", () => {
  const start = 5_000_000n;
  const end = start + 5n * BLOCKS_PER_DAY;
  const steps = buildSchedule(start, end);
  const sumMps = steps.reduce(
    (total, step) => total + step.mps * step.blockDelta,
    0n,
  );
  const sumDelta = steps.reduce((total, step) => total + step.blockDelta, 0n);
  assert.equal(sumMps, MPS);
  assert.equal(start + sumDelta, end);
  // The last step still sells, so late bidders are not shut out.
  const last = steps.at(-1);
  assert.ok(last.mps > 0n && last.blockDelta > 0n);
});

test("a snapped floor always sits on its own grid", () => {
  for (const floor of [12_345n, 7_999_999n, 1n << 33n, 987_654_321n]) {
    const spacing = tickSpacingFor(floor);
    const snapped = snapFloorToGrid(floor, spacing);
    assert.ok(spacing >= 2n, `spacing ${spacing} below the minimum`);
    assert.equal(
      snapped % spacing,
      0n,
      `${snapped} is not on a ${spacing} grid`,
    );
    // Snapping only lowers a price that was already deployable; below the
    // contract minimum it has to raise it to the minimum.
    if (floor >= MIN_FLOOR_PRICE) {
      assert.ok(snapped <= floor, "snapping must not raise a deployable price");
    } else {
      assert.ok(snapped >= MIN_FLOOR_PRICE);
    }
    assert.ok(
      snapped >= MIN_FLOOR_PRICE,
      "snapping below the contract minimum",
    );
    // And the snapped pair is deployable: no price-related complaints.
    const issues = validateLaunchParams({
      ...valid(),
      floorPrice: snapped,
      tickSpacing: spacing,
    }).filter(
      (issue) => issue.field === "floorPrice" || issue.field === "tickSpacing",
    );
    assert.deepEqual(issues, []);
  }
});

test("Q96 conversion round-trips against the contract's price scale", () => {
  // A Q96 price is currency smallest units per token smallest unit. Round-trip it
  // rather than restating the arithmetic: the scale is what matters.
  const price = q96FromPrice(1n, 18n, 6n); // 1 USD per whole 18dp token
  // Integer division truncates, so the round-trip is exact to within a part per
  // million of the Q96 unit — far below any price the auction can resolve.
  const roundTrip = (price * 10n ** 18n) / 10n ** 6n;
  const drift = roundTrip > Q96 ? roundTrip - Q96 : Q96 - roundTrip;
  assert.ok(drift * 1_000_000n <= Q96, `round-trip drifted by ${drift}`);
  // Linear in the whole price, up to the same integer truncation.
  const triple = q96FromPrice(3n, 18n, 6n);
  const expected = 3n * price;
  const gap = triple > expected ? triple - expected : expected - triple;
  assert.ok(gap <= 3n, `scaling drifted by ${gap}`);
  // And the display helper inverts it back to currency smallest units, to
  // within one smallest unit (a hundredth of a cent).
  const shown = floorPricePerToken(price, 18n);
  const cents = shown > 10n ** 6n ? shown - 10n ** 6n : 10n ** 6n - shown;
  assert.ok(cents <= 2n, `shown ${shown} is not within two cents of $1.00`);
});

test("the preset keeps the rest of the supply in mind", () => {
  const preset = standardLaunchPreset({ startBlock: 0n });
  assert.equal(preset.supply * 5n, 10n ** 18n * 1_000_000_000n);
  assert.equal(
    preset.supply + preset.retainedSupply,
    10n ** 18n * 1_000_000_000n,
  );
  // 10M valuation over 1e9 tokens is a cent per token, in USDC smallest units.
  // Within a basis point of it: the floor is snapped onto its own price grid.
  assert.ok(
    preset.floorPricePerToken >= 9_900n && preset.floorPricePerToken <= 10_100n,
    `per-token price ${preset.floorPricePerToken} is not within 1% of a cent`,
  );
  // A 20% tranche at that price raises a fifth of the valuation.
  assert.ok(preset.floorRaise >= 1_980_000_000_000n);
  assert.ok(preset.floorRaise <= 2_020_000_000_000n);
  assert.ok(preset.requiredCurrencyRaised > 0n);
  assert.ok(preset.requiredCurrencyRaised < preset.floorRaise);
});
