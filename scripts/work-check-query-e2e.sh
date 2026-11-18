#!/usr/bin/env bash
# =============================================================================
# work-check-query-e2e.sh — kind:47010 #c query-pushdown runtime proof
# =============================================================================
# Stands up an ISOLATED fresh relay (current branch build) backed by its own
# throwaway Postgres + Redis containers, seeds a two-host fixture community,
# then invokes scripts/work-check-query-e2e.mjs to publish 1 older target +
# N newer unrelated work-check-run records (kind 47010) as a fresh fixture
# identity through the REAL bridge and assert the pushdown semantics.
#
# STRICT STANDUP RULES (enforced below):
#   - only containers this script created (unique UUID names, --rm, --pull never)
#   - only ports verified free and explicitly bound to 127.0.0.1
#   - the relay runs with a scrubbed environment in a private scratch dir,
#     so no repo .env or shared dev-state can leak into the fixture
#   - never touches/pkills/kills anything not owned by this run; never frees
#     occupied ports; cleanup removes only the named containers/PID/scratch dir
#   - schema bootstrap mirrors scripts/start-isolated-test-relay.sh:
#     pgschema apply schema/schema.sql + scripts/reconcile-schema-after-pgschema.sql
#   - no auth behavior is modified: NIP-98 signed requests over the real
#     policy surface, fixture-only community row with default open policy
#   - logs are retained under the session temp dir; secrets stay out of logs
#
# Usage: ./scripts/work-check-query-e2e.sh
# Exit: 0 only when every fixture assertion passed; nonzero otherwise.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

RETAIN_LOG_ROOT="${WC_E2E_LOG_DIR:-${TMPDIR:-/tmp}}"
NOISE_COUNT="${WC_NOISE_COUNT:-60}"
# Hard wall-clock ceilings (seconds).
PG_READY_SECS=60
RELAY_READY_SECS=90
E2E_SECS=120
TOTAL_SECS=420

say()  { echo "[wc-e2e] $*"; }
warn() { echo "[wc-e2e] WARN: $*" >&2; }
die()  { echo "[wc-e2e] FAIL: $*" >&2; exit 1; }

SECONDS=0
check_timeout() {
  if (( SECONDS > TOTAL_SECS )); then die "wall-clock budget exceeded (${TOTAL_SECS}s)"; fi
}

# ── 0. Pre-flight ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker CLI not available"
docker info >/dev/null 2>&1 || die "docker daemon not reachable"
for image in postgres:17-alpine redis:7-alpine; do
  docker image inspect "$image" >/dev/null 2>&1 || die "required image not cached locally: ${image} (refusing to pull)"
done
[[ -x ./bin/pgschema ]] || die "missing ./bin/pgschema"
[[ -f schema/schema.sql ]] || die "missing schema/schema.sql"
[[ -f scripts/reconcile-schema-after-pgschema.sql ]] || die "missing reconcile SQL"
[[ -d web/node_modules/nostr-tools ]] || die "nostr-tools not installed under web/node_modules"

# ── 1. Unique names + scratch roots ─────────────────────────────────────────
RUN_ID="$(uuidgen | tr -d '-')"
PG_CONTAINER="buzz-wqc-pg-${RUN_ID}"
REDIS_CONTAINER="buzz-wqc-redis-${RUN_ID}"
WORK_ROOT="${RETAIN_LOG_ROOT}/buzz-workcheck-e2e-${RUN_ID}"
LOG_DIR="${RETAIN_LOG_ROOT}/buzz-workcheck-e2e-${RUN_ID}-logs"
mkdir -p "${WORK_ROOT}/relay-cwd/tmp" "${LOG_DIR}"
chmod 700 "${WORK_ROOT}" "${LOG_DIR}"

PG_NAME_INPUT="buzz-wqc-e2e-pg${RANDOM}"
DB_PASSWORD="$(openssl rand -hex 16)"
RELAY_PRIVATE_KEY="$(openssl rand -hex 32)"

# ── 2. Free ports (owned allocation, verified unused, loopback-bound) ───────
PORTS_JSON="$(python3 - <<'PY'
import json, socket
picks = {}
for name in ("pg", "redis", "main", "health", "metrics"):
    while True:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        if port not in picks.values() and port not in (80, 443, 3000, 3030, 5432, 6379):
            picks[name] = port
            break
print(json.dumps(picks))
PY
)"
PG_PORT="$(echo "$PORTS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["pg"])')"
REDIS_PORT="$(echo "$PORTS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["redis"])')"
MAIN_PORT="$(echo "$PORTS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["main"])')"
HEALTH_PORT="$(echo "$PORTS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["health"])')"
METRICS_PORT="$(echo "$PORTS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["metrics"])')"

