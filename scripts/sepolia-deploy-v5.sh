#!/usr/bin/env bash
#
# scripts/sepolia-deploy-v5.sh — put the weekly-sale contracts on Sepolia, beside the 5 Nov deploy (never over it).
#
# What it deploys (contracts/script/DeployV5Sepolia.s.sol): a new work budget factory, the voting policy and summoner on
# it, the secondary market factory, the creation-version kit (ContributorKitV2), a NEW work bounty and the payouts factory
# the new work budget factory made (a DAO accepts bounties and payout modules only from the factory of its own work budget
# factory, so the 5 Nov ones cannot serve new projects), and a free-mint test token to trade in (worth nothing, for testnets
# only). It leaves alone, and the printed settings reuse from the 5 Nov manifest: the court, test CREATE and its faucet, the
# open bounty and the remix bonds. contracts/deployments/dao-launch-kit-11155111.json is history and is never rewritten.
#
# Two modes:
#   scripts/sepolia-deploy-v5.sh              REHEARSE (default): fork Sepolia into a local anvil (same chain id), deploy there
#                                             with anvil's own public dev key, launch one trial project there too, check what
#                                             came out, and leave the repo as it was. Nothing public changes.
#   scripts/sepolia-deploy-v5.sh --broadcast  DEPLOY for real, to the Sepolia named by SEPOLIA_RPC_URL, signing with
#                                             DEPLOYER_PRIVATE_KEY (a key used for nothing else, holding only test ETH).
#                                             Writes contracts/deployments/v5-sepolia-11155111.json (not ignored): commit it. The
#                                             manifest stays only if the deploy passed its on-chain checks; otherwise it is removed.
#                                             (A forge script run by hand writes the file even without --broadcast: delete it.)
#
# Env (set them in .env or the shell, never on a command line, never in a file you commit):
#   SEPOLIA_RPC_URL          your node (the rehearsal falls back to a public one; a real deploy refuses to)
#   DEPLOYER_PRIVATE_KEY     --broadcast only
#   SEPOLIA_FORGE_ARGS       extra arguments for the forge script call. The ones that worked live on Sepolia:
#                              SEPOLIA_FORGE_ARGS='--skip-simulation --slow --with-gas-price 3000000 --priority-gas-price 1000000'
#                            Live Sepolia prices contract creation about 6 times what the fork does for the same contract, so
#                            use them for --broadcast; --slow sends one transaction at a time, which this deploy needs (nothing
#                            else may be sent by the deployer between the market factory and the kit: the kit refuses a
#                            factory that was authorised for another address).
#
# After a real deploy it prints the web settings for the server's .env (the trial build; see docs/sepolia-testnet.md). To start
# one trial project from a wallet afterwards (founder = the wallet, TRIAL_REVIEWER = another person):
#   cd contracts && PRIVATE_KEY=<in the environment> TRIAL_REVIEWER=0x… forge script script/LaunchV5TrialProject.s.sol \
#     --rpc-url $SEPOLIA_RPC_URL --broadcast $SEPOLIA_FORGE_ARGS
# The web Start form is the other way to start a project.
#
# Usage:  scripts/sepolia-deploy-v5.sh [--broadcast]

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\033[36m[sepolia-v5]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[sepolia-v5] %s\033[0m\n' "$*" >&2; exit 1; }

MODE="rehearse"
for arg in "$@"; do
  case "$arg" in
    --broadcast) MODE="broadcast" ;;
    *) fail "usage: scripts/sepolia-deploy-v5.sh [--broadcast]" ;;
  esac
done

if [[ -f .env ]]; then set -a; source .env; set +a; fi
export PATH="$HOME/.foundry/bin:$PATH"
command -v forge >/dev/null && command -v cast >/dev/null && command -v anvil >/dev/null || fail "foundry (forge, cast, anvil) is not on PATH"
command -v node >/dev/null || fail "node is not on PATH"

