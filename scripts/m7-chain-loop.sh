#!/usr/bin/env bash
# Milestone 7's chain loop: start a throwaway anvil (chain 31337, a free port), then run app/tests/anvil with vitest in
# Node. The loop deploys the real contracts from contracts/next/out (no compile) and drives 10,000 alone, a second
# person, 50,000, the auction, the pool and a hand-back with the app's own call builders and wallet. Cleans up after
# itself (anvil stopped, its state removed) whatever happens.
#
# Needs: anvil on PATH (or ANVIL=/path/to/anvil), node and pnpm, and contracts/next/out built.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANVIL="${ANVIL:-anvil}"
OUT="$ROOT/contracts/next/out"

fail() { echo "m7-chain-loop: $*" >&2; exit 1; }
command -v "$ANVIL" >/dev/null 2>&1 || fail "anvil not found (set ANVIL)"
[[ -f "$OUT/Launcher.sol/Launcher.json" ]] || fail "contracts/next/out is not built"

free_port() { node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})'; }

STATE="$(mktemp -d)"
ANVIL_PID=""
cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -rf "$STATE"
}
trap cleanup EXIT

PORT="$(free_port)"
RPC="http://127.0.0.1:$PORT"
# A higher block gas limit only so the Launcher's constructor (it makes the Finisher and the LiquidityHolder) fits one block.
# No history is kept and nothing is written outside $STATE: the scenarios mine tens of thousands of blocks, and anvil's
# default writes every block's state under ~/.foundry/anvil/tmp and leaves it there when it is stopped (gigabytes a run).
"$ANVIL" --port "$PORT" --chain-id 31337 --gas-limit 100000000 --prune-history --cache-path "$STATE/anvil-cache" \
  --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  curl -s -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$RPC" >/dev/null 2>&1 && break
  sleep 0.5
done

cd "$ROOT/app"
M7_ANVIL_RPC="$RPC" pnpm exec vitest run --config vitest.anvil.config.ts "$@"
