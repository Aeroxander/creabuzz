#!/usr/bin/env bash
#
# scripts/web-vault-e2e.sh — the entry-voice flow against a REAL local chain.
#
# Builds the world, then runs web/tests/simulate/story-anvil.spec.ts:
#   1. forge-builds the contracts
#   2. boots its own Anvil on a throwaway port (killed on exit)
#   3. deploys the raise currency, the project token, and a fixed join price
#      with a floor (the mocks from contracts/test/ProposalVault.t.sol, whose
#      forge artifacts are already compiled)
#   4. deploys ProposalVault with those, grants it the token's mint right, and
#      opens one funding proposal as governance
#   5. mints currency to the backer and runs the spec with a wallet that
#      forwards to Anvil
#
# What is real: the chain, the vault, every transaction and its receipt, the
# escrow, the tax, the refund. What is stubbed: the wallet (Anvil's unlocked
# accounts) and the relay (the launch record that names the vault).
#
# ⚠️  DEV ONLY. Anvil dev keys (public), a local chain, nothing else.
#
# Usage:  scripts/web-vault-e2e.sh [playwright args]
# Env:    ANVIL_PORT (default random high port), SKIP_BUILD=1 (reuse web/dist),
#         E2E_SPEC (another spec to run against the same chain)

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
# Anvil's public dev keys. Account 0 governs; account 1 is the backer.
GOV_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
GOVERNANCE="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
BACKER="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
# Anvil dev key 1 — the backer, distinct from governance.
BACKER_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
# Anvil dev key 2 — an outsider with no rights over the vault.
TROUBLEMAKER="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"

# The one proposal the story backs.
PROPOSAL="$(cast keccak 'entry-voice')"
CHECK="$(cast keccak 'the milestone check, written up front')"
MIN_AMOUNT=100
MAX_AMOUNT=10000
MATURATION=1000
TAX_BPS=500
PRICE=2
FLOOR=1
BACKER_FUNDS=100000