for p in "$PG_PORT" "$REDIS_PORT" "$MAIN_PORT" "$HEALTH_PORT" "$METRICS_PORT"; do
  if lsof -nP -iTCP:"${p}" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
    die "allocated port ${p} is somehow occupied; aborting rather than freeing ports"
  fi
done
say "sandbox ports (127.0.0.1-bound): pg=${PG_PORT} redis=${REDIS_PORT} main=${MAIN_PORT} health=${HEALTH_PORT} metrics=${METRICS_PORT}"

# ── 3. Owned throwaway containers (--rm so removal is on-kill) ──────────────
# Cleanup runs on EVERY exit path, but only ever touches the PID/container
# names captured by this run — never by name/port matching.
RELAY_PID=""
cleanup() {
  if [[ -n "${RELAY_PID:-}" ]] && kill -0 "${RELAY_PID}" 2>/dev/null; then
    kill -TERM "${RELAY_PID}" 2>/dev/null || true
    for _ in $(seq 1 10); do kill -0 "${RELAY_PID}" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "${RELAY_PID}" 2>/dev/null || true
    say "relay PID ${RELAY_PID} stopped"
  fi
  for name in "${PG_CONTAINER:-}" "${REDIS_CONTAINER:-}"; do
    if [[ -n "$name" ]] && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
      docker rm -f "$name" >/dev/null 2>&1 || true
      say "removed owned container ${name}"
    fi
  done
  if [[ -d "${WORK_ROOT:-}" ]]; then
    say "scoped logs retained under: ${LOG_DIR:-}"
    rm -rf "${WORK_ROOT}"
  fi
}
trap cleanup EXIT

docker run -d --pull never --rm \
  --name "${PG_CONTAINER}" \
  -p "127.0.0.1:${PG_PORT}:5432" \
  -e "POSTGRES_PASSWORD=${DB_PASSWORD}" -e POSTGRES_USER=buzz -e POSTGRES_DB=buzz \
  --tmpfs /var/lib/postgresql/data:rw,size=1g \
  postgres:17-alpine >/dev/null || die "could not start fixture postgres container"
docker run -d --pull never --rm \
  --name "${REDIS_CONTAINER}" \
  -p "127.0.0.1:${REDIS_PORT}:6379" \
  redis:7-alpine redis-server --save '' --appendonly no >/dev/null || die "could not start fixture redis container"
say "started owned containers: ${PG_CONTAINER}, ${REDIS_CONTAINER}"

PG_READY=0
for _ in $(seq 1 "$PG_READY_SECS"); do
  if docker exec "${PG_CONTAINER}" pg_isready -U buzz >/dev/null 2>&1; then PG_READY=1; break; fi
  sleep 1; check_timeout
done
(( PG_READY == 1 )) || die "fixture postgres did not become ready in ${PG_READY_SECS}s"

# ── 4. Desired-state schema bootstrap (same pattern as start-isolated) ─────
export PGPASSWORD="${DB_PASSWORD}"
psql_fixture() {
  psql -h 127.0.0.1 -p "${PG_PORT}" -U buzz -d buzz -v ON_ERROR_STOP=1 -qtA "$@"
}
if ! psql_fixture -c "SELECT 1" >/dev/null; then die "cannot reach fixture postgres over localhost:${PG_PORT}"; fi

say "applying desired-state schema via pgschema..."
PGSCHEMA_PLAN_HOST=127.0.0.1 PGSCHEMA_PLAN_PORT="${PG_PORT}" \
PGSCHEMA_PLAN_DB=buzz PGSCHEMA_PLAN_USER=buzz PGSCHEMA_PLAN_PASSWORD="${DB_PASSWORD}" \
PGDATABASE=buzz PGHOST=127.0.0.1 PGPORT="${PG_PORT}" PGUSER=buzz \
  ./bin/pgschema apply --file schema/schema.sql --auto-approve > "${LOG_DIR}/pgschema.log" 2>&1 \
  || { tail -30 "${LOG_DIR}/pgschema.log" >&2; die "pgschema apply failed (log: ${LOG_DIR}/pgschema.log)"; }
psql_fixture < scripts/reconcile-schema-after-pgschema.sql > "${LOG_DIR}/reconcile.log" 2>&1 \
  || { tail -30 "${LOG_DIR}/reconcile.log" >&2; die "reconcile-schema-after-pgschema.sql failed"; }
say "schema applied"

# ── 5. Fixture-only community binding on the REAL host header strings ──────
# Two communities share one relay process; host A receives the fixture events
# and host B (same relay, different Host:) must NOT see them.
psql_fixture -c "
INSERT INTO communities (host) VALUES ('127.0.0.1:${MAIN_PORT}'), ('localhost:${MAIN_PORT}')
ON CONFLICT (lower(host)) DO NOTHING;"
say "fixture communities seeded (hosts 127.0.0.1:${MAIN_PORT} and localhost:${MAIN_PORT})"

