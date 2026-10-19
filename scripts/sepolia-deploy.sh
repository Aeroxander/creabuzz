#!/usr/bin/env bash
#
# scripts/sepolia-deploy.sh — put the launch path (our patched summoner and the DaoLaunchKit) on Sepolia.
#
# What Sepolia already has and this does not touch: Uniswap's auction factory, Permit2, Circle's USDC, Limit Break's
# validator and TokenMaster router, and the passkey-account factory. What it deploys: the summoner whose Shares carry the
# milestone lock guard, the kit that launches a DAO and its sale in one transaction, and the kit that starts a contributor
# project (no sale) on the same summoner. LBAMM is not deployed (Limit
# Break's registry lists it as not deployed, and its README rules out live-network use).
#
# Two modes:
#   scripts/sepolia-deploy.sh               REHEARSE (default): fork Sepolia into a local anvil, deploy there with anvil's own
#                                           funded key, check what came out, and leave the repo as it was. Nothing public changes.
#   scripts/sepolia-deploy.sh --broadcast   DEPLOY for real, to the Sepolia named by SEPOLIA_RPC_URL, signing with
#                                           DEPLOYER_PRIVATE_KEY (a key used for nothing else, holding only test ETH).
#                                           Writes contracts/deployments/dao-launch-kit-11155111.json: commit it.
#
# Env (set them in .env, never on the command line, never in the repo):
#   SEPOLIA_RPC_URL          your node (the rehearsal falls back to a public one; a real deploy refuses to)
#   DEPLOYER_PRIVATE_KEY     --broadcast only
#
# Usage:  scripts/sepolia-deploy.sh [--broadcast]

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\033[36m[sepolia]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[sepolia] %s\033[0m\n' "$*" >&2; exit 1; }

MODE="rehearse"
[[ "${1:-}" == "--broadcast" ]] && MODE="broadcast"
[[ $# -le 1 && ( "${1:-}" == "" || "${1:-}" == "--broadcast" ) ]] || fail "usage: scripts/sepolia-deploy.sh [--broadcast]"

if [[ -f .env ]]; then set -a; source .env; set +a; fi
export PATH="$HOME/.foundry/bin:$PATH"
command -v forge >/dev/null && command -v cast >/dev/null && command -v anvil >/dev/null || fail "foundry (forge, cast, anvil) is not on PATH"

SEPOLIA_CHAIN_ID=11155111
CCA_FACTORY=0x000000001F26a0044BaA66024e7b6599c61963F8
DEPLOYMENTS="$REPO_ROOT/contracts/deployments"
MANIFEST="$DEPLOYMENTS/dao-launch-kit-${SEPOLIA_CHAIN_ID}.json"
BROADCASTS="$REPO_ROOT/contracts/broadcast/DeployLaunchKit.s.sol/${SEPOLIA_CHAIN_ID}"
BACKUP="$(mktemp -d)"
ANVIL_PID=""

cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  if [[ "$MODE" == "rehearse" ]]; then
    # A rehearsal leaves no manifest and no broadcast record behind: they name addresses on a throwaway fork.
    rm -f "$MANIFEST"; [[ -f "$BACKUP/manifest.json" ]] && cp -p "$BACKUP/manifest.json" "$MANIFEST"
    rm -rf "$BROADCASTS"
  fi
  rm -rf "$BACKUP"
}
trap cleanup EXIT
[[ -f "$MANIFEST" ]] && cp -p "$MANIFEST" "$BACKUP/manifest.json"

(cd contracts && FOUNDRY_LINT_LINT_ON_BUILD=false forge build >/dev/null) || fail "forge build failed"

if [[ "$MODE" == "broadcast" ]]; then
  [[ -n "${SEPOLIA_RPC_URL:-}" ]] || fail "set SEPOLIA_RPC_URL in .env: a real deploy does not use a public fallback"
  [[ -n "${DEPLOYER_PRIVATE_KEY:-}" ]] || fail "set DEPLOYER_PRIVATE_KEY in .env (a testnet-only key with test ETH)"
  RPC="$SEPOLIA_RPC_URL"
  KEY="$DEPLOYER_PRIVATE_KEY"
  [[ "$(cast chain-id --rpc-url "$RPC")" == "$SEPOLIA_CHAIN_ID" ]] || fail "that node is not Sepolia (chain id $SEPOLIA_CHAIN_ID)"
  DEPLOYER=$(cast wallet address --private-key "$KEY")
  BALANCE=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
  step "deploying to Sepolia from $DEPLOYER (balance $(cast from-wei "$BALANCE") ETH)"
  [[ "$BALANCE" != "0" ]] || fail "the deployer has no test ETH: fund $DEPLOYER from a Sepolia faucet"
else
  FORK_URL="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
  PORT="${ANVIL_PORT:-$((18000 + RANDOM % 1000))}"
  RPC="http://127.0.0.1:${PORT}"
  KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil's public dev key, funded on a fork
  step "rehearsal: forking Sepolia into a local anvil on :${PORT} (nothing public changes)"
  # A few blocks behind the head: a public node answers from several backends, and the newest block is not on all of them yet
  # ("block not found" while the fork is being made).
  HEAD_BLOCK="$(cast block-number --rpc-url "$FORK_URL" 2>/dev/null || true)"
  [[ "$HEAD_BLOCK" =~ ^[0-9]+$ ]] || fail "could not read the head of $FORK_URL"
  anvil --fork-url "$FORK_URL" --fork-block-number "$((HEAD_BLOCK - 10))" --port "$PORT" --silent >"$BACKUP/anvil.log" 2>&1 &
  ANVIL_PID=$!
  for _ in $(seq 1 60); do
    [[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)" == "$SEPOLIA_CHAIN_ID" ]] && break
    kill -0 "$ANVIL_PID" 2>/dev/null || { tail -20 "$BACKUP/anvil.log"; fail "anvil exited"; }
    sleep 1
  done
  [[ "$(cast chain-id --rpc-url "$RPC")" == "$SEPOLIA_CHAIN_ID" ]] || fail "the fork did not come up as Sepolia"
fi

[[ "$(cast codesize "$CCA_FACTORY" --rpc-url "$RPC")" != "0" ]] || fail "no auction factory at $CCA_FACTORY on this chain"

step "deploying the summoner and the launch kit"
OUT="$BACKUP/forge.out"
BROADCAST_FLAG=(--broadcast)
(cd contracts && PRIVATE_KEY="$KEY" forge script script/DeployLaunchKit.s.sol --rpc-url "$RPC" "${BROADCAST_FLAG[@]}" >"$OUT" 2>&1) \
  || { tail -40 "$OUT"; fail "forge script failed"; }
grep -E "^  (chain id|Summoner|Moloch implementation|Shares implementation|DaoLaunchKit|ContributorKit|Auction factory)" "$OUT" || tail -20 "$OUT"

KIT=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(m.roles.find(r=>r.role==="launch-kit").address)' "$MANIFEST")
SUMMONER=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(m.roles.find(r=>r.role==="summoner").address)' "$MANIFEST")
CONTRIBUTOR_KIT=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(m.roles.find(r=>r.role==="contributor-kit").address)' "$MANIFEST")
SHARES_IMPL=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(m.roles.find(r=>r.role==="shares-implementation").address)' "$MANIFEST")
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
first() { awk '{print $1}' | head -1; }

step "checking what the chain now holds"
[[ "$(cast codesize "$KIT" --rpc-url "$RPC")" != "0" ]] || fail "no code at the kit $KIT"
[[ "$(lower "$(cast call "$KIT" 'summoner()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$SUMMONER")" ]] || fail "the kit does not name this summoner"
[[ "$(lower "$(cast call "$KIT" 'factory()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$CCA_FACTORY")" ]] || fail "the kit does not name the auction factory"
[[ "$(lower "$(cast call "$KIT" 'sharesImplementation()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$SHARES_IMPL")" ]] || fail "the kit does not name the Shares implementation"
[[ "$(lower "$(cast call "$KIT" 'mandateFactory()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$(cast call "$SUMMONER" 'mandateFactory()(address)' --rpc-url "$RPC" | first)")" ]] || fail "the kit does not name the summoner's work budget factory"
echo "  ✓ the kit at $KIT names the summoner, the auction factory, the Shares implementation and the work budget factory it was given"
[[ "$(cast codesize "$CONTRIBUTOR_KIT" --rpc-url "$RPC")" != "0" ]] || fail "no code at the contributor kit $CONTRIBUTOR_KIT"
[[ "$(lower "$(cast call "$CONTRIBUTOR_KIT" 'summoner()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$SUMMONER")" ]] || fail "the contributor kit does not name this summoner"
[[ "$(lower "$(cast call "$CONTRIBUTOR_KIT" 'budgetFactory()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$(cast call "$SUMMONER" 'mandateFactory()(address)' --rpc-url "$RPC" | first)")" ]] || fail "the contributor kit does not name the summoner's work budget factory"
echo "  ✓ the contributor kit at $CONTRIBUTOR_KIT names the same summoner and work budget factory"

if [[ "$MODE" == "rehearse" ]]; then
  step "rehearsal passed. To deploy for real: put SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY in .env and run with --broadcast"
else
  step "deployed. Commit contracts/deployments/dao-launch-kit-${SEPOLIA_CHAIN_ID}.json, then build the web app with:"
  # The block the deploy ran at is where this chain's history starts for the app: a real node refuses an event read from
  # block 0, so the build is told where to start.
  FROM_BLOCK=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).block)' "$MANIFEST")
  echo "  VITE_LAUNCHPAD_CHAIN_ID=${SEPOLIA_CHAIN_ID} VITE_DAO_LAUNCH_KITS='{\"${SEPOLIA_CHAIN_ID}\":\"${KIT}\"}' VITE_CONTRIBUTOR_KITS='{\"${SEPOLIA_CHAIN_ID}\":\"${CONTRIBUTOR_KIT}\"}' VITE_HISTORY_FROM_BLOCKS='{\"${SEPOLIA_CHAIN_ID}\":${FROM_BLOCK}}'"
fi
