#!/usr/bin/env bash
#
# scripts/cli-market-e2e.sh — a project's Shares on the Limit Break AMM, against a REAL local chain, with the CLI alone.
#
# A project is launched into its own DAO through the kit. The DAO then votes to put some of its Shares on the AMM: it
# names the AMM's standard hook as the Shares' hook, creates a one-sided pool and seeds it. A buyer trades in, a founder
# whose Shares are locked cannot trade them out, a holder with free Shares can sell back, and the fee the hook charged on
# every trade lands in the treasury by another DAO vote.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain. LBAMM is evaluation-only software: it must be a clone kept
# OUTSIDE this repository, and it must never be deployed to a live network (see docs/v3-review/LBAMM.md).
#
# Usage:  LBAMM_DIR=/path/to/lbamm-examples scripts/cli-market-e2e.sh
# Env:    LBAMM_DIR (required), ANVIL_PORT, BUZZ_BIN (default: build target/debug/buzz)

WORLD_NAME=cli-market
# shellcheck source=lib/market-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/market-world.sh"
world_up
lbamm_up
world_launch_with_lock

# ── 1. the DAO votes a market for its Shares ────────────────────────────────────
world_market_seed

# ── 2. trading ──────────────────────────────────────────────────────────────────
step "a buyer swaps 1,000 USDC for Shares"
trade $KEY_REVIEWER1 "$CURRENCY" "$SHARES" 1000 6 1 >/dev/null || fail "the buy failed"
bought=$(shares_of "$REVIEWER1")
node -e 'const b=BigInt(process.argv[1]);const w=10n**18n;if(!(b>90000n*w&&b<100000n*w)){console.error("bought",b.toString());process.exit(1)}' "$bought" \
  || fail "1,000 USDC at about \$0.01 a Share should buy 90,000 to 100,000 Shares"

step "a founder cannot sell Shares the milestone lock still holds"
before=$(shares_of "$FOUNDER")
if trade $KEY_FOUNDER "$SHARES" "$CURRENCY" 1000 18 0 >/dev/null 2>&1; then
  fail "a founder sold locked Shares into the pool"
fi
[[ "$(shares_of "$FOUNDER")" == "$before" ]] || fail "the founder's Shares moved"

step "a holder with free Shares can sell back"
usdc_before=$(usdc_of "$REVIEWER1")
trade $KEY_REVIEWER1 "$SHARES" "$CURRENCY" 10000 18 1 >/dev/null || fail "the sale failed"
[[ "$(usdc_of "$REVIEWER1")" -gt "$usdc_before" ]] || fail "the seller received no USDC"

# ── 3. the fee the hook charged goes to the treasury, by vote ───────────────────
step "the hook's fee on those trades is collected into the treasury by another vote"
owed=$(cast call "$LBAMM" "getHookFeesOwedByToken(address,address)(uint256)" "$SHARES" "$CURRENCY" --rpc-url "$RPC" | awk '{print $1}')
[[ "$owed" -gt 0 ]] || fail "the hook charged no fee"
treasury_before=$(usdc_of "$DAO")
intent=$(as $KEY_FOUNDER market collect-fees --dao "$DAO" --amm "$LBAMM" --currency "$CURRENCY")
decide "$intent" 175000
treasury_after=$(usdc_of "$DAO")
[[ "$((treasury_after - treasury_before))" == "$owed" ]] || fail "the treasury should have gained exactly the $owed owed (gained $((treasury_after - treasury_before)))"

step "PASS: the DAO's Shares trade on the AMM, the lock still binds, and the fee reaches the treasury"
