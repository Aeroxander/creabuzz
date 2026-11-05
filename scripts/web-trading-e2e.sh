#!/usr/bin/env bash
#
# scripts/web-trading-e2e.sh — a round of secondary trading, from the WEB app against a REAL local chain, in real
# browsers.
#
# Boots its own anvil on a throwaway loopback port and deploys the whole v5 creation version on it, as real
# transactions, with `contracts/script/V5LocalFixture.s.sol`: the mandate factory, the voting policy, the Summoner, the
# SecondaryMarketFactory and the ContributorKitV2, then one launch — a DAO, its Shares, its policy, its work budget and
# its own SecondaryMarket (created by the factory for that DAO). Then it:
#   * mints the fixture's quote token to a second person (it has a public `mint`, 18 decimals);
#   * warps the chain past the founder's 180-day sale schedule, and checks `policy.saleCapacity(founder) > 0` (at birth
#     it is 0, so there is nothing to sell);
#   * builds the web app naming that market factory for chain 31337.
# and runs web/tests/e2e/secondary-trading.spec.ts:
#   1. the card says trading is off (a market from launch, no listing yet) and offers no offer or bid;
#   2. the DAO publishes a listing (the spec impersonates the DAO, as `cast rpc anvil_impersonateAccount` does, because
#      `configureListing` is `onlyDAO`), the card shows the real terms, and the founder opens the week's round;
#   3. the founder offers two lots at the lowest step, and the market holds their Shares;
#   4. a second person bids for them at the highest step, and the market holds their quote;
#   5. after the bidding window the round settles at one price, and both orders fill the same lots;
#   6. both collect (the buyer its Shares and its overpaid money, the seller the proceeds) and the round's ledgers end
#      at zero;
#   7. a wallet with no order in the round is offered no collect button, and the chain would refuse one.
#   8. a second test: a round nobody settles goes void, the next week's round opens, and the card still offers each
#      wallet what the void round owes it (the seller's Shares, the buyer's money) as 'Collect from an earlier round'.
#   9. a third test: a seller whose offer part-sold sees both what sold and how many lots are left to take back, since
#      settling hands no Shares back; the card offers 'Collect N Shares' beside the proceeds, the remainder is also
#      collected from 'Collect from an earlier round' once a newer round opens, and a repeat would pay nothing.
#      The seller who sold nothing (test 3) collects its Shares from the card too.
# Every step is a button on the page and a transaction on the chain, and each is checked against the chain.
# Trading is off by default: only this scratch anvil's DAO is made to publish a listing, by impersonation.
#
# ⚠️  DEV ONLY. Anvil dev keys (public), a local chain, nothing else.
#
# Requirements: foundry (forge, cast, anvil) on PATH, `~/.foundry/bin`, or in $FOUNDRY_BIN; node + web/node_modules;
# Chromium (set PW_CHROMIUM_PATH if the pinned Playwright wants a newer build than the machine has).
#
# Usage:  scripts/web-trading-e2e.sh [playwright args, e.g. -g "settle"]
# Env:    ANVIL_PORT (default: a free port the kernel picks; refused when something holds it),
#         SKIP_BUILD=1 (reuse web/dist, only a build this script made for this chain and market factory)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
for tool in forge cast anvil node python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool (set FOUNDRY_BIN for foundry)"; exit 2; }
done

