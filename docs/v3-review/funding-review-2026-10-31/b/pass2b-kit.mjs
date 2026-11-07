// Pass 2b: fundraising kit, §8a/§8b re-derived under the current code:
//  exit total = Shares + Loot - DAO's own - lock.totalLocked() (MolochPatched.sol ragequit, D72)
//  yearly cap: Shares._countIssued, base = Shares outside the DAO less still locked, fixed when the cap-year starts
//  (the first counted award, then the first award >= 365 days later), YEARLY_ISSUANCE_BPS = 1000 (DaoLaunchKit.sol:166)
//  no exit fee without funding terms (FundingTerms.exitFeeOf)
import { u, usd, $, U, floorOf, fundingPrice, leave, pct, f2, money, UNIT } from "./lib.mjs";

function run(name, cfg, events) {
  let s = { shares: cfg.total, loot: 0n, treasury: cfg.raise, locked: cfg.team, daoShares: 0n };
  let cap = { start: null, base: 0n, issued: 0n };
  const out = [];
  const award = (m, amt) => {
    if (cap.start === null || m >= cap.start + 12) { cap = { start: m, base: s.shares - s.locked, issued: 0n }; }
    cap.issued += amt;
    if (cap.issued * 10_000n > cap.base * 1000n) throw new Error(`over cap at month ${m}`);
    s.shares += amt;
  };
  for (const e of events) {
    if (e.unlock) s.locked -= e.unlock;
    if (e.treasury !== undefined) s.treasury += usd(e.treasury);
    if (e.award) award(e.m, e.award);
    out.push({ month: e.m, treasury: money($(s.treasury)), "$1,000 at exit": money($(leave(s, cfg.backer, 0))),
      "team votes %": f2(pct(cfg.team, s.shares)), "cap-year": cap.start === null ? "-" : `from m${cap.start}: ${U(cap.issued).toLocaleString()} of ${(U(cap.base) / 10).toLocaleString()}` });
  }
  console.log(`\n${name}`); console.table(out);
  return s;
}
// §8a film: 1,000,000 Shares, sale 750,000 at $0.0667, team 250,000 locked 33/33/34; $1,000 = 15,000 Shares.
run("§8a film, current code", { total: u(1_000_000), raise: usd(50_000), team: u(250_000), backer: u(15_000) }, [
  { m: 0 }, { m: 1, treasury: -38_000 }, { m: 4, unlock: u(82_500), award: u(10_000) },
  { m: 8, unlock: u(82_500), treasury: 2_000, award: u(10_000) }, { m: 10, treasury: -4_000 },
  { m: 14, unlock: u(85_000) }, { m: 18, treasury: 15_000 }, { m: 24, award: u(10_000) }]);
// §8b app: 10,000,000 Shares, sale 7,000,000 at $0.0357, team 3,000,000 locked 30/30/40; $1,000 = 28,000 Shares.
const app = run("§8b app, current code", { total: u(10_000_000), raise: usd(250_000), team: u(3_000_000), backer: u(28_000) }, [
  { m: 0 }, { m: 1, treasury: -100_000 }, { m: 5, unlock: u(900_000), award: u(150_000) },
  { m: 7, treasury: 10_000 - 90_000, award: u(150_000) }, { m: 11, unlock: u(900_000), award: u(200_000) },
  { m: 13, treasury: 2_500 - 50_000, award: u(100_000) }, { m: 18, unlock: u(1_200_000), treasury: 12_500, award: u(550_000) },
  { m: 24, treasury: 15_000, award: u(100_000) }]);

// The most new Shares the cap allows in 24 months, film schedule (unlocks at m4, m8, m14), over every start month.
function maxIssued(sale, unlocks, horizon = 24) {
  let best = { total: 0 };
  for (let t1 = 0; t1 <= horizon; t1 += 0.5) {
    const unl = (t) => unlocks.filter(([m]) => m <= t).reduce((a, [, x]) => a + x, 0);
    const b1 = sale + unl(t1), i1 = 0.1 * b1;
    let total = i1, b2 = 0, i2 = 0;
    if (t1 + 12 <= horizon) { b2 = sale + unl(t1 + 12) + i1; i2 = 0.1 * b2; total += i2; }
    if (total > best.total) best = { t1, total, b1, b2 };
  }
  return best;
}
const fm = maxIssued(750_000, [[4, 82_500], [8, 82_500], [14, 85_000]]);
console.log(`\n§8a most new Shares in 24 months under the code: ${Math.round(fm.total).toLocaleString()} (first award at m${fm.t1}); backers ${f2(75e4 / (1e6 + fm.total) * 100)}% of all Shares. Doc says 1,210,000 in all / 62%.`);
const am = maxIssued(7_000_000, [[5, 900_000], [11, 900_000], [18, 1_200_000]]);
console.log(`§8b most new Shares in 24 months under the code: ${Math.round(am.total).toLocaleString()} (first award at m${am.t1}); backers ${f2(7e6 / (1e7 + am.total) * 100)}%. Doc says 12,100,000 in all / 57.9%.`);

