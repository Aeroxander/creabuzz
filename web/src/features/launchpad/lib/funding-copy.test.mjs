import assert from "node:assert/strict";
import { test } from "node:test";

import {
  capPlan,
  fundingStateLine,
  instrumentLine,
  salePlan,
  soldLine,
} from "./funding-copy.ts";

const E18 = 10n ** 18n;
const view = {
  contract: "0x",
  published: true,
  asShares: false,
  activeFrom: Date.UTC(2026, 11, 1) / 1000,
  cap: 100n * E18,
  sold: 40n * E18,
  tranche: {
    quantity: 60n * E18,
    taken: 20n * E18,
    leastPrice: 1_100_000n,
    expiry: Date.UTC(2027, 0, 31) / 1000,
  },
  reserved: 0n,
};

test("where funding terms stand, in one sentence each", () => {
  assert.match(fundingStateLine("none", null), /sells no new units/);
  assert.equal(
    fundingStateLine("notice", view),
    "Funding terms were published. Sales can start from Dec 1, 2026.",
  );
  assert.match(fundingStateLine("ready", view), /no sale is open/);
  assert.equal(
    fundingStateLine("selling", view),
    "On sale for the project: 40 new units at 1.1 USDC each or more, until Jan 31, 2027.",
  );
  assert.equal(soldLine(view), "40 of at most 100 sold");
  assert.equal(instrumentLine(false), "Buyers get Loot, with no vote");
  assert.equal(instrumentLine(true), "Buyers get Shares, with a vote");
});

test("a cap and a sale are turned into what the vote carries, or a reason they can't be", () => {
  assert.deepEqual(capPlan("100"), { cap: 100n * E18 });
  assert.match(capPlan("0").problem, /above zero/);
  assert.deepEqual(salePlan("40", "1.10", "60", 1000, 60n * E18), {
    quantity: 40n * E18,
    leastPrice: 1_100_000n,
    expiry: 1000 + 60 * 86_400,
  });
  assert.match(
    salePlan("61", "1", "60", 0, 60n * E18).problem,
    /allow 60 more units/,
  );
  assert.match(salePlan("1", "0", "60", 0, 60n * E18).problem, /least price/);
  assert.match(salePlan("1", "1", "0", 0, 60n * E18).problem, /1 to 365 days/);
});
