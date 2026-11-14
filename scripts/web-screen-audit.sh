#!/usr/bin/env bash
#
# scripts/web-screen-audit.sh — every screen of the web app, with real data, as screenshots to read.
#
# Boots (all throwaway): a dev chain with the contributor kit and the launch kit, a scratch Postgres database with the
# real relay in front of it at localhost:3199 (the address the real-relay seeds use), and the web app built for both,
# served by the relay. Seeds the social world (`seed.mjs`, `seed-social.mjs`, `seed-demo.mjs`), then builds the rest
# through the pages (`web/tests/e2e-real/audit-world.spec.ts`): the Creaton contributor project with its four work
# areas, finished and waiting work, a suggestion and an open vote, a supporters board with rules, a pinned and a locked
# thread and a moderator, a report, a private room. Then `screen-audit.spec.ts` visits every screen at desktop and phone
# width and saves, per stop, a PNG and the visible words (`<name>.txt`) into SHOTS.
#
# Not a test of the words: it fails when the world cannot be built, when a stop does not reach the state it is named for,
# or when two stops saved the same picture (`scripts/screen-audit-unique.mjs`), so no screenshot passes for a screen it
# is not. Read the screenshots; `docs/v3-review/SCREEN-AUDIT-*.md` records what was found.
#
# ⚠️  DEV ONLY. Needs Postgres and Redis (see `just services`) and foundry. Anvil's public dev keys.
#
# Usage:  scripts/web-screen-audit.sh [playwright args for the capture]
# Env:    SHOTS=<dir> (default test-results/screen-audit-<date>/before), KEEP=1 (leave the world running for a look in
#         a browser; Ctrl-C ends it), SKIP_BUILD=1 (reuse target/debug/buzz-relay; the web app is always built here),
#         ONLY=<substring> (capture only stops whose name contains it), POSTGRES_ADMIN_URL, ANVIL_PORT,
#         CAPTURE=0 (build the world, take no screenshots; with KEEP=1, a world to test by hand),
#         WEB_FEATURES=audit (default: both kits) | mvp (as the hosted image is built: contributor projects, no sale) |
#         mvp+forecasts (mvp plus money behind work areas and posts, where "Will it get done?" forecasts are given)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
step() { printf '\033[36m[screen-audit]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[screen-audit] %s\033[0m\n' "$*" >&2; exit 1; }
for tool in forge cast anvil node psql; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool (set FOUNDRY_BIN for foundry)"
done

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@localhost:5432/postgres}"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()'; }
PORT=3199
HEALTH=$(free_port); METRICS=$(free_port)
ANVIL_PORT="${ANVIL_PORT:-$((18000 + RANDOM % 1000))}"
RPC="http://127.0.0.1:${ANVIL_PORT}"
DB="buzz_screen_audit_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
WEB_DIST="$STATE/web"
DEPLOYMENTS="$REPO_ROOT/contracts/deployments"
BACKUP="$(mktemp -d)"
SHOTS="${SHOTS:-$REPO_ROOT/test-results/screen-audit-$(date +%Y-%m-%d)/before}"
RELAY_PID=""

