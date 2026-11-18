// Founder control in a contributor project, per AllocationVoting rules (contracts/src/AllocationVoting.sol:143-144, 495-501).
// Full lane: quorum 20% of voting supply (yes+no+abstain), yes*10000 >= 6600*(yes+no), yes>no.
// Bounded lane (approveProject, awardContribution): 10% / 55%.
const LANES = { full: { q: 0.20, a: 0.66 }, bounded: { q: 0.10, a: 0.55 } };
// passes(yes,no,abstain,supply) exactly as thresholdsMet
function passes(lane, yes, no, abstain, supply) {
  const { q, a } = LANES[lane];
  return yes + no + abstain >= Math.ceil(supply * q) && yes > no && yes * 10000 >= Math.round(a * 10000) * (yes + no);
}
// Smallest share of non-founder Shares that must vote NO to block a founder-only YES.
function blockShare(lane, f, S) {
  const F = f * S, others = S - F;
  // block when F*10000 < a*10000*(F+no)  => no > F*(1-a)/a
  const { a } = LANES[lane];
  const need = F * (1 - a) / a;
  if (!passes(lane, F, 0, 0, S)) return { carriesWhenPassive: false, needNoShareOfOthers: 0 };
  return { carriesWhenPassive: true, needNoShareOfOthers: need >= others ? Infinity : need / others };
}
// §8c trajectory (TOKENOMICS-PROPOSAL.md §8c): founder starts 1,000,000; awards land.
const rows = [
  { month: 0, awarded: 0, founderAwards: 0 },
  { month: 6, awarded: 1_100_000, founderAwards: 100_000 },
  { month: 12, awarded: 2_200_000, founderAwards: 200_000 },
  { month: 24, awarded: 4_700_000, founderAwards: 500_000 },
];
console.log("== §8c trajectory: founder 1,000,000 start; first budget 3,000,000 ==");
for (const r of rows) {
  const S = 1_000_000 + r.awarded, F = 1_000_000 + r.founderAwards, f = F / S;
  const full = blockShare("full", f, S), b = blockShare("bounded", f, S);
  const fmt = (x) => x.carriesWhenPassive ? (x.needNoShareOfOthers === Infinity ? "cannot be blocked" : `blocked only if >${(x.needNoShareOfOthers * 100).toFixed(1)}% of others vote no`) : "cannot pass alone";
  console.log(`month ${r.month}: supply ${S.toLocaleString()}, founder ${(f * 100).toFixed(1)}% | full: ${fmt(full)} | bounded: ${fmt(b)}`);
}
// When does the founder stop carrying a vote with nobody else voting? f < 20% (full) / 10% (bounded).
// With founder holding F_total = 1.5M (month 24), supply where f hits 20% and 10%:
const F24 = 1_500_000;
console.log(`\nFounder (1.5M at month 24) alone meets full-lane turnout until supply > ${(F24 / 0.20).toLocaleString()} Shares, bounded until > ${(F24 / 0.10).toLocaleString()}`);
// founder can't be blocked at all while f >= 66% (full) / 55% (bounded): with founder 1M start, awards x
console.log(`Founder (1M, no awards) beyond any opposition: full lane while others hold < ${Math.floor(1_000_000 * 34 / 66).toLocaleString()}; bounded while < ${Math.floor(1_000_000 * 45 / 55).toLocaleString()}`);

// === Second-wallet capture of the first budget (D79 is per address) ===
console.log("\n== Founder routes the first budget to wallets they control ==");
const DAY = 86400;
// Claim filed and bound by the founder (manager of every first project, D66/D84); a reviewer the founder named approves; settle.
// ClaimStake: payout after CHALLENGE_WINDOW 7 days (TreasuryMandate.sol:46) -> Paid. Award = bounded vote:
// review 24h, hold 6h (overlaps review), then queue + TIMELOCK 1 day (ContributorKit.sol:80).
const tAward = 7 * DAY + 24 * 3600 + 1 * DAY;
console.log(`first award to a second wallet can execute ${(tAward / DAY).toFixed(1)} days after launch (no other holder exists to oppose)`);
const founderStart = 1_000_000, budget = 3_000_000;
const visible = founderStart / (founderStart + budget);
console.log(`after the whole first budget goes to founder-held wallets: app shows founder ${(visible * 100).toFixed(0)}%, real control 100%; a later joiner finds 0 Shares left in the budget`);
// Partial: founder diverts half before others join
for (const diverted of [500_000, 1_500_000, 3_000_000]) {
  const S = founderStart + diverted, real = 1;
  console.log(`  diverted ${diverted.toLocaleString()}: real control ${(100 * real).toFixed(0)}% until others earn; founder-side Shares ${(founderStart + diverted).toLocaleString()}; others must earn > ${Math.ceil((founderStart + diverted) * 34 / 66).toLocaleString()} and all vote no to block a full-lane vote`);
}

