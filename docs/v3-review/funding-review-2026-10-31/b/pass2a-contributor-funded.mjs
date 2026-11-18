// Pass 2a: contributor project -> funded. Start: TOKENOMICS-PROPOSAL.md §8c month 24.
// Inputs: founder 1.5M (1.0M start + 0.5M awarded, = 26%), other contributors 4.2M (largest 450k), treasury $12,000.
// Terms: Loot, exit fee 200 bps (FundingTerms.publish). Tranche 570,000 Loot, least price $0.05 (openTranche).
import { u, usd, $, U, floorOf, fundingPrice, leave, pct, f2, money, CUT_BPS, UNIT } from "./lib.mjs";
const FEE = 200;
let g = { founder: u(1_500_000), contributors: u(4_200_000), lootBuyers: 0n, outsideShareBuyer: 0n };
let s = { shares: u(5_700_000), loot: 0n, treasury: usd(12_000) };
const largest = u(450_000);
const rows = [];
function snap(stage, feeBps, extra = "") {
  const units = s.shares + s.loot;
  const voting = s.shares;
  const f = floorOf(s);
  const r = { stage, floor: $(f * 1n) / 1, treasury: $(s.treasury) };
  for (const [k, v] of Object.entries(g)) {
    if (v === 0n) continue;
    const isShares = k !== "lootBuyers";
    r[k] = `${f2(pct(v, units))}% units / ${f2(isShares ? pct(v, voting) : 0)}% votes / leaves with ${money($(leave(s, v, feeBps)))}`;
  }
  r.largestLeaves = money($(leave(s, largest, feeBps)));
  r.note = extra;
  rows.push(r);
}
snap("M24, no terms (fee 0)", 0);
snap("Terms published, 30-day notice (fee waived)", 0);
snap("Notice over (fee 2%)", FEE);
// Tranche: floor read at opening, price from the grid.
const fl = floorOf(s);
const { step, lowest, price } = fundingPrice(fl, usd(0.05));
const sold = u(570_000);
const paid = (sold * price) / UNIT; // WeeklyRounds._finishFunding
// settle check: price*10000 >= floorNow*10200 (floorNow before payment)
const settleOk = price * 10_000n >= floorOf(s) * 10_200n;
s.loot += sold; s.treasury += paid; g.lootBuyers += sold;
snap("Tranche sold at its lowest allowed price", FEE,
  `floor at opening $${($(fl)).toFixed(5)}, step $${$(step)}, lowest step ${lowest}, price $${$(price).toFixed(5)} = ${(Number(price) / Number(fl)).toFixed(1)}x floor; raised ${money($(paid))}; settle check ${settleOk}`);
const buyerBack = Number(leave(s, sold, FEE)) / Number(paid);
console.log(`Loot buyer leaving at once gets back ${f2(buyerBack * 100)}% of what they paid`);
const afterTranche = structuredClone({ s, g });
// Holders' round (expected case, assumed): a contributor sells 200,000 Shares to an outsider at step 2 above the round's floor.
const rf = floorOf(s); const rs = (rf * 100n) / 10_000n < 10_000n ? 10_000n : (rf * 100n) / 10_000n;
const rp = rf + 2n * rs; const q = u(200_000);
const cut = (q * (rp - rf) * CUT_BPS) / (UNIT * 10_000n);
s.treasury += cut; g.contributors -= q; g.outsideShareBuyer += q;
snap("Holders' round: 200k Shares sold at step 2", FEE,
  `round floor $${$(rf).toFixed(5)}, price $${$(rp).toFixed(5)}, seller gets ${money($(q * rp / UNIT - cut))}, treasury cut ${money($(cut))}`);
// Payouts: $20,000 revenue to the module, split 50% (Payouts.distribute).
const rev = usd(20_000); const toHolders = rev * 5000n / 10_000n; s.treasury += rev - toHolders;
const counting = s.shares + s.loot;
const perGroup = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, money($(toHolders * v / counting))]));
snap("Payouts: $20k revenue, half to holders", FEE, "credited: " + JSON.stringify(perGroup));
const afterPayout = structuredClone({ s, g });
// Expected: a year more of awards at §8c's year-2 pace (2.2M at m12 -> 5.7M at m24 = 3.5M a year), all to contributors.
s.shares += u(3_500_000); g.contributors += u(3_500_000);
snap("Expected: +1 year of awards (3.5M Shares)", FEE);
// Worst case allowed: founder passes a 57M-Share budget (10x the Shares) and it is awarded to founder and allies.
({ s, g } = structuredClone(afterPayout));
const yes = g.founder; const voting = s.shares;
const turnout = voting * 2000n / 10_000n;
const noToBlockFull = yes * 3400n / 6600n; // thresholdsMet: yes*10000 >= 6600*(yes+no)
const noToBlockBounded = yes * 4500n / 5500n;
console.log(`Full lane: turnout bar ${U(turnout).toLocaleString()} Shares; founder alone (${U(yes).toLocaleString()}) passes unless more than ${Math.round(U(noToBlockFull)).toLocaleString()} vote no (${f2(pct(noToBlockFull, voting))}% of voting Shares). Bounded lane (awards): unless > ${Math.round(U(noToBlockBounded)).toLocaleString()} vote no.`);
const big = u(57_000_000); s.shares += big; g.founder += big;
snap("Worst: founder-passed 57M-Share budget awarded to founder side", FEE);
const lootShareBefore = pct(afterPayout.g.lootBuyers, afterPayout.s.shares + afterPayout.s.loot);
const lootShareAfter = pct(g.lootBuyers, s.shares + s.loot);
console.log(`Loot buyers' share of payouts and exit: ${f2(lootShareBefore)}% -> ${f2(lootShareAfter)}%; Loot exit ${money($(leave(afterPayout.s, g.lootBuyers, FEE)))} -> ${money($(leave(s, g.lootBuyers, FEE)))} (paid ${money($(paid))})`);
// Minimum time from opening the budget vote to the first award mint (constants: AllocationVoting lanes, ContributorKit TIMELOCK, TreasuryMandate CHALLENGE_WINDOW).
const D = 86400; const full = 48 * 3600 + 1 * D, bounded = 24 * 3600 + 1 * D, challenge = 7 * D;
console.log(`Earliest first award after the budget vote opens: ${(full + bounded + challenge) / D} days (budget ${full / D}d, project approval ${bounded / D}d, claim challenge window ${challenge / D}d; the award vote overlaps the window)`);
// Q2 / worst case: every Shares holder leaves right after the tranche, in 57 equal exits (fee each, none on the very last units).
({ s, g } = structuredClone(afterTranche));
let out = 0n; const chunk = s.shares / 57n;
for (let i = 0; i < 57; i++) { const d = leave(s, chunk, FEE); out += d; s.treasury -= d; s.shares -= chunk; }
console.log(`All Shares leave after the tranche: they take ${money($(out))} (they had put in $12,000 of grant money as the treasury); Loot buyers keep ${money($(s.treasury))} of the ${money($(paid))} they paid (${f2(pct(s.treasury, paid))}%)`);
console.table(rows);
