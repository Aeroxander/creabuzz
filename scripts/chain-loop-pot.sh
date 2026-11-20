#!/usr/bin/env bash
# chain-loop-pot.sh: the chain reader's real-server loop on the contracts/pot money contracts (record version 2, with tasks).
#
# Starts a local chain (anvil), deploys contracts/pot with its own deploy script (play dollars, the real time unit of 7
# days), starts the real relay on a scratch database with the chain reader on, and walks one project through everything a
# person does, with `cast`: a launch, a faucet, a Back (in one transaction), a second Back (approve, then join), a check-in,
# a grant of Team Shares, an agent, a draw from the allowance, a rate raise announced, outside money, a Take out. It then
# reads the relay-signed project numbers record (kind 39009) over a NIP-98 signed POST /query and compares it with the
# contracts field by field, at the record's own block (scripts/chain-loop-pot-check.py): every number a view has must equal the
# view, and the settled pot, box and arriving money are worked forward there, independently of the server, and must equal
# the record's. Then the task queue is walked on the real 7-day unit, the chain's clock moved with evm_increaseTime: a task
# planned and withdrawn, three planned (in their notice), two taken, a Take out that writes a note, one paid in part, a claim
# made by a stranger, one sent back (the cap is given back), one that lapsed, one that runs out and is returned by the relay's
# own helper with nobody pressing, and the holder's claim of the last note. At every stop the record is compared with the
# contracts again (the task section against `taskOf`, `noteOf`, `claimableNote`, the buckets and the cap, and the settled
# numbers worked forward with the stream formula and the money of tasks that ran out). Last, a posted copy of the record is
# refused, and the record is signed again at its promised cadence.
#
# Prints one `ok` line per check and "chain-loop-pot: N checks passed." at the end. Stops what it started (anvil, the relay,
# a Redis it had to start), drops its scratch database and removes its temporary files, whatever the outcome.
#
# Needs: anvil, cast, forge (FOUNDRY_BIN or PATH), psql, a Postgres and a Redis (started here when they are not running,
# as scripts/run-tests.sh does), node with web/node_modules (nostr-tools), jq, openssl, python3, and a built relay
# (`cargo build -p buzz-relay`). Uses anvil's well-known development keys only; every amount is play money.
#
# Env: POSTGRES_ADMIN_URL (default postgres://buzz:buzz_dev@127.0.0.1:5432/postgres), REDIS_URL, RELAY_BIN,
#      FOUNDRY_BIN, KEEP_DB=1 (keep the scratch database), RELAY_LOG_COPY=<file>.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
N=0
step() { printf '\033[36m[chain-loop-pot]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[chain-loop-pot] FAIL %s\033[0m\n' "$*" >&2; exit 1; }
ok() { N=$((N + 1)); printf '\033[32m[chain-loop-pot] ok %02d\033[0m %s\n' "$N" "$*"; }

[[ -n "${FOUNDRY_BIN:-}" ]] && PATH="$FOUNDRY_BIN:$PATH"
for tool in anvil cast forge psql curl node jq openssl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "chain-loop-pot: $tool is not on PATH" >&2; exit 2; }
done

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@127.0.0.1:5432/postgres}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
RELAY_BIN="${RELAY_BIN:-target/debug/buzz-relay}"
POT="$REPO_ROOT/contracts/pot"
DB="buzz_chain_loop_pot_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
ANVIL_PID=""
RELAY_PID=""
REDIS_PID=""
STARTED_PG=""

