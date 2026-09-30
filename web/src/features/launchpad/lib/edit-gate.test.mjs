// The edit gate, bound to production `wizard.ts`: `editIssues` / `canSaveEdit`
// must reject every condition the old `legacyValid` gate caught (and the
// form-level checks `publishIssues` owns), so the edit surface cannot save a
// record the wizard would refuse to publish.
import test from "node:test";
import assert from "node:assert/strict";

import { STANDARD_ALLOCATION } from "./allocation.ts";
import { standardLaunchPreset } from "./launch-params.ts";
import { canSaveEdit, editIssues, initialWizardState } from "./wizard.ts";

const preset = standardLaunchPreset({
  startBlock: 0n,
  totalSupply: 10n ** 18n * 1_000_000_000n,
});

function baseForm(overrides = {}) {
  return {
    id: "",
    name: "Nebula DAO",
    pitch: "",
    longPitch: "",
    ipList: "",
    updateCadence: "",
    chainId: "11155111",
    currency: "",
    floorPrice: preset.floorPrice.toString(),
    tickSpacing: preset.tickSpacing.toString(),
    requiredRaised: preset.requiredCurrencyRaised.toString(),
    budget: "",
    auction: "",
    treasury: "",
    admission: "community",
    channels: [],
    allocation: { ...STANDARD_ALLOCATION },
    vesting: null,
    vestingPresent: false,
    vestingDirty: false,
    tokenMode: "mint",
    tokenName: "Nebula Token",
    symbol: "NEB",
    supply: (preset.supply / 10n ** 18n).toString(),
    importAddress: "",
    asAgent: false,
    startBlock: null,
    endBlock: null,
    claimBlock: null,
    unlocks: null,
    daoAtGraduation: null,
    ...overrides,
  };
}

const wizard = initialWizardState();

test("a valid edit passes the gate", () => {
  assert.deepEqual(editIssues(wizard, baseForm()), []);
  assert.equal(canSaveEdit(wizard, baseForm()), true);
});

test("the token-step rules gate an edit", () => {
  assert.equal(canSaveEdit(wizard, baseForm({ name: " " })), false);
  assert.equal(canSaveEdit(wizard, baseForm({ symbol: "" })), false);
  assert.equal(canSaveEdit(wizard, baseForm({ supply: "0" })), false);
  assert.equal(canSaveEdit(wizard, baseForm({ id: "Not A Slug" })), false);
  assert.equal(
    canSaveEdit(
      wizard,
      baseForm({ tokenMode: "import", importAddress: "0x1" }),
    ),
    false,
  );
});

test("the form-level checks gate an edit", () => {
  const badChain = editIssues(wizard, baseForm({ chainId: "sepolia" }));
  assert.ok(badChain.some((issue) => issue.startsWith("chainId:")));
  const badAuction = editIssues(wizard, baseForm({ auction: "0xzz" }));
  assert.ok(badAuction.some((issue) => issue.startsWith("auction:")));
  const badTreasury = editIssues(wizard, baseForm({ treasury: "abc" }));
  assert.ok(badTreasury.some((issue) => issue.startsWith("treasury:")));
  assert.equal(canSaveEdit(wizard, baseForm({ budget: "many" })), false);
});

test("an allocation that does not add up blocks an edit", () => {
  const form = baseForm({
    allocation: { ...STANDARD_ALLOCATION, sale: 0 },
  });
  assert.equal(canSaveEdit(wizard, form), false);
});
