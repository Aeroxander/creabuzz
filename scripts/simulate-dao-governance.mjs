#!/usr/bin/env node
/** Deterministic mechanism study; local-EVM journeys separately bind the implementation. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOUR = 3600;
const DAY = 24 * HOUR;
const HALF_LIFE = 12 * HOUR;
const grow = (score, support, elapsed, halfLife = HALF_LIFE) =>
  support + (score - support) * 2 ** (-elapsed / halfLife);

function convictionDecision({ yes, no = 0, supply = 1000, bounded = false, halfLife = HALF_LIFE, initialNo = 0, reviewed = false, requireMatureOpposition = false }) {
  const currentFloor = bounded ? 0.2 : 0.5;
  const convictionFloor = bounded ? 0.1 : 0.25;
  const review = reviewed ? 0 : bounded ? DAY : 2 * DAY;
  for (let elapsed = 0; elapsed <= 14 * DAY; elapsed += HOUR) {
    const cy = grow(0, yes, elapsed, halfLife);
    const cn = grow(initialNo, no, elapsed, halfLife);
    if (elapsed >= review && (bounded ? yes >= supply * currentFloor : yes > supply * currentFloor) && cy >= supply * convictionFloor && yes > no && (!requireMatureOpposition || cy > cn))
      return elapsed / HOUR;
  }
  return null;
}

const scenarios = [];
function record(name, observed, expectation) {
  assert.ok(expectation(observed), name);
  scenarios.push({ name, observed });
}

record("Retired credits: conserved minority defeats recently active majority", {
  coalition: 300,
  majorityRecoveredAfter48h: 700 * 2 / 7,
  winsWithSufficientQuorum: 300 > 700 * 2 / 7,
}, (x) => x.winsWithSufficientQuorum);

record("Unrestricted minority fails even after maximum conviction", {
  decisionHours: convictionDecision({ yes: 300 }),
}, (x) => x.decisionHours === null);

record("Majority can redirect without a seven-day refill", {
  redirectedShares: 700,
  decisionHours: convictionDecision({ yes: 700, no: 300 }),
}, (x) => x.decisionHours === 48);

record("Bounded project receives timely approval", {
  decisionHours: convictionDecision({ yes: 300, bounded: true }),
}, (x) => x.decisionHours === 24);

record("Weak support does not become authority merely by waiting", {
  decisionHours: convictionDecision({ yes: 190, bounded: true }),
}, (x) => x.decisionHours === null);

record("Withdrawn conviction is removed and new support starts fresh", {
  oldScore: grow(0, 700, 2 * DAY),
  oldRemainingScore: grow(0, 700, 2 * DAY) * (200 / 700),
  movedScoreAtStart: 0,
  remainingCurrentSupport: 200,
}, (x) => x.oldRemainingScore <= x.remainingCurrentSupport && x.movedScoreAtStart === 0);

record("Concurrent allocations cannot manufacture majority approval", {
  first: convictionDecision({ yes: 350 }),
  second: convictionDecision({ yes: 350 }),
  afterReallocation: convictionDecision({ yes: 700 }),
}, (x) => x.first === null && x.second === null && x.afterReallocation === 48);

record("Bounded mandate caps aggregate exposure despite many project identities", {
  treasury: 100_000,
  mandate: 10_000,
  perProjectCap: 2_000,
  maxApprovedProjects: 5,
  maximumExposure: 10_000,
}, (x) => x.maxApprovedProjects * x.perProjectCap === x.maximumExposure && x.maximumExposure === x.mandate);

record("Mature opposition would entrench a former minority after a current majority changes", {
  olderNo: grow(0, 499, 2 * DAY),
  previousCandidateHours: convictionDecision({yes:501,no:499,initialNo:grow(0,499,2*DAY),reviewed:true,requireMatureOpposition:true}),
  refinedHours: convictionDecision({yes:501,no:499,initialNo:grow(0,499,2*DAY),reviewed:true}),
}, x => x.previousCandidateHours === 95 && x.refinedHours === 12);

record("A controlling owner remains controlling under linear Shares capacity", {
  ownerPercent:60, decisionHours:convictionDecision({yes:600,no:400}),
}, x => x.decisionHours === 48);

record("Reusable token ballots approve both priorities; exclusive allocations require a choice", {
  reusableYesOnEach:700, allocatedYesOnEach:350,
  reusableBothPass:700>500, allocationDecisions:[convictionDecision({yes:350}),convictionDecision({yes:350})],
}, x => x.reusableBothPass && x.allocationDecisions.every(v=>v===null));

const changedMajority = [6,12,24,48].map(halfLifeHours => ({
  halfLifeHours,
  formerCandidateHours:convictionDecision({yes:501,no:499,initialNo:grow(0,499,2*DAY,halfLifeHours*HOUR),reviewed:true,halfLife:halfLifeHours*HOUR,requireMatureOpposition:true}),
  refinedHours:convictionDecision({yes:501,no:499,reviewed:true,halfLife:halfLifeHours*HOUR}),
}));

// Seeded, reproducible participation study. Wallet counts are NOT distinct-person proof.
let seed = 20261008;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
const sweep = [];
for (const participation of [0.3, 0.5, 0.7, 0.9]) {
  for (const halfLifeHours of [6, 12, 24, 48]) {
    const times = [];
    let rejected = 0;
    for (let trial = 0; trial < 1000; trial++) {
      let yes = 0;
      let no = 0;
      // Three investors, a contributor group, and smaller independent owners.
      const holdings = [180, 120, 100, ...Array(12).fill(50)];
      for (const weight of holdings) {
        if (random() >= participation) continue;
        if (random() < 0.8) yes += weight;
        else no += weight;
      }
      const time = convictionDecision({ yes, no, halfLife: halfLifeHours * HOUR });
      if (time === null) rejected++;
      else times.push(time);
    }
    times.sort((a, b) => a - b);
    sweep.push({
      participation,
      halfLifeHours,
      trials: 1000,
      approved: times.length,
      failedApproval: rejected,
      medianApprovalHours: times.length ? times[Math.floor(times.length / 2)] : null,
    });
  }
}

const report = {
  seed: 20261008,
  kind: "mechanism model, not deployment or security audit",
  assumptions: [
    "Shares supply 1000; no Loot votes; exclusive, movable allocations",
    "Constant support during each trial; a 24-hour execution delay is additional",
    "Unrestricted actions require current majority and 25 percent conviction",
    "Bounded projects require 20 percent current support and 10 percent conviction",
    "Mature support alone cannot authorize an action after stake is withdrawn",
    "Current AGAINST counts immediately; older opposition conviction is not a separate veto",
    "Mandate caps must be enforced by authenticated deployed contracts",
  ],
  scenarios,
  sweep,
  changedMajority,
};
const directory = fileURLToPath(new URL("../docs/simulations/", import.meta.url));
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}governance-mechanism-study.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${directory}governance-mechanism-study.md`, [
  "# Governance mechanism study",
  "",
  "Run: `. ./bin/activate-hermit; node scripts/simulate-dao-governance.mjs`.",
  "Seed: 20261008. This models governance incentives; local-EVM journeys separately verify implementation.",
  "",
  "## Observations and refinements",
  "",
  "The conserved-credit minority wins the depleted-majority example. A current-support floor prevents that outcome without charging participation. Withdrawal removes conviction immediately and new allocations start at zero. A pre-approved mandate bounds the total funds a lower-support project vote can expose.",
  "",
  "For stable support, the minimum 48-hour review dominates every tested half-life. A shorter half-life helps newly arriving support after that review; it cannot repair insufficient participation. The majority requirement deliberately causes low-turnout unrestricted proposals to fail. Delegation and better notices may help participation; they do not prove independent representation or honest votes.",
  "",
  "A 12-hour half-life with 48-hour review for unrestricted actions and 24-hour review for bounded projects is the candidate to validate on the actual governor. This is a safety/latency choice, not an empirical claim of optimal governance.",
  "",
  "## A late majority and the opposition refinement",
  "",
  "An earlier candidate required matured FOR to exceed matured AGAINST. A new 50.1% majority facing 49.9% opposition that had accumulated for 48 hours needed 95 more hours with a 12-hour half-life. Current opposition plus the FOR conviction floor needs 12 hours. We removed the matured-opposition veto: AGAINST counts immediately in current backing, while FOR must accumulate the captured conviction floor. This avoids historical opposition entrenchment. The execution delay is still additional.",
  "",
  "| Half-life hours | Former matured-opposition gate | Refined approval hours after change |",
  "| --- | --- | --- |",
  ...changedMajority.map(x=>`| ${x.halfLifeHours} | ${x.formerCandidateHours} | ${x.refinedHours} |`),
  "",
  "## Participation and half-life sweep",
  "",
  "| Participation probability | Half-life hours | Approved / 1000 | Median approval hours |",
  "| --- | --- | --- | --- |",
  ...sweep.map(x => `| ${x.participation} | ${x.halfLifeHours} | ${x.approved} | ${x.medianApprovalHours ?? "none"} |`),
  "",
  "All approval times exclude the additional execution delay. Economic self-dealing by a governing majority and collusion among delivery reviewers remain possible. Outcomes are contingent on the stated participant behavior, not evidence about real users.",
  "",
].join("\n"));
console.log(JSON.stringify({ scenarios: scenarios.length, seededTrials: sweep.length * 1000, report: `${directory}governance-mechanism-study.md` }));
