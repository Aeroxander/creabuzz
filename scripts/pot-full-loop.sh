#!/usr/bin/env bash
# pot-full-loop.sh: the join-and-leave design, all three parts joined up, in a real browser: step 1 (a project from its start to a
# Take out) and step 2 (the task queue and exit notes).
#
# Starts a local chain (anvil), deploys contracts/pot with its own deploy script (play dollars), starts Postgres and Redis when
# they are not running, starts the real relay with its chain reader pointed at that chain (and its helper on, record version 2),
# builds the app for that chain and lets the relay serve it, then runs one Playwright journey (app/tests/e2e-pot-full) in
# Chromium. The journey: a founder starts a project in the app and launches it on the chain; a first backer puts money in; a
# stranger opens the project page and sees the numbers the server published; gets play dollars; Backs in two presses; the page
# shows the new Shares and what taking out now would give, and the server's numbers move once it has read the block; the founder
# checks in from This week and draws from the allowance; outside money arrives; the backer Takes out; and every number on the
# page equals the record the server signed, which equals the contracts' own views at the record's block
# (scripts/chain-loop-pot-check.py, called by the journey).
#
# Step 2's journey (app/tests/e2e-pot-full/pot-tasks.spec.ts) runs in a world of its own, started after the first is stopped: a
# founder posts a task in the app and a worker takes it; the team plans its pay from the Tasks tab; a holder on another profile
# reads the two lines on the project page and the alert on You; the chain's clock moves past the notice; the worker sets the
# money aside; the holder takes out and is left a note; the team pays part of it and the app saves that the task was paid (the
# server ties the record to the payment on the network); the holder claims; a second task runs out and is returned by someone
# else; and the record equals the contracts' own views at each step (scripts/chain-loop-pot-check.py, called by the journey).
# The two journeys do not share a world because the first moves the chain's clock by days (a record is dated by the server's own
# clock, so a chain that is days ahead of it reads as an old record for the rest of that world).
#
# Step 3's journeys (app/tests/e2e-pot-full/pot-room.spec.ts, pot-seasons.spec.ts, pot-push.spec.ts), each in a world of its own:
#   pot-room      a visitor opens a project's link and reads the page (one banner, the line "not a return", play money, one Back);
#                 two people back and one takes out, and the live feed shows it rounded, with no names and the net money in; a holder
#                 writes in the room, a stranger is refused in the server's own words, and after taking out and one time unit the
#                 person is read-only (the server says so too);
#   pot-seasons   ten backers and a Pair on one project and the badge appears exactly when its three inputs say so (the chain's clock is
#                 moved by days); Home ranks by money held 30 days or more with the number of different accounts beside it, and a late
#                 buyer does not move it; the operator starts a season with the real `buzz` command, a founder enters two projects from
#                 Home, and the demo day page lists them;
#   pot-push      the relay with web push on and a local stand-in for a push service: a holder turns alerts on from You, a task is
#                 planned, and the stand-in receives the message the device decrypts; the real service worker shows its fixed sentence
#                 for the same kind of news as the in-app alert; after Turn off the next task reaches nobody.
#
# Prints one `ok` line per check from the journey and, at the end, "pot-full-loop: N checks passed." Stops everything it started
# (anvil, the relay, a Redis or Postgres it had to start), drops its scratch database and removes its temporary files, whatever
# the outcome. Never runs cargo: the relay must already be built (`cargo build -p buzz-relay`).
#
# Needs: anvil, cast, forge (FOUNDRY_BIN or PATH), psql, a Postgres and a Redis (started here when they are not running),
# node with web/node_modules (the checker's tools), pnpm, jq, openssl, python3, Playwright's Chromium (the one app/ already
# uses; this script installs nothing), and a built relay. Uses anvil's well-known development accounts only; every amount is
# play money.
#
# Usage:  scripts/pot-full-loop.sh [playwright args]     with no arguments: all five journeys, each in a world of its own;
#                                                          with arguments (a file name such as pot-tasks.spec, a --grep): one world, those only
#         scripts/pot-full-loop.sh --serve       the same world, left running for a person to try on a phone (see below)
#         scripts/pot-full-loop.sh --hold        one world, left running for an engineer: it writes the environment a journey needs to
#                                                HOLD_ENV (default: a file in the temporary folder, printed) and waits for Ctrl-C. Run a
#                                                journey by hand with: set -a; . "$HOLD_ENV"; set +a; cd app;
#                                                node_modules/.bin/playwright test --config=playwright.pot-full.config.ts --trace off pot-tasks.spec
#
# --serve: instead of the journey, leaves one project ("Lantern", 50 play dollars in it) on the chain and the server, mines a
#   block every two seconds (as a live chain does, so the server reads each block), binds the chain, the server and the app to
#   this computer's network address (SERVE_HOST, default: its first address) and prints the addresses and the steps. It runs
#   until you press Ctrl-C, then stops everything it started. The chain's development accounts are public and unlocked, so
#   anyone on the same network can send play-money transactions to it while it runs: use a network you trust. It also leaves one
#   planned task on the project (see the words it prints).
# Env:    BUZZ_BIN (the `buzz` command, default target/debug/buzz, for the season journey), SERVE_HOST (with --serve: the address a phone reaches this computer at), POSTGRES_ADMIN_URL (default postgres://buzz:buzz_dev@127.0.0.1:5432/postgres), REDIS_URL, RELAY_BIN, FOUNDRY_BIN,
#         RUN_TIMEOUT (seconds for the browser run, default 900), KEEP_DB=1 (keep the scratch database),
#         RELAY_LOG_COPY=<file>, PW_CHROMIUM_PATH / PW_CHROMIUM_EXTRA_ARGS (a Chromium other than Playwright's pinned one),
#         SHOTS_DIR=<folder> (keep the journey's screenshots there).
# Exit:   0 every check passed; 1 a check failed; 2 the world could not be set up
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\033[36m[pot-full-loop]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pot-full-loop] %s\033[0m\n' "$*" >&2; exit 2; }

SERVE=""
HOLD=""
if [[ "${1:-}" == "--serve" ]]; then SERVE=1; shift; fi
if [[ "${1:-}" == "--hold" ]]; then HOLD=1; shift; fi
# With a journey named on the command line, the push world is the one that has the stand-in.
for arg in "$@"; do [[ "$arg" == *pot-push* ]] && WORLD_PUSH=1; done
[[ -n "${HOLD_PUSH:-}" ]] && WORLD_PUSH=1

[[ -n "${FOUNDRY_BIN:-}" ]] && PATH="$FOUNDRY_BIN:$PATH"
for tool in anvil cast forge psql curl node jq openssl python3 pnpm; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on PATH"
done
BOUNDED="$(command -v timeout || command -v gtimeout || true)"
[[ -n "$BOUNDED" ]] || fail "missing tool: timeout (or gtimeout, from coreutils)"

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@127.0.0.1:5432/postgres}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
RELAY_BIN="${RELAY_BIN:-target/debug/buzz-relay}"
BUZZ_BIN="${BUZZ_BIN:-target/debug/buzz}"
RUN_TIMEOUT="${RUN_TIMEOUT:-1500}"
POT="$REPO_ROOT/contracts/pot"
DB=""
DB_URL=""
STATE="$(mktemp -d)"
APP_DIST="$STATE/app-dist"
ANVIL_PID=""
STANDIN_PID=""
STANDIN_URL=""
WORLD_PUSH="${WORLD_PUSH:-}"
RELAY_PID=""
REDIS_PID=""
PG_CLUSTER=""
DB_MADE=""
CHECKS_FILE="$STATE/checks.log"
: >"$CHECKS_FILE"
MINER_PID=""
BUILT_FOR=""
WORLD=0
# Where the browser and the phone reach things: this computer's own name, or (with --serve) its network address.
BIND_HOST="127.0.0.1"
PUBLIC_HOST="localhost"
if [[ -n "$SERVE" ]]; then
  PUBLIC_HOST="${SERVE_HOST:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
  [[ -n "$PUBLIC_HOST" ]] || fail "cannot tell this computer's network address: set SERVE_HOST"
  BIND_HOST="0.0.0.0"
