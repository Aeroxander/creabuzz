// Pass 5: holders' and funding rounds under no / few / many buyers, using the contract-mirror model.
import { grid, priceAt, makeRound, bid, sell, clearingStep, settle, claimAll, fundingLowest, USDC, UNIT, usd } from './rounds-model.mjs';
const MIN = 10000n; // deployed minStep (scripts/sepolia-deploy.sh:149)
const W = (n) => BigInt(n) * UNIT;
const show = (label, r, out) => {
  console.log(`\n## ${label}: floor $${usd(r.g.floor)}, step $${usd(r.g.step)}, clearing step ${r.price} price $${usd(priceAt(r.g, r.price))}, volume ${Number(r.volume / UNIT)} units, sellersShare=${r.sellersShare}`);
  for (const [who, o] of Object.entries(out)) console.log(`  ${who}: units back/bought ${Number(o.units / UNIT)}, money $${usd(o.money)}, cut $${usd(o.cut)}`);
};
// Project A: 1M units, $50k (floor $0.05, step 1c = 20%)
{ // no buyers
  const r = makeRound(grid(50_000n * USDC, W(1_000_000), MIN));
  sell(r, 'S1', W(100_000), 0); sell(r, 'S2', W(50_000), 1);
  const c = clearingStep(r); settle(r, c.step); show('A no buyers', r, claimAll(r));
}
{ // few buyers: one buyer 10k at up to step 3 ($0.08); sellers 150k at steps 0/1
  const r = makeRound(grid(50_000n * USDC, W(1_000_000), MIN));
  sell(r, 'S1', W(100_000), 0); sell(r, 'S2', W(50_000), 1); bid(r, 'B1', W(10_000), 3);
  const c = clearingStep(r); settle(r, c.step); show('A few buyers', r, claimAll(r));
}
{ // many buyers: 30k offered at step 0..5; demand 300k at up to step 1023 (they value $20): price capped
  const r = makeRound(grid(50_000n * USDC, W(1_000_000), MIN));
  sell(r, 'S1', W(30_000), 5); bid(r, 'B1', W(200_000), 1023); bid(r, 'B2', W(100_000), 1023);
  const c = clearingStep(r); settle(r, c.step); show('A many buyers, all at the top step', r, claimAll(r));
  console.log(`  top price $${usd(priceAt(r.g, 1023))} = ${(Number(priceAt(r.g,1023))/Number(r.g.floor)).toFixed(1)}x floor`);
}
// Same "many buyers" with minStep 1 micro (1% steps): cap 11.23x floor
{ const r = makeRound(grid(50_000n * USDC, W(1_000_000), 1n));
  sell(r, 'S1', W(30_000), 0); bid(r, 'B1', W(300_000), 1023);
  const c = clearingStep(r); settle(r, c.step); show('A many buyers with minStep=1 (1% steps), buyers would pay $0.80', r, claimAll(r)); }
// Empty treasury contributor project: 5.7M units, $0. Bids at step 0 are refused (escrow 0); lowest price 1 cent.
{ const g = grid(0n, W(5_700_000), MIN); const r = makeRound(g);
  try { bid(r, 'B0', W(1000), 0); } catch (e) { console.log(`\n## empty treasury: a bid at step 0 -> ${e.message}; lowest price $${usd(priceAt(g,1))} => implied value of all units $${usd(priceAt(g,1))*5_700_000}; step 2 doubles it`); }
  sell(r, 'S1', W(100_000), 1); bid(r, 'B1', W(20_000), 1);
  const c = clearingStep(r); settle(r, c.step); show('empty treasury, few buyers', r, claimAll(r)); }
// Funding round, worked example: 570k Loot tranche, least $0.05, floor 12k/5.7M
for (const [label, bids] of [['no buyers', []], ['few buyers (100k at least step)', [['B1', 100_000, 'lo']]], ['many buyers (2M at step lo+20)', [['B1', 2_000_000, 20]]]]) {
  const g = grid(12_000n * USDC, W(5_700_000), MIN); const lo = fundingLowest(g, 50_000n); const r = makeRound(g);
  sell(r, 'tranche', W(570_000), lo);
  for (const [w, a, s] of bids) bid(r, w, W(a), s === 'lo' ? lo : lo + BigInt(s));
  const c = clearingStep(r);
  try { settle(r, c.step, g.floor); const out = claimAll(r, 'tranche'); show(`funding ${label}`, r, out);
    console.log(`  raised $${usd(r.volume * priceAt(g, r.price) / UNIT)}`); }
  catch (e) { console.log(`\n## funding ${label}: clearingStep ${c.step} volume ${c.volume}; settle -> ${e.message} (round goes void; tranche returns)`); }
}
// Geometric grid comparison (after-pilot idea): 1% per step multiplicative over 1023 steps
console.log(`\nGeometric 1% grid over 1023 steps spans ${(1.01 ** 1023).toFixed(0)}x the floor; linear 1% spans 11.23x`);
