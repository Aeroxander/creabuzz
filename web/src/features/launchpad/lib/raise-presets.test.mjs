import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultRaiseTarget } from "./quick-sale.ts";
import { activePreset, presetTarget, RAISE_PRESETS } from "./raise-presets.ts";
import { SALE_DURATIONS } from "./sale-plans.ts";
import { patchForRaiseTarget } from "./wizard.ts";

const standard = RAISE_PRESETS.find((p) => p.key === "standard");

test("the middle preset is the app's own default, so there is one idea of standard", () => {
  for (const kind of ["usdc", "custom", "eth"]) {
    assert.equal(presetTarget(standard, kind), defaultRaiseTarget(kind));
  }
});

test("the presets grow in target and in length, and every length is one the wizard offers", () => {
  const keys = RAISE_PRESETS.map((p) => p.key);
  assert.deepEqual(keys, ["small", "standard", "large"]);
  for (const kind of ["usdc", "eth"]) {
    const targets = RAISE_PRESETS.map((p) => Number(presetTarget(p, kind)));
    assert.deepEqual(
      [...targets].sort((a, b) => a - b),
      targets,
    );
  }
  const seconds = RAISE_PRESETS.map(
    (p) => SALE_DURATIONS.find((d) => d.key === p.duration)?.seconds,
  );
  assert.ok(seconds.every((s) => typeof s === "number"));
  assert.deepEqual(
    [...seconds].sort((a, b) => a - b),
    seconds,
  );
});

test("every preset turns into real sale terms in both currencies", () => {
  for (const [kind, decimals] of [
    ["usdc", 6],
    ["eth", 18],
  ]) {
    for (const preset of RAISE_PRESETS) {
      const money = patchForRaiseTarget(
        presetTarget(preset, kind),
        "graduating-auction",
        "200000000",
        decimals,
      );
      assert.ok(money, `${preset.key} in ${kind} must give sale terms`);
      assert.ok(BigInt(money.floorPrice) > 0n);
      assert.ok(BigInt(money.requiredRaised) > 0n);
    }
  }
});

test("the preset in use is found from the numbers, ignoring commas, and is null once they are changed", () => {
  assert.equal(activePreset("usdc", "50000", "3d"), "small");
  assert.equal(activePreset("usdc", "300,000", "7d"), "standard");
  assert.equal(activePreset("usdc", "1 000 000", "14d"), "large");
  assert.equal(activePreset("eth", "120", "7d"), "standard");
  // Same target, different length: the founder's own mix.
  assert.equal(activePreset("usdc", "300000", "14d"), null);
  assert.equal(activePreset("usdc", "310000", "7d"), null);
  // A dollar target is not an ETH target.
  assert.equal(activePreset("eth", "300000", "7d"), null);
});
