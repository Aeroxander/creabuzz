// Copy "never below a unit's share of the treasury plus 2%" vs WeeklyRounds: step = max(1% of floor, minStep), tranche >= 2 steps.
// minStep = 10000 (USDC 6 decimals) pinned by scripts/sepolia-deploy.sh:149. STEP_BPS = 100, DAO_MIN_STEPS = 2 (WeeklyRounds.sol:94-95).
const minStep = 0.01;
for (const floor of [0.0021, 0.05, 0.5, 1, 2]) {
  const step = Math.max(floor * 0.01, minStep);
  const least = floor + 2 * step, said = floor * 1.02;
  console.log(`floor $${floor}: copy says >= $${said.toFixed(5)}, contract least $${least.toFixed(5)} (${(least / floor).toFixed(2)}x floor); a buyer leaving at once gets back ${(100 * floor / least).toFixed(1)}% before fee`);
}
// Loot buyer in the §8c tranche (brief): 570,000 Loot at $0.0521, raised $29,700; the app's exit burns only Shares (RagequitPanel.tsx:691)
const loot = 570_000, price = 0.0521;
console.log(`\nLoot buyers in the brief's tranche paid $${(loot * price).toFixed(0)}; the app offers them no exit (lootToBurn always 0); Before you buy says they can leave at any time`);