# shellcheck source=lib/sepolia-fork.sh
. "$REPO_ROOT/scripts/lib/sepolia-fork.sh"
V5_MANIFEST="$REPO_ROOT/contracts/deployments/v5-sepolia-${SEPOLIA_CHAIN_ID}.json"
V5_DEPLOY_BROADCASTS="$REPO_ROOT/contracts/broadcast/DeployV5Sepolia.s.sol"
V5_LAUNCH_BROADCASTS="$REPO_ROOT/contracts/broadcast/LaunchV5TrialProject.s.sol"
BACKUP="$(mktemp -d)"
ANVIL_PID=""
FORGE_STARTED=0   # set just before the real deploy's forge script runs
MANIFEST_OK=0     # set once the chain has been checked against the manifest
FORK_URL="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
# Bounded reads and waits: a stuck node must end the script, not hang it.
export ETH_RPC_TIMEOUT="${ETH_RPC_TIMEOUT:-60}"

cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  if [[ "$MODE" == "rehearse" ]]; then
    # A rehearsal leaves no manifest and no broadcast record behind: they name addresses on a throwaway fork. Whatever was
    # there before (a real deploy's manifest and record) is put back as it was.
    rm -f "$V5_MANIFEST"
    [[ -f "$BACKUP/manifest.json" ]] && cp -p "$BACKUP/manifest.json" "$V5_MANIFEST"
    rm -rf "$V5_DEPLOY_BROADCASTS" "$V5_LAUNCH_BROADCASTS"
    if [[ -d "$BACKUP/deploy-broadcasts" ]]; then mkdir -p "$(dirname "$V5_DEPLOY_BROADCASTS")" && cp -a "$BACKUP/deploy-broadcasts" "$V5_DEPLOY_BROADCASTS"; fi
    if [[ -d "$BACKUP/launch-broadcasts" ]]; then mkdir -p "$(dirname "$V5_LAUNCH_BROADCASTS")" && cp -a "$BACKUP/launch-broadcasts" "$V5_LAUNCH_BROADCASTS"; fi
  fi
  # The script writes the manifest while it simulates, before any transaction is sent. A real deploy that did not get through
  # its on-chain checks must not leave it behind for a rerun to trip over or for a commit to pick up by mistake. The addresses
  # of anything that did go out stay in the forge broadcast record.
  if [[ "$MODE" == "broadcast" && "$FORGE_STARTED" == "1" && "$MANIFEST_OK" != "1" && -f "$V5_MANIFEST" ]]; then
    rm -f "$V5_MANIFEST"
    printf '\033[31m[sepolia-v5] removed %s: the deploy did not finish its checks, so that file is not to be trusted or committed. Anything already sent is listed in %s/%s/run-latest.json\033[0m\n' \
      "$V5_MANIFEST" "$V5_DEPLOY_BROADCASTS" "$SEPOLIA_CHAIN_ID" >&2
  fi
  rm -rf "$BACKUP"
}
trap cleanup EXIT
[[ -f "$V5_MANIFEST" ]] && cp -p "$V5_MANIFEST" "$BACKUP/manifest.json"
[[ -d "$V5_DEPLOY_BROADCASTS" ]] && cp -a "$V5_DEPLOY_BROADCASTS" "$BACKUP/deploy-broadcasts"
[[ -d "$V5_LAUNCH_BROADCASTS" ]] && cp -a "$V5_LAUNCH_BROADCASTS" "$BACKUP/launch-broadcasts"

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
first() { awk '{print $1}' | head -1; }
# An address from a manifest: v5_role <manifest> <role>. Empty when the manifest has no such role.
role_of() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log((m.roles ?? []).find((r) => r.role === process.argv[2])?.address ?? "");
  ' "$1" "$2"
}
v5_role() { role_of "$V5_MANIFEST" "$1"; }
# The old Sepolia manifest (5 Nov): history, read and never written.
old_role() { role_of "$SEPOLIA_MANIFEST" "$1"; }
call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC" | first; }
same() { [[ "$(lower "$1")" == "$(lower "$2")" ]]; }
# The address of the private key held in the shell variable named $1. `cast wallet address` takes a key only as an argument,
# which would put it in ps and process accounting. Node reads the key from its environment, never its arguments, and derives
# the public key; only that public value (not the key) goes to cast, to hash it into the address.
address_of_env_key() {
  local pub
  pub=$(KEY_HEX="${!1:-}" node -e '
    const crypto = require("crypto");
    const hex = (process.env.KEY_HEX ?? "").replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) process.exit(1);
    const ecdh = crypto.createECDH("secp256k1");
    ecdh.setPrivateKey(Buffer.from(hex, "hex"));
    console.log(ecdh.getPublicKey("hex", "uncompressed").slice(2));
  ') || return 1
  cast to-check-sum-address "0x$(cast keccak "0x$pub" | cut -c27-66)"
}
has_code() { [[ "$(cast codesize "$1" --rpc-url "$RPC")" != "0" ]]; }

