// Pass 1: the price grid against project sizes, for the deployed minStep (10000 = 1 cent, sepolia-deploy.sh:149) and alternatives.
import { grid, priceAt, fundingLowest, USDC, UNIT, STEPS } from './rounds-model.mjs';
const treasuries = [0, 5_000, 12_000, 50_000, 250_000, 1_000_000];
const unitCounts = [1_000_000n, 5_700_000n, 10_000_000n, 1_000_000_000n];
const minSteps = [10000n, 1000n, 100n, 10n, 1n];
const rows = [];
for (const ms of minSteps) for (const u of unitCounts) for (const t of treasuries) {
  const g = grid(BigInt(t) * USDC, u * UNIT, ms);
  const fl = Number(g.floor) / 1e6, st = Number(g.step) / 1e6;
  const minTranche = Number(priceAt(g, 2)) / 1e6, maxP = Number(priceAt(g, 1023)) / 1e6;
  rows.push({ minStep_usd: Number(ms) / 1e6, units: Number(u), treasury: t, floor: fl, step: st,
    step_pct_floor: fl ? +(100 * st / fl).toFixed(1) : 'inf',
    min_tranche_x_floor: fl ? +(minTranche / fl).toFixed(2) : `$${minTranche}`,
    max_x_floor: fl ? +(maxP / fl).toFixed(2) : `$${maxP}`,
    min_valuation_step1: Math.round(Number(priceAt(g, 1)) / 1e6 * Number(u)),
    max_valuation: Math.round(maxP * Number(u)) });
}
console.table(rows.filter(r => r.minStep_usd === 0.01));
console.log('\nAlternatives (step% of floor / max multiple), rows = units x treasury:');
for (const u of unitCounts) for (const t of treasuries) {
  const line = minSteps.map(ms => { const r = rows.find(x => x.minStep_usd === Number(ms) / 1e6 && x.units === Number(u) && x.treasury === t); return `${r.minStep_usd}: ${r.step_pct_floor}%/${r.max_x_floor}`; });
  console.log(`${u} units, $${t}: ` + line.join(' | '));
}
// Where 1% steps apply: floor >= 100*minStep  => treasury >= units * 100 * minStep
console.log('\nTreasury needed for true 1% steps (floor >= 100 x minStep):');
for (const u of unitCounts) console.log(`${u} units: ` + minSteps.map(ms => `minStep ${Number(ms)/1e6}: $${(Number(u) * 100 * Number(ms) / 1e6).toLocaleString()}`).join(' | '));
// Floor truncation (integer micro-USDC per whole unit)
console.log('\nFloor rounding (floorOf truncates to 1 micro-USDC per whole unit):');
for (const [t, u] of [[5_999, 1_000_000_000n], [5_000, 1_000_000_000n], [50_000, 1_000_000_000n], [12_000, 5_700_000n]]) {
  const g = grid(BigInt(t) * USDC, u * UNIT, 1n); const exact = t / Number(u);
  console.log(`$${t} / ${u}: exact $${exact.toExponential(4)}, floorOf $${Number(g.floor)/1e6}, error ${(100*(1 - Number(g.floor)/1e6/exact)).toFixed(2)}%, best possible step (minStep=1) = ${(100*Number(g.step)/Number(g.floor)).toFixed(1)}% of floor`);
}
// Brief worked example: least price $0.05, floor 12k/5.7M
for (const ms of [10000n, 100n, 1n]) {
  const g = grid(12_000n * USDC, 5_700_000n * UNIT, ms);
  const lo = fundingLowest(g, 50_000n);
  console.log(`worked example, minStep ${Number(ms)/1e6}: floor ${Number(g.floor)/1e6}, step ${Number(g.step)/1e6}, lowest step ${lo === null ? 'REVERT BadStep (needs >1023 steps)' : lo + ' -> price $' + Number(priceAt(g, lo))/1e6}`);
}
// Highest least price a tranche can name, by minStep, for that example
for (const ms of [10000n, 1000n, 100n, 1n]) { const g = grid(12_000n * USDC, 5_700_000n * UNIT, ms); console.log(`minStep ${Number(ms)/1e6}: highest offerable tranche price $${Number(priceAt(g, 1023))/1e6} (${(Number(priceAt(g,1023))/Number(g.floor)).toFixed(1)}x floor)`); }
