#!/usr/bin/env bash
#
# scripts/web-backing-e2e.sh — investing, from the WEB app against the REAL contracts on a local chain, in a real browser.
#
# Boots its own anvil on a throwaway loopback port and puts on it, as real transactions: the real Uniswap auction factory
# and Permit2 (the opening round needs both), then `contracts/script/BackingLocalFixture.s.sol`: the work budget factory, the
# voting policy, the summoner, the weekly-sale kit (V2), the free test token, the backing pool factory and the pool kit (V3),
# a project made WITH its pool by `launchWithPool` (the founder bought and sold in it), a V2 project whose pool was opened
# afterwards by its founder, and a V2 project whose pool waits behind an opening round. It then builds the web app naming
# those addresses with the investing switch on, and runs web/tests/e2e/backing-chain.spec.ts:
#   1. a backer puts money in from the page (one approval and one buy), and sells half again;
#   2. a second backer buys too; the chain is warped past the first milestone date; the founder posts a milestone by picking
#      one of the project's own records;
#   3. the second backer leaves at it from the page (all their units sold, all their held money back);
#   4. the window ends; a visitor settles the milestone from the page and the money reaches the project's treasury;
#   5. a backer bids in the opening round of the third project (Permit2, the auction's approval, the bid), the round is
#      mined to its end, a visitor settles it, and the backer exchanges the round tokens for backing units.
# Each step is a button on the page and a transaction on the chain, and each is checked against the chain.
# NOT covered here: the passkey account path (the mocked spec and the passkey specs cover it), leaving and collecting in
# the round through "My bids" (the existing sale specs cover that panel; here the exit and the claim are sent to the auction
# directly), abandonment (the contract tests run it), and a round that fails.
#
# ⚠️  DEV ONLY. Anvil dev keys (public), a local chain, nothing else.
#
# Requirements: foundry (forge, cast, anvil) on PATH, `~/.foundry/bin`, or in $FOUNDRY_BIN; node + web/node_modules;
# Chromium (set PW_CHROMIUM_PATH if the pinned Playwright wants a newer build than the machine has).
#
# Usage:  scripts/web-backing-e2e.sh [playwright args, e.g. -g "milestone"]
# Env:    FORGE_KEEP (a folder to keep the compiled contracts in: the first build takes a quarter of an hour),
#         ANVIL_PORT (default: a free port the kernel picks), BACKING_PORT (the preview's port, default 4189),
#         SKIP_BUILD=1 (reuse the web build in BACKING_DIST, which must have been made by this script)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
for tool in forge cast anvil node python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool (set FOUNDRY_BIN for foundry)"; exit 2; }
done

step() { printf '\033[36m[web-backing-e2e]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[web-backing-e2e] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# shellcheck source=scripts/lib/local-anvil.sh
. "$REPO_ROOT/scripts/lib/local-anvil.sh"
PORT="${ANVIL_PORT:-$(free_loopback_port)}"
PREVIEW_PORT="${BACKING_PORT:-4189}"
# Foundry's HTTP client panics in this sandbox, so every `cast` and `forge` call reaches the node over its WebSocket
# transport. The app and the browser spec use plain HTTP.
RPC="ws://127.0.0.1:${PORT}"
HTTP_RPC="http://127.0.0.1:${PORT}"
STATE="$(mktemp -d)"
# The contracts take many minutes to compile (via-IR); FORGE_KEEP names a folder to keep the build in between runs.
if [[ -n "${FORGE_KEEP:-}" ]]; then
  export FOUNDRY_OUT="$FORGE_KEEP/out" FOUNDRY_CACHE_PATH="$FORGE_KEEP/cache"
else
  export FOUNDRY_OUT="$STATE/out" FOUNDRY_CACHE_PATH="$STATE/cache"
fi
export FOUNDRY_BROADCAST="$STATE/broadcast"
mkdir -p "$FOUNDRY_OUT" "$FOUNDRY_CACHE_PATH" "$FOUNDRY_BROADCAST"

# Well-known anvil keys (the public test mnemonic). Never a real wallet.
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   # anvil account 0: deploys, and is every project's founder
BACKER_A=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC   # anvil account 2
BACKER_B=0x90F79bf6EB2c4f870365E785982E1f101E93b906   # anvil account 3
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3

if [[ -n "${BACKING_DIST:-}" ]]; then
  DIST="$BACKING_DIST"
else
  DIST="$STATE/dist"
fi
# anvil keeps a state folder of its own under ~/.foundry/anvil/tmp and leaves it behind: a file for each block, and this run
# mines fifty thousand of them for the opening round (several gigabytes). The folders this run made are removed with it.
ANVIL_TMP="${HOME}/.foundry/anvil/tmp"
ANVIL_TMP_BEFORE="$(ls "$ANVIL_TMP" 2>/dev/null || true)"
cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
  local made
  for made in $(ls "$ANVIL_TMP" 2>/dev/null || true); do
    grep -qxF "$made" <<<"$ANVIL_TMP_BEFORE" || rm -rf "${ANVIL_TMP:?}/${made}"
  done
  rm -rf "$STATE"
}
trap cleanup EXIT

