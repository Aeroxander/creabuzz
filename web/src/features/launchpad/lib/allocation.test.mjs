import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDARD_ALLOCATION,
  allocationIssue,
  impliedFdv,
  minimumLiquidityPercent,
  parseAllocation,
  tokensForBudget,
  totalAllocation,
} from "./allocation.ts";

/**
 * The split that is *not* sold decides what the sold part is worth, and parts
 * that do not add up are the mistake this guards.
 */

test("the standard split adds up and leaves a fifth for sale", () => {
  assert.equal(totalAllocation(STANDARD_ALLOCATION), 100);
  assert.equal(STANDARD_ALLOCATION.sale, 20);
  assert.equal(allocationIssue(STANDARD_ALLOCATION), null);
});

test("an allocation that does not add up is refused, both ways", () => {
  assert.match(
    String(allocationIssue({ ...STANDARD_ALLOCATION, sale: 30 })),
    /110%/,
  );
  assert.match(
    String(allocationIssue({ ...STANDARD_ALLOCATION, sale: 10 })),
    /unassigned/,
  );
});

test("a stored allocation survives, and nonsense falls back to the default", () => {
  assert.deepEqual(
    parseAllocation({
      sale: 25,
      team: 25,
      treasury: 25,
      liquidity: 15,
      milestones: 5,
      community: 5,
    }),
    {
      sale: 25,
      team: 25,
      treasury: 25,
      liquidity: 15,
      milestones: 5,
      community: 5,
    },
  );
  assert.deepEqual(parseAllocation(undefined), STANDARD_ALLOCATION);
  assert.deepEqual(parseAllocation({ sale: -5 }), STANDARD_ALLOCATION);
  assert.deepEqual(parseAllocation({ sale: 40 }), {
    ...STANDARD_ALLOCATION,
    sale: 40,
  });
});

test("the valuation a buyer cares about is the whole supply's", () => {
  // A cent per token over a billion tokens is a 10M valuation, of which 2M is
  // for sale.
  const pricePerToken = 10_000n; // $0.01 in USDC smallest units
  // 10^4 smallest units per token x 10^9 tokens = $10M.
  assert.equal(impliedFdv(pricePerToken, 1_000_000_000n), 10_000_000_000_000n);
  assert.equal(impliedFdv(null, 1_000_000_000n), null);
  assert.equal(impliedFdv(pricePerToken, null), null);
});

test("a budget becomes a token count at a given price", () => {
  assert.equal(tokensForBudget(100_000_000n, 10_000n), 10_000n);
  assert.equal(tokensForBudget(100_000_000n, null), null);
  assert.equal(tokensForBudget(100_000_000n, 0n), null);
});

test("minimumLiquidityPercent is the supply-converted raise rule", () => {
  // MetaDAO seeds liquidity with 20% of the *raise*; converted to percent of
  // supply (20% sale), that is exactly 4% of supply. The standard wizard
  // allocation (15%) is comfortably above it.
  const input = { salePercent: 20, raiseShareBps: 2000 };
  assert.equal(minimumLiquidityPercent(input), 4);
  // The conversion property: liquidity/sale% * (raise share) is exact.
  // (15 / 20) * 20% = 15% of the raise at the floor — matches the doc claim.
  assert.equal(
    minimumLiquidityPercent({ salePercent: 50, raiseShareBps: 1000 }),
    5,
  );
  assert.equal(
    minimumLiquidityPercent({ salePercent: 20, raiseShareBps: 5000 }),
    10,
  );
  // No sale or no raise share: no rule.
  assert.equal(
    minimumLiquidityPercent({ salePercent: 0, raiseShareBps: 2000 }),
    null,
  );
  assert.equal(
    minimumLiquidityPercent({ salePercent: 20, raiseShareBps: 0 }),
    null,
  );
});
