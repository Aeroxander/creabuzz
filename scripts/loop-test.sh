#!/usr/bin/env bash
#
# scripts/loop-test.sh — the DAO OS "org loop", end to end, against a real relay.
#
# What it walks (each step asserts, none is simulated):
#   1. template apply   -> org root, vacant agent seats, the default budget
#   2. re-apply         -> idempotent: nothing is created twice
#   3. seat an agent    -> `org node attach-agent`, idempotent, only the author
#   4. budget bites     -> an agent past its message limit is refused; a human never is
#   5. approval         -> the agent cannot approve itself; the owner can; exactly one more action passes
#   6. emergency stop   -> the agent is hard-refused, its seat cleared, a re-run is a no-op
#   7. LLM spend budget -> (optional) a priced mock upstream, a 1-cent budget, refused on the 5th call
#
# It boots its own relay on a throwaway port (a fresh community per run) and
# stops it on exit. The on-chain half (mint, auction, bind) is
# scripts/dogfood-raise.sh plus the forge suites.
#
# Requirements: a running Postgres and Redis (DATABASE_URL, REDIS_URL), psql,
# python3, and the built binaries (built here if missing). Step 7 additionally
# needs node with web/node_modules installed and is skipped when absent.
#
# Usage:
#   DATABASE_URL=postgres://buzz@127.0.0.1:5433/buzz REDIS_URL=redis://127.0.0.1:6379 \
#     scripts/loop-test.sh
#
# ⚠️  Dev only. It writes a community, users and events into $DATABASE_URL.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

: "${DATABASE_URL:?set DATABASE_URL to a migrated Postgres}"
: "${REDIS_URL:=redis://127.0.0.1:6379}"
PORT="${BUZZ_LOOP_PORT:-$((3900 + RANDOM % 90))}"
HOST="localhost:${PORT}"
BIN="$REPO_ROOT/target/debug"
WORK="$(mktemp -d)"
RELAY_PID=""
MOCK_PID=""
FAILS=0
PASSES=0

