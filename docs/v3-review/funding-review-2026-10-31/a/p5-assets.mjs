// Pass 5: a holders' round while the treasury holds a second asset. WeeklyRounds.floorOf counts only the round's currency
// (l.264-272); holders' rounds have no one-asset check (only FundingTerms.reserve/settle call _oneAsset, l.216/240).
import { grid, priceAt, makeRound, bid, sell, clearingStep, settle, claimAll, USDC, UNIT, usd } from './rounds-model.mjs';
const W = (n) => BigInt(n) * UNIT; const units = 1_000_000; const usdc = 10_000, eth = 40_000, fee = 0.02;
const trueFloor = (usdc + eth) / units;
for (const step of [0, 4, 5]) {
  const r = makeRound(grid(BigInt(usdc) * USDC, W(units), 10_000n));
  sell(r, 'Seller', W(100_000), step); bid(r, 'Buyer', W(100_000), step);
  const c = clearingStep(r); settle(r, c.step); const out = claimAll(r);
  const paid = 100_000 * usd(priceAt(r.g, r.price)); const buyerLeaves = 100_000 * trueFloor * (1 - fee); const sellerLeaving = 100_000 * trueFloor * (1 - fee);
  console.log(`step ${step}: price $${usd(priceAt(r.g, r.price))} (USDC floor $${usd(r.g.floor)}, true floor $${trueFloor}); seller nets $${usd(out.Seller.money)} (cut $${usd(out.Seller.cut)}) vs leaving $${sellerLeaving}; buyer pays $${paid}, leaving at once pays $${buyerLeaves.toFixed(0)} -> buyer ${buyerLeaves > paid ? 'gains' : 'loses'} $${Math.abs(buyerLeaves - paid).toFixed(0)}`);
}
