#!/usr/bin/env bash
#
# scripts/secondary-keeper-e2e.sh — proves scripts/secondary-keeper.sh against a REAL local chain.
#
# Boots its own anvil, deploys the v5 creation version and launches the fixture project (the same fixture
# scripts/web-trading-e2e.sh uses), warps past the founder's sale schedule, then runs the keeper through a round's
# whole life and checks every outcome against chain state:
#   1. no round, listing off            -> the keeper sends nothing;
#   2. listing on, dry run              -> says it would open a round, and opens none;
#   3. listing on, settle-only keeper   -> opens none (opening is opt-in);
#   4. KEEPER_OPEN=1                    -> opens round 1; a second pass does not open another inside the week;
#   5. an offer and a bid, still bidding -> the keeper does not settle (the chain would refuse it);
#   6. bidding closed                   -> the keeper settles it; a second pass sends nothing more;
#      (an unfunded keeper that cannot send logs a loud ERROR with the reason, settles nothing and exits 1);
#   7. both sides collect               -> the seller's unsold lot waits until its claim (settle moves no Shares), then
#                                          the ledgers end at zero and the buyer holds the Shares;
#   8. a week later, KEEPER_OPEN=1      -> opens round 2; left unsettled past its deadline the round is void and the
#                                          keeper sends nothing (it never pays gas for a transaction that must fail).
#
# The keeper signs from a keystore, as an operator should. ⚠️  DEV ONLY. Anvil dev keys (public), a local chain.
# Usage:  scripts/secondary-keeper-e2e.sh        (foundry on PATH or in ~/.foundry/bin)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
for tool in forge cast anvil node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool (set FOUNDRY_BIN for foundry)"; exit 2; }
done

step() { printf '\033[36m[secondary-keeper-e2e]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[secondary-keeper-e2e] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

PORT="${ANVIL_PORT:-$((19000 + RANDOM % 1000))}"
# Foundry's HTTP client panics in this sandbox, so every `cast` call reaches the node over its WebSocket transport.
RPC="ws://127.0.0.1:${PORT}"
STATE="$(mktemp -d)"
export FOUNDRY_OUT="$STATE/out"
export FOUNDRY_CACHE_PATH="$STATE/cache"
export FOUNDRY_BROADCAST="$STATE/broadcast"
mkdir -p "$FOUNDRY_OUT" "$FOUNDRY_CACHE_PATH" "$FOUNDRY_BROADCAST"

DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
FOUNDER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
BIDDER_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
KEEPER_PK=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e # anvil account 6: pays gas only
BIDDER=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC # anvil account 2
THIRD=0x90F79bf6EB2c4f870365E785982E1f101E93b906  # anvil account 3
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
FOUNDER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
KEEPER=0x976EA74026E726554dB657fA54763abd0C3a0aa9
BROKE_PK=0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356 # anvil account 7, emptied: cannot pay gas
BROKE=0x14dC79964da2C08b23698B3D3cc7Ca32193d9955

cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
  rm -rf "$STATE"
}
trap cleanup EXIT

