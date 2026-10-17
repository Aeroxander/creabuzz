import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDARD_ALLOCATION,
  STANDARD_DAO_ALLOCATION,
  allocationIssue,
  allocationForMode,
  allocationRows,
  daoReserve,
  withDaoReserve,
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

test("an own-DAO launch shows three shares, and the DAO's is everything not sold and not the team's", () => {
  // The standard six-way split is the same supply as 20 / 20 / 60: nothing is funded separately in a DAO launch.
  assert.equal(daoReserve(STANDARD_ALLOCATION), 60);
  assert.equal(totalAllocation(STANDARD_DAO_ALLOCATION), 100);
  assert.equal(allocationIssue(STANDARD_DAO_ALLOCATION), null);
  const rows = allocationRows(STANDARD_ALLOCATION, true);
  assert.deepEqual(
    rows.map((r) => [r.label, r.share]),
    [
      ["Public sale", 20],
      ["Team allocation", 20],
      ["DAO reserve", 60],
    ],
  );
  // The other token modes still show the six stored shares.
  assert.equal(allocationRows(STANDARD_ALLOCATION, false).length, 6);
});

test("the team row says what the plan does: locked behind milestones, or not locked at all", () => {
  const team = (locked) =>
    allocationRows(STANDARD_DAO_ALLOCATION, true, locked).find(
      (row) => row.key === "team",
    ).hint;
  assert.match(team(true), /^Locked/);
  assert.match(team(false), /^Not locked/);
  // The default is the locked plan, which is what the wizard starts with.
  assert.match(
    allocationRows(STANDARD_DAO_ALLOCATION, true).find((r) => r.key === "team")
      .hint,
    /^Locked/,
  );
});

test("setting the DAO's share writes it all into one stored share and keeps the total honest", () => {
  const next = withDaoReserve(STANDARD_ALLOCATION, 50);
  assert.equal(next.treasury, 50);
  assert.equal(next.liquidity + next.milestones + next.community, 0);
  assert.equal(daoReserve(next), 50);
  assert.equal(next.sale, STANDARD_ALLOCATION.sale);
  assert.equal(next.team, STANDARD_ALLOCATION.team);
  assert.match(String(allocationIssue(next)), /unassigned/);
});

test("changing the kind of token swaps an untouched standard split and leaves an edited one alone", () => {
  assert.deepEqual(
    allocationForMode({ ...STANDARD_ALLOCATION }, true),
    STANDARD_DAO_ALLOCATION,
  );
  assert.deepEqual(
    allocationForMode({ ...STANDARD_DAO_ALLOCATION }, false),
    STANDARD_ALLOCATION,
  );
  const edited = { ...STANDARD_DAO_ALLOCATION, sale: 25, treasury: 55 };
  assert.deepEqual(allocationForMode(edited, false), edited);
  assert.deepEqual(allocationForMode(edited, true), edited);
});