cp -p "$DEPLOYMENTS"/*.json "$BACKUP"/ 2>/dev/null || true
stop_own_anvil() {
  local pid
  pid="$(cat "$STATE/anvil.pid" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 0
  if ps -o command= -p "$pid" 2>/dev/null | grep -Eq "anvil.* --port[ =]${ANVIL_PORT}( |\$)"; then
    kill "$pid" 2>/dev/null || true
  fi
}
cleanup() {
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null || true
  RPC_URL="$RPC" STATE_DIR="$STATE" ./scripts/dev-chain.sh down >/dev/null 2>&1 || true
  stop_own_anvil
  psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1 || true
  for f in "$BACKUP"/*.json; do [[ -f "$f" ]] && cp -p "$f" "$DEPLOYMENTS/$(basename "$f")"; done
  rm -f "$REPO_ROOT/web/tests/e2e-real/.fixture.json" "$REPO_ROOT/web/tests/e2e-real/.social-fixture.json"
  rm -rf "$STATE" "$BACKUP"
}
trap cleanup EXIT
# A run left up with KEEP=1 is ended with `kill <pid>` (a background job ignores Ctrl-C): clean up then too.
trap 'exit 143' TERM

if lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port $PORT is already in use (the real-relay seeds need it): $(lsof -ti "tcp:$PORT" -sTCP:LISTEN | head -1)"
fi

step "booting a dev chain on ${RPC}"
if ! RPC_URL="$RPC" STATE_DIR="$STATE" ./scripts/dev-chain.sh >"$STATE/dev-chain.out" 2>&1; then
  tail -60 "$STATE/dev-chain.out"; fail "dev-chain failed"
fi
manifest_role() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log((m.roles ?? []).find((r) => r.role === process.argv[2])?.address ?? "");
  ' "$1" "$2"
}
LAUNCH_KIT="$(manifest_role "$DEPLOYMENTS/dao-launch-kit-31337.json" launch-kit)"
CONTRIBUTOR_KIT="$(manifest_role "$DEPLOYMENTS/contributor-kit-31337.json" contributor-kit)"
CURRENCY="$(manifest_role "$DEPLOYMENTS/dev-currency-31337.json" currency)"
[[ -n "$LAUNCH_KIT" && -n "$CONTRIBUTOR_KIT" && -n "$CURRENCY" ]] || fail "the dev chain did not report both kits and a currency"
FEATURES=("VITE_CONTRIBUTOR_KITS={\"31337\":\"${CONTRIBUTOR_KIT}\"}")
case "${WEB_FEATURES:-audit}" in
  audit) FEATURES+=("VITE_DAO_LAUNCH_KITS={\"31337\":\"${LAUNCH_KIT}\"}") ;;
  # As the hosted image is built (Dockerfile, web-social-e2e.sh): contributor-only, so no sale shows anywhere. The
  # passkey (ZeroDev) settings stay off: they need an entry point and account factory, which only a Sepolia fork has
  # (web-passkey-contributor-e2e.sh); this dev chain has neither.
  mvp) FEATURES+=("VITE_CONTRIBUTOR_ONLY=1") ;;
  mvp+forecasts)
    FEATURES+=("VITE_CONTRIBUTOR_ONLY=1")
    WORK_BOUNTY="$(manifest_role "$DEPLOYMENTS/work-bounty-31337.json" work-bounty)"
    OPEN_BOUNTY="$(manifest_role "$DEPLOYMENTS/open-bounty-31337.json" open-bounty)"
    [[ -n "$WORK_BOUNTY" && -n "$OPEN_BOUNTY" ]] || fail "the dev chain did not report both bounty contracts"
    FEATURES+=("VITE_WORK_BOUNTIES={\"31337\":\"${WORK_BOUNTY}\"}" "VITE_OPEN_BOUNTIES={\"31337\":\"${OPEN_BOUNTY}\"}") ;;
  *) fail "WEB_FEATURES is audit, mvp or mvp+forecasts, not ${WEB_FEATURES}" ;;
esac

step "building the web app for that chain (a production build: no preview numbers; features: ${WEB_FEATURES:-audit})"
(cd web && env VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_CHAIN_RPC_URL="$RPC" VITE_LOCAL_USDC="$CURRENCY" "${FEATURES[@]}" \
  node_modules/.bin/vite build --outDir "$WEB_DIST" --emptyOutDir >"$STATE/web-build.log" 2>&1) \
  || { tail -30 "$STATE/web-build.log"; fail "web build failed"; }
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the relay"
  cargo build -q -p buzz-relay || fail "relay build failed"
fi
[[ -x target/debug/buzz-relay ]] || fail "no target/debug/buzz-relay"
cp target/debug/buzz-relay "$STATE/buzz-relay"

step "a scratch database (${DB})"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database (is Postgres running?)"

step "starting the relay on :${PORT}"
if [[ -f .env ]]; then set -a; source .env; set +a; fi
DATABASE_URL="$DB_URL" BUZZ_AUTO_MIGRATE=true BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="0.0.0.0:$PORT" RELAY_URL="ws://localhost:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
  BUZZ_WEB_DIR="$WEB_DIST" BUZZ_WEB_SPA=full BUZZ_V1_ENABLED=true \
  RELAY_OPERATOR_API_ORIGIN="http://localhost:$PORT" BUZZ_SELF_SERVE_COMMUNITY_DOMAIN="localhost:$PORT" \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_PUBLIC_COMMUNITY_DIRECTORY=1 \
  BUZZ_EVM_AUTH=1 BUZZ_EVM_CHAIN_ID=31337 BUZZ_EVM_RPC_URL="$RPC" BUZZ_EVM_ENFORCE_ATTESTATION=false \
  BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=600 BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=2000 \
  BUZZ_NEW_ACCOUNT_POSTS_PER_HOUR=0 \
  BUZZ_TERMS_OF_SERVICE_MARKDOWN="$(cat docs/policies/TERMS-DRAFT.md)" \
  BUZZ_PRIVACY_POLICY_MARKDOWN="$(cat docs/policies/PRIVACY-DRAFT.md)" \
  "$STATE/buzz-relay" >"$STATE/relay.log" 2>&1 &
RELAY_PID=$!
for _ in $(seq 1 120); do
  curl -fsS -m 2 "http://localhost:$PORT/self-serve/communities" 2>/dev/null | grep -q '"enabled":true' && break
  kill -0 "$RELAY_PID" 2>/dev/null || { tail -30 "$STATE/relay.log"; fail "the relay exited"; }
  sleep 1
done
curl -fsS -m 2 "http://localhost:$PORT/self-serve/communities" | grep -q '"enabled":true' \
  || { tail -30 "$STATE/relay.log"; fail "the relay did not come up"; }

cd web
step "seeding the community, its people, their posts and a few launches"
node --experimental-strip-types tests/e2e-real/seed.mjs "$DB_URL" "ws://localhost:$PORT" >"$STATE/seed.log" 2>&1 \
  || { cat "$STATE/seed.log"; fail "seed.mjs failed"; }
node --experimental-strip-types tests/e2e-real/seed-social.mjs "$DB_URL" "ws://localhost:$PORT" >"$STATE/seed-social.log" 2>&1 \
  || { cat "$STATE/seed-social.log"; fail "seed-social.mjs failed"; }
node --experimental-strip-types tests/e2e-real/seed-demo.mjs "ws://localhost:$PORT" >"$STATE/seed-demo.log" 2>&1 \
  || { cat "$STATE/seed-demo.log"; fail "seed-demo.mjs failed"; }

FIXTURE="$STATE/audit-world.json"
export BUZZ_REAL_RELAY_URL="http://localhost:$PORT" DATABASE_URL="$DB_URL" E2E_ANVIL_URL="$RPC" \
  E2E_CONTRIBUTOR_KIT="$CONTRIBUTOR_KIT" E2E_AUDIT_FIXTURE="$FIXTURE"
step "building the rest of the world through the pages (the Creaton project, its work, votes and boards)"
keep_up() {
  step "the world stays up: http://localhost:${PORT} (people and their keys: ${FIXTURE}); Ctrl-C ends it"
  printf 'export BUZZ_REAL_RELAY_URL=%q DATABASE_URL=%q E2E_ANVIL_URL=%q E2E_CONTRIBUTOR_KIT=%q E2E_AUDIT_FIXTURE=%q\n' \
    "$BUZZ_REAL_RELAY_URL" "$DATABASE_URL" "$E2E_ANVIL_URL" "$E2E_CONTRIBUTOR_KIT" "$E2E_AUDIT_FIXTURE" >"$REPO_ROOT/test-results/screen-audit.env"
  step "to run a spec against it: source test-results/screen-audit.env"
  wait "$RELAY_PID"
}
# With bounties in the build, the world also gets money behind a work area and a post, and forecasts on both.
[[ "${WEB_FEATURES:-audit}" == "mvp+forecasts" ]] && export E2E_AUDIT_MONEY=1
if ! node_modules/.bin/playwright test --config=playwright.real-relay.config.ts tests/e2e-real/audit-world.spec.ts \
  --reporter=list --retries=0; then
  grep -v '^{"timestamp"' "$STATE/relay.log" | tail -20 || true
  grep -E '"level":"(WARN|ERROR)"' "$STATE/relay.log" | tail -10 | cut -c1-400 || true
  [[ "${KEEP:-}" == "1" ]] && keep_up
  fail "the world could not be built"
fi

if [[ "${CAPTURE:-1}" == "0" ]]; then
  [[ "${KEEP:-}" == "1" ]] && keep_up
  exit 0
fi

step "capturing every screen into ${SHOTS}"
mkdir -p "$SHOTS"
# A capture of the hosted build first checks that it really shows no sale (screen-audit.spec.ts).
case "${WEB_FEATURES:-audit}" in mvp | mvp+forecasts) export E2E_CONTRIBUTOR_ONLY=1 ;; esac
set +e
E2E_SHOTS="$SHOTS" node_modules/.bin/playwright test --config=playwright.real-relay.config.ts \
  tests/e2e-real/screen-audit.spec.ts --reporter=list --retries=0 "$@"
status=$?
# Two stops with the same picture mean one never reached its own state; only redirects and declared look-alikes pass.
node "$REPO_ROOT/scripts/screen-audit-unique.mjs" "$SHOTS" || status=1
set -e
step "$(find "$SHOTS" -name '*.png' | wc -l | tr -d ' ') screenshots in ${SHOTS}"

[[ "${KEEP:-}" == "1" ]] && keep_up
exit $status
