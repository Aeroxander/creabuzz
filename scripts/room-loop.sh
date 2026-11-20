#!/usr/bin/env bash
# room-loop.sh: the holder room and seasons on a real relay and a real chain (package P2 of docs/next-version/STEP3-PLAN.md).
#
# Starts a local chain (anvil), deploys contracts/pot with its own deploy script (play dollars, the real 7-day unit), launches
# one project whose launch names the hash of the project record's address (as the app does), backs it from three wallets,
# lets a fourth take its whole stake out, and leaves one wei of Shares with a fifth. It then starts the real relay on a
# scratch database with the chain reader on and walks every refusal of the room and of seasons over the wire, with really
# signed records and NIP-98 signed requests (scripts/room-loop-client.mjs): the wallet links are built with the app's own
# code and signed by anvil's public development keys; a stranger, a wallet with one wei, a person who took out (inside the
# unit and, after the chain's clock moved a unit, outside it), the team's mute that follows the wallet, a removal by the
# team and its public entry. Seasons are started, shown, replaced and removed with the real `buzz` command; a project is
# entered, left and taken out of a season over the wire.
#
# Prints one `ok` line per check and "room-loop: N checks passed." at the end. Stops what it started (anvil, the relay, a Redis
# it had to start), drops its scratch database and removes its temporary files, whatever the outcome.
#
# Needs: anvil, cast, forge (FOUNDRY_BIN or PATH), psql, a Postgres and a Redis (started here when they are not running),
# node 22 with web/node_modules and packages/creaton-core/node_modules, jq, openssl, python3, and built binaries
# (`cargo build -p buzz-relay -p buzz-cli`). Uses anvil's well-known development keys only; every amount is play money.
#
# Env: POSTGRES_ADMIN_URL (default postgres://buzz:buzz_dev@127.0.0.1:5432/postgres), REDIS_URL, RELAY_BIN, BUZZ_BIN,
#      FOUNDRY_BIN, KEEP_DB=1, RELAY_LOG_COPY=<file>.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
N=0
step() { printf '\033[36m[room-loop]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[room-loop] FAIL %s\033[0m\n' "$*" >&2; exit 1; }
ok() { N=$((N + 1)); printf '\033[32m[room-loop] ok %02d\033[0m %s\n' "$N" "$*"; }

[[ -n "${FOUNDRY_BIN:-}" ]] && PATH="$FOUNDRY_BIN:$PATH"
for tool in anvil cast forge psql curl node jq openssl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "room-loop: $tool is not on PATH" >&2; exit 2; }
done

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@127.0.0.1:5432/postgres}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
RELAY_BIN="${RELAY_BIN:-target/debug/buzz-relay}"
BUZZ_BIN="${BUZZ_BIN:-target/debug/buzz}"
POT="$REPO_ROOT/contracts/pot"
DB="buzz_room_loop_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
ANVIL_PID=""; RELAY_PID=""; REDIS_PID=""; STARTED_PG=""
CLIENT=(node --experimental-strip-types --no-warnings scripts/room-loop-client.mjs)

