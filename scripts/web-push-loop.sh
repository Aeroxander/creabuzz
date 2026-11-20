#!/usr/bin/env bash
# web-push-loop.sh: web push alerts on a real relay, a real chain and a stand-in push service (package P3 of
# docs/next-version/STEP3-PLAN.md).
#
# Starts a local chain (anvil), deploys contracts/pot with its own deploy script (play dollars, the real 7-day unit),
# launches one project whose launch names the hash of the project record's address, backs it from two wallets and lets a
# third take everything out. Then it starts the stand-in push service (scripts/web-push-standin.mjs: it makes the devices'
# keys, decrypts what it receives and checks the VAPID token), and the real relay with the chain reader on and web push
# configured from the environment with a key made for this run (never written to a file). The checks, over the wire:
#
#   - the relay with only one of the two push settings refuses to start and names both; with neither it has no `webPush`
#     in `/info` and answers "not switched on" at `PUT /push/web`;
#   - with both: `/info` carries the public half of the key; an unsigned `PUT /push/web` is refused with 401; a signed one
#     keeps the device; a subscription to the metadata address is refused;
#   - the alert maker starts at the chain's position (no history is alerted); then a task is planned on the chain, and
#     another is planned and withdrawn: the stand-in receives exactly ONE message, for the holder who linked their wallet,
#     decrypted: the three keys, no amount or name, the right link, a verified token and a 32-character topic; a stranger, a
#     person who took everything out, and a holder who never linked their wallet get nothing;
#   - after the holder removes the device (the app's "Turn off") the next task reaches nobody; keeping it again brings the
#     next one back;
#   - the key appears in no log line.
#
# Prints one `ok` line per check and "web-push-loop: N checks passed." at the end. Stops what it started (anvil, the relay,
# the stand-in, a Redis it had to start), drops its scratch database and removes its temporary files, whatever the outcome.
#
# Needs: anvil, cast, forge (FOUNDRY_BIN or PATH), psql, a Postgres and a Redis (started here when they are not running),
# node 22 with web/node_modules and packages/creaton-core/node_modules, jq, openssl, python3, and built binaries
# (`cargo build -p buzz-relay`). Uses anvil's well-known development keys only; every amount is play money. No real push
# service, device or key is used.
#
# Env: POSTGRES_ADMIN_URL (default postgres://buzz:buzz_dev@127.0.0.1:5432/postgres), REDIS_URL, RELAY_BIN, FOUNDRY_BIN,
#      KEEP_DB=1, RELAY_LOG_COPY=<file>.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
N=0
step() { printf '\033[36m[web-push-loop]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[web-push-loop] FAIL %s\033[0m\n' "$*" >&2; exit 1; }
ok() { N=$((N + 1)); printf '\033[32m[web-push-loop] ok %02d\033[0m %s\n' "$N" "$*"; }

[[ -n "${FOUNDRY_BIN:-}" ]] && PATH="$FOUNDRY_BIN:$PATH"
for tool in anvil cast forge psql curl node jq openssl python3 basenc; do
  command -v "$tool" >/dev/null 2>&1 || { echo "web-push-loop: $tool is not on PATH" >&2; exit 2; }
done

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@127.0.0.1:5432/postgres}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
RELAY_BIN="${RELAY_BIN:-target/debug/buzz-relay}"
POT="$REPO_ROOT/contracts/pot"
DB="buzz_push_loop_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
ANVIL_PID=""; RELAY_PID=""; REDIS_PID=""; STANDIN_PID=""; STARTED_PG=""
CLIENT=(node --experimental-strip-types --no-warnings scripts/web-push-loop-client.mjs)

