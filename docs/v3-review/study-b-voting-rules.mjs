#!/usr/bin/env node
/**
 * Study B — comparing voting rules for a *public-raise* DAO (first cut, reproducible).
 *
 * Study A (scripts/simulate-dao-governance.mjs) checks the v3 rule against itself and against the retired
 * allowance. It never asks the question a public raise raises: most holders are passive, and one concentrated
 * holder may push a harmful proposal. This study measures both sides of that trade for each rule:
 *
 *   liveness  = share of GOOD proposals that pass
 *   safety    = share of HARMFUL proposals that pass (lower is better)
 *
 * Run:  node docs/v3-review/study-b-voting-rules.mjs  > docs/v3-review/study-b-output.txt
 *
 * ASSUMPTIONS (mine, not measured on real users; change them and re-run):
 *  - 1,000 units of supply: team 25% in 3 wallets (90% engaged), one adversary wallet, 5% dead stake (lost or
 *    DAO-held: counts in supply, can never vote), the rest spread over 197 public wallets (Pareto, alpha 1.2).
 *  - Public engagement = base turnout x stake^0.3 (bigger holders vote a bit more). "Delegation" sends a share of
 *    passive public stake to the 5 most engaged public wallets, who vote for it when they show up.
 *  - 20% of proposals are harmful. Honest voters who show up are right 80% of the time. The adversary always votes
 *    FOR a harmful proposal and flips a coin on good ones.
 *  - Proposal size: small = an approval inside an existing capped mandate (3% of treasury), large = outside any
 *    mandate (25% of treasury). Rules may treat the two differently ("tiered").
 *  - Conviction accrual is ignored: Study A shows the 48h review dominates it for steady support.
 *  - Seeded and deterministic. This is a design aid, not evidence about real people.
 */

let seed = 20261008;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const SUPPLY = 1000;

function population({ adversaryShare, deadShare, teamShare }) {
  const wallets = [];
  [0.5, 0.3, 0.2].forEach((s) => wallets.push({ kind: "team", stake: SUPPLY * teamShare * s, engagement: 0.9 }));
  wallets.push({ kind: "adversary", stake: SUPPLY * adversaryShare, engagement: 0.97 });
  wallets.push({ kind: "dead", stake: SUPPLY * deadShare, engagement: 0 });
  const publicShare = 1 - teamShare - adversaryShare - deadShare;
  const n = 197;
  const raw = Array.from({ length: n }, () => (1 - rnd()) ** (-1 / 1.2));
  const sum = raw.reduce((a, b) => a + b, 0);
  const mean = (SUPPLY * publicShare) / n;
  raw.forEach((r) => wallets.push({ kind: "public", stake: (r / sum) * SUPPLY * publicShare, mean }));
  return wallets;
}

function assignEngagement(wallets, baseTurnout, delegation) {
  const publics = wallets.filter((w) => w.kind === "public");
  for (const w of publics) {
    const rel = Math.max(0.2, (w.stake / w.mean) ** 0.3);
    w.engagement = Math.min(0.95, baseTurnout * rel);
  }
  const delegates = [...publics].sort((a, b) => b.engagement - a.engagement).slice(0, 5);
  for (const w of publics) {
    w.delegate = null;
    if (!delegates.includes(w) && rnd() < delegation) w.delegate = delegates[Math.floor(rnd() * delegates.length)];
  }
  for (const d of delegates) d.engagement = Math.max(d.engagement, 0.85);
}

function ballot(wallets, harmful, acc = 0.8) {
  let forS = 0;
  let againstS = 0;
  const decided = new Map();
  const vote = (w) => {
    if (w.kind === "adversary") return harmful ? 1 : rnd() < 0.5 ? 1 : 0;
    const correct = rnd() < acc;
    return harmful ? (correct ? 0 : 1) : correct ? 1 : 0;
  };
  for (const w of wallets) {
    if (w.kind === "dead") continue;
    let v;
    if (w.delegate) {
      if (!(rnd() < w.delegate.engagement)) continue;
      if (!decided.has(w.delegate)) decided.set(w.delegate, vote(w.delegate));
      v = decided.get(w.delegate);
    } else {
      if (!(rnd() < w.engagement)) continue;
      v = vote(w);
    }
    if (v === 1) forS += w.stake;
    else againstS += w.stake;
  }
  return { forS, againstS };
}

