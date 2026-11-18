#!/usr/bin/env node
/**
 * Voting-rules study for a public-raise DAO: the rules AS IMPLEMENTED in `AllocationVoting.sol`,
 * against the v3 rule they replaced and against plain token voting.
 *
 * What it measures, per rule:
 *   liveness = share of GOOD proposals that pass
 *   safety   = share of HARMFUL proposals that pass (lower is better)
 *
 * It exists because the first study (`scripts/simulate-dao-governance.mjs`) tested the v3 rule against
 * itself and never asked what happens when most holders are passive and one holder pushes something
 * harmful. It also models what exclusive backing costs: with k proposals open at once, a holder who
 * backs several has to split their Shares between them, while opposition is free.
 *
 * Run:  node scripts/simulate-voting-rules.mjs            (prints the tables)
 *       node scripts/simulate-voting-rules.mjs --write    (also writes docs/simulations/voting-v2-study.md)
 *
 * ASSUMPTIONS (mine, not measured on real users; change them and re-run):
 *  - 1,000 units of supply: team 25% in 3 wallets (90% engaged), one adversary wallet, 5% dead stake
 *    (DAO-held, burned or lost: in total supply, can never vote), the rest in 197 public wallets
 *    (Pareto, alpha 1.2). Public engagement = base turnout x stake^0.3; "delegation" sends part of the
 *    passive public stake to the 5 most engaged public wallets, who vote it when they show up.
 *  - 20% of proposals are harmful (the adversary backs them with everything). Honest voters who show up
 *    are right 80% of the time on each proposal.
 *  - A proposal is "small" (an approval inside a capped mandate) or "large" (outside any mandate).
 *  - k proposals are open at once. Where backing is exclusive (v3 everywhere; v2's large lane) a voter splits
 *    their Shares evenly across the proposals they back; in v2's small lane backing is reusable. Opposing is
 *    free at full weight in v2 and part of the same pool in v3.
 *  - Time is not modelled: hold and review are satisfied by steady support (the contract tests cover them).
 *  - Seeded and deterministic. A design aid, not evidence about real people; it cannot see sybils,
 *    vote buying, or turnout that moves with the stakes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SUPPLY = 1000;

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function population(rnd, { adversaryShare, deadShare, teamShare, turnout, delegation }) {
  const wallets = [];
  for (const split of [0.5, 0.3, 0.2]) {
    wallets.push({ kind: "team", stake: SUPPLY * teamShare * split, engagement: 0.9 });
  }
  wallets.push({ kind: "adversary", stake: SUPPLY * adversaryShare, engagement: 0.97 });
  wallets.push({ kind: "dead", stake: SUPPLY * deadShare, engagement: 0 });
  const publicShare = 1 - teamShare - adversaryShare - deadShare;
  const n = 197;
  const raw = Array.from({ length: n }, () => (1 - rnd()) ** (-1 / 1.2));
  const sum = raw.reduce((a, b) => a + b, 0);
  const mean = (SUPPLY * publicShare) / n;
  const publics = raw.map((r) => ({ kind: "public", stake: (r / sum) * SUPPLY * publicShare, mean }));
  for (const w of publics) {
    w.engagement = Math.min(0.95, turnout * Math.max(0.2, (w.stake / mean) ** 0.3));
  }
  const delegates = [...publics].sort((a, b) => b.engagement - a.engagement).slice(0, 5);
  for (const w of publics) {
    w.delegate = !delegates.includes(w) && rnd() < delegation ? delegates[Math.floor(rnd() * delegates.length)] : null;
  }
  for (const d of delegates) d.engagement = Math.max(d.engagement, 0.85);
  return [...wallets, ...publics];
}

/**
 * Ballots for k concurrent proposals.
 *  - `exclusive(proposal)`: backing of that proposal draws from the voter's single pool of Shares, so a voter
 *    who backs n such proposals puts stake/n behind each. Otherwise backing keeps full weight.
 *  - `freeOpposition`: AGAINST keeps full weight on every proposal (v2). In v3 it was part of the same pool.
 */
function ballots(wallets, proposals, rnd, { freeOpposition, exclusive, accuracy = 0.8 }) {
  const tally = proposals.map(() => ({ yes: 0, no: 0 }));
  const decided = new Map();
  const choose = (wallet) =>
    proposals.map((p) => {
      if (wallet.kind === "adversary") return p.harmful ? 1 : rnd() < 0.5 ? 1 : 0;
      const right = rnd() < accuracy;
      return p.harmful ? (right ? 0 : 1) : right ? 1 : 0;
    });
  for (const w of wallets) {
    if (w.kind === "dead") continue;
    let votes;
    if (w.delegate) {
      if (!(rnd() < w.delegate.engagement)) continue;
      if (!decided.has(w.delegate)) decided.set(w.delegate, choose(w.delegate));
      votes = decided.get(w.delegate);
    } else {
      if (!(rnd() < w.engagement)) continue;
      votes = choose(w);
    }
    // How many of this voter's positions share one pool of Shares.
    const pooled = votes.filter((v, i) => (v === 1 ? exclusive(proposals[i]) : !freeOpposition)).length;
    votes.forEach((v, i) => {
      const inPool = v === 1 ? exclusive(proposals[i]) : !freeOpposition;
      const weight = inPool ? w.stake / Math.max(1, pooled) : w.stake;
      if (v === 1) tally[i].yes += weight;
      else tally[i].no += weight;
    });
  }
  return tally;
}