stop_pid() { [[ -n "$1" ]] && kill "$1" 2>/dev/null && wait "$1" 2>/dev/null; return 0; }
cleanup() {
  trap - EXIT
  stop_pid "$RELAY_PID"
  stop_pid "$ANVIL_PID"
  stop_pid "$REDIS_PID"
  [[ -n "${RELAY_LOG_COPY:-}" && -f "$STATE/relay.log" ]] && cp "$STATE/relay.log" "$RELAY_LOG_COPY"
  if [[ "${KEEP_DB:-}" == "1" ]]; then
    echo "[chain-loop-pot] kept the scratch database: $DB_URL" >&2
  else
    psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1
  fi
  [[ -n "$STARTED_PG" ]] && pg_ctlcluster 16 main stop >/dev/null 2>&1
  rm -rf "$STATE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }

[[ -x "$RELAY_BIN" ]] || fail "no relay at $RELAY_BIN (run: cargo build -p buzz-relay)"
if ! psql "$ADMIN_URL" -qAtc 'select 1' >/dev/null 2>&1; then
  command -v pg_ctlcluster >/dev/null 2>&1 && pg_ctlcluster 16 main start >/dev/null 2>&1 && STARTED_PG=1
  for _ in $(seq 1 30); do psql "$ADMIN_URL" -qAtc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
fi
psql "$ADMIN_URL" -qAtc 'select 1' >/dev/null 2>&1 || fail "Postgres is not answering at $ADMIN_URL"
if [[ "$(redis-cli -u "$REDIS_URL" ping 2>/dev/null)" != "PONG" ]]; then
  port="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).port or 6379)' "$REDIS_URL")"
  redis-server --port "$port" --save '' --appendonly no >"$STATE/redis.log" 2>&1 &
  REDIS_PID=$!
  sleep 1
  [[ "$(redis-cli -u "$REDIS_URL" ping 2>/dev/null)" == "PONG" ]] || fail "Redis did not start"
fi

# ── the chain ────────────────────────────────────────────────────────────────────────────────────────────────────────
CHAIN_PORT="$(free_port)"
RPC="http://127.0.0.1:$CHAIN_PORT"
anvil --port "$CHAIN_PORT" --chain-id 31337 --accounts 14 --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || fail "anvil did not start"

# anvil's public development accounts (mnemonic "test ... junk"); the keys are derived here, none is written down
MNEMONIC="test test test test test test test test test test test junk"
key() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
K_DEPLOYER="$(key 0)"; K_FOUNDER="$(key 1)"; K_BACKER="$(key 2)"; K_PAYER="$(key 3)"; K_MEMBER="$(key 4)"
K_AGENT="$(key 5)"; K_BACKER2="$(key 6)"; K_HELPER="$(key 7)"
K_WORKER="$(key 8)"; K_WORKER2="$(key 9)"; K_BACKER3="$(key 10)"
addr() { cast wallet address --private-key "$1" | tr 'A-F' 'a-f'; }
FOUNDER="$(addr "$K_FOUNDER")"; BACKER="$(addr "$K_BACKER")"; BACKER2="$(addr "$K_BACKER2")"; PAYER="$(addr "$K_PAYER")"
MEMBER="$(addr "$K_MEMBER")"; AGENT="$(addr "$K_AGENT")"; HELPER="$(addr "$K_HELPER")"
WORKER="$(addr "$K_WORKER")"; WORKER2="$(addr "$K_WORKER2")"; BACKER3="$(addr "$K_BACKER3")"; STRANGER="$PAYER"

send() { # key, to, args...
  local k="$1" to="$2"; shift 2
  cast send --rpc-url "$RPC" --private-key "$k" --json "$to" "$@" >"$STATE/last.json" 2>"$STATE/last.err" \
    || { cat "$STATE/last.err" >&2; fail "a transaction that must succeed failed: $*"; }
  [[ "$(jq -r .status "$STATE/last.json")" == "0x1" ]] || fail "a transaction reverted: $*"
  LAST_BLOCK="$(jq -r .blockNumber "$STATE/last.json" | xargs printf '%d')"
}
call() { cast call --rpc-url "$RPC" "$@" | awk 'NR==1{print $1}'; }
warp() { cast rpc --rpc-url "$RPC" evm_increaseTime "$1" >/dev/null && cast rpc --rpc-url "$RPC" evm_mine >/dev/null; }
mine() { for _ in $(seq 1 "${1:-1}"); do cast rpc --rpc-url "$RPC" evm_mine >/dev/null; done; }
block_time() { cast block "$1" --rpc-url "$RPC" -f timestamp; }
expect_eq() { [[ "$2" == "$3" ]] || fail "$1: got $2, expected $3"; }

# ── deploy contracts/pot with its own deploy script ─────────────────────────────────────────────────────────────────
step "deploying contracts/pot on anvil :$CHAIN_PORT"
(cd "$POT" && forge script script/DeployPot.s.sol --rpc-url "$RPC" --broadcast --private-key "$K_DEPLOYER" >"$STATE/deploy.log" 2>&1) \
  || { tail -20 "$STATE/deploy.log" >&2; fail "the deploy script failed"; }
DEPLOY_JSON="$POT/deployments/pot-31337.json"
USD="$(jq -r .quote "$DEPLOY_JSON" | tr 'A-F' 'a-f')"; LAUNCHER="$(jq -r .launcher "$DEPLOY_JSON" | tr 'A-F' 'a-f')"
START_BLOCK="$(cast block-number --rpc-url "$RPC")"
[[ "$(cast code --rpc-url "$RPC" "$LAUNCHER" | wc -c)" -gt 10 ]] || fail "no code at the Launcher"
ok "deployed the play dollar $USD and the Launcher $LAUNCHER (block $START_BLOCK)"

# ── the relay, with the chain reader pointed at it ──────────────────────────────────────────────────────────────────
PORT="$(free_port)"; HEALTH="$(free_port)"; METRICS="$(free_port)"
BASE="http://localhost:$PORT"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database"
cp "$RELAY_BIN" "$STATE/buzz-relay"
step "starting the relay on :$PORT with the chain reader (2 confirmations, 1 s passes, records every 5 s while something moves, every 7 s otherwise)"
env DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" BUZZ_AUTO_MIGRATE=true \
  BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="127.0.0.1:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" BUZZ_GIT_CONFORMANCE_PROBE=false \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false \
  BUZZ_CHAIN_RPC_URL="$RPC" BUZZ_CHAIN_ID=31337 BUZZ_CHAIN_LAUNCHER="$LAUNCHER" BUZZ_CHAIN_START_BLOCK="$START_BLOCK" \
  BUZZ_CHAIN_CONFIRMATIONS=2 BUZZ_CHAIN_POLL_SECS=1 BUZZ_CHAIN_REFRESH_SECS=7 BUZZ_CHAIN_ACTIVE_REFRESH_SECS=5 \
  BUZZ_CHAIN_HELPER_KEY="$K_HELPER" BUZZ_CHAIN_HELPER_DAILY_GAS=30000000 BUZZ_CHAIN_HELPER_DAILY_SPEND_WEI=1000000000000000000 \
  "$STATE/buzz-relay" >"$STATE/relay.log" 2>&1 &
RELAY_PID=$!
relay_up() { curl -fsS -m 2 -H 'Accept: application/nostr+json' "$BASE/" >/dev/null 2>&1; }
for _ in $(seq 1 180); do
  relay_up && break
  kill -0 "$RELAY_PID" 2>/dev/null || { tail -30 "$STATE/relay.log" >&2; fail "the relay exited"; }
  sleep 1
done
relay_up || { tail -30 "$STATE/relay.log" >&2; fail "the relay did not come up"; }
grep -q '"chain reader started"\|chain reader started' "$STATE/relay.log" || fail "the chain reader did not start"
ok "the relay is up and its chain reader reads $LAUNCHER"

# ── one project, played through ─────────────────────────────────────────────────────────────────────────────────────
PROJECT_ID="$(cast format-bytes32-string loop-pot)"
HASH="$(call "$LAUNCHER" "settingsHash()(bytes32)")"
POOL="10000000000000000000000000" # 10,000,000 Team Shares
send "$K_FOUNDER" "$LAUNCHER" "launch(bytes32,string,string,(uint32,uint256),bytes32)" "$PROJECT_ID" "Loop Project" "LOOP" "(1000,$POOL)" "$HASH"
KEY="$(call "$LAUNCHER" "keyOf(address,bytes32)(bytes32)" "$FOUNDER" "$PROJECT_ID" | tr 'A-F' 'a-f')"
PROJ="$(cast call --rpc-url "$RPC" "$LAUNCHER" "project(address,bytes32)((address,address,address,address,address,uint64))" "$FOUNDER" "$PROJECT_ID" | tr -d '()' | tr ',' '\n' | awk '{print $1}')"
SHARES="$(sed -n 2p <<<"$PROJ" | tr 'A-F' 'a-f')"; TEAM="$(sed -n 3p <<<"$PROJ" | tr 'A-F' 'a-f')"
T="$(sed -n 4p <<<"$PROJ" | tr 'A-F' 'a-f')"; VESTER="$(sed -n 5p <<<"$PROJ" | tr 'A-F' 'a-f')"
ok "launched a project (key $KEY, Treasury $T) at block $LAST_BLOCK"

send "$K_BACKER" "$USD" "faucet()"
AMOUNT=100000000 # 100 play dollars
DATA="$(cast abi-encode "f(uint256,address)" 0 "$BACKER")"
send "$K_BACKER" "$USD" "transferAndCall(address,uint256,bytes)" "$T" "$AMOUNT" "$DATA"
FIRST_BACK_BLOCK="$LAST_BLOCK"
FIRST_BACK_TIME="$(block_time "$FIRST_BACK_BLOCK")"
ok "a backer took play dollars from the faucet and backed with 100 in one transaction (block $FIRST_BACK_BLOCK)"

send "$K_BACKER2" "$USD" "faucet()"
send "$K_BACKER2" "$USD" "approve(address,uint256)" "$T" 50000000
send "$K_BACKER2" "$T" "join(uint256,uint256,address)" 50000000 0 "$BACKER2"
ok "a second backer put in 50 with approve, then join"

send "$K_FOUNDER" "$T" "checkIn(bytes32)" "$(cast keccak 'loop record 1')"
send "$K_FOUNDER" "$T" "grantTeam(address,uint256)" "$MEMBER" 1000000000000000000000000
send "$K_FOUNDER" "$T" "authoriseAgent(address)" "$AGENT"
ok "the founder checked in, granted 1,000,000 Team Shares to a member and set an agent"

warp 172800 # two days: the allowance accrues into the box
send "$K_FOUNDER" "$T" "checkIn(bytes32)" "$(cast keccak 'loop record 2')"
send "$K_PAYER" "$T" "settle()"
BOX="$(call "$T" "box()(uint256)")"
[[ "$BOX" -gt 250000 ]] || fail "after two days the box holds only $BOX"
send "$K_FOUNDER" "$T" "draw(address,uint256)" "$FOUNDER" 100000
send "$K_AGENT" "$T" "draw(address,uint256)" "$AGENT" 50000
DRAWN=150000
ok "two days later the founder drew 0.10 and the agent drew 0.05 from the allowance box (box held $BOX)"

send "$K_FOUNDER" "$T" "proposeRate(uint32)" 1500
send "$K_PAYER" "$USD" "faucet()"
send "$K_PAYER" "$USD" "approve(address,uint256)" "$T" 500000000
send "$K_PAYER" "$T" "addRevenue(uint256)" 500000000
ok "the founder announced a rate raise (0.15%) and an outsider paid in 500 of outside money"

warp 86400 # a day later part of the outside money has arrived
send "$K_FOUNDER" "$T" "checkIn(bytes32)" "$(cast keccak 'loop record 3')"

N_SH="$(call "$SHARES" "balanceOf(address)(uint256)" "$BACKER")"
QUOTE="$(cast call --rpc-url "$RPC" "$T" "quoteTakeOut(address,uint256)(uint256,uint256,uint256)" "$BACKER" "$N_SH" | awk 'NR==1{print $1}')"
BEFORE="$(call "$USD" "balanceOf(address)(uint256)" "$BACKER")"
send "$K_BACKER" "$T" "leave(uint256,uint256,address)" "$N_SH" "$QUOTE" "$BACKER"
TAKEN="$(python3 -c "print($(call "$USD" "balanceOf(address)(uint256)" "$BACKER") - $BEFORE)")"
# The quote is read at one second and the leave is mined a second or so later while outside money is still arriving, so the
# cash can sit a hair above the quote (never below: the call's minimum is the quote). Within one part in 1,000 is "what it said".
python3 -c "import sys; t, q = int(sys.argv[1]), int(sys.argv[2]); sys.exit(0 if q <= t <= q + q // 1000 else 1)" "$TAKEN" "$QUOTE" \
  || fail "paid what the quote said: got $TAKEN, the quote was $QUOTE (it may be above by one part in 1,000, never below)"
TAKE_BLOCK="$LAST_BLOCK"
ok "the first backer took out all their Shares in one press and got $TAKEN, the quote (block $TAKE_BLOCK)"
mine 4 # the last events are final once two blocks lie over them

# ── the record the relay signed ─────────────────────────────────────────────────────────────────────────────────────
step "reading the signed record once it shows the take-out"
RECORD="$(node scripts/chain-loop-query.mjs read "$BASE" "$KEY" "totals.tookOut=$TAKEN")" \
  || { grep -i "chain reader\|not signed" "$STATE/relay.log" | tail -20 >&2; fail "the relay did not sign a record with the take-out in it"; }
echo "$RECORD" | jq '.content' >"$STATE/record.json"
AS_OF="$(jq -r .asOf.block "$STATE/record.json")"
[[ "$AS_OF" -ge "$TAKE_BLOCK" ]] || fail "the record is of block $AS_OF, before the take-out in $TAKE_BLOCK"
[[ "$(echo "$RECORD" | jq -r '.event.pubkey | length')" == 64 ]] || fail "the record is not signed"
ok "the relay signed the record: version $(jq -r .version "$STATE/record.json"), block $AS_OF (take-out in $TAKE_BLOCK, head $(cast block-number --rpc-url "$RPC"))"
expect_eq "refreshEverySecs" "$(jq -r .refreshEverySecs "$STATE/record.json")" 5
ok "it promises a fresh record every 5 s while the allowance accrues (the settings say 5)"

cat >"$STATE/expected.json" <<JSON
{"joined": "150000000", "fees": "3000000", "drawn": "$DRAWN", "outside": "500000000", "tookOut": "$TAKEN",
 "holders": ["$BACKER2"], "notHolders": ["$BACKER"], "firstBackedAt": $FIRST_BACK_TIME}
JSON
# (the member holds no Team Shares in hand: they were granted and have not been claimed)
python3 -I scripts/chain-loop-pot-check.py "$RPC" "$STATE/record.json" "$STATE/expected.json" >"$STATE/check.out" 2>"$STATE/check.err" \
  || { cat "$STATE/check.out" "$STATE/check.err" >&2; fail "the record and the contracts differ"; }
CHECKS="$(awk '/^CHECKS /{print $2}' "$STATE/check.out")"
[[ -n "$CHECKS" ]] || fail "the field-by-field check did not finish"
N=$((N + CHECKS))
printf '\033[32m[chain-loop-pot] ok\033[0m the record equals the contracts field by field: %s checks (every view at block %s)\n' "$CHECKS" "$AS_OF"

# ── the helper: the one call nobody should have to press ────────────────────────────────────────────────────────────
PLATFORM="$(cast call --rpc-url "$RPC" "$LAUNCHER" "platform()(address,address,uint16,uint32,uint128)" | sed -n 2p | awk '{print tolower($1)}')"
step "waiting for the relay's helper to collect the platform's fee (nobody presses)"
COLLECTED=""
for _ in $(seq 1 120); do
  [[ "$(call "$USD" "balanceOf(address)(uint256)" "$PLATFORM")" == "3000000" ]] && { COLLECTED=1; break; }
  mine 1; sleep 1
done
[[ -n "$COLLECTED" ]] || { grep -i "helper" "$STATE/relay.log" | tail -10 >&2; psql "$DB_URL" -Atc "select call, state, last_error from chain_helper_jobs" >&2; fail "the helper did not collect the platform's fee"; }
FEE_TX="$(psql "$DB_URL" -Atc "select '0x' || encode(tx_hash, 'hex') from chain_helper_jobs where call = 'treasury.collectFees' and state in ('sent','done') order by id limit 1")"
[[ "$(cast tx --rpc-url "$RPC" "$FEE_TX" from | tr 'A-F' 'a-f')" == "$HELPER" ]] || fail "the fee was not collected from the helper's address"
ok "the helper collected the platform's fee (3 play dollars) from its own address, with nobody pressing"
# It never sent anything it must not: only its two allowed calls are in its jobs, and every transaction from its address is one of them.
WRONG="$(psql "$DB_URL" -Atc "select count(*) from chain_helper_jobs where call not in ('treasury.collectFees', 'treasury.settle')")"
expect_eq "jobs of any other call" "$WRONG" 0
SENT="$(psql "$DB_URL" -Atc "select count(*) from chain_helper_sends")"
expect_eq "transactions from the helper's address" "$(cast nonce --rpc-url "$RPC" "$HELPER")" "$SENT"
expect_eq "check-ins by the helper" "$(psql "$DB_URL" -Atc "select count(*) from chain_logs where event = 'CheckedIn' and lower(decoded->>'by') = '$HELPER'")" 0
expect_eq "failed helper jobs" "$(psql "$DB_URL" -Atc "select count(*) from chain_helper_jobs where state = 'failed'")" 0
ok "the helper sent $SENT transaction(s), all of its two calls (collect the fee, settle); it checked in for nobody and no job failed"

# ── freshness: signed again at its promised cadence ─────────────────────────────────────────────────────────────────
BUILT="$(jq -r .builtAt "$STATE/record.json")"
FRESH=""
for _ in $(seq 1 30); do
  sleep 1
  NEXT="$(node scripts/chain-loop-query.mjs read "$BASE" "$KEY")" || continue
  [[ "$(echo "$NEXT" | jq -r '.content.builtAt')" -gt "$BUILT" ]] && { FRESH=1; break; }
done
[[ -n "$FRESH" ]] || fail "no fresh record within 30 s although the record promises one every 5 s"
ok "a fresh record was signed with no new event (builtAt moved on from $BUILT): the cadence holds"

# ── a posted copy is refused ────────────────────────────────────────────────────────────────────────────────────────
node scripts/chain-loop-query.mjs forge "$BASE" "$KEY" >/dev/null || fail "a posted project numbers record was not refused"
ok "a posted copy of the record is refused (relay-only kind)"

# ── the task queue, walked on the real unit ─────────────────────────────────────────────────────────────────────────────
# Every stop reads the signed record once it has caught up with the last transaction and compares the task section, the
# buckets, the cap and the settled numbers with the contracts (scripts/chain-loop-pot-check.py --stop). The loop's own
# expectations (what each task should be, how much each total should be) come from what it sent, not from the record.
BOOK="$(call "$T" "tasks()(address)" | tr 'A-F' 'a-f')"
[[ "$(jq -r .tasks.book "$STATE/record.json")" == "$BOOK" ]] || fail "the launch's record names another task book than Treasury.tasks()"
ok "the launch's task book is Treasury.tasks(): $BOOK (nothing planned yet)"
UNIT="$(call "$T" "unit()(uint32)")"
[[ "$UNIT" == 604800 ]] || fail "the task walk is written for the real 7-day unit; the Treasury's unit is $UNIT"
DAY=86400
TASK_OF="taskOf(uint64)(bytes32,address,uint8,uint16,uint8,address,uint64,uint64,uint64,uint64,uint64,uint128,uint128,uint128,uint128,uint128,uint128)"
task_word() { cast call --rpc-url "$RPC" "$BOOK" "$TASK_OF" "$1" | sed -n "$2p" | awk '{print $1}'; } # serial, which word
W_STATE=3; W_ANNOUNCED=7; W_NOTICE_END=8; W_EXPIRES=9; W_DEADLINE=11; W_LOCKED=13; W_STAYER=14; W_NOTE_FACE=15
now_ts() { cast block latest --rpc-url "$RPC" -f timestamp; }
warp_to() { # a chain time: move the clock there (a little past it is fine) and mine one block at it
  local now; now="$(now_ts)"
  (( $1 > now )) || fail "the walk wants the clock at $1 but the chain is already at $now"
  warp "$(( $1 - now ))"
}
usd() { call "$USD" "balanceOf(address)(uint256)" "$1"; }
calc() { python3 -c "print($1)"; }
founder_check_in() { send "$K_FOUNDER" "$T" "checkIn(bytes32)" "$(cast keccak "loop record $1")"; }
ZERO_ADDRESS=0x0000000000000000000000000000000000000000
announce() { # label, payee, max dollars, share (ten-thousandths) -> the serial it got, in $SERIAL
  SERIAL="$(call "$BOOK" "nextSerial()(uint64)")"
  send "$K_FOUNDER" "$T" "announceTask(bytes32,address,uint256,uint16)" "$(cast keccak "loop task $1")" "$2" "$3" "$4"
}
JOINED=150000000; FEES=3000000; OUTSIDE=500000000; TOOKOUT="$TAKEN"; PAID_W=0; NOTE_CLAIMS=0
STOPS=0
ENDED='{}' # when each task ended (chain time), as the loop saw it
ended_at() { ENDED="$(jq -c --arg s "$1" --argjson t "$2" '. + {($s): $t}' <<<"$ENDED")"; }
task_stop() { # label, the tasks the loop expects as JSON ({"2": "taken", ...}); waits for a record that has caught up
  local label="$1" expect_tasks="$2" need rec
  need="$(cast block-number --rpc-url "$RPC")" # the record must have reached the block that holds what was just done
  mine 3
  rec="$(CHAIN_LOOP_WAIT_SECS=90 node scripts/chain-loop-query.mjs read "$BASE" "$KEY" "asOf.block>=$need")" \
    || { grep -i "chain reader\|not signed" "$STATE/relay.log" | tail -10 >&2; fail "no record that has caught up with block $need ($label)"; }
  echo "$rec" | jq '.content' >"$STATE/record-$label.json"
  jq -n --arg joined "$JOINED" --arg fees "$FEES" --arg outside "$OUTSIDE" --arg tookOut "$TOOKOUT" --arg drawn "$DRAWN" \
    --arg paid "$PAID_W" --arg claims "$NOTE_CLAIMS" --argjson tasks "$expect_tasks" --argjson ended "$ENDED" \
    '{joined: $joined, fees: $fees, outside: $outside, tookOut: $tookOut, drawn: $drawn, paidToWorkers: $paid, noteClaims: $claims, tasks: $tasks, endedAt: $ended}' \
    >"$STATE/expected-$label.json"
  python3 -I scripts/chain-loop-pot-check.py --stop "$RPC" "$STATE/record-$label.json" "$STATE/expected-$label.json" \
    >"$STATE/check-$label.out" 2>"$STATE/check-$label.err" \
    || { cat "$STATE/check-$label.out" "$STATE/check-$label.err" >&2; fail "the record and the contracts differ at the stop: $label"; }
  CHECKS="$(awk '/^CHECKS /{print $2}' "$STATE/check-$label.out")"
  [[ -n "$CHECKS" ]] || fail "the field-by-field check did not finish at the stop: $label"
  N=$((N + CHECKS)); STOPS=$((STOPS + 1))
  STOP_BLOCK="$(jq -r .asOf.block "$STATE/record-$label.json")"
  printf '\033[32m[chain-loop-pot] ok\033[0m stop "%s": the record equals the contracts, %s checks (block %s)\n' "$label" "$CHECKS" "$STOP_BLOCK"
}

# Stop 1: four plans, one withdrawn, three in their notice
T0="$(now_ts)"
founder_check_in 10
announce one "$WORKER" 40000000 200; S_CANCEL="$SERIAL"
send "$K_FOUNDER" "$T" "cancelTask(uint64)" "$S_CANCEL"; ended_at "$S_CANCEL" "$(block_time "$LAST_BLOCK")"
announce two "$WORKER" 40000000 200; S_PAID="$SERIAL"
announce three "$ZERO_ADDRESS" 30000000 100; S_REJECT="$SERIAL"
announce four "$WORKER2" 20000000 100; S_LAPSE="$SERIAL"
[[ "$S_CANCEL $S_PAID $S_REJECT $S_LAPSE" == "1 2 3 4" ]] || fail "the serials are not 1 to 4: $S_CANCEL $S_PAID $S_REJECT $S_LAPSE"
expect_eq "state of the withdrawn plan" "$(task_word "$S_CANCEL" $W_STATE)" 6
[[ "$(call "$BOOK" "openCount()(uint8)")" == 3 ]] || fail "three plans should be open"
task_stop planned '{"1":"cancelled","2":"announced","3":"announced","4":"announced"}'
[[ "$(jq -r .refreshEverySecs "$STATE/record-planned.json")" == 5 ]] || fail "a record with tasks open must promise the active cadence (5 s)"
ok "a plan was withdrawn, three stay in their notice; the record promises a fresh copy every 5 s while a task is open"

# Stop 2: the notices end; a named worker takes one plan and a stranger takes the open one
warp_to $((T0 + 7 * DAY)); founder_check_in 11
NOTICE_END="$(task_word "$S_PAID" $W_NOTICE_END)"
warp_to $((NOTICE_END + 120)); founder_check_in 12
send "$K_WORKER" "$T" "takeTask(uint64,uint256)" "$S_PAID" 1
send "$K_PAYER" "$T" "takeTask(uint64,uint256)" "$S_REJECT" 1
expect_eq "state of the plan the worker took" "$(task_word "$S_PAID" $W_STATE)" 2
expect_eq "state of the open task the stranger took" "$(task_word "$S_REJECT" $W_STATE)" 2
LOCKED_PAID="$(task_word "$S_PAID" $W_LOCKED)"; LOCKED_REJECT="$(task_word "$S_REJECT" $W_LOCKED)"
[[ "$LOCKED_PAID" -gt 0 && "$LOCKED_REJECT" -gt 0 ]] || fail "a take set nothing aside"
task_stop taken '{"2":"taken","3":"taken","4":"announced"}'
ok "after the notice two plans were taken ($LOCKED_PAID and $LOCKED_REJECT play-dollar units set aside); the record equals the contracts"

# Stop 3: a Take out while money is set aside writes a note, and the record lists the leaver
N2="$(call "$SHARES" "balanceOf(address)(uint256)" "$BACKER2")"
HALF="$(calc "$N2 // 2")"
QUOTE2="$(cast call --rpc-url "$RPC" "$T" "quoteTakeOut(address,uint256)(uint256,uint256,uint256)" "$BACKER2" "$HALF")"
Q_CASH="$(sed -n 1p <<<"$QUOTE2" | awk '{print $1}')"; Q_NOTE="$(sed -n 2p <<<"$QUOTE2" | awk '{print $1}')"
[[ "$Q_NOTE" -gt 0 ]] || fail "taking out half while money is set aside should write a note (the quote says $Q_NOTE)"
BEFORE2="$(usd "$BACKER2")"
send "$K_BACKER2" "$T" "leave(uint256,uint256,address)" "$HALF" "$(calc "$Q_CASH * 99 // 100")" "$BACKER2"
GOT2="$(calc "$(usd "$BACKER2") - $BEFORE2")"
python3 -c "import sys; g, q = int(sys.argv[1]), int(sys.argv[2]); sys.exit(0 if q * 99 // 100 <= g <= q + q // 100 else 1)" "$GOT2" "$Q_CASH" \
  || fail "the part Take out paid $GOT2 and the quote said $Q_CASH"
TOOKOUT=$((TOOKOUT + GOT2))
NOTE_PAID="$(call "$BOOK" "noteOf(uint64,address)(uint256)" "$S_PAID" "$BACKER2")"
NOTE_REJECT="$(call "$BOOK" "noteOf(uint64,address)(uint256)" "$S_REJECT" "$BACKER2")"
[[ $((NOTE_PAID + NOTE_REJECT)) -gt 0 ]] || fail "the Take out wrote no note on either taken task"
task_stop note '{"2":"taken","3":"taken","4":"announced"}'
[[ "$(jq -r '[.tasks.list[] | select(.serial == '"$S_PAID"') | .notes.holders[].account] | first' "$STATE/record-note.json")" == "$BACKER2" ]] \
  || fail "the record does not list the leaver as holding a note on the paid task"
ok "a Take out of half the Shares paid $GOT2 and wrote notes of $NOTE_PAID and $NOTE_REJECT; the record lists the leaver's note and equals the contracts"

# The check can fail: a copy of this stop's record with one number wrong must be refused, each time, with a clear difference.
must_fail() { # what is wrong, a jq filter that makes it wrong
  jq "$2" "$STATE/record-note.json" >"$STATE/tampered.json" || fail "the filter for \"$1\" is wrong"
  if python3 -I scripts/chain-loop-pot-check.py --stop "$RPC" "$STATE/tampered.json" "$STATE/expected-note.json" >"$STATE/tamper.out" 2>"$STATE/tamper.err"; then
    fail "the check accepted a record that is wrong: $1"
  fi
  grep -q '^FAIL' "$STATE/tamper.err" || { cat "$STATE/tamper.err" >&2; fail "the check did not name the difference for: $1"; }
  ok "the check refuses a record that is wrong: $1"
}
more() { echo '|= ((tonumber + 1) | tostring)'; }
must_fail "a leaver's note one unit too large" "(.tasks.list[] | select(.serial == $S_PAID) | .notes.holders[0].face) $(more)"
must_fail "money set aside for a task one unit too large" "(.tasks.list[] | select(.serial == $S_REJECT) | .setAside) $(more)"
must_fail "a taken task shown as not yet taken" "(.tasks.list[] | select(.serial == $S_REJECT) | .state) = \"announced\""
must_fail "the cap used one ten-thousandth too much" '.tasks.cap.usedBps += 1'
must_fail "the next end of a task a second late" '.tasks.nextExpiry += 1'
must_fail "the money set aside one unit too large" ".money.locked $(more)"
must_fail "the pot one unit too large" ".money.pot $(more)"
must_fail "the total paid to workers wrong" '.totals.paidToWorkers = "1"'
must_fail "an open task left out of the list" ".tasks.list |= map(select(.serial != $S_LAPSE))"

# Stop 4: the team pays 60% of one task's money; a stranger claims the leaver's note, and only the leaver is paid
PAY="$(calc "$LOCKED_PAID * 60 // 100")"
WORKER_BEFORE="$(usd "$WORKER")"
send "$K_FOUNDER" "$T" "acceptTask(uint64,uint256)" "$S_PAID" "$PAY"; ended_at "$S_PAID" "$(block_time "$LAST_BLOCK")"
expect_eq "what the worker was paid" "$(calc "$(usd "$WORKER") - $WORKER_BEFORE")" "$PAY"
expect_eq "state of the task paid in part" "$(task_word "$S_PAID" $W_STATE)" 3
PAID_W="$PAY"
CLAIMABLE="$(call "$BOOK" "claimableNote(uint64,address)(uint256)" "$S_PAID" "$BACKER2")"
[[ "$CLAIMABLE" -gt 0 ]] || fail "after a part payment the leaver's note should be worth something"
LEAVER_BEFORE="$(usd "$BACKER2")"; STRANGER_BEFORE="$(usd "$STRANGER")"
send "$K_PAYER" "$T" "claimNote(uint64,address)" "$S_PAID" "$BACKER2"
NOTE_CLAIMS="$(calc "$(usd "$BACKER2") - $LEAVER_BEFORE")"
[[ "$NOTE_CLAIMS" -gt 0 ]] || fail "the claim paid the leaver nothing"
expect_eq "what the stranger who claimed for the leaver got" "$(calc "$(usd "$STRANGER") - $STRANGER_BEFORE")" 0
task_stop paid '{"2":"paid","3":"taken","4":"announced"}'
[[ "$(jq -r .totals.paidToWorkers "$STATE/record-paid.json")" == "$PAY" ]] || fail "the record's total paid to workers is not what the worker got"
ok "the worker was paid $PAY of $LOCKED_PAID, a stranger's claim paid the leaver $NOTE_CLAIMS and the stranger nothing; the record equals the contracts"

# Stop 5: the other task is sent back; the cap is given back and the leaver's note on it can be claimed
WINDOW_BEFORE="$(call "$BOOK" "windowSumBps()(uint256)")"
CAP_REJECT="$(jq -r '.tasks.list[] | select(.serial == '"$S_REJECT"') | .capBps' "$STATE/record-paid.json")"
send "$K_FOUNDER" "$T" "rejectTask(uint64)" "$S_REJECT"; ended_at "$S_REJECT" "$(block_time "$LAST_BLOCK")"
expect_eq "state of the task sent back" "$(task_word "$S_REJECT" $W_STATE)" 4
expect_eq "the cap the sent-back task gave back" "$((WINDOW_BEFORE - $(call "$BOOK" "windowSumBps()(uint256)")))" "$CAP_REJECT"
[[ "$CAP_REJECT" -gt 0 ]] || fail "the take used no cap"
[[ "$(call "$BOOK" "claimableNote(uint64,address)(uint256)" "$S_REJECT" "$BACKER2")" -gt 0 ]] || fail "the leaver's note on a sent-back task should be worth something"
task_stop rejected '{"2":"paid","3":"rejected","4":"announced"}'
ok "the task was sent back and gave $CAP_REJECT ten-thousandths of the cap back; the record equals the contracts"

# Stop 6: the plan nobody took lapses at the next action; a fifth plan is made and a new backer comes in
LAPSE_END="$(task_word "$S_LAPSE" $W_EXPIRES)"
warp_to $((LAPSE_END + 120)); founder_check_in 13; ended_at "$S_LAPSE" "$(block_time "$LAST_BLOCK")"
expect_eq "state of the plan nobody took" "$(task_word "$S_LAPSE" $W_STATE)" 7
announce five "$WORKER2" 20000000 100; S_RUNOUT="$SERIAL"
expect_eq "serial of the fifth plan" "$S_RUNOUT" 5
send "$K_BACKER3" "$USD" "faucet()"
send "$K_BACKER3" "$USD" "approve(address,uint256)" "$T" 60000000
send "$K_BACKER3" "$T" "join(uint256,uint256,address)" 60000000 0 "$BACKER3"
JOINED=$((JOINED + 60000000)); FEES=$((FEES + $(call "$T" "feeFor(uint256)(uint256)" 60000000)))
task_stop lapsed '{"2":"paid","3":"rejected","4":"lapsed","5":"announced"}'
ok "the plan nobody took lapsed, a fifth was announced and a third backer joined; the record equals the contracts"

# Stop 7: the fifth plan is taken, a second Take out writes a note on it, and the project goes quiet with the task still open
warp_to $((T0 + 30 * DAY)); founder_check_in 14
NOTICE_END5="$(task_word "$S_RUNOUT" $W_NOTICE_END)"
warp_to $((NOTICE_END5 + 120))
send "$K_WORKER2" "$T" "takeTask(uint64,uint256)" "$S_RUNOUT" 1
expect_eq "state of the fifth task" "$(task_word "$S_RUNOUT" $W_STATE)" 2
N3="$(call "$SHARES" "balanceOf(address)(uint256)" "$BACKER3")"
HALF3="$(calc "$N3 // 2")"
Q_CASH3="$(cast call --rpc-url "$RPC" "$T" "quoteTakeOut(address,uint256)(uint256,uint256,uint256)" "$BACKER3" "$HALF3" | sed -n 1p | awk '{print $1}')"
BEFORE3="$(usd "$BACKER3")"
send "$K_BACKER3" "$T" "leave(uint256,uint256,address)" "$HALF3" "$(calc "$Q_CASH3 * 99 // 100")" "$BACKER3"
GOT3="$(calc "$(usd "$BACKER3") - $BEFORE3")"
TOOKOUT=$((TOOKOUT + GOT3))
NOTE_RUNOUT="$(call "$BOOK" "noteOf(uint64,address)(uint256)" "$S_RUNOUT" "$BACKER3")"
[[ "$NOTE_RUNOUT" -gt 0 ]] || fail "the second Take out wrote no note on the fifth task"
DEADLINE5="$(task_word "$S_RUNOUT" $W_DEADLINE)"
ACTIVE_END="$(call "$T" "activeEnd()(uint256)")"
[[ "$ACTIVE_END" -lt "$DEADLINE5" ]] || fail "the project should go quiet before the fifth task is due ($ACTIVE_END, $DEADLINE5)"
warp_to $((ACTIVE_END + DAY))
task_stop quiet '{"2":"paid","3":"rejected","4":"lapsed","5":"taken"}'
[[ "$(jq -r .quiet.state "$STATE/record-quiet.json")" != "active" ]] || fail "the project should be quiet now"
[[ "$(jq -r .refreshEverySecs "$STATE/record-quiet.json")" == 5 ]] || fail "a quiet project with a task open must still promise the active cadence (5 s)"
ok "the fifth task was taken, a Take out of $GOT3 wrote a note of $NOTE_RUNOUT, the project is quiet and the record still promises a copy every 5 s while the task is open"

# Stop 8: the fifth task runs out and nobody presses anything: the relay's helper settles it, ten minutes later
HELPER_SENDS_BEFORE="$(psql "$DB_URL" -Atc "select count(*) from chain_helper_sends")"
warp_to $((DEADLINE5 + 700))
mine 4
step "waiting for the relay's helper to return the task that ran out (nobody presses)"
RETURNED=""
for _ in $(seq 1 200); do
  [[ "$(task_word "$S_RUNOUT" $W_STATE)" == 5 ]] && { RETURNED=1; break; }
  mine 1; sleep 1
done
[[ -n "$RETURNED" ]] || { grep -i "helper" "$STATE/relay.log" | tail -10 >&2; psql "$DB_URL" -Atc "select job_key, state, last_error from chain_helper_jobs" >&2; fail "the helper did not settle the task that ran out"; }
SETTLE_TX="$(psql "$DB_URL" -Atc "select '0x' || encode(tx_hash, 'hex') from chain_helper_jobs where job_key like 'settle-task:%' and state in ('sent', 'done') order by id limit 1")"
[[ -n "$SETTLE_TX" ]] || fail "no helper job settled the task"
expect_eq "who sent the settle" "$(cast tx --rpc-url "$RPC" "$SETTLE_TX" from | tr 'A-F' 'a-f')" "$HELPER"
expect_eq "what the settle called" "$(cast tx --rpc-url "$RPC" "$SETTLE_TX" to | tr 'A-F' 'a-f')" "$T"
expect_eq "the settle's whole calldata" "$(cast tx --rpc-url "$RPC" "$SETTLE_TX" input)" "$(cast sig 'settle()')"
for _ in $(seq 1 30); do
  [[ "$(psql "$DB_URL" -Atc "select count(*) from chain_logs where event = 'TaskResolved' and decoded->>'serial' = '$S_RUNOUT'")" == 1 ]] && break
  mine 1; sleep 1
done
expect_eq "the transaction that returned the task is the helper's settle" \
  "$(psql "$DB_URL" -Atc "select '0x' || encode(tx_hash, 'hex') from chain_logs where event = 'TaskResolved' and decoded->>'serial' = '$S_RUNOUT'")" "$SETTLE_TX"
ended_at "$S_RUNOUT" "$(block_time "$(cast tx --rpc-url "$RPC" "$SETTLE_TX" blockNumber)")"
task_stop returned '{"2":"paid","3":"rejected","4":"lapsed","5":"returned"}'
[[ "$(jq -r .refreshEverySecs "$STATE/record-returned.json")" == 7 ]] || fail "with no task open and the project quiet the record must promise the idle cadence (7 s)"
ok "the helper returned the task that ran out with a plain settle, nobody pressing, and the record equals the contracts; no task open and quiet: a copy every 7 s"

# Stop 9: the leaver claims their own note on the task that ran out
LEAVER3_BEFORE="$(usd "$BACKER3")"
[[ "$(call "$BOOK" "claimableNote(uint64,address)(uint256)" "$S_RUNOUT" "$BACKER3")" -gt 0 ]] || fail "the note on a returned task should be worth something"
send "$K_BACKER3" "$T" "claimNote(uint64,address)" "$S_RUNOUT" "$BACKER3"
CLAIM3="$(calc "$(usd "$BACKER3") - $LEAVER3_BEFORE")"
[[ "$CLAIM3" -gt 0 ]] || fail "the leaver's own claim paid nothing"
NOTE_CLAIMS=$((NOTE_CLAIMS + CLAIM3))
task_stop claimed '{"2":"paid","3":"rejected","4":"lapsed","5":"returned"}'
ok "the leaver claimed their own note on the returned task ($CLAIM3); the record equals the contracts"

# What the helper did during the walk: its settle, and nothing it must not send
expect_eq "helper jobs that settle a task" "$(psql "$DB_URL" -Atc "select count(*) from chain_helper_jobs where job_key like 'settle-task:%'")" 1
expect_eq "helper jobs that failed" "$(psql "$DB_URL" -Atc "select count(*) from chain_helper_jobs where state = 'failed'")" 0
expect_eq "helper jobs of any other call" "$(psql "$DB_URL" -Atc "select count(*) from chain_helper_jobs where call not in ('treasury.collectFees', 'treasury.settle')")" 0
SENT="$(psql "$DB_URL" -Atc "select count(*) from chain_helper_sends")"
expect_eq "transactions from the helper's address" "$(cast nonce --rpc-url "$RPC" "$HELPER")" "$SENT"
SIGS="$(cast sig 'settle()') $(cast sig 'collectFees()')"
for h in $(psql "$DB_URL" -Atc "select '0x' || encode(tx_hash, 'hex') from chain_helper_sends"); do
  [[ " $SIGS " == *" $(cast tx --rpc-url "$RPC" "$h" input) "* ]] || fail "the helper sent a transaction that is neither a settle nor a fee collection: $h"
done
expect_eq "check-ins by the helper" "$(psql "$DB_URL" -Atc "select count(*) from chain_logs where event = 'CheckedIn' and lower(decoded->>'by') = '$HELPER'")" 0
ok "the helper sent $SENT transaction(s) in the whole run, every one a settle or a fee collection; exactly one settled a task (nobody pressed it)"

kill -0 "$RELAY_PID" 2>/dev/null || fail "the relay stopped"
if grep -qi "numbers not signed" "$STATE/relay.log"; then
  grep -i "numbers not signed" "$STATE/relay.log" | head -3 >&2
  fail "the reader refused to sign a record at some point (see above)"
fi
ok "the reader never refused to sign: no record failed its checks during the whole run"
echo
echo "chain-loop-pot: $N checks passed."
