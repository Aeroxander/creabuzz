#!/usr/bin/env bash
# chain-loop-e2e.sh — the chain reader's real-server loop (plan v2, milestone 5, parts 1 and 2).
#
# Starts a local chain (anvil), deploys contracts/next from the built artifacts in contracts/next/out (no compiling) into
# the milestone 2 test world (the quote token, the 3% fee controller, MinBid, a mock auction strategy and pool guard, Parts,
# the Launcher), starts the real relay on a scratch database with the chain reader on, and runs one project through
# launch and a backing round with two backers (alice 2,400 and bob 100 at the lowest price). Nobody closes or settles the
# round: the relay's helper job does (BUZZ_CHAIN_HELPER_KEY, anvil's account 4), and the loop checks both transactions
# came from the helper's address and that no helper job ended failed. It then reads
# the relay-signed "project numbers" record (kind 39009) over a NIP-98 signed POST /query and checks:
#   - total raised 2,500 against the 10,000 cap, stage Backed, the price 333,333.33, both receipts;
#   - bob's refund in the record equals Rounds.refundable(1, bob) read from the chain at the record's block, on day 0
#     and on day 45 with check-ins every 10 days (58,639,010: 58.64 of each 100, the milestone 4 worked number);
#   - only blocks two below the head count (BUZZ_CHAIN_CONFIRMATIONS=2; checked against the head, since the helper's own
#     transactions mine blocks too);
#   - bob's refund shows in the record, and after the chain rolls that block back (anvil evm_snapshot / evm_revert, deeper
#     than the confirmations) its row is deleted and the record is signed again without it;
#   - the helper keeps working after the rollback takes its own transactions away;
#   - a posted copy of the record is refused (POST /events).
#
# Needs: anvil and cast (FOUNDRY_BIN or PATH), psql, redis-server or a running Redis, node with web/node_modules
# (nostr-tools), jq, openssl. Builds nothing unless the relay binary is missing: run `cargo build -p buzz-relay` first.
# Uses anvil's well-known development keys (accounts 0 to 4) only. Drops its scratch database and stops what it started.
#
# Env: POSTGRES_ADMIN_URL (default postgres://buzz:buzz_dev@127.0.0.1:5432/postgres), REDIS_URL, RELAY_BIN,
#      FOUNDRY_BIN, KEEP_DB=1 (keep the scratch database), RELAY_LOG_COPY=<file>.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\033[36m[chain-loop]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[chain-loop] %s\033[0m\n' "$*" >&2; exit 2; }
ok() { printf '\033[32m[chain-loop] ok\033[0m %s\n' "$*"; }

[[ -n "${FOUNDRY_BIN:-}" ]] && PATH="$FOUNDRY_BIN:$PATH"
for tool in anvil cast psql curl node jq openssl python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on PATH"
done

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@127.0.0.1:5432/postgres}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
RELAY_BIN="${RELAY_BIN:-target/debug/buzz-relay}"
OUT=contracts/next/out
DB="buzz_chain_loop_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
ANVIL_PID=""
RELAY_PID=""
REDIS_PID=""

stop_pid() { [[ -n "$1" ]] && kill "$1" 2>/dev/null && wait "$1" 2>/dev/null; }
cleanup() {
  trap - EXIT
  stop_pid "$RELAY_PID"
  stop_pid "$ANVIL_PID"
  stop_pid "$REDIS_PID"
  [[ -n "${RELAY_LOG_COPY:-}" && -f "$STATE/relay.log" ]] && cp "$STATE/relay.log" "$RELAY_LOG_COPY"
  if [[ "${KEEP_DB:-}" == "1" ]]; then
    echo "[chain-loop] kept the scratch database: $DB_URL" >&2
  else
    psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1
  fi
  rm -rf "$STATE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }

[[ -x "$RELAY_BIN" ]] || fail "no relay at $RELAY_BIN (run: cargo build -p buzz-relay)"
psql "$ADMIN_URL" -qAtc 'select 1' >/dev/null 2>&1 || fail "Postgres is not answering at $ADMIN_URL (pg_ctlcluster 16 main start)"
if [[ "$(redis-cli -u "$REDIS_URL" ping 2>/dev/null)" != "PONG" ]]; then
  port="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).port or 6379)' "$REDIS_URL")"
  redis-server --port "$port" --save '' --appendonly no >"$STATE/redis.log" 2>&1 &
  REDIS_PID=$!
  sleep 1
fi

# ── the chain ──────────────────────────────────────────────────────────────────────────────────────────────────────────
CHAIN_PORT="$(free_port)"
RPC="http://127.0.0.1:$CHAIN_PORT"
anvil --port "$CHAIN_PORT" --chain-id 31337 --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 30); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || fail "anvil did not start"

