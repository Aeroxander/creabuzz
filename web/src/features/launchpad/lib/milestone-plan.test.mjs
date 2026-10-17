import assert from "node:assert/strict";
import test from "node:test";

import { plannedMilestoneTokens } from "./milestone-plan.ts";

const ONE = 10n ** 18n;
const record = (over = {}) => ({
  tokenPlan: { supply: "200000000" },
  allocation: { sale: 20 },
  unlocks: {
    allocationPct: 20,
    milestones: [{ percent: 40 }, { percent: 30 }, { percent: 30 }],
  },
  ...over,
});

test("each milestone's tokens follow from the sale tranche, the share it is, and the shares the plan governs", () => {
  // 200,000,000 is 20% of everything, so 1,000,000,000 exist; the milestones govern 20% of that: 200,000,000.
  const tokens = plannedMilestoneTokens(record());
  assert.deepEqual(tokens, [
    80_000_000n * ONE,
    60_000_000n * ONE,
    60_000_000n * ONE,
  ]);
  assert.equal(
    tokens.reduce((a, b) => a + b, 0n),
    200_000_000n * ONE,
  );
});

test("a record that does not say enough gives nothing for each milestone, never a guess", () => {
  assert.deepEqual(plannedMilestoneTokens(record({ tokenPlan: null })), [
    null,
    null,
    null,
  ]);
  assert.deepEqual(
    plannedMilestoneTokens(record({ tokenPlan: { supply: "lots" } })),
    [null, null, null],
  );
  assert.deepEqual(
    plannedMilestoneTokens(record({ allocation: { sale: 0 } })),
    [null, null, null],
  );
});

test("a project with no milestone plan has no milestones to size", () => {
  assert.deepEqual(plannedMilestoneTokens(record({ unlocks: null })), []);
});

test("shares that are not whole percentages are carried exactly to a hundredth of a percent", () => {
  const tokens = plannedMilestoneTokens(
    record({
      unlocks: {
        allocationPct: 20,
        milestones: [{ percent: 33.33 }, { percent: 66.67 }],
      },
    }),
  );
  assert.equal(tokens[0], 66_660_000n * ONE);
  assert.equal(tokens[1], 133_340_000n * ONE);
});

test("a plan that governs no share of the supply gives nothing for each milestone, not zero tokens", () => {
  for (const allocationPct of [0, -5]) {
    const tokens = plannedMilestoneTokens(
      record({
        unlocks: {
          allocationPct,
          milestones: [{ percent: 50 }, { percent: 50 }],
        },
      }),
    );
    assert.deepEqual(tokens, [null, null]);
  }
});
