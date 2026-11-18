// Pass 5: runs of exits when buyers are scarce. Mirrors MolochPatched.ragequit (l.1114-1185):
// total = Shares+Loot - DAO's own - locked; fee = exitFeeOf (0 without terms / under notice) only if amt < total;
// due = pool*amt/total; due -= due*fee/10000. Fee range: FundingTerms MAX_EXIT_FEE_BPS=500 (l.49), form default 2% (FundingDecisionForm.tsx:77).
const leave = (st, amt, feeBps) => {
  const fee = amt < st.units ? feeBps : 0;
  let due = st.treasury * amt / st.units; due -= due * fee / 10000;
  st.treasury -= due; st.units -= amt; return due;
};
const $ = (x) => '$' + x.toLocaleString(undefined, { maximumFractionDigits: 2 });
// (a) No buyers, 10 equal holders of 100k units, $50k treasury, $5k/month spent into work budgets; one holder leaves at the start of each month.
for (const feeBps of [200, 0]) {
  const st = { treasury: 50_000, units: 1_000_000 }; const burn = 5_000; const rows = [];
  for (let m = 1; m <= 6; m++) {
    const floorBefore = st.treasury / st.units; const got = leave(st, 100_000, feeBps);
    rows.push({ month: m, leaver_got: +got.toFixed(2), floor_before: +floorBefore.toFixed(5), floor_after: +(st.treasury / st.units).toFixed(5), treasury: Math.round(st.treasury), runway_months: +(st.treasury / burn).toFixed(2) });
    st.treasury -= burn;
  }
  console.log(`\n(a) run, no buyers, fee ${feeBps / 100}%:`); console.table(rows);
}
// (a2) Same treasury, nobody leaves: runway 10 months; with 30% leaving at once (fee 2%): runway
{ const st = { treasury: 50_000, units: 1_000_000 }; leave(st, 300_000, 200); console.log(`(a2) 30% leave at once at 2%: treasury ${$(st.treasury)}, runway ${(st.treasury / 5000).toFixed(2)} of 10 months; floor ${(st.treasury/st.units).toFixed(5)} vs 0.05`); }
// (b) last leaver pays no fee: 99%/1% holders, $50k, fee 2% and 5%
for (const feeBps of [200, 500]) {
  const st = { treasury: 50_000, units: 100 }; const a = leave(st, 99, feeBps); const b = leave(st, 1, feeBps);
  console.log(`(b) fee ${feeBps / 100}%: 99% holder leaves first gets ${$(a)}; 1% holder leaves last gets ${$(b)} = ${(b / 500).toFixed(2)}x its pro-rata $500`);
}
// (b2) ten equal holders all leave in turn: first vs last
for (const feeBps of [200, 500]) {
  const st = { treasury: 50_000, units: 10 }; const got = []; for (let i = 0; i < 10; i++) got.push(leave(st, 1, feeBps));
  console.log(`(b2) fee ${feeBps / 100}%, 10 equal holders leave in turn: first ${$(got[0])}, ninth ${$(got[8])}, last ${$(got[9])} (pro-rata $5,000); last/first = ${(got[9] / got[0]).toFixed(3)}`);
}
// (b3) a holder keeping 1 unit of 1,000,000 waits out a full wind-down at 2%
{ const st = { treasury: 50_000, units: 1_000_000 }; leave(st, 999_999, 200); const d = leave(st, 1, 200);
  console.log(`(b3) wind-down: everyone else (999,999 units) leaves in one go at 2%; the 1-unit holder then leaves fee-free with ${$(d)} (pro-rata $0.05)`); }
// (c) a budget vote becomes unfundable: $50k treasury, a $40k budget proposal (TreasuryMandateFactory.create pulls the exact amount, TreasuryMandate.sol:430-433)
for (const leftPct of [10, 20, 21, 25]) {
  const st = { treasury: 50_000, units: 1_000_000 }; leave(st, leftPct * 10_000, 200);
  console.log(`(c) ${leftPct}% of units leave during the vote's review: treasury ${$(st.treasury)} -> $40k budget ${st.treasury >= 40_000 ? 'still funds' : 'REVERTS at execution'}`);
}
// (d) fundraising kit, locked team Shares (D72): 1B Shares, 750M sold (75/25 preset, allocation.ts:82), $250k raised, team 250M behind 4 x 25% milestones
{ const sale = 750e6, team = 250e6, T = 250_000; let unlocked = 0; const rows = [];
  for (let k = 0; k <= 4; k++) { const units = sale + unlocked; rows.push({ milestones_unlocked: k, floor: +(T / units).toFixed(7), backer_1000_units_leave_pays: +(1000 * T / units * 0.98).toFixed(4), drop_vs_before_pct: k ? +(100 * (1 - (sale + unlocked - team / 4) / (sale + unlocked))).toFixed(2) : 0 }); unlocked += team / 4; }
  console.log('\n(d) locked Shares and leaving (treasury unspent, fee 2% if terms exist):'); console.table(rows);
  console.log(`    a backer leaving just before milestone 1 instead of just after gets ${(100 * ((sale + team / 4) / sale - 1)).toFixed(2)}% more; before any vs after all: ${(100 * ((sale + team) / sale - 1)).toFixed(2)}% more`);
}