# anvil's well-known development accounts 0 to 3 (public test keys, never used anywhere real)
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # deployer, admin, platform
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # founder
K2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a   # alice
K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6   # bob
K4=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a   # the relay's helper
A0="$(cast wallet address "$K0")"; FOUNDER="$(cast wallet address "$K1")"
ALICE="$(cast wallet address "$K2")"; BOB="$(cast wallet address "$K3")"
HELPER="$(cast wallet address "$K4" | tr 'A-F' 'a-f')"
STAKE=0x000000000000000000000000000000000000057a

code_of() { jq -r '.bytecode.object' "$OUT/$1"; }
deploy() { # artifact, constructor signature (or ""), args...
  local artifact="$1" sig="$2"; shift 2
  local data; data="$(code_of "$artifact")"
  [[ -n "$sig" ]] && data="$data$(cast abi-encode "$sig" "$@" | cut -c3-)"
  cast send --rpc-url "$RPC" --private-key "$K0" --create "$data" --json | jq -r '.contractAddress'
}
send() { # key, to, signature, args...
  local key="$1" to="$2"; shift 2
  local status; status="$(cast send --rpc-url "$RPC" --private-key "$key" "$to" "$@" --json | jq -r '.status')"
  [[ "$status" == "0x1" ]] || fail "transaction failed: $to $*"
}
at_time() { cast rpc --rpc-url "$RPC" evm_setNextBlockTimestamp "$1" >/dev/null; }
mine() { cast rpc --rpc-url "$RPC" evm_mine >/dev/null; }
now_block() { cast block-number --rpc-url "$RPC"; }

step "deploying contracts/next from $OUT on anvil :$CHAIN_PORT"
USD="$(deploy QuoteToken.sol/QuoteToken.json "")"
FEES="$(deploy FixedFeeController.sol/FixedFeeController.json "constructor(address,uint24)" "$A0" 30000)"
MINBID="$(deploy MinBid.sol/MinBid.json "constructor(uint128,uint256,uint64)" 1000000 4 720)"
FACTORY="$(deploy Base.sol/MockFactory.json "constructor(address)" "$FEES")"
STRATEGY="$(deploy MockStrategy.sol/MockStrategy.json "constructor(address,address,address)" \
  0x000000000000000000000000000000000000b001 0x000000000000000000000000000000000000b002 "$FACTORY")"
# The pool guard must sit at an address whose low 14 bits ask only for beforeInitialize (0x2000): place its code there and
# set `authorized` (storage slot 0) to the strategy, as the tests' deployCodeTo does.
GUARD=0x0000000000000000000000000000000a11ce2000
cast rpc --rpc-url "$RPC" anvil_setCode "$GUARD" "$(jq -r '.deployedBytecode.object' "$OUT/MockGuard.sol/MockGuard.json")" >/dev/null
cast rpc --rpc-url "$RPC" anvil_setStorageAt "$GUARD" 0x0 "$(cast abi-encode 'f(address)' "$STRATEGY")" >/dev/null
[[ "$(cast call --rpc-url "$RPC" "$GUARD" 'authorized()(address)')" == "$(cast to-check-sum-address "$STRATEGY")" ]] \
  || fail "the guard does not name the strategy"