// Worst case 1: the cap-year boundary. 10% on the last day of a cap-year, 10% of the larger base the day after.
const B = 1;
const cut2 = 1 - 1 / (1.1 * 1.1);
console.log(`\nBoundary: 10% on day 364 and 10% on day 365 of the base then: each Share's exit value falls ${f2(cut2 * 100)}% within two days (the stated most is ${f2((1 - 1 / 1.1) * 100)}% a year).`);
// Worst case 2: the base is fixed at the start of the cap-year; holders who leave afterwards do not shrink it.
for (const leftShare of [0.25, 0.5, 0.75]) {
  const base = 1, issued = 0.1 * base, stay = base * (1 - leftShare);
  console.log(`  ${leftShare * 100}% of the year-start base leaves, then the full allowance is awarded: each remaining Share's exit value falls ${f2(issued / (stay + issued) * 100)}%`);
}
// Same with the §8b numbers: cap-year from m18, base 10,600,000 (7M + 3M unlocked + 600k awarded), 550k awarded at m18.
{
  let s = structuredClone(app); // month 24 state
  const base = u(10_600_000); const allowance = base / 10n; const usedSoFar = u(650_000);
  const leaving = u(3_500_000); // half the sale leaves at month 20
  const before = { ...s }; s.shares -= leaving; s.treasury -= leave(before, leaving, 0);
  const backerBefore = leave(s, u(28_000), 0);
  s.shares += allowance - usedSoFar;
  console.log(`§8b: half the sale (3.5M) leaves, then the rest of the cap-year's allowance (${U(allowance - usedSoFar).toLocaleString()}) is awarded: a remaining $1,000 backer's exit ${money($(backerBefore))} -> ${money($(leave(s, u(28_000), 0)))} (${f2(100 - pct(leave(s, u(28_000), 0), backerBefore))}% cut from the remainder alone; the allowance was ${f2(pct(allowance - usedSoFar, before.shares - leaving))}% of the Shares left)`);
}

// Extension: a later tranche under funding terms in a kit DAO (the contracts accept it; the app offers it to contributor projects only).
// (i) §8b month 24: treasury $50,000, 11,250,000 Shares, nothing locked. 1,125,000 Loot (10%), least price $0.05, fee 2%.
{
  let s = { shares: u(11_250_000), loot: 0n, treasury: usd(50_000), locked: 0n };
  const fl = floorOf(s); const p = fundingPrice(fl, usd(0.05)); const sold = u(1_125_000); const paid = sold * p.price / UNIT;
  s.loot += sold; s.treasury += paid;
  console.log(`\nKit tranche at m24: floor $${$(fl).toFixed(5)}, price $${$(p.price).toFixed(5)} (${(Number(p.price) / Number(fl)).toFixed(1)}x floor), raised ${money($(paid))}; Loot buyer leaving at once gets ${f2(pct(leave(s, sold, 200), paid))}% back; $1,000 backer exit ${money($(leave(s, u(28_000), 200)))}`);
}
// (ii) §8b month 1 (all 3,000,000 team Shares still locked): treasury $150,000, 7,000,000 counting.
{
  let s = { shares: u(10_000_000), loot: 0n, treasury: usd(150_000), locked: u(3_000_000) };
  const fl = floorOf(s); const p = fundingPrice(fl, fl); const sold = u(700_000); const paid = sold * p.price / UNIT;
  s.loot += sold; s.treasury += paid;
  const at = leave(s, sold, 200);
  s.locked = 0n; // all three milestones stand later, no money moves
  const after = leave(s, sold, 200);
  console.log(`Kit tranche at m1 with 3M team Shares still locked: floor $${$(fl).toFixed(5)}, price $${$(p.price).toFixed(5)} (${f2(Number(p.price) / Number(fl))}x floor), raised ${money($(paid))}. Loot buyers' exit ${money($(at))} -> ${money($(after))} once every milestone stands (${f2(100 - pct(after, at))}% lower, no vote, no money moved)`);
}
// (iii) Terms with voting Shares in a kit DAO: mintForFunding is not counted against the 10% cap.
{
  const base = 11_250_000, cap = 0.1 * base; const tranche = 11_250_000; // terms' limit is any uint128
  console.log(`Kit terms with voting Shares: a tranche of ${tranche.toLocaleString()} Shares (cap-free, Shares.mintForFunding) vs the year's award cap of ${cap.toLocaleString()}; the original holders' votes go from 100% to ${f2(base / (base + tranche) * 100)}%`);
}
