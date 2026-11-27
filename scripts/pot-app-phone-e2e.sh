#!/usr/bin/env bash
# The phone path on the pot contracts in a real browser. Starts a throwaway anvil, builds the app with the phone settings and
# the network of that anvil (to app/node_modules/.pot-phone-dist, never the normal build), and runs
# app/tests/e2e/pot-phone.spec.ts with Playwright: a browser with no wallet signs up with a passkey (Chrome's virtual
# authenticator), gets play dollars, Backs a project and Takes out from its passkey account on the real contracts, through a
# stand-in bundler and sponsor at two addresses (the bundler refuses a request for the fee, so the run only passes when the page
# asks the sponsor's own address). Prints the presses and passkey prompts of each step. It also runs
# app/tests/e2e/phone-choice.spec.ts, the You page's choice between the wallet and the passkey account by keyboard and by touch,
# which needs the same phone build.
#
# Needs: anvil and cast on PATH (or ANVIL=/path/to/anvil, CAST=/path/to/cast), node and pnpm, contracts/pot/out built,
# Playwright's Chromium.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANVIL="${ANVIL:-anvil}"
CAST="${CAST:-cast}"
fail() { echo "pot-app-phone-e2e: $*" >&2; exit 1; }
command -v "$ANVIL" >/dev/null 2>&1 || fail "anvil not found (set ANVIL)"
command -v "$CAST" >/dev/null 2>&1 || fail "cast not found (set CAST)"
[[ -f "$ROOT/contracts/pot/out/Launcher.sol/Launcher.json" ]] || fail "contracts/pot/out is not built"

free_port() { node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})'; }

STATE="$(mktemp -d)"
ANVIL_PID=""
cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -rf "$STATE" "$ROOT/app/node_modules/.pot-phone-dist"
}
trap cleanup EXIT

PORT="$(free_port)"; BUNDLER_PORT="$(free_port)"; SPONSOR_PORT="$(free_port)"; PREVIEW_PORT="$(free_port)"
RPC="http://127.0.0.1:$PORT"
"$ANVIL" --port "$PORT" --chain-id 31337 --gas-limit 100000000 --prune-history --cache-path "$STATE/anvil-cache" \
  --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  curl -s -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$RPC" >/dev/null 2>&1 && break
  sleep 0.5
done

# The spec deploys the pot contracts first from anvil's first account (the public development account), so on a fresh chain
# the dollar is its first contract and the Launcher its third: the addresses are the same every time.
ADMIN="$("$CAST" rpc --rpc-url "$RPC" eth_accounts | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0]))')"
DOLLAR="$("$CAST" compute-address "$ADMIN" --nonce 0 | awk '{print $NF}')"
LAUNCHER="$("$CAST" compute-address "$ADMIN" --nonce 2 | awk '{print $NF}')"
printf '{"chainId":31337,"launcher":"%s","quote":"%s"}\n' "$LAUNCHER" "$DOLLAR" >"$STATE/deployments.json"

cd "$ROOT/app"
# Settings by name only; the values are this run's own local addresses.
CREATON_DEPLOYMENTS_FILE="$STATE/deployments.json" VITE_CREATON_PASSKEY_ACCOUNT=1 VITE_CREATON_RPC_URL="$RPC" \
  VITE_CREATON_BUNDLER_URL="http://127.0.0.1:$BUNDLER_PORT" \
  VITE_CREATON_SPONSOR_URL="http://127.0.0.1:$SPONSOR_PORT" \
  pnpm exec vite build --outDir node_modules/.pot-phone-dist --emptyOutDir >/dev/null
M7_ANVIL_RPC="$RPC" PHONE_E2E_BUNDLER_PORT="$BUNDLER_PORT" PHONE_E2E_SPONSOR_PORT="$SPONSOR_PORT" E2E_PORT="$PREVIEW_PORT" \
  pnpm exec playwright test --config playwright.pot-phone.config.ts --trace off "$@"