if lsof -ti "tcp:${PREVIEW_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port ${PREVIEW_PORT} is already serving something: a stale preview would run an old build (BACKING_PORT picks another)"
fi

step "booting anvil on ${HTTP_RPC} (state in ${STATE})"
# The opening round's fifty thousand blocks would otherwise leave a copy of the whole chain state for each (several gigabytes).
ANVIL_ARGS="--prune-history 256" start_local_anvil "$PORT" "$STATE/anvil.log"
for _ in $(seq 1 100); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")" || { tail -20 "$STATE/anvil.log"; fail "anvil never answered on $RPC"; }
[[ "$CHAIN_ID" == "31337" ]] || fail "not a local anvil chain (chain id $CHAIN_ID)"
cast rpc --rpc-url "$RPC" anvil_mine 0x2 >/dev/null

created() { # created <log>: the address `forge create` deployed to
  sed -n 's/^Deployed to: \(0x[0-9a-fA-F]\{40\}\).*/\1/p' "$1" | head -1
}

step "deploying the auction factory and Permit2 (the opening round's own contracts)"
forge create "$REPO_ROOT/contracts/lib/continuous-clearing-auction/src/ContinuousClearingAuctionFactory.sol:ContinuousClearingAuctionFactory" \
  --root "$REPO_ROOT/contracts" --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --broadcast \
  --constructor-args 0x0000000000000000000000000000000000000000 >"$STATE/auction-factory.log" 2>&1 \
  || { tail -30 "$STATE/auction-factory.log"; fail "the auction factory did not deploy"; }
