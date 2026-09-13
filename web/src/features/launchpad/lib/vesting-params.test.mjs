import assert from "node:assert/strict";
import test from "node:test";

import {
  validateVesting,
  DEFAULT_PERFORMANCE_TRANCHES,
} from "./vesting-params.ts";
import { parseVesting } from "../models.ts";

test("the default ladder is valid", () => {
  const issues = validateVesting({
    cliffBlocks: 7776000,
    tranches: DEFAULT_PERFORMANCE_TRANCHES,
    twapWindow: 1296000,
  });
  assert.deepEqual(issues, []);
});

test("tranches that do not sum to 100 are refused", () => {
  const issues = validateVesting({
    cliffBlocks: 0,
    tranches: [{ multiple: 2, percent: 60 }],
    twapWindow: null,
  });
  assert.ok(issues.some((i) => i.message.includes("sum to 100")));
  assert.equal(issues[0].severity, "error");
});

test("descending multiples are refused", () => {
  const issues = validateVesting({
    cliffBlocks: 0,
    tranches: [
      { multiple: 8, percent: 50 },
      { multiple: 2, percent: 50 },
    ],
    twapWindow: null,
  });
  assert.ok(issues.some((i) => i.message.includes("ascending")));
});

test("a 1x tranche warns (that is the raise price, not performance)", () => {
  const issues = validateVesting({
    cliffBlocks: 0,
    tranches: [{ multiple: 1, percent: 100 }],
    twapWindow: null,
  });
  assert.ok(
    issues.some((i) => i.severity === "warning" && i.message.includes("1x")),
  );
});

test("parseVesting round-trips and rejects malformed configs", () => {
  const cfg = parseVesting({
    cliffBlocks: 7776000,
    tranches: [
      { multiple: 2, percent: 20 },
      { multiple: 4, percent: 80 },
    ],
    twapWindow: 1296000,
  });
  assert.equal(cfg.cliffBlocks, 7776000);
  assert.equal(cfg.tranches.length, 2);
  assert.equal(cfg.twapWindow, 1296000);
  assert.equal(parseVesting(null), null);
  assert.equal(parseVesting({ cliffBlocks: 0 }), null);
  assert.equal(parseVesting({ cliffBlocks: 0, tranches: [] }), null);
});
