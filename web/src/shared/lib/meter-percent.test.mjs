import assert from "node:assert/strict";
import { test } from "node:test";

import { meterPercent } from "./meter-percent.ts";

test("a meter's percent stays within 0 to 100 and never divides by zero", () => {
  assert.equal(meterPercent(8_000n, 10_000n), 80);
  assert.equal(meterPercent(0n, 10_000n), 0);
  assert.equal(meterPercent(1n, 3n), 33);
  assert.equal(meterPercent(12n, 10n), 100);
  assert.equal(meterPercent(5n, 0n), 0);
  assert.equal(meterPercent(-1n, 10n), 0);
  // Token amounts with 18 decimals stay exact.
  assert.equal(meterPercent(8_000n * 10n ** 18n, 10_000n * 10n ** 18n), 80);
});