log()  { printf '\033[36m[loop]\033[0m %s\n' "$*"; }
pass() { PASSES=$((PASSES + 1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { FAILS=$((FAILS + 1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
skip() { printf '  \033[33m-\033[0m skipped: %s\n' "$*"; }

cleanup() {
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

expect_contains() { # <label> <haystack> <needle>
  if [[ "$2" == *"$3"* ]]; then pass "$1"; else fail "$1 — wanted \"$3\" in: ${2:0:220}"; fi
}
expect_eq() { # <label> <got> <want>
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 — got \"$2\", want \"$3\""; fi
}
json() { python3 -c 'import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d = d[int(k)] if isinstance(d, list) else d.get(k) if isinstance(d, dict) else None
print("" if d is None else (json.dumps(d) if isinstance(d,(dict,list)) else d))' "$1"; }
sql() { psql "$DATABASE_URL" -Atq -c "$1"; }

# ── build and boot ──────────────────────────────────────────────────────────
if [[ ! -x "$BIN/buzz" || ! -x "$BIN/buzz-relay" ]]; then
  log "building buzz and buzz-relay (first run)"
  CARGO_INCREMENTAL=0 cargo build -p buzz-cli -p buzz-relay >/dev/null 2>&1 || { echo "build failed"; exit 2; }
fi
BUZZ="$BIN/buzz"

# Optional LLM step: a mock upstream that reports token usage.
LLM_ARGS=()
if command -v node >/dev/null 2>&1 && [[ -d web/node_modules/@noble ]]; then
  cat > "$WORK/mock_llm.py" <<'PY'
import json, http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length', 0)))
        out = json.dumps({"choices": [{"message": {"role": "assistant", "content": "hi"}}],
                          "usage": {"prompt_tokens": 1000, "completion_tokens": 500}}).encode()
        self.send_response(200); self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
  python3 "$WORK/mock_llm.py" "$((PORT + 100))" >/dev/null 2>&1 &
  MOCK_PID=$!
  LLM_ARGS=(BUZZ_LLM_PROXY_URL="http://127.0.0.1:$((PORT + 100))/v1/chat/completions"
            BUZZ_LLM_PRICE_INPUT_CENTS_PER_MTOK=100 BUZZ_LLM_PRICE_OUTPUT_CENTS_PER_MTOK=300
            BUZZ_LLM_RATE_PER_MIN=1000)
fi

# Migrate a fresh database (the relay does not create the schema itself) and
# give this run its own community: the relay binds the Host header to a
# `communities` row and fails closed for an unknown host.
if [[ "$(sql "select to_regclass('public.communities') is not null")" != "t" ]]; then
  log "migrating the database (first run)"
  CARGO_INCREMENTAL=0 cargo run -q -p buzz-admin -- migrate >/dev/null 2>&1 || { echo "migrate failed"; exit 2; }
fi
sql "insert into communities (host) values ('${HOST}'), ('127.0.0.1:${PORT}') on conflict do nothing" >/dev/null

log "starting a relay on ${HOST} (fresh community)"
env DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" \
    BUZZ_BIND_ADDR="127.0.0.1:${PORT}" RELAY_URL="ws://${HOST}" \
    BUZZ_HEALTH_PORT="$((PORT + 1))" BUZZ_METRICS_PORT="$((PORT + 2))" \
    BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" BUZZ_GIT_CONFORMANCE_PROBE=false \
    "${LLM_ARGS[@]}" \
    "$BIN/buzz-relay" >"$WORK/relay.log" 2>&1 &
RELAY_PID=$!
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  kill -0 "$RELAY_PID" 2>/dev/null || { echo "relay exited:"; grep -E '"level":"ERROR"|^Error' "$WORK/relay.log" | head -5 | cut -c1-300; exit 2; }
  sleep 0.5
done
curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || { echo "relay did not become healthy"; exit 2; }
export BUZZ_RELAY_URL="http://${HOST}"
CID="$(sql "select id from communities where host='${HOST}'")"

# ── identities ──────────────────────────────────────────────────────────────
OWNER_JSON="$("$BUZZ" users whoami --new)"; OWNER_SK="$(echo "$OWNER_JSON" | json secret)"; OWNER_PK="$(echo "$OWNER_JSON" | json pubkey)"
AGENT_JSON="$("$BUZZ" users whoami --new)"; AGENT_SK="$(echo "$AGENT_JSON" | json secret)"; AGENT_PK="$(echo "$AGENT_JSON" | json pubkey)"
owner() { BUZZ_PRIVATE_KEY="$OWNER_SK" "$BUZZ" "$@" 2>&1; }
agent() { BUZZ_PRIVATE_KEY="$AGENT_SK" "$BUZZ" "$@" 2>&1; }
sql "insert into relay_members (community_id, pubkey, role) values ('$CID','$OWNER_PK','owner') on conflict do nothing" >/dev/null
sql "insert into users (community_id, pubkey) values ('$CID', decode('$OWNER_PK','hex')), ('$CID', decode('$AGENT_PK','hex')) on conflict do nothing" >/dev/null
sql "update users set agent_owner_pubkey = decode('$OWNER_PK','hex') where community_id='$CID' and pubkey=decode('$AGENT_PK','hex')" >/dev/null
sql "insert into relay_members (community_id, pubkey, role) values ('$CID','$AGENT_PK','member') on conflict do nothing" >/dev/null

# ── 1. template apply ───────────────────────────────────────────────────────
log "1. apply the vanilla-app-studio template"
APPLY="$(owner templates apply vanilla-app-studio)"
expect_eq "apply reports ok" "$(echo "$APPLY" | json status)" "ok"
expect_contains "the org root was created" "$APPLY" "org:root"
NODES="$(owner org node list)"
for n in root seat-app-dev seat-qa-reviewer seat-product-lead; do
  expect_contains "node $n exists" "$NODES" "$n"
done
expect_contains "the default budget exists" "$(owner org budget list)" "default-agents"

# ── 2. idempotent re-apply ──────────────────────────────────────────────────
log "2. re-apply changes nothing"
AGAIN="$(owner templates apply vanilla-app-studio)"
CREATED="$(echo "$AGAIN" | python3 -c 'import json,sys; print(sum(1 for s in json.load(sys.stdin)["steps"] if s["action"]!="skipped"))')"
expect_eq "every step skipped on re-apply" "$CREATED" "0"

# ── 3. seat an agent ────────────────────────────────────────────────────────
log "3. seat the agent"
expect_contains "attach publishes" "$(owner org node attach-agent --id seat-app-dev --agent "$AGENT_PK")" '"accepted":true'
expect_contains "attach is idempotent" "$(owner org node attach-agent --id seat-app-dev --agent "$AGENT_PK")" '"changed":false'
expect_contains "only the author can change a seat" "$(agent org node attach-agent --id seat-app-dev --agent "$AGENT_PK")" "not found among your own"
SEAT="$(owner org node get --id seat-app-dev)"
expect_contains "the seat now holds the agent" "$SEAT" "$AGENT_PK"

# ── 4. the budget bites ─────────────────────────────────────────────────────
log "4. an owner budget bounds the agent, never a human"
CH="$(sql "select id from channels where community_id='$CID' and name='dev' and deleted_at is null")"
[[ -n "$CH" ]] && pass "found the dev channel" || fail "the template created no dev channel"
sql "insert into channel_members (community_id, channel_id, pubkey, role) values ('$CID','$CH',decode('$AGENT_PK','hex'),'member') on conflict do nothing" >/dev/null
# An owner-signed budget naming the agent replaces the community default for it
# (the default only applies while no authority budget names the agent).
expect_contains "the owner bounds the agent to 2 messages a day" \
  "$(owner org budget create --id b-agent --subject "$AGENT_PK" --window day --messages 2)" '"accepted":true'
expect_contains "agent message 1 passes" "$(agent messages send --channel "$CH" --content 'status 1')" '"accepted":true'
expect_contains "agent message 2 passes" "$(agent messages send --channel "$CH" --content 'status 2')" '"accepted":true'
expect_contains "agent message 3 is refused" "$(agent messages send --channel "$CH" --content 'status 3')" "budget exceeded"
for i in 1 2 3; do
  expect_contains "human message $i passes" "$(owner messages send --channel "$CH" --content "human $i")" '"accepted":true'
done

# ── 5. approval ─────────────────────────────────────────────────────────────
log "5. the owner approves; the agent cannot"
REQ="$(sql "select t->>1 from events e, jsonb_array_elements(e.tags) t where e.community_id='$CID' and e.kind=46010 and t->>0='d' order by e.created_at desc limit 1")"
[[ -n "$REQ" ]] && pass "an approval request was raised" || fail "no approval request (46010) found"
expect_contains "the agent cannot approve its own overrun" "$(agent org budget resolve --request "$REQ")" "only a community owner"
expect_contains "the owner grants" "$(owner org budget resolve --request "$REQ" --note 'ok for today')" '"accepted":true'
expect_contains "exactly one more message passes" "$(agent messages send --channel "$CH" --content 'status 3, approved')" '"accepted":true'
expect_contains "then the limit bites again" "$(agent messages send --channel "$CH" --content 'status 4')" "budget exceeded"

# ── 6. emergency stop ───────────────────────────────────────────────────────
log "6. emergency stop"
STOP="$(owner org agent stop --pubkey "$AGENT_PK")"
expect_eq "stop reports stopped" "$(echo "$STOP" | json stopped)" "True"
expect_contains "a stopped agent is hard-refused" "$(agent messages send --channel "$CH" --content 'still here?')" "limit 0"
SEATS_AFTER="$(sql "select e.content::jsonb->'agentSeats' from events e where e.community_id='$CID' and e.kind=37010 and e.d_tag='seat-app-dev' and e.deleted_at is null order by e.created_at desc limit 1")"
expect_eq "the newest seat record is empty" "$SEATS_AFTER" "[]"
STOP2="$(owner org agent stop --pubkey "$AGENT_PK")"
expect_eq "a second stop is a no-op" "$(echo "$STOP2" | python3 -c 'import json,sys; print(sum(s.get("changed",0) for s in json.load(sys.stdin)["steps"]))')" "0"

# ── 7. LLM spend budget (optional) ──────────────────────────────────────────
log "7. LLM spend budget"
if [[ -n "$MOCK_PID" ]]; then
  LLM_JSON="$("$BUZZ" users whoami --new)"; LLM_SK="$(echo "$LLM_JSON" | json secret)"; LLM_PK="$(echo "$LLM_JSON" | json pubkey)"
  sql "insert into users (community_id, pubkey) values ('$CID', decode('$LLM_PK','hex')) on conflict do nothing" >/dev/null
  sql "update users set agent_owner_pubkey = decode('$OWNER_PK','hex') where community_id='$CID' and pubkey=decode('$LLM_PK','hex')" >/dev/null
  sql "insert into relay_members (community_id, pubkey, role) values ('$CID','$LLM_PK','member') on conflict do nothing" >/dev/null
  owner org budget create --id b-llm --subject "$LLM_PK" --window day --llm-cost-cents 1 >/dev/null
  cat > web/.loop-gateway.mjs <<JS
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
const hex = (b) => Buffer.from(b).toString('hex');
const sk = Buffer.from('$LLM_SK', 'hex'); const pk = hex(schnorr.getPublicKey(sk));
const url = 'http://${HOST}/llm/chat/completions'; const out = [];
for (let i = 1; i <= 5; i++) {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi ' + i }] });
  const tags = [['u', url], ['method', 'POST'], ['payload', hex(sha256(new TextEncoder().encode(body)))]];
  const created_at = Math.floor(Date.now() / 1000);
  const id = hex(sha256(new TextEncoder().encode(JSON.stringify([0, pk, created_at, 27235, tags, '']))));
  const sig = hex(schnorr.sign(Buffer.from(id, 'hex'), sk));
  const ev = { id, pubkey: pk, created_at, kind: 27235, tags, content: '', sig };
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64') }, body });
  out.push(r.status);
}
console.log(out.join(','));
JS
  STATUSES="$(cd web && node .loop-gateway.mjs 2>&1 | tail -1)"; rm -f web/.loop-gateway.mjs
  expect_eq "4 calls served (250 milli-cents each) then the 1-cent budget refuses" "$STATUSES" "200,200,200,200,429"
else
  skip "needs node with web/node_modules (@noble) for NIP-98 signing"
fi

echo
if [[ "$FAILS" -eq 0 ]]; then
  printf '\033[32mloop-test: %d checks passed\033[0m\n' "$PASSES"
else
  printf '\033[31mloop-test: %d failed, %d passed\033[0m\n' "$FAILS" "$PASSES"
  echo "relay log tail:"; tail -5 "$WORK/relay.log" | cut -c1-200
  exit 1
fi
