#!/usr/bin/env bash
# Runtime proof, LOCAL ANVIL ONLY, that the new creation version deploys and launches inside the real
# EVM limits (EIP-3860 creation size, EIP-170 runtime size). Foundry's test VM waives both for `new`,
# so a passing unit test is not evidence; this starts its own anvil, sends every deployment and the
# launch as real transactions, then reads everything back from the node with `cast`.
#
# Safety: loopback only (127.0.0.1), chain id 31337, well-known anvil fixture keys hardcoded below,
# no .env read, no stored wallet, no real funds. It kills only the anvil process it started (captured
# PID, `trap` on exit) — never `pkill`, never a port it did not bind. Its scratch directory (under $TMPDIR, or
# /tmp) is removed on exit; set V5_FIXTURE_KEEP_RUN=1 to keep it for inspection.
#
# Demo mode (V5_DEMO=1, see scripts/v5-demo-world.sh) publishes launch records signed with the public anvil
# founder key, so it only talks to a relay on this machine unless V5_DEMO_ALLOW_REMOTE_RELAY=1 says otherwise.
# Self-test: scripts/test-v5-local-fixture.sh.
#
# Trading stays off. V5_FIXTURE_TRADE=1 additionally plays one part-filled round on this scratch chain and proves the
# seller's unsold lots are returned by claimShares (once), not by settle.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }

for TOOL in anvil cast forge jq python3 curl; do
  command -v "$TOOL" >/dev/null || fail "missing tool: $TOOL"
done

