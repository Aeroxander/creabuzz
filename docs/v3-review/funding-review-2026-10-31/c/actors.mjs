// Pass 4 (actors, money-market side). Constants read from contracts/src:
// WeeklyRounds STEP_BPS=100, CUT_BPS=2000, DAO_MIN_STEPS=2, STEPS=1024; minStep=10000 (sepolia-deploy.sh:149, 1 cent, USDC 6dp)
// FundingTerms NOTICE=30d, MAX_EXIT_FEE_BPS=500, MAX_WATCHED=16; AllocationVoting full lane quorum 20%, approval 66%, review 48h, hold 12h; kit TIMELOCK 1d
const UNIT = 10n ** 18n, MIN_STEP = 10000n, USDC = 1_000_000n;
const floorOf = (bal, units) => bal * UNIT / units;               // WeeklyRounds.sol:271
const stepOf = (F) => { const s = F * 100n / 10000n; return s < MIN_STEP ? MIN_STEP : s; }; // :248-249
const settleOk = (price, floorNow) => !(price * 10000n < floorNow * 10200n); // :362
const usd = (w) => (Number(w) / 1e6).toFixed(2);
const out = (...a) => console.log(...a);

out("== 1. Funding round at its lowest step (2): integer rounding ==");
for (const [bal, units] of [[200_010_000n, 200n * UNIT], [250_123_450_000n, 120_000n * UNIT], [250_000_000_000n, 125_000n * UNIT], [50_000_000_000n, 120_000n * UNIT]]) {
  const F = floorOf(bal, units), st = stepOf(F), p2 = F + 2n * st;
  out(`treasury $${usd(bal)} units ${units / UNIT}: floor ${F} wei ($${usd(F)}), step ${st}, price@2 ${p2}, needs >= ${(F * 10200n + 9999n) / 10000n}: settles=${settleOk(p2, F)}`);
}
// share of floors >= $1.00 (step = 1%) that fail at step 2 with no change at all
let fail = 0, n = 0;
for (let F = 1_000_000n; F < 1_100_000n; F += 1n) { n++; if (!settleOk(F + 2n * stepOf(F), F)) fail++; }
out(`floors $1.00-$1.10: ${fail}/${n} = ${(100 * fail / n).toFixed(2)}% cannot settle at step 2 even if nothing changes`);

out("\n== 1b. Grief: floor rise that voids a round clearing at step 2 (floors under $1, step = 1 cent) ==");
for (const Fc of [5n, 25n, 50n, 90n]) { // cents
  const F = Fc * 10_000n, p2 = F + 2n * MIN_STEP;
  const need = (p2 * 10000n) / 10200n + 1n; // smallest floorNow that reverts
  const r = Number(need - F) / Number(F);
  const fee = 0.05, x = r / (fee + r);
  out(`floor $${usd(F)}: price@2 $${usd(p2)} (+${(100 * Number(2n * MIN_STEP) / Number(F)).toFixed(1)}%); void if floor rises ${(100 * r).toFixed(2)}% = donation of ${(100 * r).toFixed(2)}% of treasury, or exits of ${(100 * x).toFixed(1)}% of units at a 5% fee`);
}
out("floor a multiple of 100 wei and >= $1: any +1 wei of floor voids it: donation = units/1e18 wei, e.g. 120,000 units -> 120,000 wei = $0.12");

out("\n== 2. Timing trade: buy units at the floor, inflow lands, leave ==");
// inflow raises floor by g; trader paid F; leaves at F(1+g)(1-fee)
for (const fee of [0, 0.02, 0.05]) {
  const breakeven = fee / (1 - fee);
  out(`fee ${fee * 100}%: profitable once the inflow lifts the floor by more than ${(100 * breakeven).toFixed(2)}%`);
}
// a tranche at premium: n new units at price P*F against U units
const tranche = (nOverU, prem) => (1 + nOverU * prem) / (1 + nOverU) - 1;
for (const [nU, prem] of [[0.5, 1.5], [0.25, 1.2], [1, 1.1], [0.5, 1.02]]) {
  const g = tranche(nU, prem);
  out(`tranche ${nU * 100}% of units at ${prem}x floor: floor +${(100 * g).toFixed(2)}%; trader who bought at floor nets ${(100 * ((1 + g) * 0.95 - 1)).toFixed(2)}% at 5% fee, ${(100 * ((1 + g) * 0.98 - 1)).toFixed(2)}% at 2%, ${(100 * g).toFixed(2)}% with the fee waived`);
}

