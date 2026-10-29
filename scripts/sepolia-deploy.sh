#!/usr/bin/env bash
#
# scripts/sepolia-deploy.sh — put the launch path (our patched summoner and the DaoLaunchKit) on Sepolia.
#
# What Sepolia already has and this does not touch: Uniswap's auction factory, Permit2, Circle's USDC, Limit Break's
# validator and TokenMaster router, and the passkey-account factory. What it deploys: the summoner whose Shares carry the
# milestone lock guard, the kit that launches a DAO and its sale in one transaction, the kit that starts a contributor
# project (no sale) on the same summoner, and the bounties on work areas and on posts, paid in Circle's USDC. LBAMM is not deployed (Limit
# Break's registry lists it as not deployed, and its README rules out live-network use).
#
# Two modes:
#   scripts/sepolia-deploy.sh               REHEARSE (default): fork Sepolia into a local anvil, deploy there with anvil's own
#                                           funded key, check what came out, and leave the repo as it was. Nothing public changes.
#   scripts/sepolia-deploy.sh --broadcast   DEPLOY for real, to the Sepolia named by SEPOLIA_RPC_URL, signing with
#                                           DEPLOYER_PRIVATE_KEY (a key used for nothing else, holding only test ETH).
#                                           Writes contracts/deployments/dao-launch-kit-11155111.json (not ignored): commit it.
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

# shellcheck source=lib/sepolia-fork.sh
. "$REPO_ROOT/scripts/lib/sepolia-fork.sh"
CCA_FACTORY=0x000000001F26a0044BaA66024e7b6599c61963F8
MANIFEST="$SEPOLIA_MANIFEST"
BACKUP="$(mktemp -d)"
ANVIL_PID=""
FORK_URL="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"

cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  # A rehearsal leaves no manifest and no broadcast record behind: they name addresses on a throwaway fork.
  [[ "$MODE" == "rehearse" ]] && sepolia_restore_artifacts "$BACKUP"
  rm -rf "$BACKUP"
}
trap cleanup EXIT
[[ -f "$MANIFEST" ]] && cp -p "$MANIFEST" "$BACKUP/manifest.json"

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
  PORT="${ANVIL_PORT:-$((18000 + RANDOM % 1000))}"
  KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil's public dev key, funded on a fork
  step "rehearsal: forking Sepolia into a local anvil on :${PORT} (nothing public changes)"
  sepolia_fork_up "$FORK_URL" "$PORT" "$BACKUP/anvil.log"
  RPC="$FORK_RPC"
  ANVIL_PID="$FORK_PID"
fi

[[ "$(cast codesize "$CCA_FACTORY" --rpc-url "$RPC")" != "0" ]] || fail "no auction factory at $CCA_FACTORY on this chain"

step "deploying the summoner, the launch kit and the contributor kit"
OUT="$BACKUP/forge.out"
sepolia_deploy_kits "$RPC" "$KEY" "$OUT"
grep -E "^  (chain id|Summoner|Moloch implementation|Shares implementation|DaoLaunchKit|ContributorKit|WorkAreaBounty|OpenBounty|MatchedExit|CreateToken|CreateFaucet|CreateCourt|ForecastPool|PayoutsFactory|RemixBond|WeeklyRounds|Auction factory)" "$OUT" || tail -20 "$OUT"