stop_pid() { [[ -n "$1" ]] && kill "$1" 2>/dev/null && wait "$1" 2>/dev/null; return 0; }
cleanup() {
  trap - EXIT
  stop_pid "$RELAY_PID"; stop_pid "$ANVIL_PID"; stop_pid "$REDIS_PID"
  [[ -n "${RELAY_LOG_COPY:-}" && -f "$STATE/relay.log" ]] && cp "$STATE/relay.log" "$RELAY_LOG_COPY"
  if [[ "${KEEP_DB:-}" == "1" ]]; then echo "[room-loop] kept the scratch database: $DB_URL" >&2
  else psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1; fi
  [[ -n "$STARTED_PG" ]] && pg_ctlcluster 16 main stop >/dev/null 2>&1
  rm -rf "$STATE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }

[[ -x "$RELAY_BIN" ]] || fail "no relay at $RELAY_BIN (run: cargo build -p buzz-relay)"
[[ -x "$BUZZ_BIN" ]] || fail "no buzz command at $BUZZ_BIN (run: cargo build -p buzz-cli)"
if ! psql "$ADMIN_URL" -qAtc 'select 1' >/dev/null 2>&1; then
  command -v pg_ctlcluster >/dev/null 2>&1 && pg_ctlcluster 16 main start >/dev/null 2>&1 && STARTED_PG=1
  for _ in $(seq 1 30); do psql "$ADMIN_URL" -qAtc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
fi
psql "$ADMIN_URL" -qAtc 'select 1' >/dev/null 2>&1 || fail "Postgres is not answering at $ADMIN_URL"
if [[ "$(redis-cli -u "$REDIS_URL" ping 2>/dev/null)" != "PONG" ]]; then
  port="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).port or 6379)' "$REDIS_URL")"
  redis-server --port "$port" --save '' --appendonly no >"$STATE/redis.log" 2>&1 &
  REDIS_PID=$!; sleep 1
  [[ "$(redis-cli -u "$REDIS_URL" ping 2>/dev/null)" == "PONG" ]] || fail "Redis did not start"
fi

# ── the accounts of the run: Nostr keys made for it (kept in the run's scratch directory only) ─────────────────────────
"${CLIENT[@]}" keys "$STATE/keys.json" || fail "could not make the run's keys"
pubkey() { "${CLIENT[@]}" pubkey "$STATE/keys.json" "$1"; }
secret() { jq -r ".$1" "$STATE/keys.json"; }
FOUNDER_PUB="$(pubkey founder)"; OPERATOR_PUB="$(pubkey operator)"
PROJECT_D="room-loop"
COORD="37001:$FOUNDER_PUB:$PROJECT_D"
PROJECT_ID="$(cast keccak "$COORD")" # what the chain knows the project by: the hash of its record's address

# ── the chain ────────────────────────────────────────────────────────────────────────────────────────────────────────────
CHAIN_PORT="$(free_port)"; RPC="http://127.0.0.1:$CHAIN_PORT"
anvil --port "$CHAIN_PORT" --chain-id 31337 --accounts 14 --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || fail "anvil did not start"
MNEMONIC="test test test test test test test test test test test junk"
key() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
K_DEPLOYER="$(key 0)"; K_FOUNDER="$(key 1)"; K_A="$(key 2)"; K_B="$(key 6)"; K_C="$(key 10)"; K_D="$(key 12)"; K_E="$(key 8)"; K_HELPER="$(key 7)"
addr() { cast wallet address --private-key "$1" | tr 'A-F' 'a-f'; }
A="$(addr "$K_A")"; B="$(addr "$K_B")"; C="$(addr "$K_C")"; D="$(addr "$K_D")"; E="$(addr "$K_E")"

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

step "deploying contracts/pot on anvil :$CHAIN_PORT"
(cd "$POT" && forge script script/DeployPot.s.sol --rpc-url "$RPC" --broadcast --private-key "$K_DEPLOYER" >"$STATE/deploy.log" 2>&1) \
  || { tail -20 "$STATE/deploy.log" >&2; fail "the deploy script failed"; }
DEPLOY_JSON="$POT/deployments/pot-31337.json"
USD="$(jq -r .quote "$DEPLOY_JSON" | tr 'A-F' 'a-f')"; LAUNCHER="$(jq -r .launcher "$DEPLOY_JSON" | tr 'A-F' 'a-f')"
START_BLOCK="$(cast block-number --rpc-url "$RPC")"
ok "deployed the play dollar $USD and the Launcher $LAUNCHER (block $START_BLOCK)"

HASH="$(call "$LAUNCHER" "settingsHash()(bytes32)")"
send "$K_FOUNDER" "$LAUNCHER" "launch(bytes32,string,string,(uint32,uint256),bytes32)" "$PROJECT_ID" "Room Loop" "ROOM" "(1000,10000000000000000000000000)" "$HASH"
FOUNDER_WALLET="$(addr "$K_FOUNDER")"
KEY="$(call "$LAUNCHER" "keyOf(address,bytes32)(bytes32)" "$FOUNDER_WALLET" "$PROJECT_ID" | tr 'A-F' 'a-f')"
PROJ="$(cast call --rpc-url "$RPC" "$LAUNCHER" "project(address,bytes32)((address,address,address,address,address,uint64))" "$FOUNDER_WALLET" "$PROJECT_ID" | tr -d '()' | tr ',' '\n' | awk '{print $1}')"
SHARES="$(sed -n 2p <<<"$PROJ" | tr 'A-F' 'a-f')"; T="$(sed -n 4p <<<"$PROJ" | tr 'A-F' 'a-f')"
UNIT="$(call "$T" "unit()(uint32)")"
[[ "$UNIT" == 604800 ]] || fail "the loop is written for the real 7-day unit; the Treasury's unit is $UNIT"
ok "launched a project whose launch names the hash of $COORD (key $KEY)"

back() { # key, wallet, play dollars (whole) -> backs in one transaction
  send "$1" "$USD" "faucet()"
  send "$1" "$USD" "transferAndCall(address,uint256,bytes)" "$T" "$(( $3 * 1000000 ))" "$(cast abi-encode 'f(uint256,address)' 0 "$2")"
}
back "$K_A" "$A" 100
back "$K_B" "$B" 50
back "$K_E" "$E" 50
back "$K_C" "$C" 50
N_C="$(call "$SHARES" "balanceOf(address)(uint256)" "$C")"
QUOTE="$(cast call --rpc-url "$RPC" "$T" "quoteTakeOut(address,uint256)(uint256,uint256,uint256)" "$C" "$N_C" | awk 'NR==1{print $1}')"
# the quote is read a second before the take-out is mined: ask for it less a tenth of a play dollar
send "$K_C" "$T" "leave(uint256,uint256,address)" "$N_C" "$(( QUOTE - 100000 ))" "$C"
LEFT_BLOCK="$LAST_BLOCK"; LEFT_TIME="$(block_time "$LEFT_BLOCK")"
send "$K_A" "$SHARES" "transfer(address,uint256)" "$D" 1
DUST_BLOCK="$LAST_BLOCK"
mine 4
ok "three wallets backed the project, a fourth backed and took out everything (block $LEFT_BLOCK), a fifth holds one wei (block $DUST_BLOCK)"

# ── the relay, with the chain reader pointed at it ──────────────────────────────────────────────────────────────────────
PORT="$(free_port)"; HEALTH="$(free_port)"; METRICS="$(free_port)"; BASE="http://localhost:$PORT"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database"
cp "$RELAY_BIN" "$STATE/buzz-relay"
step "starting the relay on :$PORT with the chain reader (2 confirmations, 1 s passes); the operator is the server's owner key"
env DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" BUZZ_AUTO_MIGRATE=true \
  BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" RELAY_OWNER_PUBKEY="$OPERATOR_PUB" \
  BUZZ_BIND_ADDR="127.0.0.1:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" BUZZ_GIT_CONFORMANCE_PROBE=false \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_NEW_ACCOUNT_POSTS_PER_HOUR=0 BUZZ_NEW_ACCOUNT_PROJECT_RECORDS_PER_DAY=0 \
  BUZZ_CHAIN_RPC_URL="$RPC" BUZZ_CHAIN_ID=31337 BUZZ_CHAIN_LAUNCHER="$LAUNCHER" BUZZ_CHAIN_START_BLOCK="$START_BLOCK" \
  BUZZ_CHAIN_CONFIRMATIONS=2 BUZZ_CHAIN_POLL_SECS=1 BUZZ_CHAIN_REFRESH_SECS=7 BUZZ_CHAIN_ACTIVE_REFRESH_SECS=5 \
  "$STATE/buzz-relay" >"$STATE/relay.log" 2>&1 &
RELAY_PID=$!
relay_up() { curl -fsS -m 2 -H 'Accept: application/nostr+json' "$BASE/" >/dev/null 2>&1; }
for _ in $(seq 1 180); do
  relay_up && break
  kill -0 "$RELAY_PID" 2>/dev/null || { tail -30 "$STATE/relay.log" >&2; fail "the relay exited"; }
  sleep 1
done
relay_up || { tail -30 "$STATE/relay.log" >&2; fail "the relay did not come up"; }
ok "the relay is up and its chain reader reads $LAUNCHER"

KEY_HEX="${KEY#0x}"
for _ in $(seq 1 120); do
  seen="$(psql "$DB_URL" -Atc "select coalesce(max(block_number), 0) from chain_balance_changes where project_key = decode('$KEY_HEX', 'hex')" 2>/dev/null || echo 0)"
  [[ "${seen:-0}" -ge "$DUST_BLOCK" ]] && break
  mine 1; sleep 1
done
[[ "${seen:-0}" -ge "$DUST_BLOCK" ]] || { tail -20 "$STATE/relay.log" >&2; fail "the reader did not store the balances up to block $DUST_BLOCK (it stored $seen)"; }
expect_rows="$(psql "$DB_URL" -Atc "select count(*) from chain_balances where project_key = decode('$KEY_HEX', 'hex') and token = 'shares'")"
ok "the reader stored the project's launch and its Share balances ($expect_rows accounts) up to block $seen"

export BASE KEY COORD K_A K_B K_C K_D K_E
run_client() { # mode and arguments; counts the client's checks
  local out
  out="$("${CLIENT[@]}" "$1" "$STATE/keys.json" "${@:2}" 2>"$STATE/client.err")" || { printf '%s\n' "$out" >&2; cat "$STATE/client.err" >&2; fail "the wire checks failed in $1 ${*:2}"; }
  printf '%s\n' "$out" | grep '^ok ' | sed "s/^ok /[room-loop]    /"
  local n; n="$(printf '%s\n' "$out" | awk '/^CHECKS /{print $2}')"
  [[ -n "$n" ]] || fail "the wire checks did not finish in $1"
  N=$((N + n))
}

step "the room and the team's tools, over the wire"
run_client phase1

# ── a unit later, on the chain's own clock ──────────────────────────────────────────────────────────────────────────────
step "moving the chain's clock one unit past the take-out and waiting for the reader to read it"
TARGET="$(( LEFT_TIME + UNIT + 5 ))"
NOW_CHAIN="$(block_time latest)"
(( TARGET > NOW_CHAIN )) && warp "$(( TARGET - NOW_CHAIN ))"
mine 4
for _ in $(seq 1 60); do
  newest="$(psql "$DB_URL" -Atc "select coalesce(max(block_time), 0) from chain_blocks" 2>/dev/null || echo 0)"
  [[ "${newest:-0}" -gt "$(( LEFT_TIME + UNIT ))" ]] && break
  mine 1; sleep 1
done
[[ "${newest:-0}" -gt "$(( LEFT_TIME + UNIT ))" ]] || fail "the reader did not reach the chain's new clock (newest block time $newest, wanted past $(( LEFT_TIME + UNIT )))"
ok "the reader's newest block is past the take-out plus one unit (chain time $newest)"
run_client phase2

# ── seasons, with the real command ──────────────────────────────────────────────────────────────────────────────────────
buzz_as() { # role, args...
  local role="$1"; shift
  BUZZ_RELAY_URL="$BASE" BUZZ_PRIVATE_KEY="$(secret "$role")" "$BUZZ_BIN" "$@"
}
step "seasons: the operator starts one with the real command"
out="$(buzz_as operator launchpad seasons start --number 1 2>"$STATE/start.err")" || { cat "$STATE/start.err" >&2; echo "$out" >&2; fail "starting a season failed"; }
[[ "$(jq -r .accepted <<<"$out")" == "true" ]] || fail "the server did not accept the season: $out"
grep -q 'entry opens' "$STATE/start.err" && grep -q 'demo day' "$STATE/start.err" && grep -q 'ends' "$STATE/start.err" || fail "the command did not print the three dates before it signed"
ok "buzz launchpad seasons start printed the three dates, signed the record and the server accepted it"
if buzz_as operator launchpad seasons start --number 1 >/dev/null 2>"$STATE/again.err"; then fail "a season that exists was started again without --replace"; fi
grep -q 'already exists' "$STATE/again.err" || fail "the refusal does not say the season exists: $(cat "$STATE/again.err")"
ok "starting season 1 again is refused by the command before it signs anything (it exists; --replace moves its dates)"
shown="$(buzz_as operator launchpad seasons show)" || fail "seasons show failed"
[[ "$(jq -r '.[0].number' <<<"$shown")" == 1 && "$(jq -r '.[0].openForEntry' <<<"$shown")" == "true" ]] || fail "show does not list an open season 1: $shown"
DEMO_BEFORE="$(jq -r '.[0].demoDayAt' <<<"$shown")"
ok "buzz launchpad seasons show lists season 1, open for entry"
sleep 2 # a replacement is a later record: one signed in the same second as the first does not replace it
out="$(buzz_as operator launchpad seasons start --number 1 --days 40 --replace 2>"$STATE/replace.err")" || { cat "$STATE/replace.err" >&2; fail "replacing a season failed"; }
[[ "$(jq -r .accepted <<<"$out")" == "true" ]] || fail "the server did not accept the replacement: $out"
shown="$(buzz_as operator launchpad seasons show --number 1)"
DEMO_AFTER="$(jq -r '.[0].demoDayAt' <<<"$shown")"
(( DEMO_AFTER < DEMO_BEFORE )) || fail "the replacement did not move demo day ($DEMO_BEFORE -> $DEMO_AFTER)"
ok "--replace moved demo day two days earlier and the server read the newest record"
if buzz_as stranger launchpad seasons start --number 2 >/dev/null 2>"$STATE/stranger.err"; then fail "a stranger started a season"; fi
grep -q 'only the people who run this server can start a season' "$STATE/stranger.err" || fail "the stranger's refusal is not the server's sentence: $(cat "$STATE/stranger.err")"
ok "a stranger's key cannot start a season: \"only the people who run this server can start a season\""
if buzz_as operator launchpad seasons start --number 3 --days 90 >/dev/null 2>"$STATE/bad.err"; then fail "a season of 90 days to demo day was signed"; fi
ok "dates the server would refuse are refused by the command before it signs"

run_client season entry
run_client season again
FOUNDER_REF="$PROJECT_D-${FOUNDER_PUB:0:16}"
out="$(buzz_as operator launchpad seasons remove --number 1 --project "$FOUNDER_REF" 2>"$STATE/remove.err")" || { cat "$STATE/remove.err" >&2; fail "the removal failed"; }
[[ "$(jq -r .accepted <<<"$out")" == "true" ]] || fail "the server did not accept the removal: $out"
ok "buzz launchpad seasons remove took the project out of season 1 (named by its link: $FOUNDER_REF)"
run_client season removed

kill -0 "$RELAY_PID" 2>/dev/null || fail "the relay stopped"
ok "the relay was still up at the end"
echo
echo "room-loop: $N checks passed."