step() { printf '\033[36m[web-trading-e2e]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[web-trading-e2e] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# shellcheck source=scripts/lib/local-anvil.sh
. "$REPO_ROOT/scripts/lib/local-anvil.sh"
PORT="${ANVIL_PORT:-$(free_loopback_port)}"
# Foundry's HTTP client panics in this sandbox (macOS system-configuration returns NULL), so every `cast` call reaches
# the node over its WebSocket transport: same JSON-RPC, same anvil, no proxy machinery. The app and the browser spec use
# plain HTTP, which this host's node and Chromium both serve fine.
RPC="ws://127.0.0.1:${PORT}"
HTTP_RPC="http://127.0.0.1:${PORT}"
STATE="$(mktemp -d)"

# Build output stays out of the worktree.
export FOUNDRY_OUT="$STATE/out"
export FOUNDRY_CACHE_PATH="$STATE/cache"
export FOUNDRY_BROADCAST="$STATE/broadcast"
mkdir -p "$FOUNDRY_OUT" "$FOUNDRY_CACHE_PATH" "$FOUNDRY_BROADCAST"

# Well-known anvil fixture keys (the public test mnemonic). Never a real wallet.
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
FOUNDER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
REVIEWER_A=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC # anvil account 2: the buyer
REVIEWER_B=0x90F79bf6EB2c4f870365E785982E1f101E93b906 # anvil account 3: someone with no order
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266       # anvil account 0
FOUNDER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8        # anvil account 1
BIDDER="$REVIEWER_A"
THIRD="$REVIEWER_B"

# Stop the anvil this run started, and nothing else: the pid this run captured, never a name or a port.
cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
  rm -rf "$STATE"
}
trap cleanup EXIT

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  echo "port 4173 is already serving something: a stale preview would run an old build."
  echo "Stop it (lsof -ti tcp:4173 | xargs kill) and run this again."
  exit 2
fi

step "booting anvil on ${HTTP_RPC} (state in ${STATE})"
start_local_anvil "$PORT" "$STATE/anvil.log"
for _ in $(seq 1 100); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")" || { tail -20 "$STATE/anvil.log"; fail "anvil never answered on $RPC"; }
[[ "$CHAIN_ID" == "31337" ]] || fail "not a local anvil chain (chain id $CHAIN_ID)"
# anvil starts at block 0, and `ActivationVoting` uses 0 as its "never initialized" sentinel: mine two blocks first, as
# every real chain is past genesis.
cast rpc --rpc-url "$RPC" anvil_mine 0x2 >/dev/null
step "anvil pid ${ANVIL_PID} on chain ${CHAIN_ID}, block $(cast block-number --rpc-url "$RPC")"

step "deploying the creation version and launching the fixture project (real transactions)"
V5_DEPLOYER_PK="$DEPLOYER_PK" V5_FOUNDER_PK="$FOUNDER_PK" \
  V5_REVIEWER_A="$REVIEWER_A" V5_REVIEWER_B="$REVIEWER_B" \
  forge script "$REPO_ROOT/contracts/script/V5LocalFixture.s.sol:V5LocalFixture" \
    --root "$REPO_ROOT/contracts" --rpc-url "$RPC" --sender "$DEPLOYER" --broadcast --offline -vv \
  >"$STATE/fixture.log" 2>&1 || { tail -60 "$STATE/fixture.log"; fail "the fixture did not deploy"; }
