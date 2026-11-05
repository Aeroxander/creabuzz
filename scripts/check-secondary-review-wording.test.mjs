// Docs consistency guard for the secondary-trading review status.
//
// The agent review pass is an internal pass, not an outside or independent
// audit, and "off by default" describes where the listing starts and which
// builds name a factory, not a check the software makes for a sign-off.
// Packet section 6 item 1 stays the single source of truth for the audit
// status. Run with: node --test scripts/check-secondary-review-wording.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dir = new URL("../docs/v3-review/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const packet = read("SECONDARY-TRADING-REVIEW.md");
const runbook = read("SECONDARY-TRADING-RUNBOOK.md");
const v5 = read("V5-IMPLEMENTATION.md");

test("the first review is named as an internal agent pass, not an outside audit", () => {
  assert.match(packet, /^## 10\. First review \(internal agent pass, not an outside audit\)/m);
  assert.match(v5, /^### First review \(internal agent pass, not an outside audit\): three defects, fixed/m);
  for (const [name, text] of [["packet", packet], ["v5", v5]]) {
    assert.match(text, /An agent review pass read `SecondaryMarket\.sol`/, name);
    assert.doesNotMatch(text, /An outside reviewer read `SecondaryMarket\.sol`/, name);
  }
});

test("the runbook does not say an independent review has happened", () => {
  assert.doesNotMatch(runbook, /first independent review has happened/i);
  assert.doesNotMatch(runbook, /One independent review has read/i);
  assert.match(runbook, /no independent human audit has happened/i);
});

test("off by default is described as a release gate owned by people", () => {
  assert.doesNotMatch(runbook, /stays off without this/);
  assert.doesNotMatch(packet, /Trading activation stays off\s+until that sign-off exists/);
  for (const [name, text] of [["packet", packet], ["runbook", runbook]]) {
    assert.match(text, /nothing in the software checks for (a|the)\s+sign-off/i, name);
  }
});