/** Each rule: (tally, size, ctx) -> approved? */
export const RULES = {
  "v3 as shipped (large: >50% of all Shares; small: >=20%)": {
    opts: { freeOpposition: false, exclusive: () => true },
    pass: (t, size) => (size === "large" ? t.yes > 0.5 * SUPPLY && t.yes > t.no : t.yes >= 0.2 * SUPPLY && t.yes > t.no),
  },
  "plain token vote (10% quorum, simple majority)": {
    opts: { freeOpposition: true, exclusive: () => false },
    pass: (t, _s, c) => t.yes + t.no >= 0.1 * c.votingSupply && t.yes > t.no,
  },
  "v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)": {
    opts: { freeOpposition: true, exclusive: (p) => p.size === "large" },
    pass: (t, size, c) =>
      size === "large"
        ? t.yes + t.no >= 0.2 * c.votingSupply && t.yes * 10000 >= 6600 * (t.yes + t.no)
        : t.yes + t.no >= 0.1 * c.votingSupply && t.yes * 10000 >= 5500 * (t.yes + t.no),
  },
};

export function measure(ruleName, scenario, { trials = 3000, seed = 20261008 } = {}) {
  const { opts, pass } = RULES[ruleName];
  const rnd = makeRandom(seed);
  const slots = { small: { good: 0, goodPass: 0, bad: 0, badPass: 0 }, large: { good: 0, goodPass: 0, bad: 0, badPass: 0 } };
  const votingSupply = SUPPLY * (1 - scenario.deadShare);
  for (let t = 0; t < trials; t++) {
    const wallets = population(rnd, scenario);
    const proposals = Array.from({ length: scenario.concurrent }, () => ({
      harmful: rnd() < 0.2,
      size: rnd() < 0.5 ? "small" : "large",
    }));
    const tallies = ballots(wallets, proposals, rnd, opts);
    proposals.forEach((p, i) => {
      const slot = slots[p.size];
      const ok = pass(tallies[i], p.size, { votingSupply });
      if (p.harmful) {
        slot.bad++;
        if (ok) slot.badPass++;
      } else {
        slot.good++;
        if (ok) slot.goodPass++;
      }
    });
  }
  const rate = (a, b) => (b === 0 ? null : a / b);
  return {
    smallGood: rate(slots.small.goodPass, slots.small.good),
    smallHarm: rate(slots.small.badPass, slots.small.bad),
    largeGood: rate(slots.large.goodPass, slots.large.good),
    largeHarm: rate(slots.large.badPass, slots.large.bad),
  };
}

export const REFERENCE = { adversaryShare: 0.08, deadShare: 0.05, teamShare: 0.25, turnout: 0.15, delegation: 0, concurrent: 1 };

function table(scenario) {
  const pct = (x) => (x === null ? "  - " : `${Math.round(100 * x)}%`.padStart(4));
  const lines = [
    `public turnout ${scenario.turnout}, adversary ${scenario.adversaryShare * 100}%, delegation ${scenario.delegation}, ${scenario.concurrent} open at once`,
    `  ${"rule".padEnd(62)} small good|harm    large good|harm`,
  ];
  for (const name of Object.keys(RULES)) {
    const r = measure(name, scenario);
    lines.push(`  ${name.padEnd(62)} ${pct(r.smallGood)} | ${pct(r.smallHarm)}        ${pct(r.largeGood)} | ${pct(r.largeHarm)}`);
  }
  return lines.join("\n");
}

export function report() {
  const out = ["Voting rules study (liveness = good proposals passed | safety = harmful proposals passed)", ""];
  for (const concurrent of [1, 3]) {
    for (const turnout of [0.05, 0.15, 0.3]) {
      for (const adversaryShare of [0, 0.08, 0.18]) {
        out.push(table({ ...REFERENCE, turnout, adversaryShare, concurrent }), "");
      }
    }
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = report();
  console.log(text);
  if (process.argv.includes("--write")) {
    const dir = fileURLToPath(new URL("../docs/simulations/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}voting-v2-study.md`,
      `# Voting rules study\n\nRun: \`node scripts/simulate-voting-rules.mjs --write\`. Assumptions are listed at the top of the script; the numbers are a design aid, not evidence about real users.\n\n\`\`\`\n${text}\n\`\`\`\n`,
    );
  }
}
