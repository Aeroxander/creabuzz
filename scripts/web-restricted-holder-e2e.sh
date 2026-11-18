#!/usr/bin/env bash
#
# scripts/web-restricted-holder-e2e.sh — a holder whose social access is restricted keeps the rights their Shares give
# them, on a REAL server and a REAL chain (docs/v3-review/HOLDER-ACCESS-MODEL.md, "Automated").
#
# Boots the dev chain world the command-line journey uses (a DAO, a Shares-only work budget, a project; a claim filed,
# reviewed, finished and up for an award) with the dev USDC in the DAO's treasury, and opens two decisions from the command
# line: the award, and a second work area. Then boots the real server on a scratch database and a free port, serving a web app built for that
# chain, and runs web/tests/e2e-real/restricted-holder.spec.ts:
#   - the founder makes a community and publishes the project there; a contributor submits a second piece of work from
#     the page, so its evidence is on the server;
#   - the owner mutes a holder everywhere: the holder still opens the project, reads the evidence and votes on the award
#     in the page, while a post is refused with a message that says they are muted;
#   - the owner bans the holder: the community turns them away and the server refuses their writes, while the command
#     line (given the banned person's own key and the server's address) still reads a claim with `work state`, votes on
#     the second work area with `vote`, and `buzz org ragequit` takes half the holder's Shares out, their Shares going
#     down and their part of the treasury arriving.
# The same server also runs web/tests/e2e-real/passkey-sign-in.spec.ts: signing up with a passkey (Chrome's virtual
# authenticator) and signing in with it again after a reload, against a real server and in the pilot build.
# This is the tested fallback for a browser-wallet holder; a passkey-account holder's fallback (lift the ban to a mute for
# the days they act) and the "nothing leaked" check stay hand tests (HOLDER-ACCESS-MODEL.md).
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, a scratch database. Needs Postgres and Redis (`just services`).
#
# Usage:  scripts/web-restricted-holder-e2e.sh [playwright args]
# Env:    ANVIL_PORT, BUZZ_BIN (default: build target/debug/buzz), POSTGRES_ADMIN_URL,
#         SKIP_BUILD=1 (reuse E2E_DIST and target/debug/buzz-relay), E2E_DIST (where the web app is built; default a
#         folder of this run's own, removed afterwards: never web/dist)

WORLD_NAME=web-restricted-holder
# shellcheck source=lib/no-raise-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/no-raise-world.sh"

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@localhost:5432/postgres}"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()'; }
SERVER_PORT=$(free_port); HEALTH=$(free_port); METRICS=$(free_port)
DB="buzz_restricted_e2e_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
DIST="${E2E_DIST:-$STATE/dist}"
RELAY_PID=""
server_down() {
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null || true
  psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1 || true
}
trap 'server_down; cleanup' EXIT

world_up
world_mandate
world_project
world_claim_filed
world_claim_bound
step "the claim is reviewed, finished and taken, so it can be awarded"
as $KEY_REVIEWER1 work attest --mandate "$MANDATE" --id write-docs --verdict approve >/dev/null
as $KEY_REVIEWER2 work attest --mandate "$MANDATE" --id write-docs --verdict approve >/dev/null
as $KEY_CONTRIBUTOR work settle --mandate "$MANDATE" --id write-docs >/dev/null
warp 700000
as $KEY_CONTRIBUTOR work payout --mandate "$MANDATE" --id write-docs >/dev/null
[[ "$(as $KEY_CONTRIBUTOR work state --mandate "$MANDATE" --id write-docs | jget status)" == "Paid" ]] \
  || fail "the claim should be finished"

HOLDER="$REVIEWER1"
[[ "$(shares_of "$HOLDER")" != "0" ]] || fail "the holder should hold Shares in the DAO"
[[ "$(cast call "$DAO" "ragequittable()(bool)" --rpc-url "$RPC")" == "true" ]] \
  || fail "the dev chain's DAO does not let members leave, so leaving cannot be checked"
step "1,000 dev USDC in the treasury, so leaving pays something"
cast send "$CURRENCY" "mint(address,uint256)" "$DAO" 1000000000 --private-key "$KEY_FOUNDER" --rpc-url "$RPC" >/dev/null \
  || fail "could not put dev USDC in the treasury"
