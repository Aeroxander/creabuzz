import assert from "node:assert/strict";
import test from "node:test";

import { SANDBOX_ID, sandboxProgress, sandboxRecord } from "./sandbox.ts";

test("the sandbox record has deployable terms and honest no-chain links", () => {
  const rec = sandboxRecord();
  assert.equal(rec.id, SANDBOX_ID);
  assert.ok(
    rec.budget && rec.vesting && rec.longPitch,
    "bundle commitments set",
  );
  assert.equal(rec.auction, null, "no fake chain link");
  assert.equal(rec.chainId, "11155111");
  // The terms parse under the launch validation
  const { floorPrice, tickSpacing, requiredRaised } = rec;
  assert.ok(
    BigInt(floorPrice) % BigInt(tickSpacing) === 0n,
    "floor on the tick grid",
  );
  assert.ok(BigInt(requiredRaised) > 0n);
});

test("sandbox progress is deterministic and honest about being simulated", () => {
  const start = Date.parse("2026-09-14T00:00:00Z");
  const a = sandboxProgress(start + 30_000);
  const b = sandboxProgress(start + 30_000);
  assert.deepEqual(a, b, "same instant, same state");
  assert.equal(a.source, "simulated");
  assert.ok(a.raised > 0n && a.goal > 0n);
  assert.ok(a.percent >= 15 && a.percent <= 110);
  // Later in the raise: more raised, higher clearing price.
  const late = sandboxProgress(start + 100_000);
  assert.ok(late.raised >= a.raised, "monotonic raise");
  assert.ok(late.clearingPrice >= a.clearingPrice, "monotonic clearing");
  // By the virtual end the auction has graduated.
  const ended = sandboxProgress(start + RAISE_END);
  assert.equal(ended.graduated, true);
});

const RAISE_END = 130_000; // beyond the 120s virtual raise

test("the sandbox never claims a real stage beyond its lifecycle", () => {
  const start = Date.parse("2026-09-14T00:00:00Z");
  const rec = sandboxRecord(start + 130_000);
  assert.equal(rec.stage, "graduated");
  const early = sandboxRecord(start + 1_000);
  assert.equal(early.stage, "review");
});