# "<gas used> <transactions> <largest gas limit> <largest gas used>" from a forge broadcast record.
run_gas() {
  node -e '
    const run = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const receipts = run.receipts ?? [];
    const gas = receipts.reduce((sum, r) => sum + BigInt(r.gasUsed), 0n);
    const max = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0n);
    const largestLimit = max((run.transactions ?? []).map((t) => BigInt(t.transaction.gas ?? 0)));
    const largestUsed = max(receipts.map((r) => BigInt(r.gasUsed)));
    console.log(`${gas} ${receipts.length} ${largestLimit} ${largestUsed}`);
  ' "$1"
}

if [[ "$MODE" == "broadcast" ]]; then
  [[ -n "${SEPOLIA_RPC_URL:-}" ]] || fail "set SEPOLIA_RPC_URL in .env: a real deploy does not use a public fallback"
  [[ -n "${DEPLOYER_PRIVATE_KEY:-}" ]] || fail "set DEPLOYER_PRIVATE_KEY in .env (a testnet-only key with test ETH)"
  RPC="$SEPOLIA_RPC_URL"
  KEY="$DEPLOYER_PRIVATE_KEY"
  [[ "$(cast chain-id --rpc-url "$RPC")" == "$SEPOLIA_CHAIN_ID" ]] || fail "that node is not Sepolia (chain id $SEPOLIA_CHAIN_ID)"
  [[ ! -f "$V5_MANIFEST" ]] || fail "$V5_MANIFEST already exists: this set is already deployed. Move it aside on purpose if you mean to deploy another"
  DEPLOYER=$(address_of_env_key DEPLOYER_PRIVATE_KEY) || fail "DEPLOYER_PRIVATE_KEY is not a 64-digit hex key"
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
  DEPLOYER=$(address_of_env_key KEY) || fail "could not derive the rehearsal deployer's address"
fi

has_code "$SEPOLIA_USDC" || fail "no USDC at $SEPOLIA_USDC on this chain"

step "building"
(cd contracts && FOUNDRY_LINT_LINT_ON_BUILD=false forge build >/dev/null) || fail "forge build failed"

step "deploying the mandate factory, voting policy, summoner, market factory, kit V2, work bounty and test token"
OUT="$BACKUP/deploy.out"
FORGE_STARTED=1
# The key reaches forge through the environment only: never an argument, never a file.
(cd contracts && PRIVATE_KEY="$KEY" forge script script/DeployV5Sepolia.s.sol --rpc-url "$RPC" --broadcast ${SEPOLIA_FORGE_ARGS:-} >"$OUT" 2>&1) \
  || { tail -40 "$OUT"; fail "forge script failed"; }
[[ -f "$V5_MANIFEST" ]] || fail "the deploy wrote no manifest ($V5_MANIFEST)"
grep -E "^  ?(chain id|TreasuryMandateFactory|ActivationVoting|Summoner|SecondaryMarketFactory|ContributorKitV2|WorkAreaBounty|PayoutsFactory|TestQuoteToken)" "$OUT" || tail -20 "$OUT"

MANDATE_FACTORY=$(v5_role mandate-factory)
POLICY_IMPL=$(v5_role activation-voting-implementation)
SUMMONER=$(v5_role summoner)
MARKET_FACTORY=$(v5_role market-factory)
KIT=$(v5_role contributor-kit-v2)
WORK_BOUNTY=$(v5_role work-bounty)
PAYOUTS_FACTORY=$(v5_role payouts-factory)
TEST_TOKEN=$(v5_role test-quote-token)
for pair in "mandate-factory:$MANDATE_FACTORY" "activation-voting-implementation:$POLICY_IMPL" "summoner:$SUMMONER" \
            "market-factory:$MARKET_FACTORY" "contributor-kit-v2:$KIT" "work-bounty:$WORK_BOUNTY" \
            "payouts-factory:$PAYOUTS_FACTORY" "test-quote-token:$TEST_TOKEN"; do
  [[ -n "${pair#*:}" ]] || fail "the manifest has no ${pair%%:*}"
