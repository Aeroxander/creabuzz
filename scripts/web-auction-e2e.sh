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
#   4. puts Permit2 at its canonical address, deploys a 6-decimal sale currency
#      ("Dev USDC") and an 18-decimal sale token, and mints the whole 200M sale
#      supply to Anvil account 0
#   5. builds the web app and runs the spec with a wallet that forwards to Anvil
#
# The spec drives the UI through all seven deploy steps (executor, auction via
# the factory, fund, open bidding, bind the executor, save the record) and checks
# the chain afterwards: real code at the auction, the whole supply (minus the
# router's 1 wei) held by it. It also runs the full journey for an ETH sale and a
# USDC sale: deploy, a bidder bids in the bid dialog, blocks are mined past the
# end, the treasury executes graduation, and the chain is checked (raise met,
# 40% reserve escrowed, the rest paid to the treasury, receipts published).
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
#         E2E_SPEC (another spec to run against the same chain),
#         E2E_CONFIG (another Playwright config, e.g. the real-relay one)

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
# Permit2 at its canonical address, so ERC-20 (USDC) bids can pull the bidder's
# funds. Deployed normally, then its runtime code (constructor-resolved values
# included) is copied to the canonical address; only the allowance paths the
# auction uses are exercised, where the EIP-712 domain does not matter.
PERMIT2="0x000000000022D473030F116dDEE9F6B43aC78BA3"
step "placing Permit2 at ${PERMIT2}"
PERMIT2_BC="$(json_field contracts/out/Permit2.sol/Permit2.json bytecode.object)"
P2_RECEIPT="$(cast send --json --rpc-url "$RPC" --private-key "$KEY" --create "$PERMIT2_BC")"
P2_TMP="$(echo "$P2_RECEIPT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).contractAddress))')"
cast rpc --rpc-url "$RPC" anvil_setCode "$PERMIT2" "$(cast code "$P2_TMP" --rpc-url "$RPC")" >/dev/null
[[ "$(cast code "$PERMIT2" --rpc-url "$RPC")" != "0x" ]] || { echo "Permit2 code was not set"; exit 2; }

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
  # A local chain has no fixed USDC: tell the app which token the dev USDC is.
  # The dev chain is also the create dialog's default chain (production defaults
  # to Sepolia).
  VITE_LOCAL_USDC="$CURRENCY" VITE_LAUNCHPAD_CHAIN_ID=31337 node_modules/.bin/vite build >/dev/null 2>&1 || { echo "web build failed"; exit 2; }
fi
step "running the browser spec"
# E2E_CONFIG: run against another Playwright config instead of the mocked-relay
# `smoke` project, e.g. playwright.real-relay.config.ts for the journey spec
# (a real relay serving web/dist must already be up; see tests/e2e-real/README.md).
if [[ -n "${E2E_CONFIG:-}" ]]; then
  PROJECT_ARGS=(--config="$E2E_CONFIG")
else
  PROJECT_ARGS=(--project=smoke)
fi
E2E_ANVIL_URL="$RPC" E2E_SALE_TOKEN="$SALE_TOKEN" E2E_CURRENCY="$CURRENCY" \
  node_modules/.bin/playwright test "${E2E_SPEC:-tests/e2e/launchpad-auction.spec.ts}" "${PROJECT_ARGS[@]}" --reporter=list "$@"
