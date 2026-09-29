#!/usr/bin/env bash
#
# scripts/web-auction-e2e.sh — deploy the auction from the WEB app against a
# REAL local chain, in a real browser.
#
# Builds the world, then runs web/tests/e2e/launchpad-auction.spec.ts:
#   1. forge-builds the contracts (the CCA factory + a mintable ERC-20 mock)
#   2. boots its own Anvil on a throwaway port (killed on exit)
#   3. puts the CCA factory's runtime code at its canonical address (the real
#      factory only exists on forks; this is the same code at the same address)
#   4. deploys a 6-decimal sale currency ("Dev USDC") and an 18-decimal sale
#      token, and mints the whole 200M sale supply to Anvil account 0
#   5. builds the web app and runs the spec with a wallet that forwards to Anvil
#
# The spec drives the UI through all seven deploy steps (executor, auction via
# the factory, fund, open bidding, bind the executor, save the record) and checks
# the chain afterwards: real code at the auction address, the whole supply
# (minus the router's 1 wei) held by it. A second test proves a wallet that is
# not the treasury is stopped before any transaction is sent.
#
# ⚠️  DEV ONLY. Anvil dev keys (public), a local chain, nothing else.
#
# Requirements: foundry (forge, cast, anvil) on PATH, `~/.foundry/bin`, or in
# $FOUNDRY_BIN; node + web/node_modules; Chromium. If the pinned Playwright wants
# a newer browser build than the machine has, set PW_CHROMIUM_PATH to a Chromium
# executable (never run `playwright install` for this).
#
# Usage:  scripts/web-auction-e2e.sh [playwright args, e.g. -g "curated" --repeat-each=3]
# Env:    ANVIL_PORT (default random high port), SKIP_BUILD=1 (reuse web/dist),
#         E2E_SPEC (another spec to run against the same chain)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Toolchain: hermit-pinned node when available, foundry from the usual places.
# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
for tool in forge cast anvil node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool (set FOUNDRY_BIN for foundry)"; exit 2; }
done

PORT="${ANVIL_PORT:-$((18000 + RANDOM % 1000))}"
RPC="http://127.0.0.1:${PORT}"
# Anvil's public dev account 0 (the treasury and the deploying wallet).
KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ACCT="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
FACTORY="0x000000001F26a0044BaA66024e7b6599c61963F8"
SALE_SUPPLY_WEI="200000000000000000000000000" # 200,000,000 tokens, 18 decimals
ANVIL_PID=""
cleanup() { [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

step() { printf '\033[36m[auction-e2e]\033[0m %s\n' "$*"; }

# ── 1. contracts ────────────────────────────────────────────────────────────
step "building contracts"
export FOUNDRY_LINT_LINT_ON_BUILD=false
(cd contracts && forge build >/dev/null && forge build lib/tm-tokenmaster/test/mocks/MockPairedTokenERC20.sol >/dev/null) \
  || { echo "forge build failed"; exit 2; }
FACTORY_JSON="contracts/out/ContinuousClearingAuctionFactory.sol/ContinuousClearingAuctionFactory.json"
MOCK_JSON="contracts/out/MockPairedTokenERC20.sol/MockPairedTokenERC20.json"
json_field() { node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(process.argv[2].split(".").reduce((o,k)=>o[k],a))' "$1" "$2"; }

# ── 2. chain ────────────────────────────────────────────────────────────────
step "booting anvil on ${RPC}"
anvil --port "$PORT" --chain-id 31337 --silent >/dev/null 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 40); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || { echo "anvil did not start"; exit 2; }

step "placing the CCA factory at ${FACTORY}"
cast rpc --rpc-url "$RPC" anvil_setCode "$FACTORY" "$(json_field "$FACTORY_JSON" deployedBytecode.object)" >/dev/null
[[ "$(cast code "$FACTORY" --rpc-url "$RPC")" != "0x" ]] || { echo "factory code was not set"; exit 2; }

deploy_mock() { # <name> <symbol> <decimals> -> address
  local bytecode args receipt
  bytecode="$(json_field "$MOCK_JSON" bytecode.object)"
  args="$(cast abi-encode "constructor(string,string,uint8)" "$1" "$2" "$3")"
  receipt="$(cast send --json --rpc-url "$RPC" --private-key "$KEY" --create "0x${bytecode#0x}${args#0x}")"
  echo "$receipt" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).contractAddress))'
}
step "deploying the sale currency and the sale token"
CURRENCY="$(deploy_mock "Dev USDC" dUSDC 6)"
SALE_TOKEN="$(deploy_mock "Nebula Token" NBL 18)"
cast send "$SALE_TOKEN" "mint(address,uint256)" "$ACCT" "$SALE_SUPPLY_WEI" --rpc-url "$RPC" --private-key "$KEY" >/dev/null
[[ "$(cast call "$SALE_TOKEN" "balanceOf(address)(uint256)" "$ACCT" --rpc-url "$RPC" | awk '{print $1}')" == "$SALE_SUPPLY_WEI" ]] \
  || { echo "sale supply was not minted"; exit 2; }
step "currency ${CURRENCY}  sale token ${SALE_TOKEN}"

# ── 3. web ──────────────────────────────────────────────────────────────────
cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  node_modules/.bin/vite build >/dev/null 2>&1 || { echo "web build failed"; exit 2; }
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_SALE_TOKEN="$SALE_TOKEN" E2E_CURRENCY="$CURRENCY" \
  node_modules/.bin/playwright test "${E2E_SPEC:-tests/e2e/launchpad-auction.spec.ts}" --project=smoke --reporter=list "$@"