AUCTION_FACTORY="$(created "$STATE/auction-factory.log")"
[[ "$AUCTION_FACTORY" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no auction factory address"
forge create "$REPO_ROOT/contracts/lib/continuous-clearing-auction/lib/permit2/src/Permit2.sol:Permit2" \
  --root "$REPO_ROOT/contracts" --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --broadcast >"$STATE/permit2.log" 2>&1 \
  || { tail -30 "$STATE/permit2.log"; fail "Permit2 did not deploy"; }
PERMIT2_COPY="$(created "$STATE/permit2.log")"
# Permit2 lives at one canonical address on every network; the auction pulls its bids through it there.
cast rpc --rpc-url "$RPC" anvil_setCode "$PERMIT2" "$(cast code "$PERMIT2_COPY" --rpc-url "$RPC")" >/dev/null
[[ "$(cast code "$PERMIT2" --rpc-url "$RPC")" != "0x" ]] || fail "Permit2 is not at its canonical address"

step "deploying the backing set and three projects (real transactions)"
# Each deploy nearly fills a block, so the chain's base fee climbs faster than the price forge fixed from its first estimate,
# and a transaction priced below it waits for ever. A price far above any base fee the run can reach keeps them all moving.
BACKING_AUCTION_FACTORY="$AUCTION_FACTORY" PRIVATE_KEY="$DEPLOYER_PK" \
  forge script "$REPO_ROOT/contracts/script/BackingLocalFixture.s.sol:BackingLocalFixture" \
    --root "$REPO_ROOT/contracts" --rpc-url "$RPC" --sender "$DEPLOYER" --broadcast --offline -vv \
    --with-gas-price 100gwei --priority-gas-price 1 \
  >"$STATE/fixture.log" 2>&1 || { tail -60 "$STATE/fixture.log"; fail "the fixture did not deploy"; }
logged() { sed -n "s/^ *$1: *\(0x[0-9a-fA-F]\{40\}\).*/\1/p" "$STATE/fixture.log" | head -1; }
QUOTE="$(logged "quote")"
KIT_V3="$(logged "kit v3")"
POOL_FACTORY="$(logged "pool factory")"
POOL_BORN="$(logged "pool at birth")"
POOL_ROUND="$(logged "pool waiting for its round")"
AUCTION="$(logged "its auction")"
# The V2 kit has no line of its own: it is in the broadcast, by name.
KIT_V2="$(node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const run = JSON.parse(fs.readFileSync(path, "utf8"));
  const kit = run.transactions.find((t) => t.contractName === "ContributorKitV2");
  process.stdout.write(kit ? kit.contractAddress : "");
' "$FOUNDRY_BROADCAST/BackingLocalFixture.s.sol/31337/run-latest.json")"
for pair in "quote:$QUOTE" "kit v3:$KIT_V3" "pool factory:$POOL_FACTORY" "pool at birth:$POOL_BORN" \
            "round pool:$POOL_ROUND" "auction:$AUCTION" "kit v2:$KIT_V2"; do
  [[ "${pair#*:}" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the fixture reported no ${pair%%:*}"
done
DAO_BORN="$(cast call "$POOL_BORN" "dao()(address)" --rpc-url "$RPC" | awk '{print $1}')"
DAO_ROUND="$(cast call "$POOL_ROUND" "dao()(address)" --rpc-url "$RPC" | awk '{print $1}')"
step "pool factory ${POOL_FACTORY}  pool kit ${KIT_V3}  quote ${QUOTE}  project ${DAO_BORN}  round project ${DAO_ROUND}"

# The backers need the token to put in: it has a public `mint` (at most 10,000 a call).
for who in "$BACKER_A" "$BACKER_B"; do
  for _ in 1 2; do
    cast send "$QUOTE" "mint(address,uint256)" "$who" 10000000000000000000000 \
      --private-key "$DEPLOYER_PK" --rpc-url "$RPC" >/dev/null || fail "could not give a backer the token"
  done
done

cd "$REPO_ROOT/web"
BUILD_MARKER="$DIST/.web-backing-e2e-build"
BUILD_RECORD="factory=${POOL_FACTORY} kit3=${KIT_V3} kit2=${KIT_V2} quote=${QUOTE}"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app with investing on"
  env -i PATH="$PATH" HOME="$HOME" VITE_LAUNCHPAD_CHAIN_ID="$CHAIN_ID" VITE_CONTRIBUTOR_ONLY=1 VITE_INVESTING=1 \
    VITE_BACKING_POOL_FACTORY="{\"${CHAIN_ID}\":\"${POOL_FACTORY}\"}" VITE_CONTRIBUTOR_KIT_V3="{\"${CHAIN_ID}\":\"${KIT_V3}\"}" \
    VITE_BACKING_QUOTE_TOKEN="{\"${CHAIN_ID}\":\"${QUOTE}\"}" VITE_TEST_QUOTE_TOKENS="{\"${CHAIN_ID}\":\"${QUOTE}\"}" \
    VITE_CONTRIBUTOR_KITS="{\"${CHAIN_ID}\":\"${KIT_V2}\"}" \
    node_modules/.bin/vite build --outDir "$DIST" --emptyOutDir >"$STATE/web-build.log" 2>&1 \
    || { tail -20 "$STATE/web-build.log"; fail "web build failed"; }
  printf '%s\n' "$BUILD_RECORD" >"$BUILD_MARKER"
else
  [[ -f "$BUILD_MARKER" && "$(cat "$BUILD_MARKER")" == "$BUILD_RECORD" ]] \
    || fail "SKIP_BUILD=1 but ${DIST} was not built by this script for these addresses (a fresh anvil gives the same addresses to the same deployer: delete it and run again)"
fi
step "running the browser spec"
E2E_ANVIL_URL="$HTTP_RPC" E2E_PORT="$PREVIEW_PORT" E2E_DIST="$DIST" E2E_BACKING_CHAIN=1 \
  E2E_QUOTE="$QUOTE" E2E_POOL="$POOL_BORN" E2E_DAO="$DAO_BORN" E2E_ROUND_POOL="$POOL_ROUND" E2E_ROUND_DAO="$DAO_ROUND" \
  E2E_FOUNDER="$DEPLOYER" E2E_BACKER_A="$BACKER_A" E2E_BACKER_B="$BACKER_B" \
  node_modules/.bin/playwright test tests/e2e/backing-chain.spec.ts --project=investing --reporter=list "$@"
