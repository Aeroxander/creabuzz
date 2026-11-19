#!/usr/bin/env bash
# chain-loop-pot.sh: the chain reader's real-server loop on the contracts/pot money contracts (record version 2).
#
# Starts a local chain (anvil), deploys contracts/pot with its own deploy script (play dollars, the real time unit of 7
# days), starts the real relay on a scratch database with the chain reader on, and walks one project through everything a
# person does, with `cast`: a launch, a faucet, a Back (in one transaction), a second Back (approve, then join), a check-in,
# a grant of Team Shares, an agent, a draw from the allowance, a rate raise announced, outside money, a Take out. It then
# reads the relay-signed project numbers record (kind 39009) over a NIP-98 signed POST /query and compares it with the
# contracts field by field, at the record's own block (scripts/chain-loop-pot-check.py): every number a view has must equal the
# view, and the settled pot, box and arriving money are worked forward there, independently of the server, and must equal
# the record's. Last, a posted copy of the record is refused, and the record is signed again at its promised cadence.
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
anvil --port "$CHAIN_PORT" --chain-id 31337 --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || fail "anvil did not start"

# anvil's public development accounts (mnemonic "test ... junk"); the keys are derived here, none is written down
MNEMONIC="test test test test test test test test test test test junk"
key() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
K_DEPLOYER="$(key 0)"; K_FOUNDER="$(key 1)"; K_BACKER="$(key 2)"; K_PAYER="$(key 3)"; K_MEMBER="$(key 4)"
K_AGENT="$(key 5)"; K_BACKER2="$(key 6)"; K_HELPER="$(key 7)"
addr() { cast wallet address --private-key "$1" | tr 'A-F' 'a-f'; }
FOUNDER="$(addr "$K_FOUNDER")"; BACKER="$(addr "$K_BACKER")"; BACKER2="$(addr "$K_BACKER2")"; PAYER="$(addr "$K_PAYER")"
MEMBER="$(addr "$K_MEMBER")"; AGENT="$(addr "$K_AGENT")"; HELPER="$(addr "$K_HELPER")"

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
step "starting the relay on :$PORT with the chain reader (2 confirmations, 1 s passes, records at least every 5 s)"
env DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" BUZZ_AUTO_MIGRATE=true \
  BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="127.0.0.1:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" BUZZ_GIT_CONFORMANCE_PROBE=false \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false \
  BUZZ_CHAIN_RPC_URL="$RPC" BUZZ_CHAIN_ID=31337 BUZZ_CHAIN_LAUNCHER="$LAUNCHER" BUZZ_CHAIN_START_BLOCK="$START_BLOCK" \
  BUZZ_CHAIN_CONFIRMATIONS=2 BUZZ_CHAIN_POLL_SECS=1 BUZZ_CHAIN_REFRESH_SECS=5 BUZZ_CHAIN_ACTIVE_REFRESH_SECS=5 \
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
expect_eq "paid what the quote said" "$TAKEN" "$QUOTE"
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

kill -0 "$RELAY_PID" 2>/dev/null || fail "the relay stopped"
if grep -qi "numbers not signed" "$STATE/relay.log"; then
  grep -i "numbers not signed" "$STATE/relay.log" | head -3 >&2
  fail "the reader refused to sign a record at some point (see above)"
fi
ok "the reader never refused to sign: no record failed its checks during the whole run"
echo
echo "chain-loop-pot: $N checks passed."
