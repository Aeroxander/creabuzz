// Pass 3 scenarios: value moving between groups through money that is "about to arrive" in the treasury but is not in
// the floor when a funding round settles (WeeklyRounds.settle reads floorOf = currency.balanceOf(dao) only).
import { u, usd, $, U, floorOf, fundingPrice, leave, pct, f2, money, UNIT } from "./lib.mjs";
const FEE = 200;
function scenario(title, { shares, treasury, pending, splitBps, sold, least }) {
  // Path A: the round settles first, then the pending money lands (Payouts.distribute / TreasuryMandate.returnUnused).
  let s = { shares: u(shares), loot: 0n, treasury: usd(treasury) };
  const fl = floorOf(s); const p = fundingPrice(fl, usd(least));
  const ok = p.price * 10_000n >= floorOf(s) * 10_200n;
  const paid = u(sold) * p.price / UNIT;
  s.loot += u(sold); s.treasury += paid;
  const toHolders = usd(pending) * BigInt(splitBps) / 10_000n;
  const counting = s.shares + s.loot;
  const lootPayout = toHolders * s.loot / counting;
  s.treasury += usd(pending) - toHolders;
  const buyerValue = leave(s, s.loot, FEE) + lootPayout;
  // Path B: someone lands the pending money before settling.
  let t = { shares: u(shares), loot: 0n, treasury: usd(treasury) + usd(pending) - toHolders * 0n };
  const tNoSplit = { ...t, treasury: usd(treasury) + usd(pending) - usd(pending) * BigInt(splitBps) / 10_000n };
  const okB = p.price * 10_000n >= floorOf(tNoSplit) * 10_200n;
  console.log(`\n${title}`);
  console.log(`  floor at opening $${$(fl).toFixed(4)}, step $${$(p.step).toFixed(4)}, price $${$(p.price).toFixed(4)}, settle check passes: ${ok}`);
  console.log(`  buyers pay ${money($(paid))} for ${sold.toLocaleString()} Loot; once the pending ${money(pending)} lands they can leave with ${money($(buyerValue))} at once (after the 2% fee, payouts included): +${money($(buyerValue - paid))}, taken from the earlier holders`);
  console.log(`  had the money landed before settling, the floor would be $${$(floorOf(tNoSplit)).toFixed(4)} and the round could not settle at that price: ${!okB}`);
}
scenario("Revenue waiting in the payout module (split 20% to holders), larger project where the 1% step applies",
  { shares: 100_000, treasury: 200_000, pending: 60_000, splitBps: 2000, sold: 20_000, least: 2.10 });
scenario("An expired work budget with $30,000 unspent, not yet returned (returnUnused: anyone, after expiry)",
  { shares: 100_000, treasury: 200_000, pending: 30_000, splitBps: 0, sold: 20_000, least: 2.04 });
scenario("Same revenue case at §8c size (minStep dominates)",
  { shares: 5_700_000, treasury: 12_000, pending: 20_000, splitBps: 5000, sold: 570_000, least: 0.05 });

// Exit fee when leaving to avoid a dilutive award budget (fee waived only under the terms' own notice, FundingTerms.exitFeeOf).
{
  const s = { shares: u(5_500_000) + u(200_000), loot: u(570_000), treasury: usd(52_499.85) }; // pass2a stage 5
  for (const [who, amt] of [["all Loot buyers (570,000)", u(570_000)], ["largest contributor (450,000)", u(450_000)]]) {
    const gross = leave(s, amt, 0), net = leave(s, amt, FEE);
    console.log(`Leaving ahead of a dilutive award budget, ${who}: fee ${money($(gross - net))} of ${money($(gross))}`);
  }
}
