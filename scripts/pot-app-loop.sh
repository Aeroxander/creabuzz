#!/usr/bin/env bash
# The app's own money calls against the real contracts on a local chain: start a throwaway anvil (chain 31337, a free
# port), then run the app's chain harness (app/tests/anvil) with vitest in Node. The harness deploys the pot contracts from
# contracts/pot/out (no compile) and drives them only through the app's own call builders, quote readers and senders:
#   pot-loop.test.ts      faucet, launch, Back in one signature and in two, the quote equals what landed, a second backer, Take out
#                         with its minimum-cash guard, the weekly check-in with a record hash, the door, the allowance (a draw,
#                         a raise that must wait), a Team grant claimed after the cliff (the chain's clock is moved), a
#                         member's own exit, outside money, and each refusal read in the app's own words;
#   pot-screens.test.ts   what the money screens read and send, and a Pair's whole round for a draw with both signers;
#   pot-states.test.ts    Take out with the door shut, after the team stopped checking in, with outside money arriving, after a
#                         wind-down by anyone and by the runner; a Pair's call refused for its own proposer;
#   passkey-back.test.ts  a Back from a passkey account: one operation, one passkey prompt, the Shares equal the quote.
# It prints one line with the count of tests passed, failed and skipped. Replaces scripts/m7-chain-loop.sh (the
# Rounds-and-auction loop, retired with those screens). Cleans up after itself (anvil stopped, its state removed).
#
# Needs: anvil on PATH (or ANVIL=/path/to/anvil), node and pnpm, and contracts/pot/out built (`forge build` there).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANVIL="${ANVIL:-anvil}"
OUT="$ROOT/contracts/pot/out"

fail() { echo "pot-app-loop: $*" >&2; exit 1; }
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
REPORT="$STATE/vitest.json"
status=0
M7_ANVIL_RPC="$RPC" pnpm exec vitest run --config vitest.anvil.config.ts \
  tests/anvil/pot-loop.test.ts tests/anvil/pot-screens.test.ts tests/anvil/pot-states.test.ts tests/anvil/passkey-back.test.ts \
  --reporter=default --reporter=json --outputFile.json="$REPORT" "$@" || status=$?
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log(`pot-app-loop: ${r.numPassedTests} tests passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped, in ${r.numTotalTestSuites > 0 ? r.testResults.length : 0} files`);
' "$REPORT" || true
exit "$status"