fi

stop_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.2; done
  kill -9 "$pid" 2>/dev/null || true
}
# Stops one world: the miner, the relay, the chain and the scratch database (the Postgres and Redis this script started are left to
# cleanup, which runs once at the end).
world_down() {
  stop_pid "$MINER_PID"; MINER_PID=""
  stop_pid "$RELAY_PID"; RELAY_PID=""
  stop_pid "$STANDIN_PID"; STANDIN_PID=""; STANDIN_URL=""
  stop_pid "$ANVIL_PID"; ANVIL_PID=""
  [[ -n "${RELAY_LOG_COPY:-}" && -f "$STATE/relay.log" ]] && cp "$STATE/relay.log" "$RELAY_LOG_COPY"
  if [[ -n "$DB_MADE" && "${KEEP_DB:-}" == "1" ]]; then
    echo "[pot-full-loop] kept the scratch database: $DB_URL (drop it with: psql \"$ADMIN_URL\" -c 'drop database $DB with (force)')" >&2
  elif [[ -n "$DB_MADE" ]]; then
    psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1
  fi
  DB_MADE=""
}
cleanup() {
  local code=$?
  trap - EXIT
  world_down
  stop_pid "$REDIS_PID"
  # shellcheck disable=SC2086
  [[ -n "$PG_CLUSTER" ]] && pg_ctlcluster $PG_CLUSTER stop >/dev/null 2>&1
  rm -rf "$STATE" "$REPO_ROOT/app/test-results/playwright-pot-full"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
wait_for() {
  local seconds="$1"; shift
  for _ in $(seq 1 "$seconds"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
pg_ready() { psql "$ADMIN_URL" -qAtc 'select 1'; }
redis_ready() { [[ "$(redis-cli -u "$REDIS_URL" ping 2>/dev/null)" == "PONG" ]]; }

[[ -x "$RELAY_BIN" ]] || fail "no relay at $RELAY_BIN: build it once with cargo (this script never does), or set RELAY_BIN"
[[ -f "$POT/out/Launcher.sol/Launcher.json" ]] || fail "contracts/pot/out is not built (forge build in contracts/pot)"

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


# One chain port for the whole run: the app's build names it, so every world's chain listens there.
CHAIN_PORT="$(free_port)"
RPC="http://127.0.0.1:$CHAIN_PORT"
PUBLIC_RPC="http://$PUBLIC_HOST:$CHAIN_PORT"

# Starts a world: a chain, the contracts on it, the app built for it (once, while the contracts land where they did), the relay
# with its chain reader and helper serving the app, and a scratch database of its own. Sets RELAY_PID, ANVIL_PID, BASE, DB_URL
# and the variables the journeys read.
world_up() {
  WORLD=$((WORLD + 1))
  DB="buzz_pot_full_$$_$WORLD"
  DB_URL="${ADMIN_URL%/*}/$DB"
  step "world $WORLD: a local chain on :$CHAIN_PORT"
  anvil --host "$BIND_HOST" --port "$CHAIN_PORT" --chain-id 31337 --accounts 14 --gas-limit 100000000 --cache-path "$STATE/anvil-cache-$WORLD" \
    --silent >"$STATE/anvil.log" 2>&1 &
  ANVIL_PID=$!
  wait_for 50 cast block-number --rpc-url "$RPC" || fail "anvil did not start"

  # anvil's public development accounts (mnemonic "test ... junk"); the key of the first is derived here and none is written down
  MNEMONIC="test test test test test test test test test test test junk"
  K_DEPLOYER="$(cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index 0)"
  K_HELPER="$(cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index 7)"
  step "deploying contracts/pot with its own deploy script (a real week as the time unit)"
  (cd "$POT" && forge script script/DeployPot.s.sol --rpc-url "$RPC" --broadcast --private-key "$K_DEPLOYER" >"$STATE/deploy.log" 2>&1) \
    || { tail -20 "$STATE/deploy.log" >&2; fail "the deploy script failed"; }
  # The file is shared by every run on this machine and is git-ignored: take our copy at once and read only that.
  cp "$POT/deployments/pot-31337.json" "$STATE/deployments.json" || fail "the deploy script wrote no deployments file"
  LAUNCHER="$(jq -r .launcher "$STATE/deployments.json" | tr 'A-F' 'a-f')"
  USD="$(jq -r .quote "$STATE/deployments.json" | tr 'A-F' 'a-f')"
  START_BLOCK="$(cast block-number --rpc-url "$RPC")"
  [[ "$(cast code --rpc-url "$RPC" "$LAUNCHER" | wc -c)" -gt 10 ]] || fail "no code at the Launcher $LAUNCHER"
  step "play dollar $USD, Launcher $LAUNCHER (block $START_BLOCK)"

  # ── the app, built for this chain: once, and again only if a later world's contracts landed elsewhere ─────────────────
  if [[ "$BUILT_FOR" != "$LAUNCHER" ]]; then
    step "building the app for this chain into a temporary folder"
    ( cd app && CREATON_DEPLOYMENTS_FILE="$STATE/deployments.json" VITE_CREATON_RPC_URL="$PUBLIC_RPC" \
        pnpm exec vite build --outDir "$APP_DIST" --emptyOutDir >"$STATE/app-build.log" 2>&1 ) \
      || { tail -30 "$STATE/app-build.log" >&2; fail "app build failed"; }
    [[ -f "$APP_DIST/index.html" ]] || fail "the app build has no index.html"
    grep -rqi "$LAUNCHER" "$APP_DIST/assets" || fail "the app build does not name the Launcher $LAUNCHER"
    BUILT_FOR="$LAUNCHER"
  fi

  # ── the relay: the chain reader and its helper on, serving the app ────────────────────────────────────────────────────
  psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database"
  DB_MADE=1
  [[ -x "$STATE/buzz-relay" ]] || ln "$RELAY_BIN" "$STATE/buzz-relay" 2>/dev/null || cp "$RELAY_BIN" "$STATE/buzz-relay" || fail "could not take a copy of $RELAY_BIN"
  PORT="$(free_port)"; HEALTH="$(free_port)"; METRICS="$(free_port)"
  BASE="http://localhost:$PORT"
  PUBLIC_BASE="http://$PUBLIC_HOST:$PORT"
  # The platform's operator: a key made for this run (never written to a file). Its public half is the server's owner; the season
  # journey signs with the key through the real `buzz` command.
  OPERATOR_KEY="$(openssl rand -hex 32)"
  OPERATOR_PUB="$(cd app && node --input-type=module -e "import {getPublicKey} from 'nostr-tools/pure'; import {hexToBytes} from 'nostr-tools/utils'; console.log(getPublicKey(hexToBytes(process.argv[1])))" "$OPERATOR_KEY")" \
    || fail "could not derive the operator's public key"
  PUSH_ENV=()
  if [[ -n "$WORLD_PUSH" ]]; then
    local vapid_key
    vapid_key="$(openssl ecparam -name prime256v1 -genkey -noout -out /dev/stdout 2>/dev/null | openssl ec -outform DER 2>/dev/null | tail -c +8 | head -c 32 | basenc --base64url | tr -d '=')"
    [[ ${#vapid_key} -eq 43 ]] || fail "could not make a push key for this run"
    local standin_port
    standin_port="$(free_port)"
    node scripts/web-push-standin.mjs --port "$standin_port" >"$STATE/standin.log" 2>&1 &
    STANDIN_PID=$!
    STANDIN_URL="http://127.0.0.1:$standin_port"
    wait_for 20 curl -fsS "$STANDIN_URL/_received" || fail "the push stand-in did not start"
    PUSH_ENV=(BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY="$vapid_key" BUZZ_WEB_PUSH_SUBJECT="mailto:operator@example.org" BUZZ_WEB_PUSH_EXTRA_HOSTS="127.0.0.1:$standin_port")
  fi
  step "starting the relay on :$PORT (the chain reader on this chain: 2 confirmations, 1 s passes, a fresh record at least every 30 s)"
  env DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" BUZZ_AUTO_MIGRATE=true \
    BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
    BUZZ_BIND_ADDR="$BIND_HOST:$PORT" BUZZ_RELAY_URL="ws://$PUBLIC_HOST:$PORT" RELAY_URL="ws://$PUBLIC_HOST:$PORT" \
    BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
    BUZZ_WEB_DIR="$APP_DIST" BUZZ_WEB_SPA=full BUZZ_MEDIA_BASE_URL="http://$PUBLIC_HOST:$PORT/media" \
    BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_GIT_CONFORMANCE_PROBE=false \
    BUZZ_INVESTING=true RELAY_OWNER_PUBKEY="$OPERATOR_PUB" "${PUSH_ENV[@]}" \
    BUZZ_TERMS_OF_SERVICE_MARKDOWN="$(cat docs/policies/TERMS-DRAFT.md)" \
    BUZZ_PRIVACY_POLICY_MARKDOWN="$(cat docs/policies/PRIVACY-DRAFT.md)" \
    BUZZ_AGE_ATTESTATION_REQUIRED=true \
    BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=600 BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=2000 \
    BUZZ_NEW_ACCOUNT_POSTS_PER_HOUR=0 BUZZ_NEW_ACCOUNT_PROJECT_RECORDS_PER_DAY=0 \
    BUZZ_CHAIN_RPC_URL="$RPC" BUZZ_CHAIN_ID=31337 BUZZ_CHAIN_LAUNCHER="$LAUNCHER" BUZZ_CHAIN_START_BLOCK="$START_BLOCK" \
    BUZZ_CHAIN_CONFIRMATIONS=2 BUZZ_CHAIN_POLL_SECS=1 BUZZ_CHAIN_REFRESH_SECS=30 BUZZ_CHAIN_ACTIVE_REFRESH_SECS=30 \
    BUZZ_CHAIN_HELPER_KEY="$K_HELPER" BUZZ_CHAIN_HELPER_DAILY_GAS=30000000 BUZZ_CHAIN_HELPER_DAILY_SPEND_WEI=1000000000000000000 \
    "$STATE/buzz-relay" >"$STATE/relay.log" 2>&1 &
  RELAY_PID=$!
  relay_up() { curl -fsS -m 2 -H 'Accept: application/nostr+json' "$BASE/"; }
  for _ in $(seq 1 120); do
    relay_up >/dev/null 2>&1 && break
    kill -0 "$RELAY_PID" 2>/dev/null || { tail -30 "$STATE/relay.log" >&2; fail "the relay exited"; }
    sleep 1
  done
  relay_up >/dev/null 2>&1 || { tail -30 "$STATE/relay.log" >&2; fail "the relay did not come up in two minutes"; }
  # The server answers only for hosts it knows (fail-closed host binding): this run's address is one.
  psql "$DB_URL" -qc "insert into communities (host) values ('localhost:$PORT'), ('$PUBLIC_HOST:$PORT') on conflict ((lower(host))) do nothing" \
    || fail "could not add this run's address to the server's communities"
  relay_up | jq -e '.investing == true and (.self | test("^[0-9a-f]{64}$"))' >/dev/null \
    || fail "the relay does not say it offers investing and its own key"
  grep -q 'chain reader started' "$STATE/relay.log" || fail "the chain reader did not start"
  if [[ -n "$WORLD_PUSH" ]]; then
    local public
    public="$(relay_up | jq -r '.webPush.publicKey // empty')"
    [[ -n "$public" ]] || fail "the relay does not carry a push key in its information"
    curl -fsS -X POST -d "{\"publicKey\":\"$public\"}" "$STANDIN_URL/_vapid" >/dev/null || fail "could not give the stand-in the operator's public key"
  fi
  curl -fsS -m 5 -H 'Accept: text/html' "$BASE/welcome" >"$STATE/page.html" 2>&1 || true
  grep -q '<div id="root"' "$STATE/page.html" || fail "the relay does not serve the app's page"
}

# ── --serve: leave the world running for a person ───────────────────────────────────────────────────────────────────
if [[ -n "$SERVE" ]]; then
  world_up
  ( while true; do sleep 2; cast rpc --rpc-url "$RPC" evm_mine >/dev/null 2>&1; done ) &
  MINER_PID=$!
  step "leaving a project on the chain for you to try"
  ( cd app && env BUZZ_REAL_RELAY_URL="$PUBLIC_BASE" POT_RPC_URL="$RPC" POT_DEPLOYMENTS_FILE="$STATE/deployments.json" \
      POT_STATE_DIR="$STATE" POT_CHECKS_FILE="$CHECKS_FILE" POT_REPO_ROOT="$REPO_ROOT" POT_DB_URL="$DB_URL" POT_SERVE=1 \
      "$BOUNDED" 300 node_modules/.bin/playwright test --config=playwright.pot-full.config.ts --reporter=line --trace off seed ) \
    || { tail -20 "$STATE/relay.log" >&2; fail "could not leave a project on the chain"; }
  LINK="$(jq -r .link "$STATE/serve.json")"
  cat <<EOF

[pot-full-loop] READY. Everything here is a local test chain and play money. Leave this window open; press Ctrl-C to stop it all.

  The app (open this on the phone):   $PUBLIC_BASE$LINK
  The chain, for the phone's wallet:  network name "Creaton test", RPC $PUBLIC_RPC, chain id 31337, symbol ETH
  An account to import in the wallet: anvil's public development account number 2. Its key is printed by
      cast wallet private-key --mnemonic "test test test test test test test test test test test junk" --mnemonic-index 2
  (it is public and worth nothing: never import a real account's key anywhere near this)

  Then: open the Money tab; Get play dollars; type 25 and press Back, then the button in the sheet; later press Take out, then the
  sheet's button. Each asks the wallet once.

  The project also has one planned task ("Paint the lamp shades", up to 2 play dollars, for the wallet of development account
  number 5). A holder reads it above the project's tabs and on You. Its notice is long (14 days on this chain's real week), so to
  try the worker's side, move the chain's clock from this computer and wait for the next block:
      cast rpc --rpc-url $RPC evm_increaseTime 1300000
  then, with account number 5 in the wallet, open the project's Tasks tab and press "Set the money aside". The team's side (plan,
  pay, send back, withdraw) needs a project of your own: see docs/next-version/STEP2-SERVER-APP-REPORT.md.

  Step 3 on the same project: the page opens on the name, the money with "This can go up or down. It is not a return.", the
  banner and Back; Share gives the link and a picture; after you Back, the Room tab asks you once to confirm that your account is
  the wallet's (one signature) and then you can write; "Lately" shows joins and take-outs with rounded amounts and no names. The
  room's "one time unit after taking out" is a real week on this chain: move the chain's clock from this computer
  (cast rpc --rpc-url $RPC evm_increaseTime 700000) and the server will say the room is read only for someone who took out.
  Alerts away from the app and seasons are not in this mode: a phone needs a secure address for alerts (see
  docs/next-version/STEP3-REPORT.md, section 9), and a season is started by the operator's key, which only the full run holds.

EOF
  while kill -0 "$RELAY_PID" 2>/dev/null && kill -0 "$ANVIL_PID" 2>/dev/null; do sleep 2; done
  fail "the chain or the server stopped"
fi

# ── the journeys ────────────────────────────────────────────────────────────────────────────────────────────────────
# Runs one Playwright invocation in the world that is up now and judges its outcome.
run_journey() {
  step "running the journey in Chromium (up to ${RUN_TIMEOUT}s): $*"
  local code
  ( cd app
    env BUZZ_REAL_RELAY_URL="$BASE" POT_RPC_URL="$RPC" POT_DEPLOYMENTS_FILE="$STATE/deployments.json" \
      POT_STATE_DIR="$STATE" POT_CHECKS_FILE="$CHECKS_FILE" POT_REPO_ROOT="$REPO_ROOT" POT_DB_URL="$DB_URL" \
      POT_HELPER_ADDRESS="$(cast wallet address --private-key "$K_HELPER" | tr 'A-F' 'a-f')" \
      POT_OPERATOR_KEY="$OPERATOR_KEY" POT_BUZZ_BIN="$REPO_ROOT/$BUZZ_BIN" POT_STANDIN_URL="$STANDIN_URL" \
      ${SHOTS_DIR:+POT_SHOTS_DIR="$SHOTS_DIR"} \
      "$BOUNDED" "$RUN_TIMEOUT" node_modules/.bin/playwright test --config=playwright.pot-full.config.ts \
      --reporter=list --trace off "$@" )
  code=$?
  local checks extra
  checks="$(grep -c '^ok' "$CHECKS_FILE" 2>/dev/null || echo 0)"
  extra="$(awk '/^plus /{s+=$2} END{print s+0}' "$CHECKS_FILE" 2>/dev/null)"
  if [[ $code -ne 0 ]]; then
    [[ $code -eq 124 ]] && printf '\033[31m[pot-full-loop] the browser run did not finish in %ss\033[0m\n' "$RUN_TIMEOUT" >&2
    printf '\033[31m[pot-full-loop] the journey failed (exit %s) after %s checks. The relay'"'"'s last lines:\033[0m\n' "$code" "$((checks + extra))" >&2
    grep -v '"level":"DEBUG"' "$STATE/relay.log" | tail -15 >&2
    exit 1
  fi
  # The reader must never have refused to sign during the whole run, and the relay must still be alive.
  kill -0 "$RELAY_PID" 2>/dev/null || { echo "[pot-full-loop] the relay stopped during the run" >&2; exit 1; }
  if grep -qi "numbers not signed" "$STATE/relay.log"; then
    grep -i "numbers not signed" "$STATE/relay.log" | head -3 >&2
    echo "[pot-full-loop] the reader refused to sign a record at some point" >&2
    exit 1
  fi
  printf '\033[32m[pot-full-loop] ok\033[0m the reader never refused to sign: no record failed its checks during the whole run of this world\n'
  echo "ok --- the reader never refused to sign in world $WORLD" >>"$CHECKS_FILE"
}

if [[ -n "$HOLD" ]]; then
  world_up
  HOLD_ENV="${HOLD_ENV:-$STATE/world.env}"
  cat >"$HOLD_ENV" <<EOF
BUZZ_REAL_RELAY_URL=$BASE
POT_RPC_URL=$RPC
POT_DEPLOYMENTS_FILE=$STATE/deployments.json
POT_STATE_DIR=$STATE
POT_CHECKS_FILE=$CHECKS_FILE
POT_REPO_ROOT=$REPO_ROOT
POT_DB_URL=$DB_URL
POT_HELPER_ADDRESS=$(cast wallet address --private-key "$K_HELPER" | tr 'A-F' 'a-f')
POT_BUZZ_BIN=$REPO_ROOT/$BUZZ_BIN
POT_STANDIN_URL=$STANDIN_URL
EOF
  echo "[pot-full-loop] HOLDING world $WORLD. Environment for a journey: $HOLD_ENV. The relay log: $STATE/relay.log. Press Ctrl-C to stop it all."
  while kill -0 "$RELAY_PID" 2>/dev/null && kill -0 "$ANVIL_PID" 2>/dev/null; do sleep 2; done
  fail "the chain or the server stopped"
elif [[ $# -gt 0 ]]; then
  world_up
  run_journey "$@"
  world_down
else
  # Step 1's journey, step 2's task queue and step 3's three, each in a world of its own (the chain's clock is moved by days in
  # most of them, and a world that is days ahead of the server's clock cannot be reused). Only the push world has a stand-in.
  for journey in pot-full.spec pot-tasks.spec pot-room.spec pot-seasons.spec pot-push.spec; do
    WORLD_PUSH=""
    [[ "$journey" == pot-push.spec ]] && WORLD_PUSH=1
    world_up
    run_journey "$journey"
    world_down
  done
fi
CHECKS="$(grep -c '^ok' "$CHECKS_FILE" 2>/dev/null || echo 0)"
EXTRA="$(awk '/^plus /{s+=$2} END{print s+0}' "$CHECKS_FILE" 2>/dev/null)"
echo
echo "pot-full-loop: $((CHECKS + EXTRA)) checks passed."
