// Mirror of contracts/src/WeeklyRounds.sol integer math (BigInt). Read from the contract:
// STEPS=1024 (l.89), STEP_BPS=100 (l.91), CUT_BPS=2000 (l.93), DAO_MIN_STEPS=2 (l.95), UNIT=1e18 (l.96)
// _openRound step = max(floor*STEP_BPS/10000, minStep) (l.247-249); floorOf = bal*UNIT/units (l.271)
export const STEPS = 1024n, STEP_BPS = 100n, CUT_BPS = 2000n, DAO_MIN_STEPS = 2n, UNIT = 10n ** 18n;
export const USDC = 10n ** 6n;
export const floorOf = (balance, units) => { if (units === 0n) throw new Error('NobodyCanLeave'); return balance * UNIT / units; };
export function grid(balance, units, minStep) {
  const floor = floorOf(balance, units);
  let step = floor * STEP_BPS / 10000n;
  if (step < minStep) step = minStep;
  return { floor, step };
}
export const priceAt = (g, s) => g.floor + BigInt(s) * g.step;
const up = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n);
// openFunding lowest step (l.234-239)
export function fundingLowest(g, least) {
  let lowest = DAO_MIN_STEPS;
  if (least > g.floor) { const atLeast = (least - g.floor + g.step - 1n) / g.step; if (atLeast > lowest) lowest = atLeast; }
  if (lowest >= STEPS) return null; // BadStep revert
  return lowest;
}
// A round: sells [{who, amount, step}], bids [{who, amount, step}]
export function makeRound(g) { return { g, sells: [], bids: [] }; }
export function bid(r, who, amount, step) {
  const escrow = up(amount * priceAt(r.g, step), UNIT);
  if (escrow === 0n) throw new Error('BadStep(escrow 0)');
  if (BigInt(step) >= STEPS) throw new Error('BadStep');
  r.bids.push({ who, amount, step: BigInt(step), escrow });
}
export function sell(r, who, amount, step) { if (BigInt(step) >= STEPS) throw new Error('BadStep'); r.sells.push({ who, amount, step: BigInt(step) }); }
const supplyAt = (r, s) => r.sells.filter(o => o.step <= s).reduce((a, o) => a + o.amount, 0n);
const demandAt = (r, s) => r.bids.filter(o => o.step >= s).reduce((a, o) => a + o.amount, 0n);
// clearingStep (l.433-447)
export function clearingStep(r) {
  let lo = 0n, hi = STEPS;
  while (lo < hi) { const mid = (lo + hi) / 2n; if (demandAt(r, mid) >= supplyAt(r, mid)) lo = mid + 1n; else hi = mid; }
  if (lo === 0n) return { step: 0n, volume: demandAt(r, 0n), sellersShare: true };
  const highest = lo - 1n, covered = supplyAt(r, highest);
  const above = highest + 1n < STEPS ? demandAt(r, highest + 1n) : 0n;
  return above > covered ? { step: highest + 1n, volume: above, sellersShare: true } : { step: highest, volume: covered, sellersShare: false };
}
// settle (l.353-395) incl. funding floor check against floorNow
export function settle(r, step, floorNow = null) {
  if (floorNow !== null && priceAt(r.g, step) * 10000n < floorNow * (10000n + STEP_BPS * DAO_MIN_STEPS)) throw new Error('BelowFloor');
  const supply = supplyAt(r, step), demand = demandAt(r, step);
  if (demand >= supply) {
    let demandUp = 0n;
    if (step + 1n < STEPS) { demandUp = demandAt(r, step + 1n); if (demandUp >= supplyAt(r, step + 1n) || demandUp > supply) throw new Error('WrongPrice'); }
    Object.assign(r, { volume: supply, sellersShare: false, marginTotal: demand - demandUp, marginGets: supply - demandUp });
  } else {
    let supplyDown = 0n;
    if (step !== 0n) { supplyDown = supplyAt(r, step - 1n); if (demandAt(r, step - 1n) < supplyDown || demand <= supplyDown) throw new Error('WrongPrice'); }
    Object.assign(r, { volume: demand, sellersShare: true, marginTotal: supply - supplyDown, marginGets: demand - supplyDown });
  }
  r.price = step; r.marginClaimed = 0n; return r;
}
// claims (l.467-514) without payouts; returns per-person {units, money, cut}
export function claimAll(r, daoAddr = 'dao') {
  const price = priceAt(r.g, r.price), out = {};
  const margin = (amt) => { const b = r.marginClaimed, a = b + amt; r.marginClaimed = a; return a * r.marginGets / r.marginTotal - b * r.marginGets / r.marginTotal; };
  for (const s of r.sells) {
    const filled = s.step < r.price ? s.amount : s.step > r.price ? 0n : (r.sellersShare ? margin(s.amount) : s.amount);
    const value = filled * price / UNIT;
    const cut = s.who === daoAddr ? 0n : filled * (price - r.g.floor) * CUT_BPS / (UNIT * 10000n);
    out[s.who] = { units: s.amount - filled, sold: filled, money: value - cut, cut };
  }
  r.marginClaimed = 0n;
  for (const b of r.bids) {
    const filled = b.step > r.price ? b.amount : b.step < r.price ? 0n : (r.sellersShare ? b.amount : margin(b.amount));
    const o = out[b.who] ?? { units: 0n, money: 0n, cut: 0n };
    o.units += filled; o.bought = filled; o.money += b.escrow - up(filled * price, UNIT); o.paid = up(filled * price, UNIT);
    out[b.who] = o;
  }
  return out;
}
export const usd = (x) => Number(x) / 1e6;
export const whole = (x) => Number(x / UNIT);