# --- demo mode only talks to a relay on this machine (checked before anything starts) ----------
if [[ "${V5_DEMO:-}" == "1" && "${V5_DEMO_ALLOW_REMOTE_RELAY:-}" != "1" ]]; then
  [[ "${V5_DEMO_RELAY:-http://127.0.0.1:3030}" =~ ^https?://(127\.[0-9]+\.[0-9]+\.[0-9]+|localhost|\[::1\])(:[0-9]+)?(/|$) ]] \
    || fail "V5_DEMO_RELAY must be a relay on this machine (127.x.x.x, localhost or [::1]); this demo signs launch records with a public key. Set V5_DEMO_ALLOW_REMOTE_RELAY=1 to override."
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONTRACTS="$ROOT/contracts"
RUN=$(mktemp -d "${TMPDIR:-/tmp}/v5-local-fixture.XXXXXX")
ANVIL_PID=""

# Stops what this script started and removes its scratch directory. Installed before anything is started, so it
# is safe at any point. INT and TERM exit (a signal trap that returns would resume the interrupted command), and
# the EXIT trap then runs this.
cleanup() {
  if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
  [[ "${V5_FIXTURE_KEEP_RUN:-}" == "1" ]] || rm -rf "$RUN"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Build output stays out of the worktree.
export FOUNDRY_OUT="$RUN/out"
export FOUNDRY_CACHE_PATH="$RUN/cache"
export FOUNDRY_BROADCAST="$RUN/broadcast"
mkdir -p "$FOUNDRY_OUT" "$FOUNDRY_CACHE_PATH" "$FOUNDRY_BROADCAST"

MAX_INITCODE=49152
MAX_RUNTIME=24576

# Well-known anvil fixture keys (the public test mnemonic). Never a real wallet.
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
FOUNDER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
REVIEWER_A=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC # anvil account 2
REVIEWER_B=0x90F79bf6EB2c4f870365E785982E1f101E93b906 # anvil account 3
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266       # anvil account 0
FOUNDER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8        # anvil account 1

# --- a free high loopback port, then anvil bound to exactly that port -------------------------
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
# Foundry's HTTP client panics in this sandbox (macOS system-configuration returns NULL), so the
# same node is reached over its WebSocket transport: same JSON-RPC, same anvil, no proxy machinery.
RPC="ws://127.0.0.1:$PORT"

anvil --host 127.0.0.1 --port "$PORT" --chain-id 31337 --silent >"$RUN/anvil.log" 2>&1 &
ANVIL_PID=$!

for _ in $(seq 1 100); do
  if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
CHAIN_ID=$(cast chain-id --rpc-url "$RPC") || fail "anvil never answered on $RPC"
[ "$CHAIN_ID" = "31337" ] || fail "not a local anvil chain (chain id $CHAIN_ID)"
# anvil starts at block 0; `ActivationVoting` uses 0 as its "never initialized" sentinel and refuses
# `configureSecondary` at block 0 (`initBlock == 0`). Every real chain is past genesis, so mine two
# blocks first instead of weakening that guard.
cast rpc --rpc-url "$RPC" anvil_mine 0x2 >/dev/null
BLOCK=$(cast block-number --rpc-url "$RPC")
[ "$BLOCK" -ge 2 ] || fail "anvil is still at block $BLOCK"
echo "anvil pid $ANVIL_PID on $RPC (chain id $CHAIN_ID, block $BLOCK)"

# --- the fixture: deployments 1..6, then the founder's launch, as real transactions ----------
V5_DEPLOYER_PK="$DEPLOYER_PK" V5_FOUNDER_PK="$FOUNDER_PK" \
V5_REVIEWER_A="$REVIEWER_A" V5_REVIEWER_B="$REVIEWER_B" \
  forge script "$CONTRACTS/script/V5LocalFixture.s.sol:V5LocalFixture" \
    --root "$CONTRACTS" --rpc-url "$RPC" --sender "$DEPLOYER" --broadcast --offline -vv \
  2>&1 | tee "$RUN/script.log"

SUMMARY=$(grep -o 'FIXTURE_JSON {.*}' "$RUN/script.log" | head -1 | sed 's/^FIXTURE_JSON //')
[ -n "$SUMMARY" ] || fail "the fixture did not print its summary line"
echo "$SUMMARY" | jq . >"$RUN/summary.json"
# One address out of the summary; a missing key (jq's "null") or anything but an address stops the run, naming the key.
addr() {
  local value
  value=$(echo "$SUMMARY" | jq -r ".$1 // empty")
  [[ "$value" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the fixture summary has no address for '$1' (got '$value')"
  echo "$value"
}

KIT=$(addr kit)
MARKET_FACTORY=$(addr marketFactory)
SUMMONER=$(addr summoner)
POLICY_IMPL=$(addr policyImplementation)
MANDATE_FACTORY=$(addr mandateFactory)
QUOTE=$(addr quote)
DAO=$(addr dao)
BUDGET=$(addr budget)
POLICY=$(addr policy)
SHARES=$(addr shares)
MARKET=$(addr market)

# --- every receipt the node kept must be status 1 --------------------------------------------
BCAST="$FOUNDRY_BROADCAST/V5LocalFixture.s.sol/31337/run-latest.json"
[ -f "$BCAST" ] || fail "no broadcast log at $BCAST"
echo
echo "=== receipts (read from the node) ==="
TXS=$(jq -r '.receipts[].transactionHash' "$BCAST")
[ -n "$TXS" ] || fail "the broadcast log has no receipts"
COUNT=0
for HASH in $TXS; do
  STATUS=$(cast receipt --rpc-url "$RPC" "$HASH" --json | jq -r '.status')
  [ "$STATUS" = "0x1" ] || fail "receipt $HASH status $STATUS"
  echo "  $HASH status=$STATUS"
  COUNT=$((COUNT + 1))
done
echo "  all $COUNT receipts status=1"

# --- creation payload sizes, measured from the node's own transactions ------------------------
echo
echo "=== creation payloads as the node received them (EIP-3860 limit $MAX_INITCODE) ==="
while read -r IDX HASH NAME; do
  INPUT=$(cast tx --rpc-url "$RPC" "$HASH" input)
  BYTES=$(( (${#INPUT} - 2) / 2 ))
  [ "$BYTES" -le "$MAX_INITCODE" ] || fail "$NAME creation payload $BYTES bytes over EIP-3860"
  printf '  %-28s %6s bytes  %s\n' "$NAME" "$BYTES" "$HASH"
done < <(jq -r '.transactions as $t | .receipts | to_entries[]
  | select(.value.contractAddress != null)
  | "\(.key) \(.value.transactionHash) \($t[.key].contractName)"' "$BCAST")

# --- runtime sizes, measured from the node's state -------------------------------------------
echo
echo "=== runtime code as the node holds it (EIP-170 limit $MAX_RUNTIME) ==="
runtime_check() {
  local label=$1 target=$2 size
  size=$(cast codesize --rpc-url "$RPC" "$target")
  [ "$size" -ne 0 ] || fail "$label: no code at $target"
  [ "$size" -le "$MAX_RUNTIME" ] || fail "$label: runtime $size bytes over EIP-170"
  printf '  %-28s %6s bytes  %s\n' "$label" "$size" "$target"
}
runtime_check "ContributorKitV2" "$KIT"
runtime_check "SecondaryMarketFactory" "$MARKET_FACTORY"
runtime_check "SecondaryMarket" "$MARKET"
runtime_check "Summoner" "$SUMMONER"
runtime_check "ActivationVoting (impl)" "$POLICY_IMPL"
runtime_check "TreasuryMandateFactory" "$MANDATE_FACTORY"
runtime_check "Moloch (impl)" "$(cast call --rpc-url "$RPC" "$SUMMONER" 'getImplementation()(address)')"
runtime_check "Shares (impl)" "$(cast call --rpc-url "$RPC" "$KIT" 'sharesImplementation()(address)')"
runtime_check "dao (clone)" "$DAO"
runtime_check "shares (clone)" "$SHARES"
runtime_check "policy (clone)" "$POLICY"
runtime_check "work budget" "$BUDGET"

# --- read-back, independently from the node --------------------------------------------------
echo
echo "=== read-back from the node (not from the script's memory) ==="
C() { cast call --rpc-url "$RPC" "$@"; }
# `cast call` appends a human-readable hint like " [2e20]" to numbers; strip it and keep the value.
strip() { sed -E 's/ \[[^]]*\]//g'; }
num() { strip | head -1 | awk '{print $1}'; }
gt0() { awk -v v="$1" 'BEGIN { exit !(v + 0 > 0) }'; }

DAO_SHARES=$(C "$DAO" 'shares()(address)')
DAO_WEIGHT=$(C "$DAO" 'votingWeight()(address)')
MARKET_OF=$(C "$MARKET_FACTORY" 'marketOf(address)(address)' "$DAO")
M_DAO=$(C "$MARKET" 'dao()(address)')
M_SHARES=$(C "$MARKET" 'sharesToken()(address)')
M_POLICY=$(C "$MARKET" 'policy()(address)')
M_QUOTE=$(C "$MARKET" 'quote()(address)')
M_LOT=$(C "$MARKET" 'lotSize()(uint256)' | num)
LISTING=$(C "$MARKET" 'listing()(bool,uint128,uint128,uint32)' | strip | tr '\n' ' ')
ELIGIBLE=$(C "$SHARES" 'saleEligibleOf(address)(uint256,uint8)' "$FOUNDER" | strip | awk '{print $1}' | tr '\n' ' ' | sed 's/ $//')
LOCK_GUARD=$(C "$SHARES" 'lockGuard()(address)')
LOCK_GUARD_SET=$(C "$SHARES" 'lockGuardSet()(bool)')
TRANSFER_EXEMPT=$(C "$SHARES" 'transferExempt()(address)')
TRANSFERS_LOCKED=$(C "$SHARES" 'transfersLocked()(bool)')
SALE_POLICY=$(C "$SHARES" 'salePolicy()(address)')
CAPACITY=$(C "$POLICY" 'capacity(address)(uint96)' "$FOUNDER" | num)
THRESHOLD=$(C "$DAO" 'proposalThreshold()(uint96)' | num)
SALE_CAPACITY=$(C "$POLICY" 'saleCapacity(address)(uint256)' "$FOUNDER" | num)
CONFIG=$(C "$POLICY" 'secondaryConfiguration()(address,address,uint256,uint64,uint64,uint64)' | strip | tr '\n' ' ')
AUTHORIZED_KIT=$(C "$MARKET_FACTORY" 'authorizedKit()(address)')
BUDGET_DAO=$(C "$MANDATE_FACTORY" 'daos(address)(address)' "$BUDGET")
PROJECT=$(C "$BUDGET" 'projects(bytes32)(address,address,uint128,uint128,uint64,uint128,bytes32)' "$(cast keccak 'work-area:docs')" | strip | tr '\n' ' ')
PROJECT_MANAGER=$(echo "$PROJECT" | awk '{print $1}')
PROJECT_SHARES=$(echo "$PROJECT" | awk '{print $6}')

echo "  dao.shares()               $DAO_SHARES"
echo "  dao.votingWeight()         $DAO_WEIGHT"
echo "  marketFactory.marketOf     $MARKET_OF"
echo "  market.dao()               $M_DAO"
echo "  market.sharesToken()       $M_SHARES"
echo "  market.policy()            $M_POLICY"
echo "  market.quote()             $M_QUOTE"
echo "  market.lotSize()           $M_LOT"
echo "  market.listing()           $LISTING"
echo "  shares.saleEligibleOf      $ELIGIBLE"
echo "  shares.lockGuard()         $LOCK_GUARD"
echo "  shares.lockGuardSet()      $LOCK_GUARD_SET"
echo "  shares.transferExempt()    $TRANSFER_EXEMPT"
echo "  shares.transfersLocked()   $TRANSFERS_LOCKED"
echo "  shares.salePolicy()        $SALE_POLICY"
echo "  policy.capacity(founder)   $CAPACITY"
echo "  dao.proposalThreshold()    $THRESHOLD"
echo "  policy.saleCapacity        $SALE_CAPACITY"
echo "  policy.secondaryConfig     $CONFIG"
echo "  marketFactory.authKit      $AUTHORIZED_KIT"
echo "  mandateFactory.daos(bgt)   $BUDGET_DAO"
echo "  budget.projects(workArea)  $PROJECT"

# --- assertions over those on-chain reads ----------------------------------------------------
[ "$(echo "$DAO_SHARES" | tr 'A-Z' 'a-z')" = "$(echo "$SHARES" | tr 'A-Z' 'a-z')" ] || fail "dao.shares != predicted shares clone"
[ "$(echo "$DAO_WEIGHT" | tr 'A-Z' 'a-z')" = "$(echo "$POLICY" | tr 'A-Z' 'a-z')" ] || fail "dao.votingWeight != predicted policy clone"
[ "$(echo "$MARKET_OF" | tr 'A-Z' 'a-z')" = "$(echo "$MARKET" | tr 'A-Z' 'a-z')" ] || fail "marketOf(dao) != predicted market"
[ "$(echo "$M_DAO" | tr 'A-Z' 'a-z')" = "$(echo "$DAO" | tr 'A-Z' 'a-z')" ] || fail "market.dao mismatch"
[ "$(echo "$M_SHARES" | tr 'A-Z' 'a-z')" = "$(echo "$SHARES" | tr 'A-Z' 'a-z')" ] || fail "market.sharesToken mismatch"
[ "$(echo "$M_POLICY" | tr 'A-Z' 'a-z')" = "$(echo "$POLICY" | tr 'A-Z' 'a-z')" ] || fail "market.policy mismatch"
[ "$(echo "$M_QUOTE" | tr 'A-Z' 'a-z')" = "$(echo "$QUOTE" | tr 'A-Z' 'a-z')" ] || fail "market.quote mismatch"
[ "$M_LOT" = "1000000000000000000" ] || fail "market.lotSize != 1e18 ($M_LOT)"
[ "$(echo "$LISTING" | cut -d' ' -f1)" = "false" ] || fail "the listing is not disabled at birth"
[ "$ELIGIBLE" = "0 1" ] || fail "saleEligibleOf(founder) != (0, 1): $ELIGIBLE"
[ "$(echo "$LOCK_GUARD" | tr 'A-Z' 'a-z')" = "0x0000000000000000000000000000000000000000" ] || fail "lockGuard != 0"
[ "$LOCK_GUARD_SET" = "true" ] || fail "lockGuardSet != true"
[ "$(echo "$TRANSFER_EXEMPT" | tr 'A-Z' 'a-z')" = "$(echo "$MARKET" | tr 'A-Z' 'a-z')" ] || fail "transferExempt != market"
[ "$TRANSFERS_LOCKED" = "true" ] || fail "transfers are not locked at birth"
[ "$(echo "$SALE_POLICY" | tr 'A-Z' 'a-z')" = "$(echo "$POLICY" | tr 'A-Z' 'a-z')" ] || fail "salePolicy != policy"
gt0 "$CAPACITY" || fail "the founder has no governance capacity at birth"
gt0 "$THRESHOLD" || fail "the DAO's proposal threshold is zero at birth"
[ "$SALE_CAPACITY" = "0" ] || fail "the founder's sale capacity at birth != 0"
[ "$(echo "$AUTHORIZED_KIT" | tr 'A-Z' 'a-z')" = "$(echo "$KIT" | tr 'A-Z' 'a-z')" ] || fail "factory authorised another kit"
[ "$(echo "$BUDGET_DAO" | tr 'A-Z' 'a-z')" = "$(echo "$DAO" | tr 'A-Z' 'a-z')" ] || fail "the budget is not the DAO's"
[ "$(echo "$PROJECT_MANAGER" | tr 'A-Z' 'a-z')" = "$(echo "$FOUNDER" | tr 'A-Z' 'a-z')" ] || fail "the work area's manager is not the founder"
[ "$PROJECT_SHARES" = "40000000000000000000" ] || fail "the work area's share budget != 40e18 ($PROJECT_SHARES)"

echo
echo "=== artifact creation sizes printed by the fixture (incl. constructor args) ==="
grep -E 'creation bytes|EIP-3860 limit|runtime bytes|EIP-170 limit' "$RUN/script.log" || fail "no size report in the script log"

# --- opt-in: a part-filled weekly sale, on this scratch chain only ----------------------------
# Trading stays OFF in the fixture (asserted above, and in every hosted or pilot build). With V5_FIXTURE_TRADE=1 this
# turns a listing on for the throwaway anvil this script started, plays one round, and proves with real transactions
# that settling hands no Shares back (so the heaviest settle fits one transaction) and that the seller's unsold lots
# wait in the market until `claimShares` returns them exactly once.
if [[ "${V5_FIXTURE_TRADE:-}" == "1" ]]; then
  echo
  echo "=== a part-filled round on local anvil (V5_FIXTURE_TRADE=1): the remainder is collected, not pushed ==="
  BUYER="$REVIEWER_A"
  THIRD="$REVIEWER_B"
  S() { cast send --rpc-url "$RPC" --unlocked "$@" >/dev/null || fail "transaction failed: cast send $*"; }
  EQ() { python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) == int(sys.argv[2]) else 1)' "$1" "$2"; }
  CALC() { python3 -c 'import sys; print(eval(sys.argv[1]))' "$1"; }
  BAL() { C "$1" 'balanceOf(address)(uint256)' "$2" | num; }
  LOT=1000000000000000000
  # The founder's Shares sit in a 180-day schedule: warp past it so there is capacity to offer.
  cast rpc --rpc-url "$RPC" anvil_increaseTime "$(cast to-hex 17280000)" >/dev/null
  cast rpc --rpc-url "$RPC" anvil_mine 0x1 >/dev/null
  gt0 "$(C "$POLICY" 'saleCapacity(address)(uint256)' "$FOUNDER" | num)" || fail "no sale capacity after the schedule"
  S "$QUOTE" 'mint(address,uint256)' "$BUYER" 1000000000000000000000 --from "$FOUNDER"
  # `configureListing` is onlyDAO: on a local chain the DAO speaks for itself once anvil impersonates it.
  cast rpc --rpc-url "$RPC" anvil_setBalance "$DAO" 0x21e19e0c9bab2400000 >/dev/null
  cast rpc --rpc-url "$RPC" anvil_impersonateAccount "$DAO" >/dev/null
  S "$MARKET" 'configureListing(bool,uint128,uint128,uint32)' true 1000000000000000000 65000000000000000000 64 --from "$DAO"
  cast rpc --rpc-url "$RPC" anvil_stopImpersonatingAccount "$DAO" >/dev/null
  S "$MARKET" 'openRound()' --from "$FOUNDER"
  RID=$(C "$MARKET" 'roundCount()(uint256)' | num)
  [ "$RID" = "1" ] || fail "expected round 1, got $RID"
  FOUNDER_BEFORE=$(BAL "$SHARES" "$FOUNDER")
  BUYER_BEFORE=$(BAL "$SHARES" "$BUYER")
  # Three lots offered at the lowest step, one lot bid at the highest: one lot trades, two stay unsold.
  S "$SHARES" 'approve(address,uint256)' "$MARKET" "$(CALC "3 * $LOT")" --from "$FOUNDER"
  S "$MARKET" 'sell(uint256,uint128,uint16)' "$RID" 3 0 --from "$FOUNDER"
  S "$QUOTE" 'approve(address,uint256)' "$MARKET" 65000000000000000000 --from "$BUYER"
  S "$MARKET" 'bid(uint256,uint128,uint16)' "$RID" 1 64 --from "$BUYER"
  cast rpc --rpc-url "$RPC" anvil_increaseTime "$(cast to-hex 259260)" >/dev/null
  cast rpc --rpc-url "$RPC" anvil_mine 0x1 >/dev/null
  SETTLE_TX=$(cast send --rpc-url "$RPC" --unlocked --from "$THIRD" "$MARKET" 'settle(uint256)' "$RID" --json | jq -r '.transactionHash')
  SETTLE_GAS=$(cast receipt --rpc-url "$RPC" "$SETTLE_TX" --json | jq -r '.gasUsed' | xargs printf '%d')
  [ "$SETTLE_GAS" -lt 16777216 ] || fail "settle used $SETTLE_GAS gas, over the 2**24 per-transaction cap"
  echo "  settle used $SETTLE_GAS gas"
  SELL=$(C "$MARKET" 'sells(uint256,address)(uint128,uint16,uint128,uint64,bool,bool)' "$RID" "$FOUNDER" | strip | awk '{print $1}' | tr '\n' ' ')
  [ "$(echo "$SELL" | awk '{print $3}')" = "1" ] || fail "the seller did not fill exactly one lot: $SELL"
  [ "$(echo "$SELL" | awk '{print $5}')" = "false" ] || fail "settle already returned the remainder: $SELL"
  EQ "$(BAL "$SHARES" "$FOUNDER")" "$(CALC "$FOUNDER_BEFORE - 3 * $LOT")" || fail "settle moved the seller's Shares"
  EQ "$(C "$MARKET" 'sharesIn(uint256)(uint256)' "$RID" | num)" "$(CALC "3 * $LOT")" || fail "the market should still hold all three lots after settle"
  # Anyone returns the seller's two unsold lots; the seller then holds one lot fewer than before (one sold).
  S "$MARKET" 'claimShares(uint256,address)' "$RID" "$FOUNDER" --from "$THIRD"
  EQ "$(BAL "$SHARES" "$FOUNDER")" "$(CALC "$FOUNDER_BEFORE - $LOT")" || fail "claimShares did not return the two unsold lots"
  EQ "$(C "$MARKET" 'sharesIn(uint256)(uint256)' "$RID" | num)" "$LOT" || fail "only the buyer's lot should be left after the remainder is collected"
  SELL=$(C "$MARKET" 'sells(uint256,address)(uint128,uint16,uint128,uint64,bool,bool)' "$RID" "$FOUNDER" | strip | awk '{print $1}' | tr '\n' ' ')
  [ "$(echo "$SELL" | awk '{print $5}')" = "true" ] || fail "escrowReturned was not set after the remainder was collected: $SELL"
  if C "$MARKET" 'claimShares(uint256,address)' "$RID" "$FOUNDER" --from "$THIRD" >/dev/null 2>&1; then
    fail "a second claimShares for the same remainder was accepted"
  fi
  S "$MARKET" 'claimShares(uint256,address)' "$RID" "$BUYER" --from "$THIRD"
  EQ "$(BAL "$SHARES" "$BUYER")" "$(CALC "$BUYER_BEFORE + $LOT")" || fail "the buyer did not receive its lot"
  EQ "$(C "$MARKET" 'sharesIn(uint256)(uint256)' "$RID" | num)" 0 || fail "the round still holds Shares after both sides collected"
  echo "  the part-filled seller collected its two unsold lots once, and the round's Shares ledger ended at zero"
fi

echo
echo "=== cleanup ==="
if [[ "${V5_DEMO:-}" == "1" ]]; then
  # ── demo mode: keep the world up and serve the app on it ──────────────────
  RELAY="${V5_DEMO_RELAY:-http://127.0.0.1:3030}"
  WEB_PORT="${V5_DEMO_WEB_PORT:-5173}"
  curl -sf -m 3 "${RELAY}/health" >/dev/null 2>&1 \
    || fail "no relay at ${RELAY}; start one first (or set V5_DEMO_RELAY)"
  export BUZZ_RELAY_URL="$RELAY"
  export BUZZ_PRIVATE_KEY="${FOUNDER_PK#0x}"
  FOUNDER_PUB=$(node -e 'const {getPublicKey}=require(process.argv[1]+"/nostr-tools");console.log(getPublicKey(Buffer.from(process.argv[2].replace(/^0x/,""),"hex")))' \
    "$ROOT/web/node_modules" "$FOUNDER_PK")
  [[ "$FOUNDER_PUB" =~ ^[0-9a-f]{64}$ ]] || fail "could not derive the founder's public key"
  "$ROOT/target/debug/buzz" launchpad curate demo --name "Docs Demo" \
    --pitch "A local project for trying the agreed-reward flow by hand." \
    --chain 31337 --treasury "$DAO" --token "$SHARES" >/dev/null \
    || fail "could not publish the launch record"
  # The DAO really was summoned by this fixture's own launch transaction, so the
  # launch gets a truthful summon receipt pointing at that transaction: the app
  # then shows the project's governance tabs instead of the sale page.
  SUMMON_TX=$(jq -r '.receipts[-1].transactionHash' "$FOUNDRY_BROADCAST/V5LocalFixture.s.sol/31337/run-latest.json")
  [[ "$SUMMON_TX" =~ ^0x[0-9a-f]{64}$ ]] || fail "no summon transaction in the broadcast log"
  "$ROOT/target/debug/buzz" launchpad record-receipt demo --table summon --tx "$SUMMON_TX" >/dev/null \
    || fail "could not publish the summon receipt"
  # The launch record must say the project's token is a DAO's Shares, or the app
  # shows the sale page instead of the project's governance tabs. `curate` has no
  # flag for it, so the founder re-signs their own record with that field added.
  FOUNDER_PK="$FOUNDER_PK" FOUNDER_PUB="$FOUNDER_PUB" RELAY="$RELAY" \
    node "$ROOT/scripts/v5-demo-token-plan.mjs" || fail "could not set the DAO token plan on the record"
  # The factory, so the app can find this DAO's market with `marketOf(dao)`. Trading is still off:
  # the market exists from launch and sells nothing until a listing is published.
  # `exec` makes vite itself the background process, so VITE_PID is vite and not the subshell around it.
  ( cd "$ROOT/web" && VITE_LAUNCHPAD_CHAIN_ID=31337 \
      VITE_SECONDARY_MARKET_FACTORY="{\"31337\":\"$MARKET_FACTORY\"}" \
      exec node_modules/.bin/vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort \
      >"$RUN/vite.log" 2>&1 ) &
  VITE_PID=$!
  IDLE_PID=""
  cleanup_demo() {
    kill "$VITE_PID" 2>/dev/null || true
    wait "$VITE_PID" 2>/dev/null || true
    [[ -z "$IDLE_PID" ]] || kill "$IDLE_PID" 2>/dev/null || true
    cleanup
    echo
    echo "[demo] stopped (chain and web server are down)"
  }
  trap cleanup_demo EXIT
  for _ in $(seq 1 60); do
    curl -sf -m 2 "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf -m 2 "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1 \
    || { tail -20 "$RUN/vite.log"; fail "the web server did not start"; }
  cat <<INFO

────────────────────────────────────────────────────────────────────────────
Demo world is up. Ctrl-C here stops the chain and the web server.

  App          http://localhost:${WEB_PORT}/launchpad/demo?author=${FOUNDER_PUB}
  Relay        ${RELAY}   (already running; this script does not stop it)
  Chain        http://127.0.0.1:${PORT}   (chain id 31337)
  DAO          ${DAO}
  Work budget  ${BUDGET}
  Shares       ${SHARES}
  Market       ${MARKET}

  In the app's devtools console, once (this tab only):

    localStorage.setItem("buzz.relayUrl", "ws://127.0.0.1:3030");
    localStorage.setItem("buzz.launchpad.rpc", "http://127.0.0.1:${PORT}");
    location.reload();

  Anvil accounts (public dev keys, no value):
    founder      ${FOUNDER_PK}
    deployer     ${DEPLOYER_PK}

  Try: Work tab → the founder (manager of the "docs" work area) proposes a
  fixed Share reward; the beneficiary accepts; they submit once; a reviewer
  asks for changes (not a vote); the panel approves; after the challenge
  window anyone settles and the record shows the exact recipients.
────────────────────────────────────────────────────────────────────────────
INFO
  # `wait` (unlike a foreground `sleep`) returns as soon as a trapped signal arrives, so Ctrl-C stops the demo at once.
  while true; do
    sleep 30 &
    IDLE_PID=$!
    wait "$IDLE_PID" || true
  done
fi

cleanup
trap - EXIT INT TERM
if kill -0 "$ANVIL_PID" 2>/dev/null; then
  fail "anvil pid $ANVIL_PID is still alive"
fi
echo "  anvil pid $ANVIL_PID is gone"
if [[ "${V5_FIXTURE_KEEP_RUN:-}" == "1" ]]; then echo "  run directory kept: $RUN"; else echo "  run directory removed: $RUN"; fi
echo "PASS: creation version deploys and launches inside the real EVM limits on local anvil"
