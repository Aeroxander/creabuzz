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
# shellcheck source=lib/lbamm-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/lbamm-world.sh"
# shellcheck source=lib/milestone-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/milestone-world.sh"
world_up
lbamm_up
world_launch_with_lock

lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
usdc_of() { cast call "$CURRENCY" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC" | awk '{print $1}'; }
SEED=100000000000000000000000000   # 100,000,000 Shares

# ── 1. the DAO votes a market for its Shares ────────────────────────────────────
step "the DAO votes to put 100,000,000 Shares on the AMM at \$0.01 a Share"
intent=$(as $KEY_FOUNDER market seed --dao "$DAO" --amm "$LBAMM" --hook "$LBAMM_HOOK" --registry "$LBAMM_REGISTRY" \
  --pool-type "$LBAMM_DYNAMIC" --currency "$CURRENCY" --currency-decimals 6 --shares 100000000 --price 0.01)
[[ "$(echo "$intent" | jget lane)" == "unrestricted" ]] || fail "a market changes the treasury, so it should take the full vote"
POOL_ID=$(echo "$intent" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).market.poolId)')
[[ "$POOL_ID" =~ ^0x[0-9a-f]{64}$ ]] || fail "no pool id in the composed vote: $intent"
dao_before=$(shares_of "$DAO")
decide "$intent" 175000

step "the chain shows the market the vote made"
hook_now=$(cast call "$LBAMM" "getTokenSettings(address)((uint16,uint32,address))" "$SHARES" --rpc-url "$RPC")
[[ "$(lower "$hook_now")" == *"$(lower "$LBAMM_HOOK")"* ]] || fail "the Shares' hook is not the standard hook: $hook_now"
[[ "$(cast call "$POLICY" "isExcluded(address)(bool)" "$LBAMM" --rpc-url "$RPC")" == "true" ]] \
  || fail "the AMM's Shares still count toward the voting supply"
# The pool takes the Shares as liquidity, which is rounded down by one part in a billion so a deposit can never exceed
# what the vote approved: so it holds the seeded amount, less at most 0.00001%.
node -e '
  const [seed, held, before, after] = process.argv.slice(1).map(BigInt);
  const ok = held <= seed && seed - held <= seed / 10_000_000n && before - after === held;
  process.exit(ok ? 0 : 1);
' "$SEED" "$(shares_of "$LBAMM")" "$dao_before" "$(shares_of "$DAO")" \
  || fail "the AMM should hold the seeded Shares (holds $(shares_of "$LBAMM")), all of them from the DAO"

# ── 2. trading ──────────────────────────────────────────────────────────────────
step "a buyer swaps 1,000 USDC for Shares"
as $KEY_REVIEWER1 market swap --amm "$LBAMM" --pool-id "$POOL_ID" --token-in "$CURRENCY" --token-out "$SHARES" \
  --amount 1000 --decimals 6 --min-out 1 >/dev/null || fail "the buy failed"
bought=$(shares_of "$REVIEWER1")
node -e 'const b=BigInt(process.argv[1]);const w=10n**18n;if(!(b>90000n*w&&b<100000n*w)){console.error("bought",b.toString());process.exit(1)}' "$bought" \
  || fail "1,000 USDC at about \$0.01 a Share should buy 90,000 to 100,000 Shares"

step "a founder cannot sell Shares the milestone lock still holds"
before=$(shares_of "$FOUNDER")
if as $KEY_FOUNDER market swap --amm "$LBAMM" --pool-id "$POOL_ID" --token-in "$SHARES" --token-out "$CURRENCY" \
    --amount 1000 --decimals 18 --min-out 0 >/dev/null 2>&1; then
  fail "a founder sold locked Shares into the pool"
fi
[[ "$(shares_of "$FOUNDER")" == "$before" ]] || fail "the founder's Shares moved"

step "a holder with free Shares can sell back"
usdc_before=$(usdc_of "$REVIEWER1")
as $KEY_REVIEWER1 market swap --amm "$LBAMM" --pool-id "$POOL_ID" --token-in "$SHARES" --token-out "$CURRENCY" \
  --amount 10000 --decimals 18 --min-out 1 >/dev/null || fail "the sale failed"
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