done

step "checking what the chain now holds"
for pair in "mandate factory:$MANDATE_FACTORY" "voting policy:$POLICY_IMPL" "summoner:$SUMMONER" "market factory:$MARKET_FACTORY" \
            "kit:$KIT" "work bounty:$WORK_BOUNTY" "payouts factory:$PAYOUTS_FACTORY" "test token:$TEST_TOKEN"; do
  has_code "${pair#*:}" || fail "no code at the ${pair%%:*} ${pair#*:}"
done
same "$(call "$MARKET_FACTORY" 'authorizedKit()(address)')" "$KIT" || fail "the market factory is authorised for another kit"
same "$(call "$KIT" 'marketFactory()(address)')" "$MARKET_FACTORY" || fail "the kit does not name this market factory"
echo "  ✓ the market factory at $MARKET_FACTORY is authorised for exactly the kit at $KIT, and the kit names it"
same "$(call "$KIT" 'summoner()(address)')" "$SUMMONER" || fail "the kit does not name the new summoner"
same "$(call "$MARKET_FACTORY" 'summoner()(address)')" "$SUMMONER" || fail "the market factory does not name the new summoner"
same "$(call "$SUMMONER" 'mandateFactory()(address)')" "$MANDATE_FACTORY" || fail "the summoner is not on the new work budget factory"
same "$(call "$KIT" 'budgetFactory()(address)')" "$MANDATE_FACTORY" || fail "the kit is not on the new work budget factory"
same "$(call "$KIT" 'policyImplementation()(address)')" "$POLICY_IMPL" || fail "the kit does not name the new voting policy"
[[ "$(call "$POLICY_IMPL" 'SECONDARY_POLICY_VERSION()(uint8)')" == "1" ]] || fail "the voting policy does not report the secondary version"
echo "  ✓ the kit and the market factory name the new summoner (on the new work budget factory, with the secondary voting policy)"
same "$(call "$WORK_BOUNTY" 'factory()(address)')" "$MANDATE_FACTORY" || fail "the work bounty does not name the new work budget factory"
same "$(call "$WORK_BOUNTY" 'currency()(address)')" "$SEPOLIA_USDC" || fail "the work bounty is not paid in Sepolia's USDC"
echo "  ✓ the work bounty at $WORK_BOUNTY names the new work budget factory and pays in USDC"
same "$(call "$MANDATE_FACTORY" 'payoutsFactory()(address)')" "$PAYOUTS_FACTORY" || fail "the payouts factory is not the one the new work budget factory made"
echo "  ✓ the payouts factory at $PAYOUTS_FACTORY is the one the new work budget factory made"
[[ "$(call "$TEST_TOKEN" 'decimals()(uint8)')" == "18" ]] || fail "the test token does not have 18 decimals"
[[ "$(call "$TEST_TOKEN" 'symbol()(string)')" == '"tTEST"' ]] || fail "the test token is not called tTEST"
[[ "$(call "$TEST_TOKEN" 'totalSupply()(uint256)')" == "0" ]] || fail "the test token already has a supply"
echo "  ✓ the free test token at $TEST_TOKEN is tTEST, 18 decimals, nothing minted yet"

# The 5 Nov contracts the trial build keeps using. Each must still be there; the new ones above replace the rest.
OLD_OPEN_BOUNTY=$(old_role open-bounty)
OLD_CREATE_TOKEN=$(old_role create-token)
OLD_CREATE_FAUCET=$(old_role create-faucet)
OLD_COURT=$(old_role court)
OLD_REMIX_BONDS=$(old_role remix-bonds)
for pair in "open bounty:$OLD_OPEN_BOUNTY" "test CREATE:$OLD_CREATE_TOKEN" "CREATE faucet:$OLD_CREATE_FAUCET" "court:$OLD_COURT" "remix bonds:$OLD_REMIX_BONDS"; do
  [[ -n "${pair#*:}" ]] || fail "the 5 Nov manifest has no ${pair%%:*}"
  has_code "${pair#*:}" || fail "the 5 Nov ${pair%%:*} at ${pair#*:} has no code on this chain"
