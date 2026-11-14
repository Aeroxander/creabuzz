// Shared helpers that mirror the contracts' arithmetic (USDC 6 decimals, units 18 decimals).
export const UNIT = 10n ** 18n;
export const USD = 10n ** 6n;
export const u = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // whole units (allow fractional input) -> 18 dec
export const usd = (n) => BigInt(Math.round(n * 1e6)); // dollars -> 6 dec
export const $ = (x) => Number(x) / 1e6;
export const U = (x) => Number(x) / 1e18;
export const MIN_STEP = 10_000n; // scripts/sepolia-deploy.sh:149 (one cent)
export const STEP_BPS = 100n, CUT_BPS = 2000n, DAO_MIN_STEPS = 2n, STEPS = 1024n; // WeeklyRounds.sol constants

// WeeklyRounds.floorOf: currency * UNIT / (Shares + Loot - DAO's own - locked)
export function floorOf(s) {
  const units = s.shares + s.loot - (s.daoShares ?? 0n) - (s.locked ?? 0n);
  return (s.treasury * UNIT) / units;
}
export function stepOf(floor) {
  let st = (floor * STEP_BPS) / 10_000n;
  return st < MIN_STEP ? MIN_STEP : st;
}
// WeeklyRounds.openFunding: lowest step = max(2, ceil((least - floor)/step))
export function fundingPrice(floor, least) {
  const st = stepOf(floor);
  let lowest = DAO_MIN_STEPS;
  if (least > floor) {
    const atLeast = (least - floor + st - 1n) / st;
    if (atLeast > lowest) lowest = atLeast;
  }
  return { step: st, lowest, price: floor + lowest * st };
}
// MolochPatched.ragequit: due = pool*amt/total, less fee if amt < total
export function leave(s, amt, feeBps) {
  const total = s.shares + s.loot - (s.daoShares ?? 0n) - (s.locked ?? 0n);
  const fee = amt < total ? BigInt(feeBps) : 0n;
  let due = (s.treasury * amt) / total;
  if (fee) due -= (due * fee) / 10_000n;
  return due;
}
export const pct = (a, b) => (100 * Number(a)) / Number(b);
export const f2 = (x) => x.toFixed(2);
export const money = (x) => "$" + Math.round(x).toLocaleString("en-US");
