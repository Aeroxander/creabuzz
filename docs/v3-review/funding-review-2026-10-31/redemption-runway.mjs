// The brief's example after its tranche: how much of the raise stays if existing Shares leave at once.
// Inputs: 5.7M earned Shares, 570k Loot sold for $29,700, treasury $41,700 (brief-example.mjs).
// One batch of leavers at the 2% exit fee (terms are past their notice, Loot remains, so nobody is "last out").
const shares = 5_700_000, loot = 570_000, treasury = 41_700, raised = 29_700, fee = 0.02, burn = 3_000;
const units = shares + loot;
for (const fee_ of [0, fee]) {
  console.log(`exit fee ${fee_ * 100}%`);
  for (const pct of [0, 0.1, 0.3, 1]) {
    const out = pct * shares * (treasury / units) * (1 - fee_);
    const left = treasury - out;
    console.log(`  ${String(pct * 100).padStart(3)}% of Shares leave: paid out $${out.toFixed(0).padStart(6)}, treasury $${left.toFixed(0).padStart(6)}, ` +
      `${(100 * left / raised).toFixed(0)}% of the raise, ${(left / burn).toFixed(1)} months at $${burn}/month`);
  }
}