out("\n== 3. Raise mid-round (forge test D): 200 USDC / 200 units, fee 5%, tranche 100 units at 1.50 ==");
{ const T = 350, U = 300, bob = 100; const whole = T * bob / U; out(`Bob leaves 100 Loot: ${whole.toFixed(4)} USDC fee-free vs ${(whole * 0.95).toFixed(4)} with 5%: ${(whole * 0.05).toFixed(4)} USDC (5% of his exit) does not stay with Alice and the 100 new buyers`);
  const scale = 250_000 / 200; out(`same shape at a $250,000 treasury: $${(whole * 0.05 * scale).toFixed(0)} leaves with one third of the old units instead of staying`); }

out("\n== 4. Accept is per token (forge test E): 200 USDC, 200 units, accepted dust token, 300 more arrive, tranche 100 at 1.02 ==");
{ const paid = 102, usdcBack = 302 * 100 / 300, tok = 300 * 100 / 300; out(`Ben pays ${paid} USDC, leaves with ${usdcBack.toFixed(4)} USDC + ${tok} of the token; old holders' share of it falls from 300 to 200`); }

out("\n== 5. Payouts: revenue waiting at the module is credited to whoever holds when someone presses distribute ==");
{ const T = 60_000, U = 120_000, F = T / U, R = 10_000, split = 0.5, q = 12_000, fee = 0.05;
  const credited = R * split * q / U, floor2 = (T + R * (1 - split)) / U;
  const exit = q * floor2 * (1 - fee), cost = q * F;
  out(`treasury $${T}, ${U} units (floor $${F}), $${R} revenue waiting, split 50%. Trader buys ${q} units at the floor ($${cost}) in a round, then distributes:`);
  out(`  payout credit $${credited.toFixed(2)} (no exit fee on it) + leaves at floor $${floor2.toFixed(4)} less 5% = $${exit.toFixed(2)}; net $${(credited + exit - cost).toFixed(2)}`);
  out(`  the seller of those ${q} units lost $${(credited + q * (floor2 - F)).toFixed(2)} they would have had by distributing first; a holder who left before distribute loses the same per unit`); }

out("\n== 6. The cut: routing around it, and what a fake last price costs ==");
{ const F = 0.5, P = 1.0, q = 10_000; out(`${q} units worth $${P} on a $${F} floor: cut in a round = $${(q * (P - F) * 0.2).toFixed(0)}; at step 0 with a side payment = $0, but any stranger bidding step 1 takes all ${q} at $${(F * 1.0 + 0.01).toFixed(2)} (step = 1 cent here)`);
  out(`wash 1 unit at 3x floor ($${3 * F}) to set the 'last trade': cut $${(1 * (3 * F - F) * 0.2).toFixed(2)} + gas (sell ~280k-700k, bid ~120k-320k, settle ~150k)`); }

out("\n== 7. Watch-list and ETH griefing: attacker vs project ==");
out("attacker: 1 wei ETH = ~14.6k gas, no holding needed; fresh lying token + flag = ~98-120k gas, needs any units (1 wei of Loot bought for 1 wei of USDC in test C)");
out("project per block: a full-lane vote to accept (48h review + 12h hold + 1d timelock = 3.5 days min, 20% turnout, 66% yes) or to send the ETH out, plus the void round: next funding round opens 7 days after the last opened");
out("rounds blocked per attacker action: 1; list size 16 does not bound it (accepting frees the slot; lying tokens never read 'no longer held')");
