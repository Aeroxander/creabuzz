#!/usr/bin/env bash
#
# scripts/web-mint-e2e.sh — the founder's whole journey, with the token MINTED
# FROM THE BROWSER, against the apptoken local environment on a real local chain
# and a real relay.
#
# What it builds:
#   1. forge-builds the contracts (the CCA factory and Permit2 come from there)
#   2. boots its own Anvil (chain 1776411, the apptoken-dev environment's chain)
#   3. bootstraps apptoken-dev/local-environment (TokenMaster router, the pool
#      factories, the transfer validator) on it, then allowlists the real pool
#      factories on the router by storage write (the packaged environment
#      allowlists placeholder addresses; see contracts/README.md "Minting").
#      Dev chain only: real chains use the governed admin.
#   4. places the CCA factory and Permit2 at their canonical addresses
#   5. builds the web app and runs web/tests/e2e-real/journey.spec.ts in apptoken
#      mode: idea -> quick sale -> commitments -> MINT the token -> deploy the
#      auction (ETH sale) -> go live -> a backer bids -> the founder admits them.
#
# Needs a real relay serving web/dist with the seeded fixture
# (web/tests/e2e-real/README.md) and foundry (forge, cast, anvil; FOUNDRY_BIN if
# not on PATH). The apptoken-dev submodule must be checked out.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Usage:  scripts/web-mint-e2e.sh [playwright args]
# Env:    ANVIL_PORT, SKIP_BUILD=1, E2E_CONFIG (default
#         playwright.local-chromium.config.ts, which points at this machine's
#         Chromium; use playwright.real-relay.config.ts elsewhere)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
for tool in forge cast anvil node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool (set FOUNDRY_BIN for foundry)"; exit 2; }
done

PORT="${ANVIL_PORT:-$((19000 + RANDOM % 1000))}"
RPC="http://127.0.0.1:${PORT}"
CHAIN_ID=1776411
KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
FACTORY="0x000000001F26a0044BaA66024e7b6599c61963F8"
PERMIT2="0x000000000022D473030F116dDEE9F6B43aC78BA3"
ROUTER="0x0E00009d00d1000069ed00A908e00081F5006008"
POOL_FACTORIES=(
  0x000000c5F2DF717F497BeAcCE161F8b042310d17   # Standard
  0x0000006a50a9c9Efae8875266ff222579fC2F449   # Stable
  0x00000014D04B7d1Cad1960eA8980A9af5De2104e   # Promotional
)
# The deterministic deployment proxy's runtime code (what the apptoken bootstrap
# deploys through).
CREATE2_PROXY="0x4e59b44847b379578588920cA78FbF26c0B4956C"
CREATE2_CODE="0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
ANVIL_PID=""
cleanup() { [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT
step() { printf '\033[36m[mint-e2e]\033[0m %s\n' "$*"; }
json_field() { node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(process.argv[2].split(".").reduce((o,k)=>o[k],a))' "$1" "$2"; }

[[ -f apptoken-dev/local-environment/script/bootstrap.sh ]] \
  || { echo "apptoken-dev is not checked out (git submodule update --init apptoken-dev)"; exit 2; }

step "building contracts"
export FOUNDRY_LINT_LINT_ON_BUILD=false
(cd contracts && forge build >/dev/null) || { echo "forge build failed"; exit 2; }

step "booting anvil (chain ${CHAIN_ID}) on ${RPC}"
anvil --port "$PORT" --chain-id "$CHAIN_ID" --silent >/dev/null 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 40); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || { echo "anvil did not start"; exit 2; }

step "bootstrapping the apptoken environment"
cast rpc --rpc-url "$RPC" anvil_setCode "$CREATE2_PROXY" "$CREATE2_CODE" >/dev/null
RPC_URL="$RPC" bash apptoken-dev/local-environment/script/bootstrap.sh >/dev/null \
  || { echo "apptoken bootstrap failed"; exit 2; }
[[ "$(cast code "$ROUTER" --rpc-url "$RPC")" != "0x" ]] || { echo "the TokenMaster router is missing"; exit 2; }

step "allowlisting the pool factories on the router (dev chain only)"
for f in "${POOL_FACTORIES[@]}"; do
  cast rpc --rpc-url "$RPC" anvil_setStorageAt "$ROUTER" "$(cast index address "$f" 1)" \
    0x0000000000000000000000000000000000000000000000000000000000000001 >/dev/null
  [[ "$(cast call "$ROUTER" "allowedTokenFactory(address)(bool)" "$f" --rpc-url "$RPC")" == "true" ]] \
    || { echo "could not allowlist $f"; exit 2; }
done

step "placing the CCA factory at ${FACTORY}"
cast rpc --rpc-url "$RPC" anvil_setCode "$FACTORY" \
  "$(json_field contracts/out/ContinuousClearingAuctionFactory.sol/ContinuousClearingAuctionFactory.json deployedBytecode.object)" >/dev/null
[[ "$(cast code "$FACTORY" --rpc-url "$RPC")" != "0x" ]] || { echo "factory code was not set"; exit 2; }

step "placing Permit2 at ${PERMIT2}"
P2_RECEIPT="$(cast send --json --rpc-url "$RPC" --private-key "$KEY" --create "$(json_field contracts/out/Permit2.sol/Permit2.json bytecode.object)")"
P2_TMP="$(echo "$P2_RECEIPT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).contractAddress))')"
cast rpc --rpc-url "$RPC" anvil_setCode "$PERMIT2" "$(cast code "$P2_TMP" --rpc-url "$RPC")" >/dev/null

cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  node_modules/.bin/vite build >/dev/null 2>&1 || { echo "web build failed"; exit 2; }
fi
step "running the journey (apptoken mode)"
E2E_ANVIL_URL="$RPC" E2E_APPTOKEN=1 E2E_CHAIN_ID="$CHAIN_ID" \
  node_modules/.bin/playwright test tests/e2e-real/journey.spec.ts \
  --config="${E2E_CONFIG:-playwright.local-chromium.config.ts}" --reporter=list "$@"
