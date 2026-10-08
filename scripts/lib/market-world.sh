#!/usr/bin/env bash
#
# scripts/lib/market-world.sh — the `cli-market-e2e.sh` world, in steps other scripts can reuse: a dev chain with LBAMM on
# it, a project launched into its own DAO through the kit, and the DAO's vote that puts 100,000,000 of its Shares on the
# AMM at $0.01 a Share. Sourced on top of nothing else: it pulls in the worlds it builds on.
#
# ⚠️  DEV ONLY. See lbamm-world.sh: LBAMM is evaluation-only and must be a clone kept outside this repository.

# shellcheck source=lbamm-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lbamm-world.sh"
# shellcheck source=milestone-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/milestone-world.sh"

MARKET_SEED=100000000000000000000000000   # 100,000,000 Shares

lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
usdc_of() { cast call "$CURRENCY" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC" | awk '{print $1}'; }

# The DAO votes the market in and the chain is checked to show it. Sets POOL_ID.
world_market_seed() {
  step "the DAO votes to put 100,000,000 Shares on the AMM at \$0.01 a Share"
  local intent dao_before
  intent=$(as $KEY_FOUNDER market seed --dao "$DAO" --amm "$LBAMM" --hook "$LBAMM_HOOK" --registry "$LBAMM_REGISTRY" \
    --pool-type "$LBAMM_DYNAMIC" --currency "$CURRENCY" --currency-decimals 6 --shares 100000000 --price 0.01)
  [[ "$(echo "$intent" | jget lane)" == "unrestricted" ]] || fail "a market changes the treasury, so it should take the full vote"
  POOL_ID=$(echo "$intent" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).market.poolId)')
  [[ "$POOL_ID" =~ ^0x[0-9a-f]{64}$ ]] || fail "no pool id in the composed vote: $intent"
  dao_before=$(shares_of "$DAO")
  decide "$intent" 175000

  step "the chain shows the market the vote made"
  local hook_now
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
  ' "$MARKET_SEED" "$(shares_of "$LBAMM")" "$dao_before" "$(shares_of "$DAO")" \
    || fail "the AMM should hold the seeded Shares (holds $(shares_of "$LBAMM")), all of them from the DAO"
}

# `trade <key> <token-in> <token-out> <whole amount> <decimals-in> <min-out base units>`
trade() {
  as "$1" market swap --amm "$LBAMM" --pool-id "$POOL_ID" --token-in "$2" --token-out "$3" --amount "$4" --decimals "$5" --min-out "$6"
}

# Start the price indexer (services/price-indexer) on the chain, wait until it answers, and set INDEXER_PORT and
# INDEXER_PID. `stop_indexer` ends it; scripts that start one should trap EXIT to run it before `cleanup`.
INDEXER_PID=""
stop_indexer() { [[ -n "$INDEXER_PID" ]] && kill "$INDEXER_PID" >/dev/null 2>&1 || true; }
start_indexer() {
  [[ -d "$REPO_ROOT/services/price-indexer/node_modules/ponder" ]] \
    || fail "install the indexer first: (cd services/price-indexer && pnpm install --ignore-workspace)"
  INDEXER_PORT="${INDEXER_PORT:-$((21000 + RANDOM % 1000))}"
  step "starting the indexer on port ${INDEXER_PORT}"
  ( cd "$REPO_ROOT/services/price-indexer" \
    && LBAMM_ADDRESS="$LBAMM" PONDER_RPC_URL="$RPC" PONDER_CHAIN_ID=31337 PONDER_START_BLOCK=0 \
       exec pnpm exec ponder dev --port "$INDEXER_PORT" --disable-ui ) >"$STATE/indexer.out" 2>&1 &
  INDEXER_PID=$!
  local ready=0
  for _ in $(seq 1 120); do
    if curl -sf "http://127.0.0.1:${INDEXER_PORT}/ready" >/dev/null 2>&1; then ready=1; break; fi
    kill -0 "$INDEXER_PID" 2>/dev/null || { tail -30 "$STATE/indexer.out"; fail "the indexer exited"; }
    sleep 1
  done
  [[ "$ready" == 1 ]] || { tail -30 "$STATE/indexer.out"; fail "the indexer did not become ready"; }
}
