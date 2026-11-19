#!/usr/bin/env bash
# The app's own money calls against the real contracts on a local chain: start a throwaway anvil (chain 31337, a free
# port), then run app/tests/anvil/pot-loop.test.ts with vitest in Node. The loop deploys the pot contracts from
# contracts/pot/out (no compile) and drives the faucet, a launch, Back in one signature and in two, Take out with its
# minimum-cash guard, the weekly check-in with a record hash, the door, the allowance, a Team grant, a member's own exit
# and outside money with the app's own call builders, quote readers and wallet, and reads each refusal in the app's own
# words. Replaces scripts/m7-chain-loop.sh (the Rounds-and-auction loop, retired with those screens). Cleans up after
# itself (anvil stopped, its state removed) whatever happens.
#
# Needs: anvil on PATH (or ANVIL=/path/to/anvil), node and pnpm, and contracts/pot/out built (`forge build` there).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANVIL="${ANVIL:-anvil}"
OUT="$ROOT/contracts/pot/out"

fail() { echo "pot-app-chain-loop: $*" >&2; exit 1; }
command -v "$ANVIL" >/dev/null 2>&1 || fail "anvil not found (set ANVIL)"
[[ -f "$OUT/Treasury.sol/Treasury.json" ]] || fail "contracts/pot/out is not built (run forge build in contracts/pot)"

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
# No history is kept and nothing is written outside $STATE (anvil's default writes every block's state under
# ~/.foundry/anvil/tmp and leaves it there when it is stopped).
"$ANVIL" --port "$PORT" --chain-id 31337 --gas-limit 100000000 --prune-history --cache-path "$STATE/anvil-cache" \
  --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  curl -s -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$RPC" >/dev/null 2>&1 && break
  sleep 0.5
done

cd "$ROOT/app"
M7_ANVIL_RPC="$RPC" pnpm exec vitest run --config vitest.anvil.config.ts tests/anvil/pot-loop.test.ts tests/anvil/pot-screens.test.ts "$@"
