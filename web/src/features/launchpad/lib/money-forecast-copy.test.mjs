import assert from "node:assert/strict";
import { test } from "node:test";

import { outcomeLine, poolsLine } from "./money-forecast-copy.ts";

const money = (u) => `${u} USDC`;

test("the pools and how they ended read plainly", () => {
  assert.equal(poolsLine(0n, 0n, money), "No money on it yet.");
  assert.equal(
    poolsLine(40n, 20n, money),
    "40 USDC says it will be paid · 20 USDC says it won't.",
  );
  assert.match(outcomeLine("yes"), /^It was paid\./);
  assert.match(outcomeLine("no"), /^It wasn't paid\./);
  assert.match(outcomeLine("void"), /everyone takes back/);
  assert.equal(outcomeLine("open"), null);
});
