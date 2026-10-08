#!/usr/bin/env bash
#
# scripts/market-index-e2e.sh — the price indexer reading a REAL local chain's AMM trades into candles.
#
# Builds the `cli-market-e2e.sh` world (a project's Shares on LBAMM), makes some trades, starts the Ponder indexer
# (`services/price-indexer`) against the chain, and checks what its HTTP API says: the pool for the Shares, candles at
# the traded price, and a trade made AFTER the indexer started showing up live.
#
# ⚠️  DEV ONLY. A local chain; LBAMM is evaluation-only (see docs/v3-review/LBAMM.md).
#
# Usage:  LBAMM_DIR=/path/to/lbamm-examples scripts/market-index-e2e.sh
# Env:    LBAMM_DIR (required), ANVIL_PORT, BUZZ_BIN, INDEXER_PORT

WORLD_NAME=market-index
# shellcheck source=lib/market-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/market-world.sh"

trap 'stop_indexer; cleanup' EXIT

world_up
lbamm_up
world_launch_with_lock
world_market_seed

step "a buyer buys, and sells some back, before the indexer starts"
trade $KEY_REVIEWER1 "$CURRENCY" "$SHARES" 1000 6 1 >/dev/null || fail "the buy failed"
trade $KEY_REVIEWER1 "$SHARES" "$CURRENCY" 10000 18 1 >/dev/null || fail "the sale failed"

start_indexer

api() { curl -sf "http://127.0.0.1:${INDEXER_PORT}$1"; }
js() { node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));$1"; }

step "the indexer knows the pool that trades the Shares"
pools=$(api "/pools?token=$SHARES")
[[ "$(echo "$pools" | js 'console.log(o.pools.length)')" == "1" ]] || fail "expected one pool for the Shares: $pools"
[[ "$(echo "$pools" | js 'console.log(o.pools[0].id)')" == "$POOL_ID" ]] || fail "the pool is not the one the DAO made: $pools"
[[ "$(echo "$pools" | js 'console.log(o.pools[0].swaps)')" == "2" ]] || fail "both trades should be counted: $pools"

step "the minute candles hold both trades at about \$0.01 a Share"
candles=$(api "/candles?pool=$POOL_ID&interval=60")
echo "$candles" | js '
  const total = o.candles.reduce((n, c) => n + c.trades, 0);
  if (total !== 2) { console.error("trades", total, JSON.stringify(o)); process.exit(1); }
  // Price is token1 per token0 in base units; the Shares have 18 decimals and the USDC 6, and which sorts first decides
  // the direction. Either way a dollar-a-hundred Shares is 1e-14 (USDC per Share) or 1e14 (Shares per USDC).
  for (const c of o.candles) {
    const near = (p) => Math.abs(p / 1e-14 - 1) < 0.1 || Math.abs(p / 1e14 - 1) < 0.1;
    if (![c.open, c.high, c.low, c.close].every(near)) { console.error("price off", JSON.stringify(c)); process.exit(1); }
    if (c.high < c.low) process.exit(1);
  }
' || fail "the candles are not what the trades were"

step "a trade made after the indexer started shows up too"
trade $KEY_REVIEWER1 "$CURRENCY" "$SHARES" 500 6 1 >/dev/null || fail "the second buy failed"
seen=0
for _ in $(seq 1 30); do
  if [[ "$(api "/pools?token=$SHARES" | js 'console.log(o.pools[0].swaps)')" == "3" ]]; then seen=1; break; fi
  sleep 1
done
[[ "$seen" == 1 ]] || { tail -20 "$STATE/indexer.out"; fail "the new trade never appeared"; }

step "an unknown token has no pool, and a bad request is refused"
[[ "$(api "/pools?token=0x000000000000000000000000000000000000dEaD" | js 'console.log(o.pools.length)')" == "0" ]] || fail "a token nobody trades should have no pools"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${INDEXER_PORT}/candles?pool=nope&interval=60")
[[ "$code" == "400" ]] || fail "a bad pool id should be refused with 400 (got $code)"

step "PASS: the indexer turned the AMM's trades into candles, live"