open_decision() { # <intent json>: opens it as the founder, without voting, and prints its id
  local intent="$1"
  as $KEY_FOUNDER propose --dao "$DAO" --to "$(echo "$intent" | jget to)" --data "$(echo "$intent" | jget data)" \
    --nonce "$(echo "$intent" | jget nonce)" | jget id
}
step "two open decisions: the award, for the holder to vote on in the page while muted, and a second work area, from the command line while banned"
AWARD_DECISION=$(open_decision "$(as $KEY_FOUNDER work award --dao "$DAO" --mandate "$MANDATE" --claim write-docs --shares 20)")
[[ "$AWARD_DECISION" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "no decision id for the award: $AWARD_DECISION"
CLI_DECISION=$(open_decision "$(as $KEY_FOUNDER work project --dao "$DAO" --mandate "$MANDATE" --id site --manager "$MANAGER" \
  --shares 10 --expires-in-days 30 --check-text "site live")")
[[ "$CLI_DECISION" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "no decision id for the second work area: $CLI_DECISION"

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app for chain 31337 as the pilot builds it (VITE_CONTRIBUTOR_ONLY=1) into $DIST, and the server"
  (cd web && env -i PATH="$PATH" HOME="$HOME" VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="$CURRENCY" VITE_CONTRIBUTOR_ONLY=1 \
    node_modules/.bin/vite build --outDir "$DIST" --emptyOutDir >"$STATE/web-build.log" 2>&1) \
    || { tail -20 "$STATE/web-build.log"; fail "web build failed"; }
  cargo build -q -p buzz-relay || fail "server build failed"
fi
[[ -x target/debug/buzz-relay ]] || fail "no target/debug/buzz-relay (build it, or unset SKIP_BUILD)"
[[ -f "$DIST/index.html" ]] || fail "no web build in $DIST (build it, or unset SKIP_BUILD)"

step "a scratch database ($DB)"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database (is Postgres running?)"
step "starting the server on :$SERVER_PORT: its own community at that address, self-serve communities on"
# The same service settings the dev server uses (object storage and so on), then this run's own database, port and key.
if [[ -f .env ]]; then set -a; source .env; set +a; fi
DATABASE_URL="$DB_URL" BUZZ_AUTO_MIGRATE=true BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="0.0.0.0:$SERVER_PORT" RELAY_URL="ws://localhost:$SERVER_PORT" BUZZ_RELAY_URL="ws://localhost:$SERVER_PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
  BUZZ_WEB_DIR="$DIST" BUZZ_WEB_SPA=full \
  RELAY_OPERATOR_API_ORIGIN="http://localhost:$SERVER_PORT" BUZZ_SELF_SERVE_COMMUNITY_DOMAIN="localhost:$SERVER_PORT" \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_PUBLIC_COMMUNITY_DIRECTORY=1 \
  BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=600 BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=2000 \
  ./target/debug/buzz-relay >"$STATE/relay.log" 2>&1 &
RELAY_PID=$!
for _ in $(seq 1 120); do
  curl -fsS -m 2 "http://localhost:$SERVER_PORT/self-serve/communities" 2>/dev/null | grep -q '"enabled":true' && break
  kill -0 "$RELAY_PID" 2>/dev/null || { tail -30 "$STATE/relay.log"; fail "the server exited"; }
  sleep 1
done
curl -fsS -m 2 "http://localhost:$SERVER_PORT/self-serve/communities" | grep -q '"enabled":true' \
  || { tail -30 "$STATE/relay.log"; fail "the server did not come up with self-serve on"; }

step "running the browser spec"
# The spec runs the command line from web/, so it gets the binary's full path.
BUZZ="$(cd "$(dirname "$BUZZ")" && pwd)/$(basename "$BUZZ")"
cd web
BUZZ_REAL_RELAY_URL="http://localhost:$SERVER_PORT" E2E_INVITE_PORT="$SERVER_PORT" \
  E2E_ANVIL_URL="$RPC" E2E_DAO="$DAO" E2E_MANDATE="$MANDATE" E2E_SHARES="$SHARES" E2E_CURRENCY="$CURRENCY" \
  E2E_FOUNDER="$FOUNDER" E2E_CONTRIBUTOR="$CONTRIBUTOR" E2E_HOLDER="$HOLDER" E2E_HOLDER_KEY="$KEY_REVIEWER1" \
  E2E_BUZZ="$BUZZ" E2E_CLI_DECISION="$CLI_DECISION" \
  node_modules/.bin/playwright test --config=playwright.real-relay.config.ts tests/e2e-real/restricted-holder.spec.ts \
  tests/e2e-real/passkey-sign-in.spec.ts \
  --reporter=list --retries=0 "$@"
