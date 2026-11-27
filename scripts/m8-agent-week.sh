#!/usr/bin/env bash
#
# scripts/m8-agent-week.sh — "an agent runs a week unattended", against the REAL relay and a scratch database.
#
# Seven simulated days (docs/PLAN-V2.md section 9, milestone 8). A person starts a project; a manager agent asks the
# server for the weekly draft every day it is allowed to; a worker agent and a stranger take, work and hand in tasks;
# the team's other agents, the manager and the stranger try to check the work and are refused; and no record says the
# work was accepted, or paid, until the founder (a person) accepts it on day 6. What it proves, and what it does not:
#
#   proves   - the manager asks for drafts as the founder's own labelled account; a worker agent may not
#            - "post weekly" binds a project older than 14 days: day 1's draft is refused until the founder posts
#            - the draft passes the honesty envelope: a made-up worth is blocked, a tax question goes to a person, no
#              "What's next" is ever drafted, and nothing is posted by the manager
#            - the worker agent takes and hands in a task open to anyone; its own, its sibling's, the manager's and a
#              stranger's confirmation are all refused; no "accepted" record exists before the founder's
#            - drafts are counted against the week, and what they cost stays under a tenth of the platform's fees
#   not      - money. Paying is a Treasury spend the runner presses in the app (tested on a local chain by
#              scripts/pot-app-loop.sh and the app's journeys); here the founder's acceptance is written without a
#              payment, and the script says so. It does not check the real AI model either (scripts/m8-planted-eval.sh).
#
# Time: the server has no test clock. A day passes by moving every stored record one day into the past in the SCRATCH
# database (the project is also made 20 days old at the start so the 14-day "post weekly" rule has something to bind).
# The weekly allowance and the spend counters keep real time, which is why seven drafts fit in one real week.
#
# Never runs cargo: it needs target/debug/buzz-relay and target/debug/buzz built from this tree (or RELAY_BIN and
# BUZZ_BIN). Starts Postgres and Redis only if they are not answering, and stops only what it started. Every key is
# made for the run and none is written to disk. The AI service is a stand-in on a local port that answers every call.
#
# ⚠️  DEV ONLY. Its own database, dropped on exit.
#
# Usage:  scripts/m8-agent-week.sh
# Env:    KEEP_DB=1 (keep the scratch database and print its address), RELAY_BIN, BUZZ_BIN, POSTGRES_ADMIN_URL, REDIS_URL,
#         RELAY_LOG_COPY=<file>
# Exit:   0 every check passed; 1 a check failed; 2 the world could not be set up

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\033[36m[m8-agent-week]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[m8-agent-week] %s\033[0m\n' "$*" >&2; exit 2; }

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@127.0.0.1:5432/postgres}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
RELAY_BIN="${RELAY_BIN:-target/debug/buzz-relay}"
BUZZ="${BUZZ_BIN:-target/debug/buzz}"
DB="buzz_m8_week_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
RELAY_PID=""; AI_PID=""; REDIS_PID=""; PG_CLUSTER=""; DB_MADE=""
PASSES=0; FAILS=0

for tool in psql curl node openssl python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool"
done
[[ -x "$RELAY_BIN" ]] || fail "no relay at $RELAY_BIN: build it once with cargo (this script never does), or set RELAY_BIN"
[[ -x "$BUZZ" ]] || fail "no command line at $BUZZ: build it once with cargo (this script never does), or set BUZZ_BIN"
"$BUZZ" launchpad manager draft --help >/dev/null 2>&1 \
  || fail "$BUZZ has no 'launchpad manager draft': it is older than this tree. Build buzz-cli again."
[[ -d app/node_modules/nostr-tools ]] || fail "app/node_modules/nostr-tools is missing: run pnpm install"

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
wait_for() { local n="$1"; shift; for _ in $(seq 1 "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
stop_pid() {
  local pid="$1"; [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.2; done
  kill -9 "$pid" 2>/dev/null || true
}
cleanup() {
  local code=$?
  trap - EXIT
  stop_pid "$RELAY_PID"; stop_pid "$AI_PID"
  if [[ -n "$DB_MADE" && "${KEEP_DB:-}" == "1" ]]; then
    echo "[m8-agent-week] kept the scratch database: $DB_URL (drop it with: psql \"$ADMIN_URL\" -c 'drop database $DB with (force)')" >&2
  elif [[ -n "$DB_MADE" ]]; then
    psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1
  fi
  stop_pid "$REDIS_PID"
  # shellcheck disable=SC2086
  [[ -n "$PG_CLUSTER" ]] && pg_ctlcluster $PG_CLUSTER stop >/dev/null 2>&1
  [[ -n "${RELAY_LOG_COPY:-}" && -f "$STATE/relay.log" ]] && cp "$STATE/relay.log" "$RELAY_LOG_COPY"
  rm -rf "$STATE"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

pg_ready() { psql "$ADMIN_URL" -qAtc 'select 1'; }
redis_ready() { [[ "$(redis-cli -u "$REDIS_URL" ping 2>/dev/null)" == "PONG" ]]; }

step "Postgres and Redis"
if ! pg_ready >/dev/null 2>&1; then
  command -v pg_ctlcluster >/dev/null 2>&1 && command -v pg_lsclusters >/dev/null 2>&1 \
    || fail "Postgres is not answering at $ADMIN_URL and there is no pg_ctlcluster to start it with"
  cluster="$(pg_lsclusters -h | awk '$4 == "down" { print $1, $2; exit }')"
  [[ -n "$cluster" ]] || fail "Postgres is not answering at $ADMIN_URL and no stopped cluster was found to start"
  # shellcheck disable=SC2086
  pg_ctlcluster $cluster start || fail "could not start the Postgres cluster $cluster"
  PG_CLUSTER="$cluster"
  wait_for 30 pg_ready || fail "Postgres was started but does not answer at $ADMIN_URL"
fi
if ! redis_ready; then
  command -v redis-server >/dev/null 2>&1 || fail "Redis is not answering at $REDIS_URL and there is no redis-server to start"
  redis_port="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).port or 6379)' "$REDIS_URL")"
  redis-server --port "$redis_port" --bind 127.0.0.1 --save "" --appendonly no >"$STATE/redis.log" 2>&1 &
  REDIS_PID=$!
  wait_for 20 redis_ready || { tail -20 "$STATE/redis.log" >&2; fail "Redis was started but does not answer at $REDIS_URL"; }
fi

ln "$RELAY_BIN" "$STATE/buzz-relay" 2>/dev/null || cp "$RELAY_BIN" "$STATE/buzz-relay" || fail "could not take a copy of $RELAY_BIN"
ln "$BUZZ" "$STATE/buzz" 2>/dev/null || cp "$BUZZ" "$STATE/buzz" || fail "could not take a copy of $BUZZ"
BUZZ="$STATE/buzz"

# ── The AI service: a stand-in that answers every call the same way and counts them ────────────────────────────────
# What it "writes" is what a careless model might: two lines the record backs, one with a made-up worth the envelope must
# block, and a "what happened" line citing a record that was read.
cat >"$STATE/ai.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

REPLY = json.dumps({
    "this_week": [{"text": "Keep testing the lamps.", "from": ["r1"]}],
    "not_doing": [],
    "what_happened": [
        {"text": "Posted the weekly update.", "from": ["r1"]},
        {"text": "Lamps said to be worth 9000 dollars.", "from": ["r1"]},
    ],
})

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        with open(sys.argv[2], "a") as calls:
            calls.write("1\n")
        body = json.dumps({
            "choices": [{"message": {"content": REPLY}}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 100},
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass

HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
PY
AI_PORT=$(free_port)
python3 -I "$STATE/ai.py" "$AI_PORT" "$STATE/ai-calls" >/dev/null 2>&1 &
AI_PID=$!
: >"$STATE/ai-calls"

step "a scratch database ($DB)"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database"
DB_MADE=1

PORT=$(free_port); HEALTH=$(free_port); METRICS=$(free_port); DEAD_RPC=$(free_port)
LAUNCHER=0x5fbdb2315678afecb367f032d93f642f64180aa3
READER="31337:$LAUNCHER"
step "starting the relay on :$PORT (AI service priced, a chain reader that reads nothing, hosted-manager ceiling 50 cents)"
env DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" BUZZ_AUTO_MIGRATE=true \
  BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="127.0.0.1:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" BUZZ_MEDIA_BASE_URL="http://localhost:$PORT/media" \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_GIT_CONFORMANCE_PROBE=false BUZZ_ALLOW_NIP_OA_AUTH=true \
  BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=600 BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=2000 \
  BUZZ_NEW_ACCOUNT_POSTS_PER_HOUR=0 BUZZ_NEW_ACCOUNT_PROJECT_RECORDS_PER_DAY=0 \
  BUZZ_LLM_PROXY_URL="http://127.0.0.1:$AI_PORT/v1/chat/completions" BUZZ_LLM_API_KEY="$(openssl rand -hex 16)" \
  BUZZ_LLM_PRICE_INPUT_CENTS_PER_MTOK=300 BUZZ_LLM_PRICE_OUTPUT_CENTS_PER_MTOK=1500 BUZZ_LLM_RATE_PER_MIN=60 \
  BUZZ_MANAGER_CALLS_PER_WEEK=10 BUZZ_MANAGER_MAX_CENTS_PER_90_DAYS=50 \
  BUZZ_MANAGER_FLOOR_CENTS_PER_90_DAYS=50 \
  BUZZ_CHAIN_RPC_URL="http://127.0.0.1:$DEAD_RPC" BUZZ_CHAIN_ID=31337 BUZZ_CHAIN_LAUNCHER="$LAUNCHER" \
  "$STATE/buzz-relay" >"$STATE/relay.log" 2>&1 &
RELAY_PID=$!
relay_up() { curl -fsS -m 2 -H 'Accept: application/nostr+json' "http://localhost:$PORT/"; }
for _ in $(seq 1 120); do
  relay_up >/dev/null 2>&1 && break
  kill -0 "$RELAY_PID" 2>/dev/null || { tail -30 "$STATE/relay.log" >&2; fail "the relay exited"; }
  sleep 1
done
relay_up >/dev/null 2>&1 || { tail -30 "$STATE/relay.log" >&2; fail "the relay did not come up in two minutes"; }
sql() { psql "$DB_URL" -qAtX -c "$1"; }
sql "insert into communities (host) values ('localhost:$PORT') on conflict ((lower(host))) do nothing" >/dev/null \
  || fail "could not add this run's address to the server's communities"
CID="$(sql "select id from communities where lower(host) = 'localhost:$PORT'")"
[[ -n "$CID" ]] || fail "no community for this run"
BASE="http://localhost:$PORT"

# ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
json() { python3 -c 'import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d = d[int(k)] if isinstance(d, list) else (d.get(k) if isinstance(d, dict) else None)
print("" if d is None else (json.dumps(d) if isinstance(d, (dict, list, bool)) else d))' "$1" 2>/dev/null; }
ok() { PASSES=$((PASSES + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { FAILS=$((FAILS + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1" >&2; [[ -n "${2:-}" ]] && printf '       %s\n' "$2" >&2; }
check() { # check "what" "$got" "$want"
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "got: $2 | wanted: $3 | last output: ${OUT:0:500}"; fi
}
contains() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1" "no \"$3\" in: ${2:0:300}"; fi; }
lacks() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else bad "$1" "found \"$3\" in: ${2:0:300}"; fi; }

# who KEY [TAG] -- buzz args…   → OUT (stdout and stderr together), CODE
run() {
  local key="$1" tag="$2"; shift 2
  OUT="$(BUZZ_PRIVATE_KEY="$key" BUZZ_AUTH_TAG="$tag" BUZZ_RELAY_URL="$BASE" "$BUZZ" "$@" 2>&1)"; CODE=$?
}
# sign KEY TAG 'record JSON' → OUT = {"status", "id", "body"}
sign() { OUT="$(BUZZ_PRIVATE_KEY="$1" BUZZ_AUTH_TAG="$2" node scripts/m8-sign.mjs "$BASE" "$3" 2>&1)"; CODE=$?; }
newkey() { local j; j="$("$BUZZ" users whoami --new)"; echo "$(echo "$j" | json secret) $(echo "$j" | json pubkey)"; }

read -r F_SK F_PK < <(newkey)      # the founder, a person
read -r W_SK W_PK < <(newkey)      # the worker agent, who takes and hands in task A
read -r S_SK S_PK < <(newkey)      # the worker's sibling agent: also run by the founder, and on the team
read -r M_SK M_PK < <(newkey)      # the manager agent, on the team
read -r X_SK X_PK < <(newkey)      # a stranger, who takes and hands in task B
for k in "$F_SK" "$W_SK" "$S_SK" "$M_SK" "$X_SK"; do [[ ${#k} -eq 64 ]] || fail "could not make keys"; done

step "the founder starts a project, and labels three agent accounts it runs: a worker, a sibling and a manager"
run "$F_SK" "" launchpad start --name "Lantern" --pitch "Solar lamps for night markets, made by volunteers." \
  --goal "Light ten night markets" --how "Ten markets run on our lamps"
[[ $CODE -eq 0 ]] || { echo "$OUT" >&2; fail "the founder could not start a project"; }
PID="$(echo "$OUT" | json project.id)"
[[ -n "$PID" ]] || { echo "$OUT" >&2; fail "no project id in: $OUT"; }
COORD="37001:$F_PK:$PID"
label() { # label NAME SK PK [role]
  run "$F_SK" "" agents confirm "$3"
  [[ $CODE -eq 0 ]] || { echo "$OUT" >&2; fail "the founder could not confirm $1"; }
  local tag; tag="$(echo "$OUT" | json auth_tag)"
  [[ -n "$tag" ]] || fail "no auth_tag for $1: $OUT"
  eval "$1_TAG=\$tag"
  if [[ -n "${4:-}" ]]; then run "$2" "$tag" agents label --operator "$F_PK" --role "$4"; else run "$2" "$tag" agents label --operator "$F_PK"; fi
  [[ $CODE -eq 0 ]] || { echo "$OUT" >&2; fail "$1 could not be labelled"; }
}
label W "$W_SK" "$W_PK"
label S "$S_SK" "$S_PK"
label M "$M_SK" "$M_PK" manager

step "the project is made 20 days old, and the sibling agent and the manager join its team"
sql "update events set created_at = created_at - interval '20 days' where community_id = '$CID'" >/dev/null
TEAM_JSON="$(sql "select tags::text from events where community_id='$CID' and kind=37001 and deleted_at is null order by created_at desc limit 1")"
CONTENT="$(sql "select content from events where community_id='$CID' and kind=37001 and deleted_at is null order by created_at desc limit 1")"
RECORD="$(TEAM_JSON="$TEAM_JSON" CONTENT="$CONTENT" S_PK="$S_PK" M_PK="$M_PK" python3 -c 'import json,os
tags=[t for t in json.loads(os.environ["TEAM_JSON"]) if t[0]!="team"]
tags+=[["team",os.environ["S_PK"],"engineer"],["team",os.environ["M_PK"],"manager"]]
print(json.dumps({"kind":37001,"tags":tags,"content":os.environ["CONTENT"]}))')"
sign "$F_SK" "" "$RECORD"
check "the founder adds the sibling agent and the manager to the team" "$(echo "$OUT" | json status)" "200"
sql "update events set created_at = created_at - interval '20 days' where community_id = '$CID' and kind = 37001" >/dev/null

# What the manager is asked, and the day it is asked on, kept in one place.
fees_seed() { # fees in raw dollar units (6 decimals) under the relay's own chain reader name
  sql "insert into chain_blocks (reader, number, hash, parent_hash, block_time) values ('$READER', 1, decode(repeat('07',32),'hex'), decode(repeat('07',32),'hex'), extract(epoch from now())::bigint - 3600)" >/dev/null
  sql "insert into chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, project_key, event, topics, data, decoded) values ('$READER', 1, 0, decode(repeat('07',32),'hex'), decode(repeat('07',32),'hex'), decode(repeat('01',20),'hex'), 'rounds', NULL, 'Settled', '{}', ''::bytea, '{\"toPlatform\": \"$1\"}'::jsonb)" >/dev/null
}
draft() { # draft SK TAG [answer]  → OUT, CODE
  if [[ -n "${3:-}" ]]; then run "$1" "$2" launchpad manager draft "$PID" --author "$F_PK" --answer "$3"
  else run "$1" "$2" launchpad manager draft "$PID" --author "$F_PK"; fi
}
post_update() { # the founder, a person, signs the weekly update
  run "$F_SK" "" launchpad updates post "$PID" --title "Week $1" --done "$2" --next "Light the next four stalls."
  check "day $DAY: the founder signs and posts the weekly update" "$CODE" "0"
}
next_day() {
  sql "update events set created_at = created_at - interval '1 day' where community_id = '$CID'" >/dev/null
  DAY=$((DAY + 1))
  step "day $DAY"
}
confirm_record() { # confirm_record TASK_ID HAND_IN_ID
  python3 -c 'import json,sys
coord,task,hand=sys.argv[1:4]
print(json.dumps({"kind":47003,"content":json.dumps({"title":"Work accepted","body":""}),"tags":[["a",coord],["l","creaton-task"],["task-part","confirm"],["e",task],["task",task],["p",sys.argv[4]],["task-evidence",hand]]}))' \
    "$COORD" "$1" "$2" "$F_PK"
}
confirms() { sql "select count(*) from events where community_id='$CID' and kind=47003 and deleted_at is null and tags @> '[[\"task-part\",\"confirm\"]]'::jsonb"; }
paids() { sql "select count(*) from events where community_id='$CID' and kind=47003 and deleted_at is null and tags::text like '%task-paid%'"; }

# ══ Day 1 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
DAY=1
step "day 1: the manager asks before the founder has posted"
fees_seed 1000000000   # 1,000 dollars of platform fees in the chain reader's tables: a tenth buys many drafts
draft "$M_SK" "$M_TAG"
check "a project older than 14 days with no update is told to post first (exit 3)" "$CODE" "3"
contains "…in the server's words, with its code" "$OUT" "ai_manager_post_weekly"
check "…and the AI service was not called" "$(wc -l <"$STATE/ai-calls" | tr -d ' ')" "0"
post_update 1 "Lit the first four stalls."
draft "$W_SK" "$W_TAG"
check "a worker agent may not ask for a draft (exit 3)" "$CODE" "3"
contains "…the server says only the founder or the founder's manager may" "$OUT" "ai_manager_founder_only"
draft "$M_SK" "$M_TAG" "Do I owe tax on the round?"
check "the manager's draft comes after the update is posted" "$CODE" "0"
D1="$OUT"
check "…it is the manager schema" "$(echo "$D1" | json schema)" "creaton.manager.v1"
lacks "…a made-up worth never reaches the founder" "$D1" "9000"
check "…it was blocked and counted" "$(echo "$D1" | json blocked)" "1"
contains "…the tax question is handed to a person" "$(echo "$D1" | json needs_a_person)" "tax"
check "…nothing is drafted for what's next" "$(echo "$D1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(any(k in d for k in ("next","whats_next","what_next")))')" "False"
contains "…it says what it read and that it can be wrong" "$D1" "can_be_wrong"
check "…the manager posted nothing: the founder's update is the only one" "$(sql "select count(*) from events where community_id='$CID' and kind=47003 and deleted_at is null and tags::text like '%update-part%'")" "1"

step "day 1: the founder posts a task open to anyone, and two stranger-side accounts will take them"
task() { # task "what" usd → TASK_ID
  sign "$F_SK" "" "$(python3 -c 'import json,sys
what,usd,coord=sys.argv[1:4]
print(json.dumps({"kind":47003,"content":json.dumps({"title":"Task","body":what}),"tags":[["a",coord],["l","creaton-task"],["task-part","task"],["task-what",what],["task-done",what],["task-size","small"],["task-usd",usd]]}))' "$1" "$2" "$COORD")"
  check "the founder posts a task: $1, $2 dollars" "$(echo "$OUT" | json status)" "200"
  TASK_ID="$(echo "$OUT" | json id)"
}
task "Test twelve lamps and write down what failed" 40; TASK_A="$TASK_ID"
task "Translate the lamp guide into Spanish" 25; TASK_B="$TASK_ID"
ADDR_W=0x1111111111111111111111111111111111111111
ADDR_X=0x2222222222222222222222222222222222222222

# ══ Day 2 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
next_day
run "$W_SK" "$W_TAG" launchpad tasks take "$PID" --author "$F_PK" --task "$TASK_A" --pay-to "$ADDR_W"
check "the worker agent takes task A" "$CODE" "0"
run "$X_SK" "" launchpad tasks take "$PID" --author "$F_PK" --task "$TASK_B" --pay-to "$ADDR_X"
check "the stranger takes task B" "$CODE" "0"
# The command line already says a team member cannot take an open task, so the manager's own signed take goes straight
# to the server: the manager role may sign no task step, whatever its place on the team.
sign "$M_SK" "$M_TAG" "$(python3 -c 'import json,sys
coord,task,founder,addr=sys.argv[1:5]
print(json.dumps({"kind":47003,"content":json.dumps({"title":"Task taken","body":""}),"tags":[["a",coord],["l","creaton-task"],["task-part","take"],["e",task],["task",task],["p",founder],["task-pay-to",addr]]}))' "$COORD" "$TASK_B" "$F_PK" "$ADDR_W")"
check "the manager agent may sign no task step: its signed take is refused" "$([[ "$(echo "$OUT" | json status)" != 200 ]] && echo refused || echo accepted)" "refused"
check "…and no take by the manager was written" "$(sql "select count(*) from events where community_id='$CID' and kind=47003 and encode(pubkey,'hex')='$M_PK' and tags::text like '%\"take\"%'")" "0"
draft "$M_SK" "$M_TAG"
check "day 2: the manager drafts again (the founder posted within 14 days)" "$CODE" "0"

# ══ Day 3 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
next_day
run "$W_SK" "$W_TAG" launchpad tasks submit "$PID" --author "$F_PK" --task "$TASK_A" \
  --note "Twelve lamps tested; the log is attached." --result "lamps_tested=12/n=12/by=hand count"
check "the worker agent hands in task A, with a number it reports" "$CODE" "0"
HAND_A="$(echo "$OUT" | json event_id)"
draft "$M_SK" "$M_TAG"
check "day 3: the manager drafts" "$CODE" "0"
check "…nothing is accepted or paid yet" "$(confirms)/$(paids)" "0/0"

# ══ Day 4 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
next_day
run "$X_SK" "" launchpad tasks submit "$PID" --author "$F_PK" --task "$TASK_B" --note "The guide in Spanish: https://example.org/es"
check "the stranger hands in task B" "$CODE" "0"
HAND_B="$(echo "$OUT" | json event_id)"
step "day 4: everyone who is not the founder tries to accept the work"
try_confirm() { # try_confirm "who" SK TAG TASK HAND
  sign "$2" "$3" "$(confirm_record "$4" "$5")"
  local before; before="$(confirms)"
  if [[ "$before" == "0" ]]; then ok "$1 cannot accept: refused (status $(echo "$OUT" | json status)), nothing was written"; else bad "$1 got an acceptance written" "$OUT"; fi
}
try_confirm "the worker agent, on its own work" "$W_SK" "$W_TAG" "$TASK_A" "$HAND_A"
try_confirm "its sibling agent (same operator, on the team)" "$S_SK" "$S_TAG" "$TASK_A" "$HAND_A"
try_confirm "the manager agent (on the team)" "$M_SK" "$M_TAG" "$TASK_A" "$HAND_A"
try_confirm "the stranger, on their own work" "$X_SK" "" "$TASK_B" "$HAND_B"
try_confirm "the stranger, on the agent's work" "$X_SK" "" "$TASK_A" "$HAND_A"
check "nothing is accepted or paid, and the AI service has been called once a drafting day" "$(confirms)/$(paids)" "0/0"
draft "$M_SK" "$M_TAG"
check "day 4: the manager drafts" "$CODE" "0"

# ══ Day 5 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
next_day
post_update 2 "Tested twelve lamps and handed the Spanish guide in for checking."
draft "$M_SK" "$M_TAG" "We decided to stop the second colour."
check "day 5: the manager drafts again" "$CODE" "0"
run "$S_SK" "$S_TAG" launchpad updates post "$PID" --author "$F_PK" --title "Agent week" --done "Tested twelve lamps." --next "Light ten more stalls."
check "an agent on the team posts an update, and its \"What's next\" lines are plans, not promises" "$(echo "$OUT" | json promises)" "[]"
sign "$S_SK" "$S_TAG" "$(python3 -c 'import json,sys
coord=sys.argv[1]
print(json.dumps({"kind":47003,"content":json.dumps({"title":"Sneaked promise","body":""}),"tags":[["a",coord],["update-part","done","Tested lamps."],["update-part","next","Light ten more stalls."],["promise","0","Light ten more stalls."]]}))' "$COORD")"
check "…and a promise signed by an agent account anyway is refused by the server" "$([[ "$(echo "$OUT" | json status)" != 200 ]] && echo refused || echo accepted)" "refused"

# ══ Day 6 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
next_day
check "day 6, before the founder looks: still nothing accepted or paid" "$(confirms)/$(paids)" "0/0"
sign "$F_SK" "" "$(confirm_record "$TASK_A" "$HAND_A")"
check "the founder, a person, accepts the agent's work" "$(echo "$OUT" | json status)" "200"
sign "$F_SK" "" "$(confirm_record "$TASK_B" "$HAND_B")"
check "…and the stranger's work" "$(echo "$OUT" | json status)" "200"
check "two acceptances now exist, both signed by the founder" "$(sql "select count(*) from events where community_id='$CID' and kind=47003 and deleted_at is null and tags @> '[[\"task-part\",\"confirm\"]]'::jsonb and encode(pubkey,'hex')='$F_PK'")" "2"
check "no payment is recorded by anyone: the money is the runner's own step, in the app" "$(paids)" "0"
run "$F_SK" "" launchpad tasks show "$TASK_A"
contains "the task reads as accepted" "$OUT" "confirmed"
draft "$M_SK" "$M_TAG"
check "day 6: the manager drafts" "$CODE" "0"

# ══ Day 7 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
next_day
draft "$M_SK" "$M_TAG"
check "day 7: the manager drafts" "$CODE" "0"

step "the week's books"
DRAFTS="$(wc -l <"$STATE/ai-calls" | tr -d ' ')"
check "the AI service was called once for each draft served (7 drafts in 7 days; none was served on day 1 before the update)" "$DRAFTS" "7"
CALLS_ROW="$(sql "select coalesce(sum(consumed),0) from budget_consumption where community_id='$CID' and counter_type='manager_calls'")"
check "the project's weekly count equals the drafts served" "$CALLS_ROW" "$DRAFTS"
SPENT="$(sql "select coalesce(sum(consumed),0) from budget_consumption where community_id='$CID' and counter_type='manager_spend_mc'")"
FEES_MC=$((1000000000 / 10))
if [[ "$SPENT" -gt 0 && $((SPENT * 100)) -le $((FEES_MC * 10)) && "$SPENT" -le 50000 ]]; then
  ok "the platform spent $SPENT milli-cents: under a tenth of the fees ($FEES_MC) and under the 50 cent ceiling"
else
  bad "the platform's spend is outside its caps" "spent $SPENT milli-cents, fees $FEES_MC"
fi
check "the manager never posted, signed or paid anything (no record by its key)" "$(sql "select count(*) from events where community_id='$CID' and encode(pubkey,'hex')='$M_PK' and kind not in (0, 10100, 10101)")" "0"

echo
if [[ "$FAILS" -eq 0 ]]; then
  printf '\033[32m[m8-agent-week] %d checks passed. No money moved: acceptance was written without a payment.\033[0m\n' "$PASSES"
  exit 0
fi
printf '\033[31m[m8-agent-week] %d failed, %d passed. The relay'"'"'s last lines:\033[0m\n' "$FAILS" "$PASSES" >&2
grep -v '"level":"DEBUG"' "$STATE/relay.log" | tail -12 | cut -c1-300 >&2
exit 1