# ── 6. Fresh relay build from the current branch ────────────────────────────
if command -v "${HOME}/.cargo/bin/cargo" >/dev/null 2>&1; then
  export PATH="${HOME}/.cargo/bin:${PATH}"
fi
. ./bin/activate-hermit >/dev/null 2>&1 || true
CARGO_BIN="$(command -v cargo || true)"
[[ -n "${CARGO_BIN}" ]] || die "cargo not found (hermit activation failed)"
say "building buzz-relay (profile=debug, cargo=$(${CARGO_BIN} --version))..."
if ! (${CARGO_BIN} build -p buzz-relay > "${LOG_DIR}/build.log" 2>&1); then
  tail -40 "${LOG_DIR}/build.log" >&2; die "cargo build -p buzz-relay failed"
fi
say "relay built fresh: target/debug/buzz-relay"

# ── 7. Run the relay in a private env, own PID, captured log ────────────────
RELAY_BIN="${REPO_ROOT}/target/debug/buzz-relay"
[[ -x "${RELAY_BIN}" ]] || die "relay binary missing after build"
(
  cd "${WORK_ROOT}/relay-cwd"
  exec env -i \
    HOME="${WORK_ROOT}/relay-cwd" \
    TMPDIR="${WORK_ROOT}/relay-cwd/tmp" \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    "DATABASE_URL=postgres://buzz:${DB_PASSWORD}@127.0.0.1:${PG_PORT}/buzz" \
    "REDIS_URL=redis://127.0.0.1:${REDIS_PORT}" \
    "RELAY_URL=ws://127.0.0.1:${MAIN_PORT}" \
    "BUZZ_BIND_ADDR=127.0.0.1:${MAIN_PORT}" \
    "BUZZ_HEALTH_PORT=${HEALTH_PORT}" \
    "BUZZ_METRICS_PORT=${METRICS_PORT}" \
    "BUZZ_S3_ENDPOINT=http://127.0.0.1:1" \
    "BUZZ_S3_ACCESS_KEY=fixture" \
    "BUZZ_S3_SECRET_KEY=fixture-local-only" \
    "BUZZ_S3_BUCKET=buzz-media-fixture" \
    "BUZZ_RELAY_PRIVATE_KEY=${RELAY_PRIVATE_KEY}" \
    "BUZZ_REQUIRE_AUTH_TOKEN=false" \
    "BUZZ_GIT_CONFORMANCE_PROBE=false" \
    "RUST_LOG=info" \
    "${RELAY_BIN}"
) > "${LOG_DIR}/relay.log" 2>&1 &
RELAY_PID=$!
disown || true
say "relay started with captured PID ${RELAY_PID} (log: ${LOG_DIR}/relay.log)"

RELAY_READY=0
for _ in $(seq 1 "$RELAY_READY_SECS"); do
  check_timeout
  if ! kill -0 "${RELAY_PID}" 2>/dev/null; then
    tail -40 "${LOG_DIR}/relay.log" >&2
    die "relay process exited during startup"
  fi
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${MAIN_PORT}/"; then
    RELAY_READY=1; break
  fi
  sleep 1
done
(( RELAY_READY == 1 )) || { tail -40 "${LOG_DIR}/relay.log" >&2; die "relay did not become ready on :${MAIN_PORT}"; }
say "relay live on http://127.0.0.1:${MAIN_PORT} (health :${HEALTH_PORT}, metrics :${METRICS_PORT})"

# ── 8. Fixture harness (fresh signer, real NIP-98 over the real doors) ─────
set +e
WC_E2E_MAIN="http://127.0.0.1:${MAIN_PORT}" \
WC_E2E_ALT="http://localhost:${MAIN_PORT}" \
WC_E2E_WS="ws://127.0.0.1:${MAIN_PORT}" \
WC_NOISE_COUNT="${NOISE_COUNT}" \
  WC_E2E_NODE_MODULES="${REPO_ROOT}/web/node_modules" \
  node --experimental-websocket --no-warnings \
    "${SCRIPT_DIR}/work-check-query-e2e.mjs" 2>&1 | tee "${LOG_DIR}/fixture.log"
E2E_STATUS=${PIPESTATUS[0]}
set -e

# ── 9. Result adjudication (cleanup already wired via trap) ────────────────
if [[ "${E2E_STATUS}" == "0" ]]; then
  say "RESULT: PASS — full fixture harness green (build=debug, local-only endpoints)"
  exit 0
else
  die "fixture harness exited with status ${E2E_STATUS} — see ${LOG_DIR}/fixture.log"
fi