stop_pid() { [[ -n "$1" ]] && kill "$1" 2>/dev/null && wait "$1" 2>/dev/null; return 0; }
cleanup() {
  trap - EXIT
  stop_pid "$RELAY_PID"; stop_pid "$STANDIN_PID"; stop_pid "$ANVIL_PID"; stop_pid "$REDIS_PID"
  [[ -n "${RELAY_LOG_COPY:-}" && -f "$STATE/relay.log" ]] && cp "$STATE/relay.log" "$RELAY_LOG_COPY"
  if [[ "${KEEP_DB:-}" == "1" ]]; then echo "[web-push-loop] kept the scratch database: $DB_URL" >&2
  else psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1; fi
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
  REDIS_PID=$!; sleep 1
  [[ "$(redis-cli -u "$REDIS_URL" ping 2>/dev/null)" == "PONG" ]] || fail "Redis did not start"
fi

# ── the stand-in for a push service, and the run's accounts ─────────────────────────────────────────────────────────────
node scripts/web-push-standin.mjs --self-test >"$STATE/selftest.log" 2>&1 || { cat "$STATE/selftest.log" >&2; fail "the stand-in does not read the RFC 8291 message"; }
ok "the stand-in reads RFC 8291 appendix A's message and RFC 8292's token (so what it says about the relay's pushes can be believed)"
STANDIN_PORT="$(free_port)"
node scripts/web-push-standin.mjs --port "$STANDIN_PORT" >"$STATE/standin.log" 2>&1 &
STANDIN_PID=$!
STANDIN="http://127.0.0.1:$STANDIN_PORT"
for _ in $(seq 1 50); do curl -fsS -m 1 "$STANDIN/_received" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fsS -m 1 "$STANDIN/_received" >/dev/null 2>&1 || fail "the stand-in did not start"

"${CLIENT[@]}" keys "$STATE/keys.json" || fail "could not make the run's keys"
pubkey() { "${CLIENT[@]}" pubkey "$STATE/keys.json" "$1"; }
FOUNDER_PUB="$(pubkey founder)"
PROJECT_D="web-push-loop"
COORD="37001:$FOUNDER_PUB:$PROJECT_D"
PROJECT_ID="$(cast keccak "$COORD")"
LINK_REF="$PROJECT_D-${FOUNDER_PUB:0:16}"

# ── the chain ────────────────────────────────────────────────────────────────────────────────────────────────────────────
CHAIN_PORT="$(free_port)"; RPC="http://127.0.0.1:$CHAIN_PORT"
anvil --port "$CHAIN_PORT" --chain-id 31337 --accounts 14 --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || fail "anvil did not start"
MNEMONIC="test test test test test test test test test test test junk"
key() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
K_DEPLOYER="$(key 0)"; K_FOUNDER="$(key 1)"; K_A="$(key 2)"; K_C="$(key 10)"; K_E="$(key 8)"
addr() { cast wallet address --private-key "$1" | tr 'A-F' 'a-f'; }
A="$(addr "$K_A")"; C="$(addr "$K_C")"; E="$(addr "$K_E")"

send() { # key, to, args...
  local k="$1" to="$2"; shift 2
  cast send --rpc-url "$RPC" --private-key "$k" --json "$to" "$@" >"$STATE/last.json" 2>"$STATE/last.err" \
    || { cat "$STATE/last.err" >&2; fail "a transaction that must succeed failed: $*"; }
  [[ "$(jq -r .status "$STATE/last.json")" == "0x1" ]] || fail "a transaction reverted: $*"
  LAST_BLOCK="$(jq -r .blockNumber "$STATE/last.json" | xargs printf '%d')"
}
call() { cast call --rpc-url "$RPC" "$@" | awk 'NR==1{print $1}'; }
mine() { for _ in $(seq 1 "${1:-1}"); do cast rpc --rpc-url "$RPC" evm_mine >/dev/null; done; }

step "deploying contracts/pot on anvil :$CHAIN_PORT"
(cd "$POT" && forge script script/DeployPot.s.sol --rpc-url "$RPC" --broadcast --private-key "$K_DEPLOYER" >"$STATE/deploy.log" 2>&1) \
  || { tail -20 "$STATE/deploy.log" >&2; fail "the deploy script failed"; }
DEPLOY_JSON="$POT/deployments/pot-31337.json"
USD="$(jq -r .quote "$DEPLOY_JSON" | tr 'A-F' 'a-f')"; LAUNCHER="$(jq -r .launcher "$DEPLOY_JSON" | tr 'A-F' 'a-f')"
START_BLOCK="$(cast block-number --rpc-url "$RPC")"
ok "deployed the play dollar $USD and the Launcher $LAUNCHER (block $START_BLOCK)"

HASH="$(call "$LAUNCHER" "settingsHash()(bytes32)")"
send "$K_FOUNDER" "$LAUNCHER" "launch(bytes32,string,string,(uint32,uint256),bytes32)" "$PROJECT_ID" "Web Push Loop" "PUSH" "(1000,10000000000000000000000000)" "$HASH"
FOUNDER_WALLET="$(addr "$K_FOUNDER")"
KEY="$(call "$LAUNCHER" "keyOf(address,bytes32)(bytes32)" "$FOUNDER_WALLET" "$PROJECT_ID" | tr 'A-F' 'a-f')"
PROJ="$(cast call --rpc-url "$RPC" "$LAUNCHER" "project(address,bytes32)((address,address,address,address,address,uint64))" "$FOUNDER_WALLET" "$PROJECT_ID" | tr -d '()' | tr ',' '\n' | awk '{print $1}')"
SHARES="$(sed -n 2p <<<"$PROJ" | tr 'A-F' 'a-f')"; T="$(sed -n 4p <<<"$PROJ" | tr 'A-F' 'a-f')"
BOOK="$(call "$T" "tasks()(address)" | tr 'A-F' 'a-f')"
ok "launched a project whose launch names the hash of $COORD (key $KEY)"

back() { # key, wallet, play dollars (whole)
  send "$1" "$USD" "faucet()"
  send "$1" "$USD" "transferAndCall(address,uint256,bytes)" "$T" "$(( $3 * 1000000 ))" "$(cast abi-encode 'f(uint256,address)' 0 "$2")"
}
back "$K_A" "$A" 100
back "$K_E" "$E" 50
back "$K_C" "$C" 50
N_C="$(call "$SHARES" "balanceOf(address)(uint256)" "$C")"
QUOTE="$(cast call --rpc-url "$RPC" "$T" "quoteTakeOut(address,uint256)(uint256,uint256,uint256)" "$C" "$N_C" | awk 'NR==1{print $1}')"
send "$K_C" "$T" "leave(uint256,uint256,address)" "$N_C" "$(( QUOTE - 100000 ))" "$C"
LEFT_BLOCK="$LAST_BLOCK"
mine 4
ok "a holder backed the project, another backed it and never linked a wallet, a third backed it and took everything out (block $LEFT_BLOCK)"

# ── the relay: first the two ways it must NOT send, then the real one ──────────────────────────────────────────────────
VAPID_KEY="$(openssl ecparam -name prime256v1 -genkey -noout -out /dev/stdout 2>/dev/null | openssl ec -outform DER 2>/dev/null | tail -c +8 | head -c 32 | basenc --base64url | tr -d '=')"
[[ ${#VAPID_KEY} -eq 43 ]] || fail "could not make a VAPID key for this run"
SUBJECT="mailto:operator@example.org"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database"
cp "$RELAY_BIN" "$STATE/buzz-relay"
RELAY_OWNER="$(openssl rand -hex 32)"
relay_env() { # port, health, metrics -> the settings every start shares
  local port="$1" health="$2" metrics="$3"
  echo DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" BUZZ_AUTO_MIGRATE=true BUZZ_RELAY_PRIVATE_KEY="$RELAY_OWNER" \
    BUZZ_BIND_ADDR="127.0.0.1:$port" BUZZ_RELAY_URL="ws://localhost:$port" RELAY_URL="ws://localhost:$port" \
    BUZZ_HEALTH_PORT="$health" BUZZ_METRICS_PORT="$metrics" BUZZ_GIT_CONFORMANCE_PROBE=false \
    BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_NEW_ACCOUNT_POSTS_PER_HOUR=0 BUZZ_NEW_ACCOUNT_PROJECT_RECORDS_PER_DAY=0 \
    BUZZ_CHAIN_RPC_URL="$RPC" BUZZ_CHAIN_ID=31337 BUZZ_CHAIN_LAUNCHER="$LAUNCHER" BUZZ_CHAIN_START_BLOCK="$START_BLOCK" \
    BUZZ_CHAIN_CONFIRMATIONS=2 BUZZ_CHAIN_POLL_SECS=1 BUZZ_CHAIN_REFRESH_SECS=7 BUZZ_CHAIN_ACTIVE_REFRESH_SECS=5
}
wait_up() { # base url, pid, log
  for _ in $(seq 1 180); do
    curl -fsS -m 2 -H 'Accept: application/nostr+json' "$1/" >/dev/null 2>&1 && return 0
    kill -0 "$2" 2>/dev/null || { tail -30 "$3" >&2; fail "the relay exited"; }
    sleep 1
  done
  tail -30 "$3" >&2; fail "the relay did not come up"
}

# Half a setting stops the relay at start and names both.
PORT="$(free_port)"
if env $(relay_env "$PORT" "$(free_port)" "$(free_port)") BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY="$VAPID_KEY" timeout 60 "$STATE/buzz-relay" >"$STATE/half.log" 2>&1; then
  fail "the relay started with a push key and no contact"
fi
grep -q 'BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY' "$STATE/half.log" && grep -q 'BUZZ_WEB_PUSH_SUBJECT' "$STATE/half.log" || { tail -5 "$STATE/half.log" >&2; fail "the refusal does not name both settings"; }
grep -q "$VAPID_KEY" "$STATE/half.log" && fail "the key was printed"
ok "the relay with a push key and no contact stops at start and names both settings (and does not print the key)"

# With neither, push is off: no webPush in /info, the path refuses, nothing is stored.
OFF_PORT="$(free_port)"
env $(relay_env "$OFF_PORT" "$(free_port)" "$(free_port)") "$STATE/buzz-relay" >"$STATE/off.log" 2>&1 &
OFF_PID=$!
wait_up "http://localhost:$OFF_PORT" "$OFF_PID" "$STATE/off.log"
INFO="$(curl -fsS -H 'Accept: application/nostr+json' "http://localhost:$OFF_PORT/info")"
[[ "$(jq 'has("webPush")' <<<"$INFO")" == "false" ]] || fail "a relay with push off advertises webPush: $INFO"
[[ "$(jq -r '.smartAccountLinks' <<<"$INFO")" == "false" ]] || fail "a relay with a chain reader and no chain connection for phone links must say smartAccountLinks false: $INFO"
code="$(curl -s -o "$STATE/off-put.json" -w '%{http_code}' -X PUT -H 'content-type: application/json' -d '{}' "http://localhost:$OFF_PORT/push/web")"
[[ "$code" == 404 ]] && grep -q 'not switched on' "$STATE/off-put.json" || fail "PUT /push/web on a relay with push off answered $code: $(cat "$STATE/off-put.json")"
stop_pid "$OFF_PID"
ok "with push off: no webPush in /info (smartAccountLinks is false), PUT /push/web answers 404 \"not switched on\""

PORT="$(free_port)"; HEALTH="$(free_port)"; METRICS="$(free_port)"; BASE="http://localhost:$PORT"
step "starting the relay on :$PORT with the chain reader and web push (the stand-in at :$STANDIN_PORT is the one extra host)"
env $(relay_env "$PORT" "$HEALTH" "$METRICS") \
  BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY="$VAPID_KEY" BUZZ_WEB_PUSH_SUBJECT="$SUBJECT" BUZZ_WEB_PUSH_EXTRA_HOSTS="127.0.0.1:$STANDIN_PORT" \
  "$STATE/buzz-relay" >"$STATE/relay.log" 2>&1 &
RELAY_PID=$!
wait_up "$BASE" "$RELAY_PID" "$STATE/relay.log"
INFO="$(curl -fsS -H 'Accept: application/nostr+json' "$BASE/info")"
PUBLIC="$(jq -r '.webPush.publicKey' <<<"$INFO")"
python3 - "$PUBLIC" <<'PY' || fail "/info's webPush.publicKey is not a 65-byte uncompressed P-256 point: $PUBLIC"
import base64, sys
raw = base64.urlsafe_b64decode(sys.argv[1] + "=" * (-len(sys.argv[1]) % 4))
sys.exit(0 if len(raw) == 65 and raw[0] == 4 else 1)
PY
curl -fsS -X POST -d "{\"publicKey\":\"$PUBLIC\"}" "$STANDIN/_vapid" >/dev/null || fail "could not give the stand-in the operator's public key"
ok "with both settings the relay is up and /info carries the public half of the key (65 bytes)"

# ── the project's records and the devices ──────────────────────────────────────────────────────────────────────────────
KEY_HEX="${KEY#0x}"
for _ in $(seq 1 120); do
  seen="$(psql "$DB_URL" -Atc "select coalesce(max(block_number), 0) from chain_balance_changes where project_key = decode('$KEY_HEX', 'hex')" 2>/dev/null || echo 0)"
  [[ "${seen:-0}" -ge "$LEFT_BLOCK" ]] && break
  mine 1; sleep 1
done
[[ "${seen:-0}" -ge "$LEFT_BLOCK" ]] || { tail -20 "$STATE/relay.log" >&2; fail "the reader did not store the balances up to block $LEFT_BLOCK (it stored $seen)"; }
ok "the reader stored the project's launch and its Share balances up to block $seen"

export BASE STANDIN KEY PROJECT_D K_A K_C K_E
run_client() { # mode and arguments; counts the client's checks
  local out n
  out="$("${CLIENT[@]}" "$1" "$STATE/keys.json" "${@:2}" 2>"$STATE/client.err")" || { printf '%s\n' "$out" >&2; cat "$STATE/client.err" >&2; fail "the wire checks failed in $1 ${*:2}"; }
  printf '%s\n' "$out" | grep '^ok ' | sed "s/^ok /[web-push-loop]    /"
  n="$(printf '%s\n' "$out" | awk '/^CHECKS /{print $2}')"
  [[ -n "$n" ]] || fail "the wire checks did not finish in $1"
  N=$((N + n))
}
run_client setup "$STATE/devices.json"
device_path() { jq -r ".$1.endpoint" "$STATE/devices.json" | sed 's#^http://[^/]*##'; }
count_sql() { psql "$DB_URL" -Atc "$1"; }
[[ "$(count_sql "select count(*) from web_push_subscriptions")" == 2 ]] || fail "the relay does not keep exactly the two devices of the two accounts that linked a wallet"
ok "the relay keeps exactly the two devices of the accounts that linked a wallet (the unlinked holder and the stranger kept none, and the bad subscription wrote nothing)"

# ── the cursor starts where the chain is: nothing before it is alerted ─────────────────────────────────────────────────
for _ in $(seq 1 60); do [[ "$(count_sql "select count(*) from web_push_cursor")" == 1 ]] && break; mine 1; sleep 1; done
[[ "$(count_sql "select count(*) from web_push_cursor")" == 1 ]] || { tail -20 "$STATE/relay.log" >&2; fail "the alert maker never set its cursor"; }
[[ "$(count_sql "select count(*) from web_push_alerts")" == 0 ]] || fail "alerts were made for what the chain did before push was on"
ok "the alert maker's cursor is set at the reader's position and the project's history made no alert"

# ── a task is planned, another is planned and withdrawn ────────────────────────────────────────────────────────────────
announce() { # label, payee, max dollars, share (ten-thousandths) -> serial in $SERIAL
  SERIAL="$(call "$BOOK" "nextSerial()(uint64)")"
  send "$K_FOUNDER" "$T" "announceTask(bytes32,address,uint256,uint16)" "$(cast keccak "push loop task $1")" "$2" "$3" "$4"
}
WORKER="$(addr "$(key 3)")"
send "$K_FOUNDER" "$T" "checkIn(bytes32)" "$(cast keccak "push loop record 1")"
announce one "$WORKER" 40000000 200; S_KEPT="$SERIAL"
announce two "$WORKER" 30000000 100; S_WITHDRAWN="$SERIAL"
send "$K_FOUNDER" "$T" "cancelTask(uint64)" "$S_WITHDRAWN"
mine 4
received() { curl -fsS "$STANDIN/_received"; }
for _ in $(seq 1 90); do
  [[ "$(received | jq length)" -ge 1 ]] && break
  mine 1; sleep 1
done
[[ "$(received | jq length)" -ge 1 ]] || { tail -30 "$STATE/relay.log" >&2; fail "the stand-in received nothing after a task was planned"; }
sleep 12 # two more ticks: a second message, or one for someone else, would have come by now
GOT="$(received)"
[[ "$(jq length <<<"$GOT")" == 1 ]] || fail "the stand-in received $(jq length <<<"$GOT") messages, not one: $GOT"
HOLDER_PATH="$(device_path holder)"
[[ "$(jq -r '.[0].path' <<<"$GOT")" == "$HOLDER_PATH" ]] || fail "the message went to $(jq -r '.[0].path' <<<"$GOT"), not the holder's device $HOLDER_PATH"
ok "the stand-in received ONE push, and it is for the holder who linked their wallet (not the stranger, the leaver, or the holder who never linked)"
python3 - "$GOT" "$LINK_REF" "$SUBJECT" <<'PY' || fail "the message or its headers are not what the plan says"
import json, sys
got, link_ref, subject = json.loads(sys.argv[1])[0], sys.argv[2], sys.argv[3]
assert got["messageError"] is None, got["messageError"]
message = json.loads(got["message"])
assert sorted(message) == ["k", "r", "v"], message
assert message == {"v": 1, "k": "planned", "r": link_ref}, message
assert len(got["message"]) < 200
assert got["vapidError"] is None, got["vapidError"]
claims = got["vapid"]
assert claims["sub"] == subject and claims["aud"].startswith("http://127.0.0.1:"), claims
assert got["ttl"] == "86400" and got["urgency"] == "normal" and got["contentEncoding"] == "aes128gcm", got
assert got["topic"] and len(got["topic"]) == 32, got["topic"]
PY
ok "the stand-in decrypted {\"v\":1,\"k\":\"planned\",\"r\":\"$LINK_REF\"}: exactly three keys, no amount or name, a verified token, TTL 86400, a 32-character topic"
[[ "$(count_sql "select count(*) from web_push_alerts")" == 1 && "$(count_sql "select serial from web_push_alerts")" == "$S_KEPT" ]] || fail "the withdrawn plan made an alert (or the planned one did not)"
[[ "$(count_sql "select count(*) from web_push_outbox")" == 1 && "$(count_sql "select state from web_push_outbox")" == delivered ]] || fail "the outbox is not one delivered row"
ok "one alert (task $S_KEPT planned), one outbox row, delivered; the withdrawn plan (task $S_WITHDRAWN) made none"

# ── the person turns alerts off; the next task reaches nobody; turning them on again brings the next one ─────────────────
run_client remove "$STATE/devices.json" holder
[[ "$(count_sql "select count(*) from web_push_subscriptions")" == 1 ]] || fail "removing the holder's device did not remove one row"
announce three "$WORKER" 20000000 100; S_AFTER="$SERIAL"
mine 4
for _ in $(seq 1 60); do
  [[ "$(count_sql "select count(*) from web_push_alerts")" == 2 ]] && break
  mine 1; sleep 1
done
[[ "$(count_sql "select count(*) from web_push_alerts")" == 2 ]] || fail "the next task made no alert"
sleep 8
[[ "$(received | jq length)" == 1 ]] || fail "a push was sent after the holder removed the device"
[[ "$(count_sql "select count(*) from web_push_outbox")" == 0 ]] || fail "the removed device's rows were not deleted with it, or the next alert made a row for someone"
ok "after the holder removed the device (its rows went with it) the next task (task $S_AFTER) made an alert that reached nobody"
run_client again "$STATE/devices.json" holder
announce four "$WORKER" 20000000 100; S_AGAIN="$SERIAL"
mine 4
for _ in $(seq 1 90); do
  [[ "$(received | jq length)" -ge 2 ]] && break
  mine 1; sleep 1
done
[[ "$(received | jq length)" == 2 ]] || { tail -20 "$STATE/relay.log" >&2; fail "the holder who kept the device again did not get the next push ($(received | jq length) received)"; }
[[ "$(received | jq -r '.[1].path')" == "$HOLDER_PATH" ]] || fail "the second push went to the wrong device"
ok "after the holder kept the device again the next task (task $S_AGAIN) reached it: two pushes in all, none for anyone else"

# ── a refused key is a retry and a pause, never a lost row: the stand-in turns the operator's key down ──────────────────
curl -fsS -X POST -d '{"answers":[403]}' "$STANDIN/_script" >/dev/null
announce five "$WORKER" 20000000 100
mine 4
for _ in $(seq 1 60); do
  [[ "$(count_sql "select count(*) from web_push_outbox where state = 'pending' and last_status = 403")" == 1 ]] && break
  mine 1; sleep 1
done
[[ "$(count_sql "select count(*) from web_push_outbox where state = 'pending' and last_status = 403")" == 1 ]] || fail "a refused key did not leave a pending row with its status"
[[ "$(count_sql "select attempts from web_push_outbox where state = 'pending'")" == 1 ]] || fail "the attempt was not counted"
ok "a push the service refused with 403 is a pending row with its status and one attempt, to be tried again with a pause"

grep -q "$VAPID_KEY" "$STATE/relay.log" && fail "the VAPID key appears in the relay's log"
ok "the VAPID key appears in no line of the relay's log"
kill -0 "$RELAY_PID" 2>/dev/null || fail "the relay stopped"
ok "the relay was still up at the end"
echo
echo "web-push-loop: $N checks passed."