ANVIL_PID=""
cleanup() { [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

step() { printf '\033[36m[vault-e2e]\033[0m %s\n' "$*"; }

json_field() {
  node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(process.argv[2].split(".").reduce((o,k)=>o[k],a))' "$1" "$2"
}

# ── 1. contracts ────────────────────────────────────────────────────────────
step "building contracts"
export FOUNDRY_LINT_LINT_ON_BUILD=false
(cd contracts && forge build >/dev/null) || { echo "forge build failed"; exit 2; }

VAULT_JSON="contracts/out/ProposalVault.sol/ProposalVault.json"
CURRENCY_JSON="contracts/out/ProposalVault.t.sol/MockCurrency.json"
TOKEN_JSON="contracts/out/ProposalVault.t.sol/MockToken.json"
PRICE_JSON="contracts/out/ProposalVault.t.sol/MockJoinPrice.json"
for f in "$VAULT_JSON" "$CURRENCY_JSON" "$TOKEN_JSON" "$PRICE_JSON"; do
  [[ -f "$f" ]] || { echo "missing artifact: $f"; exit 2; }
done

# ── 2. chain ────────────────────────────────────────────────────────────────
step "booting anvil on ${RPC}"
anvil --port "$PORT" --chain-id 31337 --silent >/dev/null 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 40); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || { echo "anvil did not start"; exit 2; }

deploy() { # <artifact> [constructor args...] -> address
  local json="$1"; shift
  local bytecode args receipt
  bytecode="$(json_field "$json" bytecode.object)"
  args=""
  if [[ $# -gt 0 ]]; then
    args="$(cast abi-encode "f($1)" "${@:2}")"
  fi
  receipt="$(cast send --json --rpc-url "$RPC" --private-key "$GOV_KEY" --create "0x${bytecode#0x}${args#0x}")"
  echo "$receipt" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).contractAddress))'
}

step "deploying the currency, the token, and the join price"
CURRENCY="$(deploy "$CURRENCY_JSON")"
TOKEN="$(deploy "$TOKEN_JSON")"
PRICING="$(deploy "$PRICE_JSON")"
step "currency ${CURRENCY}  token ${TOKEN}  pricing ${PRICING}"

step "deploying the ProposalVault"
VAULT="$(deploy "$VAULT_JSON" \
  "address,address,address,address,address,uint64,uint16" \
  "$CURRENCY" "$TOKEN" "$GOVERNANCE" "$GOVERNANCE" "$PRICING" "$MATURATION" "$TAX_BPS")"
[[ "$(cast code "$VAULT" --rpc-url "$RPC")" != "0x" ]] || { echo "vault code was not deployed"; exit 2; }
step "vault ${VAULT}"

step "wiring mint rights, the price, and the funding proposal"
cast send "$TOKEN" "setMinter(address)" "$VAULT" --rpc-url "$RPC" --private-key "$GOV_KEY" >/dev/null
cast send "$PRICING" "set(uint256,uint256)" "$PRICE" "$FLOOR" --rpc-url "$RPC" --private-key "$GOV_KEY" >/dev/null
cast send "$VAULT" "openProposal(bytes32,uint256,uint256,uint64,bytes32)" \
  "$PROPOSAL" "$MIN_AMOUNT" "$MAX_AMOUNT" "$(($(cast block-number --rpc-url "$RPC") + 100000))" "$CHECK" \
  --rpc-url "$RPC" --private-key "$GOV_KEY" >/dev/null

step "funding the backer with ${BACKER_FUNDS} units of currency"
cast send "$CURRENCY" "mint(address,uint256)" "$BACKER" "$BACKER_FUNDS" \
  --rpc-url "$RPC" --private-key "$GOV_KEY" >/dev/null
[[ "$(cast call "$CURRENCY" "balanceOf(address)(uint256)" "$BACKER" --rpc-url "$RPC" | awk '{print $1}')" == "$BACKER_FUNDS" ]] \
  || { echo "the backer was not funded"; exit 2; }

# `pledge` pulls the currency, so the vault needs the backer's allowance first
# — without it the transfer reverts and the vouchers never appear.
step "letting the vault pull the backer's currency"
cast send "$CURRENCY" "approve(address,uint256)" "$VAULT" "$BACKER_FUNDS" \
  --rpc-url "$RPC" --private-key "$BACKER_KEY" >/dev/null
[[ "$(cast call "$CURRENCY" "allowance(address,address)(uint256)" "$BACKER" "$VAULT" --rpc-url "$RPC" | awk '{print $1}')" == "$BACKER_FUNDS" ]] \
  || { echo "the vault was not approved"; exit 2; }

# ── 3. web ──────────────────────────────────────────────────────────────────
cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  VITE_LAUNCHPAD_CHAIN_ID=31337 node_modules/.bin/vite build >/dev/null 2>&1 || { echo "web build failed"; exit 2; }
fi

step "running the browser spec"
E2E_ANVIL_URL="$RPC" \
E2E_VAULT="$VAULT" \
E2E_CURRENCY="$CURRENCY" \
E2E_TOKEN="$TOKEN" \
E2E_TREASURY="$GOVERNANCE" \
E2E_TROUBLEMAKER="$TROUBLEMAKER" \
E2E_PROPOSAL="$PROPOSAL" \
E2E_BACKER="$BACKER" \
E2E_BACKER_FUNDS="$BACKER_FUNDS" \
E2E_MATURATION="$MATURATION" \
E2E_TAX_BPS="$TAX_BPS" \
E2E_PRICE="$PRICE" \
E2E_MIN_AMOUNT="$MIN_AMOUNT" \
E2E_MAX_AMOUNT="$MAX_AMOUNT" \
  node_modules/.bin/playwright test "${E2E_SPEC:-tests/simulate/story-anvil.spec.ts}" \
  --config=playwright.simulate.config.ts --reporter=list "$@"