SUMMARY="$(grep -o 'FIXTURE_JSON {.*}' "$STATE/fixture.log" | head -1 | sed 's/^FIXTURE_JSON //')"
[[ -n "$SUMMARY" ]] || fail "the fixture did not print its summary line"
addr() {
  printf '%s' "$SUMMARY" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk)).on("end", () => {
      const value = JSON.parse(raw)[process.argv[1]];
      if (typeof value !== "string" || value.length === 0) process.exit(1);
      process.stdout.write(value);
    });
  ' "$1"
}
QUOTE="$(addr quote)"
DAO="$(addr dao)"
SHARES="$(addr shares)"
POLICY="$(addr policy)"
MARKET="$(addr market)"
MARKET_FACTORY="$(addr marketFactory)"
for pair in "quote:$QUOTE" "dao:$DAO" "shares:$SHARES" "policy:$POLICY" "market:$MARKET" "marketFactory:$MARKET_FACTORY"; do
  [[ "${pair#*:}" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the fixture reported no ${pair%%:*}"
done
step "dao ${DAO}  shares ${SHARES}  market ${MARKET}  quote ${QUOTE}"

# The buyer needs the quote to bid with: the fixture's token has a public `mint`, and 1,000 is plenty for two lots at
# the highest step of this listing.
cast send "$QUOTE" "mint(address,uint256)" "$BIDDER" 1000000000000000000000 \
  --private-key "$FOUNDER_PK" --rpc-url "$RPC" >/dev/null || fail "could not give the buyer the quote token"

# The founder's 200 Shares sit inside a 180-day schedule with no cliff, so `saleCapacity(founder)` is 0 at birth and
# grows over those days: nothing can be offered until the chain is past it. Warp past the whole schedule, mine a block
# so the new time is the head, and check the capacity the market's `sell` will check.
cast rpc --rpc-url "$RPC" anvil_increaseTime "$(cast to-hex 17280000)" >/dev/null # 200 days
cast rpc --rpc-url "$RPC" anvil_mine 0x1 >/dev/null
strip() { sed -E 's/ \[[^]]*\]//g' | head -1 | awk '{print $1}'; }
CAPACITY="$(cast call "$POLICY" "saleCapacity(address)(uint256)" "$FOUNDER" --rpc-url "$RPC" | strip)"
[[ "$CAPACITY" =~ ^[0-9]+$ ]] || fail "could not read the founder's sale capacity ($CAPACITY)"
awk -v v="$CAPACITY" 'BEGIN { exit !(v + 0 > 0) }' || fail "the founder's sale capacity is still 0 after 200 days"
step "the founder's sale capacity is ${CAPACITY} base units after the schedule"

# Trading is off until the DAO publishes a listing: the spec checks that first, then publishes it as the DAO itself.
LISTING="$(cast call "$MARKET" "listing()(bool,uint128,uint128,uint32)" --rpc-url "$RPC" | strip | tr '\n' ' ')"
[[ "$(printf '%s' "$LISTING" | cut -d' ' -f1)" == "false" ]] || fail "the listing is not disabled at birth ($LISTING)"

cd "$REPO_ROOT/web"
# The build records what it was made for next to the bundle. A minified bundle does not carry the factory address in a form
# worth searching for, and a fresh anvil gives the same address to the same deployer, so the record is the check: SKIP_BUILD=1
# reuses web/dist only for this chain and factory, and any other build (another script's, an older run's) has no such record.
BUILD_MARKER="$REPO_ROOT/web/dist/.web-trading-e2e-build"
BUILD_RECORD="chain=${CHAIN_ID} secondaryMarketFactory=${MARKET_FACTORY}"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  # env -i keeps any VITE_ setting from the caller's shell out of the build: it has only what is named here.
  env -i PATH="$PATH" HOME="$HOME" VITE_LAUNCHPAD_CHAIN_ID="$CHAIN_ID" \
    VITE_SECONDARY_MARKET_FACTORY="{\"${CHAIN_ID}\":\"${MARKET_FACTORY}\"}" \
    node_modules/.bin/vite build >"$STATE/web-build.log" 2>&1 \
    || { tail -20 "$STATE/web-build.log"; fail "web build failed"; }
  printf '%s\n' "$BUILD_RECORD" >"$BUILD_MARKER"
else
  [[ -f "$BUILD_MARKER" && "$(cat "$BUILD_MARKER")" == "$BUILD_RECORD" ]] \
    || fail "SKIP_BUILD=1 but web/dist was not built by this script for ${BUILD_RECORD} (stale build; it does not match): run again without SKIP_BUILD"
fi
step "running the browser spec"
E2E_ANVIL_URL="$HTTP_RPC" E2E_QUOTE="$QUOTE" E2E_SHARES="$SHARES" E2E_DAO="$DAO" \
  E2E_MARKET="$MARKET" E2E_POLICY="$POLICY" E2E_FOUNDER="$FOUNDER" E2E_BIDDER="$BIDDER" E2E_THIRD="$THIRD" \
  node_modules/.bin/playwright test tests/e2e/secondary-trading.spec.ts --project=smoke --reporter=list "$@"