KIT=$(sepolia_role launch-kit)
SUMMONER=$(sepolia_role summoner)
CONTRIBUTOR_KIT=$(sepolia_role contributor-kit)
WORK_BOUNTY=$(sepolia_role work-bounty)
OPEN_BOUNTY=$(sepolia_role open-bounty)
MATCHED_EXIT=$(sepolia_role matched-exit)
CREATE_TOKEN=$(sepolia_role create-token)
CREATE_FAUCET=$(sepolia_role create-faucet)
COURT=$(sepolia_role court)
POOLS=$(sepolia_role forecast-pool)
PAYOUTS_FACTORY=$(sepolia_role payouts-factory)
REMIX_BONDS=$(sepolia_role remix-bonds)
WEEKLY_ROUNDS=$(sepolia_role weekly-rounds)
SHARES_IMPL=$(sepolia_role shares-implementation)
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
[[ "$(cast codesize "$WORK_BOUNTY" --rpc-url "$RPC")" != "0" ]] || fail "no code at the work bounty $WORK_BOUNTY"
[[ "$(lower "$(cast call "$WORK_BOUNTY" 'factory()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$(cast call "$SUMMONER" 'mandateFactory()(address)' --rpc-url "$RPC" | first)")" ]] || fail "the work bounty does not name the summoner's work budget factory"
[[ "$(lower "$(cast call "$WORK_BOUNTY" 'currency()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$SEPOLIA_USDC")" ]] || fail "the work bounty is not paid in Sepolia's USDC"
echo "  ✓ the work bounty at $WORK_BOUNTY names the same work budget factory and pays in USDC"
[[ "$(cast codesize "$OPEN_BOUNTY" --rpc-url "$RPC")" != "0" ]] || fail "no code at the open bounty $OPEN_BOUNTY"
[[ "$(lower "$(cast call "$OPEN_BOUNTY" 'currency()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$SEPOLIA_USDC")" ]] || fail "the open bounty is not paid in Sepolia's USDC"
echo "  ✓ the open bounty at $OPEN_BOUNTY pays in USDC"
[[ "$(cast codesize "$MATCHED_EXIT" --rpc-url "$RPC")" != "0" ]] || fail "no code at the matched exit $MATCHED_EXIT"
[[ "$(lower "$(cast call "$MATCHED_EXIT" 'currency()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$SEPOLIA_USDC")" ]] || fail "the matched exit is not paid in Sepolia's USDC"
echo "  ✓ the matched exit at $MATCHED_EXIT pays in USDC"
[[ "$(cast codesize "$CREATE_FAUCET" --rpc-url "$RPC")" != "0" ]] || fail "no code at the CREATE faucet $CREATE_FAUCET"
[[ "$(lower "$(cast call "$CREATE_FAUCET" 'token()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$CREATE_TOKEN")" ]] || fail "the faucet does not hand out the test CREATE"
[[ "$(cast call "$CREATE_TOKEN" 'balanceOf(address)(uint256)' "$CREATE_FAUCET" --rpc-url "$RPC" | first)" == "$(cast call "$CREATE_TOKEN" 'totalSupply()(uint256)' --rpc-url "$RPC" | first)" ]] || fail "the faucet does not hold the whole test CREATE supply"
echo "  ✓ test CREATE at $CREATE_TOKEN, all of it in the faucet at $CREATE_FAUCET"
[[ "$(lower "$(cast call "$COURT" 'stakeToken()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$CREATE_TOKEN")" ]] || fail "the court does not stake the test CREATE"
[[ "$(lower "$(cast call "$COURT" 'feeToken()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$SEPOLIA_USDC")" ]] || fail "the court is not paid in Sepolia's USDC"
[[ "$(lower "$(cast call "$OPEN_BOUNTY" 'court()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$COURT")" ]] || fail "bounties on posts do not appeal to this court"
echo "  ✓ the court at $COURT stakes test CREATE and is paid in USDC; bounties on posts appeal to it"
[[ "$(lower "$(cast call "$POOLS" 'bounties()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$OPEN_BOUNTY")" ]] || fail "the money forecast pools do not read these bounties on posts"
echo "  ✓ money forecasts at $POOLS read the bounties on posts"
[[ "$(cast codesize "$PAYOUTS_FACTORY" --rpc-url "$RPC")" != "0" ]] || fail "no code at the payouts factory $PAYOUTS_FACTORY"
[[ "$(lower "$(cast call "$(cast call "$SUMMONER" 'mandateFactory()(address)' --rpc-url "$RPC" | first)" 'payoutsFactory()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$PAYOUTS_FACTORY")" ]] || fail "the payouts factory is not the one the DAOs accept modules from"
echo "  ✓ the payouts factory at $PAYOUTS_FACTORY is the one the work budget factory made, the only one DAOs accept"
FUNDING_TERMS="$(cast call "$(cast call "$SUMMONER" 'mandateFactory()(address)' --rpc-url "$RPC" | first)" 'fundingTerms()(address)' --rpc-url "$RPC" | first)"
[[ "$(cast codesize "$FUNDING_TERMS" --rpc-url "$RPC")" != "0" ]] || fail "the work budget factory names no funding-terms contract"
echo "  ✓ funding terms at $FUNDING_TERMS, made by the work budget factory: the only contract whose sales Shares and Loot create"
[[ "$(lower "$(cast call "$REMIX_BONDS" 'court()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$COURT")" ]] || fail "remix bonds do not go to this court"
echo "  ✓ remix bonds at $REMIX_BONDS go to the court"
[[ "$(lower "$(cast call "$WEEKLY_ROUNDS" 'currency()(address)' --rpc-url "$RPC" | first)")" == "$(lower "$SEPOLIA_USDC")" ]] || fail "weekly rounds are not paid in Sepolia's USDC"
[[ "$(cast call "$WEEKLY_ROUNDS" 'minStep()(uint256)' --rpc-url "$RPC" | first)" == "10000" ]] || fail "weekly rounds' smallest step is not one cent"
echo "  ✓ weekly rounds at $WEEKLY_ROUNDS are paid in USDC, a cent a step at the least"

# What it costs: the gas the deploy used, priced at what Sepolia charges now and at a busy day's 20 gwei. Test ETH has no
# price, but the deployer needs this much of it from a faucet.
read -r GAS TXS LARGEST <<<"$(sepolia_deploy_gas)"
(( LARGEST <= SEPOLIA_TX_GAS_CAP )) || fail "one deploy transaction asks for ${LARGEST} gas, over Sepolia's cap of ${SEPOLIA_TX_GAS_CAP} for one transaction"
echo "  ✓ the largest deploy transaction asks for ${LARGEST} gas, under Sepolia's cap of ${SEPOLIA_TX_GAS_CAP} for one transaction"
eth_for() { cast from-wei "$(node -e 'console.log((BigInt(process.argv[1])*BigInt(process.argv[2])).toString())' "$GAS" "$1")"; }
if [[ "$MODE" == "rehearse" ]]; then
  PRICE_NOW="$(cast gas-price --rpc-url "$FORK_URL" 2>/dev/null || echo 0)"
  echo "  the deploy used ${GAS} gas in ${TXS} transactions: $(eth_for "$PRICE_NOW") ETH at Sepolia's gas price now ($(cast from-wei "$PRICE_NOW" gwei) gwei), $(eth_for 20000000000) ETH at 20 gwei"
  step "rehearsal passed. To deploy for real: put SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY in .env and run with --broadcast"
else
  SPENT=$(node -e 'console.log((BigInt(process.argv[1])-BigInt(process.argv[2])).toString())' "$BALANCE" "$(cast balance "$DEPLOYER" --rpc-url "$RPC")")
  echo "  the deploy used ${GAS} gas in ${TXS} transactions and cost $(cast from-wei "$SPENT") test ETH"
  step "deployed. Commit contracts/deployments/dao-launch-kit-${SEPOLIA_CHAIN_ID}.json, then set up the web app:"
  # The block the deploy ran at is where this chain's history starts for the app: a real node refuses an event read from
  # block 0, so the build is told where to start.
  FROM_BLOCK=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).block)' "$MANIFEST")
  C="$SEPOLIA_CHAIN_ID"
  # The pilot's settings come first and alone, as .env lines: the hosted image takes only these, and each optional
  # feature is a screen the first pilot does not measure. What is the operator's to fill in is a CHANGE_ME, so run.sh
  # refuses to build or start until it is replaced.
  cat <<EOF

# ── The contributor pilot: paste into deploy/compose/.env, replace each CHANGE_ME, then ./run.sh build and ./run.sh restart
VITE_LAUNCHPAD_CHAIN_ID=${C}
VITE_CHAIN_RPC_URL=CHANGE_ME_a_read_only_Sepolia_node_for_the_page_that_allows_wide_log_ranges
VITE_CONTRIBUTOR_KITS={"${C}":"${CONTRIBUTOR_KIT}"}
VITE_HISTORY_FROM_BLOCKS={"${C}":${FROM_BLOCK}}
VITE_ZERODEV_PROJECT_ID=CHANGE_ME_your_ZeroDev_project_id
VITE_ZERODEV_CHAIN_ID=${C}
VITE_BUNDLER_URL=CHANGE_ME_its_bundler_URL
# The server checks passkey accounts against this chain; without these it refuses to link one to a person.
BUZZ_EVM_AUTH=1
BUZZ_EVM_CHAIN_ID=${C}
BUZZ_EVM_RPC_URL=CHANGE_ME_a_Sepolia_node_for_the_server
# Error reports (docs/error-reporting.md); the release defaults to the source revision.
# VITE_ERROR_REPORT_URL=https://<your collector>
# VITE_APP_RELEASE=<the build's version>

# ── Not for the first pilot, and not in the hosted image: test raises and the optional features, for a build of your
# own (pnpm build in web/; docs/sepolia-testnet.md, section 3)
VITE_DAO_LAUNCH_KITS='{"${C}":"${KIT}"}'
VITE_WORK_BOUNTIES='{"${C}":"${WORK_BOUNTY}"}'
VITE_OPEN_BOUNTIES='{"${C}":"${OPEN_BOUNTY}"}'
VITE_MATCHED_EXITS='{"${C}":"${MATCHED_EXIT}"}'
VITE_WEEKLY_ROUNDS='{"${C}":"${WEEKLY_ROUNDS}"}'
VITE_CREATE_TOKENS='{"${C}":"${CREATE_TOKEN}"}'
VITE_CREATE_FAUCETS='{"${C}":"${CREATE_FAUCET}"}'
VITE_COURTS='{"${C}":"${COURT}"}'
VITE_FORECAST_POOLS='{"${C}":"${POOLS}"}'
VITE_PAYOUTS_FACTORIES='{"${C}":"${PAYOUTS_FACTORY}"}'
VITE_REMIX_BONDS='{"${C}":"${REMIX_BONDS}"}'

EOF
  echo "  (docs/sepolia-testnet.md has the rest: the server, the page's node, passkey accounts, what testers need)"
fi