done
echo "  ✓ the 5 Nov open bounty, test CREATE, faucet, court and remix bonds are all still on the chain"
MANIFEST_OK=1

# What it cost. The old per-transaction cap is a rule of the live network that a local fork does not enforce, so the
# rehearsal compares the deploy's gas limits against it; the real run reports the largest transaction and never fails after
# the money is spent.
read -r GAS TXS LARGEST_LIMIT LARGEST_USED <<<"$(run_gas "$V5_DEPLOY_BROADCASTS/${SEPOLIA_CHAIN_ID}/run-latest.json")"
if [[ "$MODE" == "rehearse" ]]; then
  (( LARGEST_LIMIT <= SEPOLIA_TX_GAS_CAP )) || fail "one deploy transaction asks for ${LARGEST_LIMIT} gas, over Sepolia's cap of ${SEPOLIA_TX_GAS_CAP} for one transaction"
  echo "  ✓ the largest deploy transaction asks for ${LARGEST_LIMIT} gas (uses ${LARGEST_USED}), under Sepolia's cap of ${SEPOLIA_TX_GAS_CAP} for one transaction"
else
  echo "  the largest deploy transaction asked for ${LARGEST_LIMIT} gas and used ${LARGEST_USED} (the per-transaction cap is ${SEPOLIA_TX_GAS_CAP})"
fi
eth_for() { cast from-wei "$(node -e 'console.log((BigInt(process.argv[1])*BigInt(process.argv[2])).toString())' "$GAS" "$1")"; }

if [[ "$MODE" == "rehearse" ]]; then
  PRICE_NOW="$(cast gas-price --rpc-url "$FORK_URL" 2>/dev/null || echo 0)"
  echo "  the deploy used ${GAS} gas in ${TXS} transactions on the fork: $(eth_for "$PRICE_NOW") ETH at Sepolia's gas price now ($(cast from-wei "$PRICE_NOW" gwei) gwei)"
  echo "  live Sepolia prices contract creation about 6 times the fork: about $(eth_for 18000000) ETH at the 0.003 gwei of the live arguments (gas x 6 x 3000000 wei); the deployer needs a few hundredths of an ETH to be safe"

  # ---- one trial project, from the same public dev key, on the fork ----
  step "rehearsal: launching one trial project from a wallet (founder = the dev key, reviewer = anvil's second account)"
  export TRIAL_REVIEWER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
  LOUT="$BACKUP/launch.out"
  # Pass 1 sends nothing: it prints the exact calldata so the node can be asked what the transaction needs.
  (cd contracts && PRIVATE_KEY="$KEY" forge script script/LaunchV5TrialProject.s.sol --rpc-url "$RPC" >"$LOUT" 2>&1) \
    || { tail -40 "$LOUT"; fail "the trial launch simulation failed"; }
  CALLDATA=$(awk '/LAUNCH_CALLDATA/ {print $2; exit}' "$LOUT")
  [[ "$CALLDATA" =~ ^0x[0-9a-f]+$ ]] || { tail -20 "$LOUT"; fail "the trial launch printed no calldata"; }
  ESTIMATE_HEX=$(cast rpc eth_estimateGas "{\"from\":\"$DEPLOYER\",\"to\":\"$KIT\",\"data\":\"$CALLDATA\"}" --rpc-url "$RPC" | tr -d '"') \
    || fail "eth_estimateGas refused the trial launch"
  ESTIMATE=$(cast to-dec "$ESTIMATE_HEX")
  echo "  eth_estimateGas for the launch on the fork: ${ESTIMATE} (cap ${SEPOLIA_TX_GAS_CAP})"
  # Pass 2 sends it.
  (cd contracts && PRIVATE_KEY="$KEY" forge script script/LaunchV5TrialProject.s.sol --rpc-url "$RPC" --broadcast >"$LOUT" 2>&1) \
    || { tail -40 "$LOUT"; fail "the trial launch failed"; }
  grep -E "^  ?(dao|budget|policy|market|launch gas|launch is)" "$LOUT" || true
  read -r _ _ LAUNCH_LIMIT LAUNCH_USED <<<"$(run_gas "$V5_LAUNCH_BROADCASTS/${SEPOLIA_CHAIN_ID}/run-latest.json")"
  echo "  the launch transaction used ${LAUNCH_USED} gas (gas limit set ${LAUNCH_LIMIT})"
  (( LAUNCH_USED <= SEPOLIA_TX_GAS_CAP )) || fail "the launch used ${LAUNCH_USED} gas, over Sepolia's cap of ${SEPOLIA_TX_GAS_CAP} for one transaction"
  echo "  ✓ the launch used ${LAUNCH_USED} gas, under Sepolia's cap of ${SEPOLIA_TX_GAS_CAP} for one transaction (${ESTIMATE} estimated)"
  step "rehearsal passed. To deploy for real: put SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY in .env, set SEPOLIA_FORGE_ARGS (see the top of this file) and run with --broadcast"