// === Second budget at month 12 voted with friendly reviewers (§8c says one is voted) ===
console.log("\n== Month 12: founder votes a second 3,000,000 budget whose reviewers they chose; awards go founder-side ==");
{
  const S = 3_200_000, F = 1_200_000, others = S - F;
  const needNo = F * 34 / 66;
  console.log(`full-lane budget vote: founder ${(F / S * 100).toFixed(1)}%, passes unless > ${needNo.toLocaleString(undefined,{maximumFractionDigits:0})} of others' ${others.toLocaleString()} (${(needNo / others * 100).toFixed(1)}%) vote no in ~3 days`);
  const S2 = S + 3_000_000, F2 = F + 3_000_000;
  console.log(`if all 3,000,000 go founder-side: founder-side ${(F2 / S2 * 100).toFixed(1)}%, contributors ${(others / S2 * 100).toFixed(1)}% (was ${(others / S * 100).toFixed(1)}%); treasury $0, so leaving first pays $0`);
}

// === Paying themselves from a grant: month 15, $40,000 in the treasury ===
console.log("\n== Month 15: $40,000 grant; founder proposes paying it to a company they control ==");
{
  const S = 3_200_000, F = 1_200_000, T = 40_000;
  const needNo = F * 34 / 66;
  console.log(`passes unless > ${needNo.toLocaleString(undefined,{maximumFractionDigits:0})} non-founder Shares (${(needNo / (S - F) * 100).toFixed(1)}%) vote no`);
  for (const h of [100_000, 300_000]) console.log(`  a holder of ${h.toLocaleString()} who leaves first takes $${(h / S * T).toFixed(0)} and gives up ${(h / S * 100).toFixed(2)}% of the project; who stays gets $0 of it`);
  // founder take if every non-founder left first: founder's own pro rata
  console.log(`  if nobody leaves, founder-controlled payee takes $${T.toLocaleString()}; founder's own pro-rata share was $${(F / S * T).toFixed(0)}`);
}

// === Quorum counts NO votes: a small opposition can make a proposal pass ===
console.log("\n== Turnout counts 'no': opposing can turn a failing proposal into a passing one ==");
const S = 10_000_000;
for (const [lane, yesPct, noPct] of [["full", 0.14, 0.06], ["full", 0.15, 0.05], ["bounded", 0.07, 0.03]]) {
  const yes = yesPct * S, no = noPct * S;
  console.log(`${lane}: yes ${yesPct * 100}% alone -> ${passes(lane, yes, 0, 0, S) ? "PASSES" : "fails"}; yes ${yesPct * 100}% + no ${noPct * 100}% -> ${passes(lane, yes, no, 0, S) ? "PASSES" : "fails"}`);
}
// Largest NO that still lets a 14% yes pass in the full lane, and the smallest that triggers quorum
{
  const yes = 0.14 * S;
  const minNoForQuorum = 0.20 * S - yes, maxNoStillPass = yes * 34 / 66;
  console.log(`full lane, yes 14%: any NO between ${(minNoForQuorum / S * 100).toFixed(2)}% and ${(maxNoStillPass / S * 100).toFixed(2)}% of supply makes it pass`);
  const yb = 0.07 * S;
  console.log(`bounded lane, yes 7%: any NO between ${((0.10 * S - yb) / S * 100).toFixed(2)}% and ${(yb * 45 / 55 / S * 100).toFixed(2)}% makes it pass`);
}
