// Contributor project at month 24 of TOKENOMICS-PROPOSAL §8c, then funding terms and one tranche.
const shares = 5_700_000, treasury = 12_000, top = 450_000;
const minStep = 0.01, stepBps = 0.01, fee = 0.02;
const floor0 = treasury / shares;
const step = Math.max(floor0 * stepBps, minStep);
const least = 0.05, units = 570_000;
const lowest = Math.max(2, Math.ceil((least - floor0) / step));
const price = floor0 + lowest * step;
const raised = units * price;
const t1 = treasury + raised, u1 = shares + units, floor1 = t1 / u1;
const f = (x, d = 4) => x.toFixed(d);
console.log({ floor0: f(floor0, 6), step, maxPrice: f(floor0 + 1023 * step), lowestStep: lowest, price: f(price, 6),
  priceOverFloor: f(price / floor0, 2), raised: f(raised, 0), treasury1: f(t1, 0), floor1: f(floor1, 6),
  buyerExitPerUnit: f(floor1 * (1 - fee), 6), buyerKeepsPct: f(100 * floor1 * (1 - fee) / price, 1),
  topBefore: f(top * floor0, 0), topAfter: f(top * floor1 * (1 - fee), 0), topShareBefore: f(100*top/shares,2), topShareAfter: f(100*top/u1,2),
  kitFloorExample: '1M Shares, $50k: floor ~0.0667 -> one-cent step is ' + f(100 * 0.01 / 0.0667, 1) + '% of floor' });