else
  SPENT=$(node -e 'console.log((BigInt(process.argv[1])-BigInt(process.argv[2])).toString())' "$BALANCE" "$(cast balance "$DEPLOYER" --rpc-url "$RPC")")
  echo "  the deploy used ${GAS} gas in ${TXS} transactions and cost $(cast from-wei "$SPENT") test ETH"
  step "deployed. Commit contracts/deployments/v5-sepolia-${SEPOLIA_CHAIN_ID}.json, then put these in the server's deploy/compose/.env and rebuild:"
fi

# The web settings for the trial build, from the manifests. The block is the chain's head when the deploy began, at or before
# every contract here. Contracts the new work budget factory replaced (work bounty, payouts factory) are the new ones; the
# court, test CREATE and its faucet, the open bounty and the remix bonds are the 5 Nov ones, which do not name the summoner.
# The raise kit (DaoLaunchKit) and the old contributor kit are left out: the trial build is contributor-only.
FROM_BLOCK=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).block)' "$V5_MANIFEST")
C="$SEPOLIA_CHAIN_ID"
cat <<EOF

# ── The weekly-sale trial build: add these to deploy/compose/.env (the rest of the Sepolia settings stay as they are), then ./run.sh build and ./run.sh restart
# Replaces the 5 Nov kit: projects started on it before have no weekly sale and show no 'made by the kit' badge on this build.
VITE_CONTRIBUTOR_KITS='{"${C}":"${KIT}"}'
VITE_SECONDARY_MARKET_FACTORY='{"${C}":"${MARKET_FACTORY}"}'
VITE_TRADING_TRIAL=1
# The free-mint token the trial trades in (anyone can mint it; prices in it prove nothing).
VITE_TEST_QUOTE_TOKENS='{"${C}":"${TEST_TOKEN}"}'
# New with the new work budget factory:
VITE_WORK_BOUNTIES='{"${C}":"${WORK_BOUNTY}"}'
VITE_PAYOUTS_FACTORIES='{"${C}":"${PAYOUTS_FACTORY}"}'
# Kept from the 5 Nov deploy (they name neither the summoner nor the work budget factory):
VITE_OPEN_BOUNTIES='{"${C}":"${OLD_OPEN_BOUNTY}"}'
VITE_CREATE_TOKENS='{"${C}":"${OLD_CREATE_TOKEN}"}'
VITE_CREATE_FAUCETS='{"${C}":"${OLD_CREATE_FAUCET}"}'
VITE_COURTS='{"${C}":"${OLD_COURT}"}'
VITE_REMIX_BONDS='{"${C}":"${OLD_REMIX_BONDS}"}'
# Where reading starts: the block this set was deployed at. (Projects from the 5 Nov deploy are older than this; use their block, 12072551, to keep them in view.)
VITE_HISTORY_FROM_BLOCKS='{"${C}":${FROM_BLOCK}}'

EOF
[[ "$MODE" == "rehearse" ]] && echo "  (these addresses are on the throwaway fork: a rehearsal prints them only to show the shape)"
echo "  (not set on purpose: VITE_DAO_LAUNCH_KITS, so raises stay off; docs/sepolia-testnet.md has the rest)"
