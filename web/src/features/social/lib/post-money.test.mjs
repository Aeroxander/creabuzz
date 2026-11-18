import assert from "node:assert/strict";
import { test } from "node:test";

import { postMoneyLine } from "./post-money.ts";

const usdc = (units) => `${units} USDC`;

test("a post's money chip keeps what was paid apart from what is still there", () => {
  // One bounty paid 80, a later one holds 20: never "Paid 100".
  assert.deepEqual(postMoneyLine({ paid: 80n, held: 20n }, usdc), {
    text: "80 USDC paid · 20 USDC available",
    paidOnly: false,
  });
  assert.deepEqual(postMoneyLine({ paid: 80n, held: 0n }, usdc), {
    text: "80 USDC paid",
    paidOnly: true,
  });
  assert.deepEqual(postMoneyLine({ paid: 0n, held: 30n }, usdc), {
    text: "30 USDC behind this",
    paidOnly: false,
  });
  // Everything taken back: nothing to show.
  assert.equal(postMoneyLine({ paid: 0n, held: 0n }, usdc), null);
});