PARTS="$(deploy Parts.sol/Parts.json "")"
LAUNCHER="$(deploy Launcher.sol/Launcher.json \
  "constructor(address,(address,address,address,uint16,uint16,uint16,uint16,uint128,uint128),address,address,address,address,address)" \
  "$A0" "($USD,$A0,$STAKE,500,100,15,60,25000000,1000000000000000000000000)" \
  "$STRATEGY" "$GUARD" "$MINBID" "$PARTS" 0x0000000000000000000000000000000000000000)"
[[ "$LAUNCHER" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the Launcher did not deploy"
START_BLOCK="$(now_block)"
ok "Launcher $LAUNCHER at block $START_BLOCK"

# ── the relay ──────────────────────────────────────────────────────────────────────────────────────────────────────────
PORT="$(free_port)"; HEALTH="$(free_port)"; METRICS="$(free_port)"
BASE="http://localhost:$PORT"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database"
cp "$RELAY_BIN" "$STATE/buzz-relay"
step "starting the relay on :$PORT with the chain reader (2 confirmations, 1 s passes) and the helper ($HELPER)"
env DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" BUZZ_AUTO_MIGRATE=true \
  BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="127.0.0.1:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" BUZZ_GIT_CONFORMANCE_PROBE=false \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false \
  BUZZ_CHAIN_RPC_URL="$RPC" BUZZ_CHAIN_ID=31337 BUZZ_CHAIN_LAUNCHER="$LAUNCHER" BUZZ_CHAIN_START_BLOCK="$START_BLOCK" \
  BUZZ_CHAIN_CONFIRMATIONS=2 BUZZ_CHAIN_POLL_SECS=1 BUZZ_CHAIN_REFRESH_SECS=60 \
  BUZZ_CHAIN_HELPER_KEY="$K4" BUZZ_CHAIN_HELPER_DAILY_GAS=30000000 BUZZ_CHAIN_HELPER_DAILY_SPEND_WEI=1000000000000000000 \
  "$STATE/buzz-relay" >"$STATE/relay.log" 2>&1 &
RELAY_PID=$!
relay_up() { curl -fsS -m 2 -H 'Accept: application/nostr+json' "$BASE/" >/dev/null 2>&1; }
for _ in $(seq 1 120); do
  relay_up && break
  kill -0 "$RELAY_PID" 2>/dev/null || { tail -30 "$STATE/relay.log" >&2; fail "the relay exited"; }
  sleep 1
done
relay_up || { tail -30 "$STATE/relay.log" >&2; fail "the relay did not come up"; }
grep -q '"chain reader started"' "$STATE/relay.log" || fail "the chain reader did not start"
grep -q '"chain helper on"' "$STATE/relay.log" || fail "the chain helper did not start"

# ── one project: launch, a round with two backers; the helper closes and settles ─────────────────────────────────
PROJECT_ID="$(cast keccak 'chain loop project')"
step "launching a project and running a backing round"
send "$K1" "$LAUNCHER" "launch(bytes32,string,string,bytes32)" "$PROJECT_ID" "Chain Loop" "LOOP" \
  "$(cast call --rpc-url "$RPC" "$LAUNCHER" 'settingsHash()(bytes32)')"
KEY="$(cast call --rpc-url "$RPC" "$LAUNCHER" 'keyOf(address,bytes32)(bytes32)' "$FOUNDER" "$PROJECT_ID")"
PROJECT="$(cast call --rpc-url "$RPC" "$LAUNCHER" 'projectByKey(bytes32)((address,address,address,address,address,address,uint64))' "$KEY")"
TREASURY="$(echo "$PROJECT" | tr -d '()' | cut -d, -f3 | tr -d ' ')"
ROUNDS="$(echo "$PROJECT" | tr -d '()' | cut -d, -f6 | tr -d ' ')"
send "$K1" "$TREASURY" "checkIn()"
send "$K1" "$LAUNCHER" "openRound(bytes32,uint256)" "$KEY" 3000000000000000
for who in "$K2:$ALICE:2400000000" "$K3:$BOB:100000000"; do
  IFS=: read -r key addr amount <<<"$who"
  send "$K0" "$USD" "mint(address,uint256)" "$addr" "$amount"
  send "$key" "$USD" "approve(address,uint256)" "$ROUNDS" "$amount"
  send "$key" "$ROUNDS" "ask(uint256,uint256)" 1 "$amount"
done
OPENED_AT="$(cast call --rpc-url "$RPC" "$ROUNDS" 'roundOf(uint256)((uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint256))' 1 | tr -d '()' | cut -d, -f1 | awk '{print $1}')"
CLOSE_AT=$((OPENED_AT + 86400))
at_time "$CLOSE_AT"
mine
step "nobody presses: the chain moves on (empty blocks) until the helper has closed and settled the round"
position_settled() { # backer -> true/false
  cast call --rpc-url "$RPC" "$ROUNDS" 'positionOf(uint256,address)((uint256,uint256,uint256,bool))' 1 "$1" \
    | tr -d '()' | cut -d, -f4 | tr -d ' '
}
CLOSED=""
for _ in $(seq 1 90); do
  CLOSED_AT="$(cast call --rpc-url "$RPC" "$ROUNDS" 'roundOf(uint256)((uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint256))' 1 | tr -d '()' | cut -d, -f2 | awk '{print $1}')"
  if [[ "$CLOSED_AT" != "0" && "$(position_settled "$ALICE")" == "true" && "$(position_settled "$BOB")" == "true" ]]; then
    CLOSED=1; break
  fi
  mine; sleep 1
done
[[ -n "$CLOSED" ]] || { grep 'chain helper' "$STATE/relay.log" | tail -20 >&2; fail "the helper did not close and settle the round"; }
helper_tx() { # call -> tx hashes of its done jobs
  psql "$DB_URL" -Atc "select '0x' || encode(tx_hash, 'hex') from chain_helper_jobs where call = '$1' and state = 'done' order by id"
}
CLOSE_TX="$(helper_tx rounds.close)"
SETTLE_TXS="$(helper_tx rounds.settleMany)"
[[ -n "$CLOSE_TX" && -n "$SETTLE_TXS" ]] || fail "no done close and settle jobs in chain_helper_jobs"
for tx in $CLOSE_TX $SETTLE_TXS; do
  from="$(cast tx --rpc-url "$RPC" "$tx" from | tr 'A-F' 'a-f')"
  [[ "$from" == "$HELPER" ]] || fail "transaction $tx came from $from, not the helper $HELPER"
done
SETTLED_BLOCK="$(cast receipt --rpc-url "$RPC" "$(echo "$SETTLE_TXS" | tail -1)" blockNumber)"
ok "the helper closed the round (tx $CLOSE_TX) and settled both backers in $(echo "$SETTLE_TXS" | wc -l) transaction(s), block $SETTLED_BLOCK"

# Only final blocks count: the record is never newer than the head less two.
PRE="$(node scripts/chain-loop-query.mjs read "$BASE" "$KEY" version=1)" || fail "no record after the launch"
HEAD_NOW="$(now_block)"
[[ "$(echo "$PRE" | jq -r '.content.asOf.block')" -le $((HEAD_NOW - 2)) ]] || fail "the record counts blocks under the confirmation depth"
ok "the record is as of block $(echo "$PRE" | jq -r '.content.asOf.block') with the head at $HEAD_NOW"
mine; mine

DAY0="$(node scripts/chain-loop-query.mjs read "$BASE" "$KEY" rounds.0.settled=2)" || fail "the record did not reach the settled round"
DAY0_BLOCK="$(echo "$DAY0" | jq -r '.content.asOf.block')"
[[ "$DAY0_BLOCK" -ge "$SETTLED_BLOCK" ]] || fail "the settled record is as of $DAY0_BLOCK, before the settle in $SETTLED_BLOCK"
check() { # label, jq path, expected
  local got; got="$(echo "$DAY0" | jq -r "$2")"
  [[ "$got" == "$3" ]] || fail "$1: expected $3, got $got"
  ok "$1: $got"
}
check "signed by the relay" '.event.pubkey | length' 64
check "total raised" '.content.raised.total' 2500000000
check "against the cap" '.content.raised.cap' 10000000000
check "stage" '.content.stage.name' backed
check "round price for the whole project" '.content.rounds[0].projectPrice' 333333.33
check "average price" '.content.averagePrice.projectPrice' 333333.33
check "receipts" '.content.receiptCount' 2
check "held Shares for alice" ".content.holders[] | select(.account == \"$(echo "$ALICE" | tr 'A-F' 'a-f')\") | .held" 7200000000000000000000000
DAY0_REFUND="$(echo "$DAY0" | jq -r ".content.now.refunds[] | select(.backer == \"$(echo "$BOB" | tr 'A-F' 'a-f')\") | .refundable")"
CHAIN_REFUND="$(cast call --rpc-url "$RPC" --block "$DAY0_BLOCK" "$ROUNDS" 'refundable(uint256,address)(uint256)' 1 "$BOB" | awk '{print $1}')"
[[ "$DAY0_REFUND" == "$CHAIN_REFUND" ]] || fail "day 0: the record says $DAY0_REFUND, the chain $CHAIN_REFUND"
ok "day 0 refund for bob: $DAY0_REFUND (chain: $CHAIN_REFUND; per 100: $(echo "$DAY0" | jq -r ".content.now.refunds[] | select(.backer == \"$(echo "$BOB" | tr 'A-F' 'a-f')\") | .per100"))"
echo "$DAY0" | jq '.content' >"$STATE/day0.json"

# ── day 45, check-ins every 10 days ──────────────────────────────────────────────────────────────────────────────────
step "checking in every 10 days to day 45"
for day in 10 20 30 40 45; do
  at_time $((CLOSE_AT + day * 86400))
  send "$K1" "$TREASURY" "checkIn()"
done
DAY45_BLOCK="$(now_block)"
DAY45_LAST="$(cast call --rpc-url "$RPC" "$TREASURY" 'lastCheckIn()(uint256)' | awk '{print $1}')"
mine; mine
DAY45="$(node scripts/chain-loop-query.mjs read "$BASE" "$KEY" clock.lastCheckIn="$DAY45_LAST")" || fail "no day-45 record"
DAY45_BLOCK="$(echo "$DAY45" | jq -r '.content.asOf.block')"
BOB_LC="$(echo "$BOB" | tr 'A-F' 'a-f')"
R45="$(echo "$DAY45" | jq -r ".content.now.refunds[] | select(.backer == \"$BOB_LC\") | .refundable")"
P45="$(echo "$DAY45" | jq -r ".content.now.refunds[] | select(.backer == \"$BOB_LC\") | .per100")"
C45="$(cast call --rpc-url "$RPC" --block "$DAY45_BLOCK" "$ROUNDS" 'refundable(uint256,address)(uint256)' 1 "$BOB" | awk '{print $1}')"
[[ "$R45" == "$C45" ]] || fail "day 45: the record says $R45, the chain $C45"
# The helper's own transactions (the weekly release, the fee sweep) can take a check-in's planned second, so the raw
# number may move by a few units; 58,639,010 when the check-ins kept their seconds. The per 100 is pinned.
[[ "$P45" == "58.64" ]] || fail "day 45: expected 58.64 of each 100, got $R45 ($P45)"
ok "day 45 refund for bob: $R45 = chain $C45 ($P45 of each 100; the worked number is 58639010)"
SIGNED="$(psql "$DB_URL" -Atc "select count(*) from chain_project_numbers")"
LOGS="$(psql "$DB_URL" -Atc "select count(*) from chain_logs")"
ok "tables: $LOGS logs, $SIGNED project record(s)"

# ── a chain rollback deeper than the confirmations ─────────────────────────────────────────────────────────────────
step "bob takes his money back, then the chain rolls that block back (deeper than the 2 confirmations)"
SNAP="$(cast rpc --rpc-url "$RPC" evm_snapshot | tr -d '"')"
send "$K3" "$ROUNDS" "refund(uint256)" 1
REFUND_BLOCK="$(now_block)"
PAID="$(cast call --rpc-url "$RPC" "$USD" 'balanceOf(address)(uint256)' "$BOB" | awk '{print $1}')"
mine; mine
GONE="$(node scripts/chain-loop-query.mjs read "$BASE" "$KEY" treasury.refundsPaid="$PAID")" || fail "the refund did not reach the record"
[[ "$(echo "$GONE" | jq -r ".content.now.refunds[] | select(.backer == \"$BOB_LC\") | .refundable")" == "0" ]] \
  || fail "after the refund the record still offers bob a refund"
ok "block $REFUND_BLOCK: bob took back $PAID; the record shows it and offers him nothing more"
cast rpc --rpc-url "$RPC" evm_revert "$SNAP" >/dev/null
# A different first block at the same height (a check-in instead of the refund), then enough blocks to be final.
send "$K1" "$TREASURY" "checkIn()"
mine; mine; mine
BACK="$(node scripts/chain-loop-query.mjs read "$BASE" "$KEY" treasury.refundsPaid=undefined)" \
  || fail "the record still counts the refund that left the chain"
[[ "$(echo "$BACK" | jq -r ".content.now.refunds[] | select(.backer == \"$BOB_LC\") | .refundable")" != "0" ]] \
  || fail "after the rollback bob's refund is not offered again"
[[ "$(psql "$DB_URL" -Atc "select count(*) from chain_logs where event = 'Refunded'")" == "0" ]] \
  || fail "the refund's row survived the rollback"
grep -q "chain rolled back" "$STATE/relay.log" || fail "the relay did not log the rollback"
BACK_BLOCK="$(echo "$BACK" | jq -r '.content.asOf.block')"
BACK_REFUND="$(echo "$BACK" | jq -r ".content.now.refunds[] | select(.backer == \"$BOB_LC\") | .refundable")"
BACK_CHAIN="$(cast call --rpc-url "$RPC" --block "$BACK_BLOCK" "$ROUNDS" 'refundable(uint256,address)(uint256)' 1 "$BOB" | awk '{print $1}')"
[[ "$BACK_REFUND" == "$BACK_CHAIN" ]] || fail "after the rollback the record says $BACK_REFUND, the chain $BACK_CHAIN at block $BACK_BLOCK"
ok "rolled back: the refund's row is gone, the record offers bob $BACK_REFUND again (chain: $BACK_CHAIN at block $BACK_BLOCK)"

# The helper lives through the rollback (its transactions in the dropped blocks vanish) and no job ended failed.
mine; mine; sleep 3
kill -0 "$RELAY_PID" 2>/dev/null || fail "the relay stopped"
FAILED_JOBS="$(psql "$DB_URL" -Atc "select count(*) from chain_helper_jobs where state = 'failed'")"
[[ "$FAILED_JOBS" == "0" ]] || { psql "$DB_URL" -Atc "select call, last_error from chain_helper_jobs where state = 'failed'" >&2; fail "$FAILED_JOBS helper job(s) failed"; }
JOBS="$(psql "$DB_URL" -Atc "select call || ':' || state from chain_helper_jobs order by id" | tr '\n' ' ')"
SENDS="$(psql "$DB_URL" -Atc "select count(*) || ' sent, ' || coalesce(sum(gas_used), 0) || ' gas' from chain_helper_sends")"
ok "helper: $SENDS; jobs: $JOBS"

# ── a posted copy is refused ──────────────────────────────────────────────────────────────────────────────────────
node scripts/chain-loop-query.mjs forge "$BASE" "$KEY" >/dev/null || fail "a posted project numbers record was not refused"
ok "a posted copy of the record is refused (relay-only kind)"

[[ -n "${CHAIN_LOOP_RECORD:-}" ]] && echo "$DAY45" | jq '.content' >"$CHAIN_LOOP_RECORD"
step "every check passed"