step "booting anvil on ${RPC}"
anvil --host 127.0.0.1 --port "$PORT" --chain-id 31337 --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 100); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done
[[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" == "31337" ]] || { tail -20 "$STATE/anvil.log"; fail "no local anvil chain on $RPC"; }
cast rpc --rpc-url "$RPC" anvil_mine 0x2 >/dev/null

step "deploying the creation version and launching the fixture project"
V5_DEPLOYER_PK="$DEPLOYER_PK" V5_FOUNDER_PK="$FOUNDER_PK" V5_REVIEWER_A="$BIDDER" V5_REVIEWER_B="$THIRD" \
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
QUOTE="$(addr quote)"; DAO="$(addr dao)"; SHARES="$(addr shares)"; MARKET="$(addr market)"
for pair in "quote:$QUOTE" "dao:$DAO" "shares:$SHARES" "market:$MARKET"; do
  [[ "${pair#*:}" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the fixture reported no ${pair%%:*}"
done

# ---- helpers ------------------------------------------------------------------------------------------------------
num() { awk -v n="${1:-1}" 'NR == n { sub(/ \[.*/, ""); print $1 }'; }
call() { cast call "$@" --rpc-url "$RPC"; }
rounds_count() { call "$MARKET" "roundCount()(uint256)" | num 1; }
settled_of() { call "$MARKET" "rounds(uint256)(uint128,uint128,uint32,uint64,uint64,uint64,uint256,uint256,uint16,bool,bool)" "$1" | num 10; }
nonce_of() { cast nonce "$KEEPER" --rpc-url "$RPC"; }
warp() { cast rpc --rpc-url "$RPC" anvil_increaseTime "$(cast to-hex "$1")" >/dev/null; cast rpc --rpc-url "$RPC" anvil_mine 0x1 >/dev/null; }
expect() { [[ "$2" == "$3" ]] || fail "$1: expected '$3', got '$2'"; step "ok: $1 ($2)"; }
# The keeper signs from a keystore (its key never reaches a command line); these two are dev-only anvil keys.
KS="$STATE/keystores"; mkdir -p "$KS"; printf 'dev-only' >"$KS/password"
cast wallet import keeper --private-key "$KEEPER_PK" --keystore-dir "$KS" --unsafe-password dev-only >/dev/null
cast wallet import broke --private-key "$BROKE_PK" --keystore-dir "$KS" --unsafe-password dev-only >/dev/null
keeper() { RPC_URL="$RPC" MARKET="$MARKET" KEEPER_PASSWORD_FILE="$KS/password" "$REPO_ROOT/scripts/secondary-keeper.sh" --once "$@"; }

# Setup: the buyer has quote to bid with, the chain is past the founder's schedule, the keeper has gas and nothing else.
cast send "$QUOTE" "mint(address,uint256)" "$BIDDER" 1000000000000000000000 --private-key "$FOUNDER_PK" --rpc-url "$RPC" >/dev/null
cast rpc --rpc-url "$RPC" anvil_setBalance "$KEEPER" 0x56BC75E2D63100000 >/dev/null # 100 ETH, gas only
warp 17280000 # 200 days

MIN=1000000000000000000   # 1 quote a lot
MAX=65000000000000000000  # 65 quote a lot, in 64 steps
publish_listing() {
  cast rpc --rpc-url "$RPC" anvil_setBalance "$DAO" 0x56BC75E2D63100000 >/dev/null
  cast rpc --rpc-url "$RPC" anvil_impersonateAccount "$DAO" >/dev/null
  cast send "$MARKET" "configureListing(bool,uint128,uint128,uint32)" true "$MIN" "$MAX" 64 --from "$DAO" --unlocked --rpc-url "$RPC" >/dev/null
  cast rpc --rpc-url "$RPC" anvil_stopImpersonatingAccount "$DAO" >/dev/null
}

# 1. Listing off, no round: nothing to do.
N0="$(nonce_of)"
KEEPER_KEYSTORE="$KS/keeper" KEEPER_OPEN=1 keeper >/dev/null
expect "a market with its listing off gets no transaction" "$(nonce_of)" "$N0"

publish_listing
# 2. Dry run says it would open, and opens nothing.
OUT="$(KEEPER_DRY_RUN=1 KEEPER_OPEN=1 keeper)"
[[ "$OUT" == *"would send openRound()"* ]] || fail "the dry run did not say it would open a round: $OUT"
expect "a dry run opens no round" "$(rounds_count)" "0"

# 3. Settle-only keeper never opens (opening spends the operator's money, so it is opt-in).
KEEPER_KEYSTORE="$KS/keeper" keeper >/dev/null
expect "a settle-only keeper opens no round" "$(rounds_count)" "0"

# 4. KEEPER_OPEN=1 opens round 1, and a second pass inside the week does not open another.
KEEPER_KEYSTORE="$KS/keeper" KEEPER_OPEN=1 keeper >/dev/null
expect "the keeper opens the week's round" "$(rounds_count)" "1"
KEEPER_KEYSTORE="$KS/keeper" KEEPER_OPEN=1 keeper >/dev/null
expect "a second pass inside the week opens no other" "$(rounds_count)" "1"

# 5. An offer and a bid while bidding is open; the keeper must not try to settle.
cast send "$SHARES" "approve(address,uint256)" "$MARKET" 1000000000000000000000 --private-key "$FOUNDER_PK" --rpc-url "$RPC" >/dev/null
cast send "$QUOTE" "approve(address,uint256)" "$MARKET" 1000000000000000000000 --private-key "$BIDDER_PK" --rpc-url "$RPC" >/dev/null
cast send "$MARKET" "sell(uint256,uint128,uint16)" 1 3 0 --private-key "$FOUNDER_PK" --rpc-url "$RPC" >/dev/null
cast send "$MARKET" "bid(uint256,uint128,uint16)" 1 2 64 --private-key "$BIDDER_PK" --rpc-url "$RPC" >/dev/null
N1="$(nonce_of)"
KEEPER_KEYSTORE="$KS/keeper" keeper >/dev/null
expect "the keeper does not settle while bidding is open" "$(settled_of 1)" "false"
expect "and sends no transaction for it" "$(nonce_of)" "$N1"

# 6. Bidding closes: the keeper settles it, and a second pass sends nothing more.
warp 259201 # three days and a second
# A keeper that cannot pay for the transaction says so loudly, with the reason, and the round stays unsettled.
cast rpc --rpc-url "$RPC" anvil_setBalance "$BROKE" 0x0 >/dev/null
RC=0
OUT="$(KEEPER_KEYSTORE="$KS/broke" keeper 2>&1)" || RC=$?
[[ "$OUT" == *"ERROR: settle(round 1)"* ]] || fail "an unfunded keeper did not log a loud error: $OUT"
expect "an unfunded keeper exits non-zero for cron to alert on" "$RC" "1"
expect "an unfunded keeper settles nothing" "$(settled_of 1)" "false"
KEEPER_KEYSTORE="$KS/keeper" keeper >/dev/null
expect "the keeper settles a closed round" "$(settled_of 1)" "true"
N2="$(nonce_of)"
KEEPER_KEYSTORE="$KS/keeper" keeper >/dev/null
expect "a settled round gets no second transaction" "$(nonce_of)" "$N2"

# 7. Both sides collect and the round's ledgers end at zero.
cast send "$MARKET" "claimQuote(uint256,address)" 1 "$FOUNDER" --private-key "$FOUNDER_PK" --rpc-url "$RPC" >/dev/null
cast send "$MARKET" "claimQuote(uint256,address)" 1 "$BIDDER" --private-key "$BIDDER_PK" --rpc-url "$RPC" >/dev/null
cast send "$MARKET" "claimShares(uint256,address)" 1 "$BIDDER" --private-key "$BIDDER_PK" --rpc-url "$RPC" >/dev/null
expect "settle returned no Shares: the seller's unsold lot waits in the vault" "$(call "$MARKET" "sharesIn(uint256)(uint256)" 1 | num 1)" "1000000000000000000"
cast send "$MARKET" "claimShares(uint256,address)" 1 "$FOUNDER" --private-key "$BIDDER_PK" --rpc-url "$RPC" >/dev/null # anyone may send it
expect "the quote ledger ends at zero" "$(call "$MARKET" "quoteIn(uint256)(uint256)" 1 | num 1)" "0"
expect "the Shares ledger ends at zero" "$(call "$MARKET" "sharesIn(uint256)(uint256)" 1 | num 1)" "0"
expect "the buyer holds the two lots" "$(call "$SHARES" "balanceOf(address)(uint256)" "$BIDDER" | num 1)" "2000000000000000000"

# 8. A week later round 2 opens; nobody settles, it passes its deadline, and the keeper sends nothing for a void round.
warp 604800
KEEPER_KEYSTORE="$KS/keeper" KEEPER_OPEN=1 keeper >/dev/null
expect "a week after the last opening the keeper opens the next round" "$(rounds_count)" "2"
warp 432001 # past the settle deadline (three days of bidding, two to settle) with nobody settling
N3="$(nonce_of)"
KEEPER_KEYSTORE="$KS/keeper" keeper >/dev/null
expect "the keeper sends nothing for a void round" "$(nonce_of)" "$N3"
expect "and the round stays unsettled" "$(settled_of 2)" "false"

step "PASS secondary-keeper-e2e: opens only when told to, settles inside the window, never sends a doomed transaction"
