import assert from "node:assert/strict";
import test from "node:test";

import { formatShares } from "./shares-format.ts";

const ONE = 10n ** 18n;

test("a large holding shows whole Shares: the fraction is noise next to hundreds of millions", () => {
  assert.equal(
    formatShares(240_000_000n * ONE + 100_000_000_000_000n),
    "240,000,000",
  );
  assert.equal(formatShares(1_000n * ONE), "1,000");
});

test("a small holding keeps a few decimals so it never reads as nothing", () => {
  assert.equal(formatShares(ONE / 2n), "0.5");
  assert.equal(formatShares(12n * ONE + ONE / 4n), "12.25");
  assert.equal(formatShares(0n), "0");
});
