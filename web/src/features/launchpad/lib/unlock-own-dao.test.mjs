// A launch into the project's own DAO locks the team's Shares behind milestones (or not at all): the wizard refuses
// the time-vesting choice there, because a published record cannot be edited into a plan the launch can use.
import test from "node:test";
import assert from "node:assert/strict";

import { STANDARD_ALLOCATION } from "./allocation.ts";
import { initialWizardState, wizardStepIssues } from "./wizard.ts";

const form = (tokenMode) => ({
  id: "",
  name: "Nebula DAO",
  pitch: "",
  longPitch: "",
  ipList: "",
  updateCadence: "",
  chainId: "31337",
  currency: "",
  floorPrice: "792281625140000",
  tickSpacing: "79228162514",
  requiredRaised: "299999999998",
  budget: "",
  auction: "",
  treasury: "",
  admission: "community",
  channels: [],
  allocation: { ...STANDARD_ALLOCATION },
  vesting: null,
  vestingPresent: false,
  vestingDirty: false,
  tokenMode,
  tokenName: "Nebula",
  symbol: "NEB",
  supply: "1000000000",
  importAddress: "",
  asAgent: false,
  startBlock: null,
  endBlock: null,
  claimBlock: null,
  unlocks: null,
  daoAtGraduation: null,
  funding: null,
});

const stepIssues = (wizard, tokenMode) =>
  wizardStepIssues(wizard, form(tokenMode), "unlocks", 1_000);

test("short time vesting is refused for a project with its own DAO, and nowhere else", () => {
  const time = { ...initialWizardState(), unlockMode: "time", months: 6 };
  assert.match(stepIssues(time, "dao").join(" "), /milestones, or not at all/);
  assert.deepEqual(stepIssues(time, "mint"), []);
  assert.deepEqual(stepIssues(time, "import"), []);
});

test("milestones, and no lock, are fine for a project with its own DAO", () => {
  const start = initialWizardState();
  const milestones = {
    ...start,
    unlockMode: "milestones",
    milestones: start.milestones.map((row, index) => ({
      ...row,
      label: `Milestone ${index + 1} words`,
    })),
  };
  const none = { ...initialWizardState(), unlockMode: "none" };
  assert.deepEqual(stepIssues(milestones, "dao"), []);
  assert.deepEqual(stepIssues(none, "dao"), []);
});
