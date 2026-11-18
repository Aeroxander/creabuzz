/**
 * Pins what the voting-rules study says about the rules as built, so a parameter change that quietly
 * kills liveness (or opens a hole) fails a test instead of shipping. The bounds are loose on purpose:
 * they guard the SHAPE of the result, not a decimal. If a bound has to move, say why in the commit.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { measure, REFERENCE, RULES } from "./simulate-voting-rules.mjs";

const [V3, PLAIN, V2] = Object.keys(RULES);
const run = (rule, over = {}) => measure(rule, { ...REFERENCE, ...over }, { trials: 2000 });

test("the rules as built keep treasury-scale proposals live and safe at ordinary turnout", () => {
  const r = run(V2);
  assert.ok(r.largeGood >= 0.65, `large lane passes ${r.largeGood} of good proposals`);
  assert.ok(r.largeHarm <= 0.06, `large lane lets ${r.largeHarm} of harmful ones through`);
  assert.ok(r.smallGood >= 0.82, `small lane passes ${r.smallGood} of good proposals`);
  assert.ok(r.smallHarm <= 0.12, `small lane lets ${r.smallHarm} of harmful ones through`);
});

test("the v3 rule is the reason for the change: safe, but treasury-scale governance is mostly dead", () => {
  const r = run(V3);
  assert.ok(r.largeGood <= 0.4, `v3 passed ${r.largeGood} of good large proposals`);
  assert.ok(run(V3, { concurrent: 3 }).smallGood <= 0.2, "and exclusive backing starves concurrent approvals");
});

test("plain token voting is live but exposes the treasury to a concentrated holder", () => {
  const r = run(PLAIN, { adversaryShare: 0.18 });
  assert.ok(r.largeGood >= 0.8);
  assert.ok(r.largeHarm >= 0.2, `plain voting let ${r.largeHarm} of harmful ones through`);
  assert.ok(run(V2, { adversaryShare: 0.18 }).largeHarm <= 0.1, "the rules as built resist the same holder");
});

test("opposition being free keeps harmful proposals out while several good ones are open", () => {
  const r = run(V2, { concurrent: 3 });
  assert.ok(r.largeHarm <= 0.05, `${r.largeHarm} of harmful large proposals passed with three open`);
  assert.ok(r.smallGood >= 0.8, "reusable backing inside a mandate does not starve concurrent approvals");
  assert.ok(r.largeGood >= 0.45, "exclusive backing costs the treasury-scale lane something, but it stays usable");
});