/** Each rule: (ballot, size) -> approved? `size` is "small" (inside a capped mandate) or "large". */
const rules = {
  "Current v3 (large: >50% of supply; small: >=20%)": (b, size) =>
    size === "large" ? b.forS > 0.5 * SUPPLY && b.forS > b.againstS : b.forS >= 0.2 * SUPPLY && b.forS > b.againstS,
  "Plain token vote (10% quorum, simple majority)": (b) =>
    b.forS + b.againstS >= 0.1 * SUPPLY && b.forS > b.againstS,
  "Supermajority (66% of cast, 20% quorum) for everything": (b) =>
    b.forS + b.againstS >= 0.2 * SUPPLY && b.forS >= 0.66 * (b.forS + b.againstS),
  "Tiered (small: optimistic, 7.5% veto; large: 66% of cast, 20% quorum)": (b, size) =>
    size === "small" ? b.againstS < 0.075 * SUPPLY : b.forS + b.againstS >= 0.2 * SUPPLY && b.forS >= 0.66 * (b.forS + b.againstS),
  "Tiered-B (small: 55% of cast, 10% quorum; large: 66% of cast, 20% quorum)": (b, size) =>
    size === "small"
      ? b.forS + b.againstS >= 0.1 * SUPPLY && b.forS >= 0.55 * (b.forS + b.againstS)
      : b.forS + b.againstS >= 0.2 * SUPPLY && b.forS >= 0.66 * (b.forS + b.againstS),
};

function measure(rule, scen, trials = 4000) {
  const out = { small: { good: 0, goodPass: 0, bad: 0, badPass: 0 }, large: { good: 0, goodPass: 0, bad: 0, badPass: 0 } };
  for (let t = 0; t < trials; t++) {
    const wallets = population(scen);
    assignEngagement(wallets, scen.turnout, scen.delegation);
    const harmful = rnd() < 0.2;
    const size = rnd() < 0.5 ? "small" : "large";
    const pass = rule(ballot(wallets, harmful), size);
    const slot = out[size];
    if (harmful) {
      slot.bad++;
      if (pass) slot.badPass++;
    } else {
      slot.good++;
      if (pass) slot.goodPass++;
    }
  }
  const pct = (a, b) => (b === 0 ? "  - " : `${Math.round((100 * a) / b)}%`.padStart(4));
  return {
    sGood: pct(out.small.goodPass, out.small.good),
    sBad: pct(out.small.badPass, out.small.bad),
    lGood: pct(out.large.goodPass, out.large.good),
    lBad: pct(out.large.badPass, out.large.bad),
  };
}

console.log("Study B — liveness (good proposals passed) | safety (harmful proposals passed)");
console.log("team 25%, dead stake 5%, 197 public wallets; small = approval inside a capped mandate, large = outside one\n");
for (const delegation of [0, 0.5]) {
  for (const turnout of [0.05, 0.15, 0.3]) {
    for (const adversaryShare of [0, 0.08, 0.18]) {
      const scen = { turnout, adversaryShare, delegation, deadShare: 0.05, teamShare: 0.25 };
      console.log(`public turnout ${turnout}, adversary ${adversaryShare * 100}%, delegation ${delegation}`);
      console.log(`  ${"rule".padEnd(76)} small good|bad   large good|bad`);
      for (const [name, rule] of Object.entries(rules)) {
        const r = measure(rule, scen);
        console.log(`  ${name.padEnd(76)} ${r.sGood} | ${r.sBad}       ${r.lGood} | ${r.lBad}`);
      }
      console.log("");
    }
  }
}
