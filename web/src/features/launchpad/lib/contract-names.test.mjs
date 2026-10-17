import assert from "node:assert/strict";
import test from "node:test";

import { contractNames } from "./contract-names.ts";

const mandate = (n, panel = false) => ({
  address: `0x${String(n).repeat(40)}`.toUpperCase().replace("0X", "0x"),
  verifiersAddress: `0x${String(n + 1).repeat(40)}`,
  claimsAddress: `0x${String(n + 2).repeat(40)}`,
  isMilestonePanel: panel,
});

test("each budget's contracts get plain names, found by lowercase address", () => {
  const names = contractNames({ mandates: [mandate(1), mandate(4, true)] });
  assert.equal(names.get(`0x${"1".repeat(40)}`), "A work budget");
  assert.equal(names.get(`0x${"2".repeat(40)}`), "Reviewers' bonds");
  assert.equal(
    names.get(`0x${"3".repeat(40)}`),
    "Contributors' claim deposits",
  );
  assert.equal(names.get(`0x${"4".repeat(40)}`), "The milestone panel");
});

test("with no work read there is nothing to name", () => {
  assert.equal(contractNames(undefined).size, 0);
});
