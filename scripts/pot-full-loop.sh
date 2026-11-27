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
# Step 3's journey (app/tests/e2e-pot-full/pot-room.spec.ts), in a world of its own:
#   pot-room      a visitor opens a project's link and reads the page (one banner, the line "not a return", play money, one Back);
#                 two people back and one takes out, and the live feed shows it rounded, with no names and the net money in; a holder
#                 writes in the room, a stranger is refused in the server's own words, and after taking out and one time unit the
#                 person is read-only (the server says so too);
#
# Step 4's journey (app/tests/e2e-pot-full/pot-pause.spec.ts), in a world of its own, deployed with the setting step 4 adds (it is
# off in every other world, as in a default deployment):
#   pot-pause     the deploy script is run with HOLDER_PAUSE=1: a founder launches in the app (and is told, before signing, that holders
#                 can pause the team's spending); two holders park their Shares in the app until the line is passed; the chain's clock
#                 moves past the warning day; the team's Draw is off and a plan is refused in the app's own words; a holder who has
#                 Shares parked takes out in one press (un-park, then leave); the pause ends and the team's Draw is back; the record
#                 equals the contracts' own views at each step (scripts/chain-loop-pot-check.py).
#
# Prints one `ok` line per check from the journey and, at the end, "pot-full-loop: N checks passed." Stops everything it started
# (anvil, the relay, a Redis or Postgres it had to start), drops its scratch database and removes its temporary files, whatever
# the outcome. Never runs cargo: the relay must already be built (`cargo build -p buzz-relay`).
#
# Needs: anvil, cast, forge (FOUNDRY_BIN or PATH), psql and redis-cli, a Postgres and a Redis (started here when they are not
# running; `docker compose up -d postgres redis` gives the defaults below), node with app/node_modules (the checker's tools), pnpm,
# jq, openssl, python3, curl, Playwright's Chromium (the one app/ already uses; this script installs nothing), and a built relay.
# The tools are checked first and every missing one is named with how to get it (docs/next-version/TRY-IT.md, part 1). Works on
# Linux and macOS (`timeout` and `hostname -I` are not needed). Uses anvil's well-known development accounts only; every amount
# is play money.
#
# Usage:  scripts/pot-full-loop.sh [playwright args]     with no arguments: all six journeys, each in a world of its own;
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
# Env:    SERVE_HOST (with --serve: the address a phone reaches this computer at), POSTGRES_ADMIN_URL (default postgres://buzz:buzz_dev@127.0.0.1:5432/postgres), REDIS_URL, RELAY_BIN, FOUNDRY_BIN,
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
# With a journey named on the command line, the pause journey is the one that gets the pause world.
for arg in "$@"; do
  [[ "$arg" == *pot-pause* ]] && WORLD_KIND=pause
done

[[ -n "${FOUNDRY_BIN:-}" ]] && PATH="$FOUNDRY_BIN:$PATH"
# Every tool this script needs, checked at once: each missing one is named in a plain sentence with how to get it.
missing=0
lack() { printf '\033[31m[pot-full-loop] %s\033[0m\n' "$*" >&2; missing=1; }
for tool in anvil cast forge; do
  command -v "$tool" >/dev/null 2>&1 || lack "Foundry is missing ($tool): install it with 'curl -L https://foundry.paradigm.xyz | bash' and then 'foundryup', or put its folder in FOUNDRY_BIN."
done
command -v psql >/dev/null 2>&1 || lack "psql is missing: on a Mac 'brew install libpq && brew link --force libpq', on Ubuntu 'sudo apt install postgresql-client'."
command -v redis-cli >/dev/null 2>&1 || lack "redis-cli is missing: on a Mac 'brew install redis', on Ubuntu 'sudo apt install redis-tools'."
command -v jq >/dev/null 2>&1 || lack "jq is missing: on a Mac 'brew install jq', on Ubuntu 'sudo apt install jq'."
command -v openssl >/dev/null 2>&1 || lack "openssl is missing: on a Mac 'brew install openssl', on Ubuntu 'sudo apt install openssl'."
command -v python3 >/dev/null 2>&1 || lack "python3 is missing: on a Mac 'brew install python', on Ubuntu 'sudo apt install python3'."
command -v curl >/dev/null 2>&1 || lack "curl is missing: on a Mac 'brew install curl', on Ubuntu 'sudo apt install curl'."
command -v node >/dev/null 2>&1 || lack "Node is missing: run '. ./bin/activate-hermit' in this folder, or install Node 22 from nodejs.org."
command -v pnpm >/dev/null 2>&1 || lack "pnpm is missing: run '. ./bin/activate-hermit' in this folder, or 'npm install -g pnpm'."
[[ -d app/node_modules ]] || lack "The app's libraries are not installed: run 'pnpm install' in this folder (and 'git submodule update --init --recursive' once)."
[[ -x "${RELAY_BIN:-target/debug/buzz-relay}" ]] || lack "The server is not built: run 'cargo build -p buzz-relay' once (this script never builds)."
[[ -f contracts/pot/out/Launcher.sol/Launcher.json ]] || lack "The contracts are not built: run 'scripts/ensure-solc.sh 0.8.37' and then 'forge build' in contracts/pot."
[[ $missing -eq 0 ]] || exit 2
ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@127.0.0.1:5432/postgres}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
RELAY_BIN="${RELAY_BIN:-target/debug/buzz-relay}"
RUN_TIMEOUT="${RUN_TIMEOUT:-1500}"
POT="$REPO_ROOT/contracts/pot"
DB=""
DB_URL=""
STATE="$(mktemp -d)"
# A command that stops another after a time: GNU timeout, Homebrew's gtimeout, or (on a Mac without coreutils) a small stand-in.
BOUNDED="$(command -v timeout || command -v gtimeout || true)"
if [[ -z "$BOUNDED" ]]; then
  BOUNDED="$STATE/bounded"
  cat >"$BOUNDED" <<'SH'
#!/usr/bin/env bash
secs="$1"; shift
"$@" &
pid=$!
( sleep "$secs"; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
watcher=$!
wait "$pid"; code=$?
if kill -0 "$watcher" 2>/dev/null; then pkill -P "$watcher" 2>/dev/null; kill "$watcher" 2>/dev/null; else code=124; fi
exit "$code"
SH
  chmod +x "$BOUNDED"
fi
APP_DIST="$STATE/app-dist"
ANVIL_PID=""
# What the deployment of a world is given: "default" (no switch) or "pause" (HOLDER_PAUSE=1).
WORLD_KIND="${WORLD_KIND:-default}"
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
  # This computer's address on the network: `hostname -I` on Linux, `ipconfig getifaddr` on a Mac (Wi-Fi, then the cable).
  lan_address() {
    local found
    found="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [[ -n "$found" ]] || found="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    printf '%s' "$found"
  }
  PUBLIC_HOST="${SERVE_HOST:-$(lan_address)}"
  [[ -n "$PUBLIC_HOST" ]] || fail "I cannot tell this computer's address on your network: run it again with SERVE_HOST=<the address>. On a Mac it is under System Settings, Wi-Fi, Details (or run 'ipconfig getifaddr en0'); on Linux run 'hostname -I'. The phone must be on the same network."
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
    || fail "Postgres is not answering at $ADMIN_URL. Start one: 'docker compose up -d postgres redis' in this folder gives the defaults this script uses (or set POSTGRES_ADMIN_URL to one you run)."
  cluster="$(pg_lsclusters -h | awk '$4 == "down" { print $1, $2; exit }')"
  [[ -n "$cluster" ]] || fail "Postgres is not answering at $ADMIN_URL. Start one: 'docker compose up -d postgres redis' in this folder gives the defaults this script uses (or set POSTGRES_ADMIN_URL to one you run)."
  # shellcheck disable=SC2086
  pg_ctlcluster $cluster start || fail "could not start the Postgres cluster $cluster"
  PG_CLUSTER="$cluster"
  wait_for 30 pg_ready || fail "Postgres was started but does not answer at $ADMIN_URL"
fi
if ! redis_ready; then
  command -v redis-server >/dev/null 2>&1 || fail "Redis is not answering at $REDIS_URL. Start one: 'docker compose up -d postgres redis' in this folder gives the defaults this script uses (or set REDIS_URL to one you run)."
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
  DEPLOY_ENV=()
  if [[ "$WORLD_KIND" == "pause" ]]; then
    DEPLOY_ENV=(HOLDER_PAUSE=1)
  fi
  step "deploying contracts/pot with its own deploy script (a real week as the time unit; world kind: $WORLD_KIND)"
  (cd "$POT" && env ${DEPLOY_ENV[@]+"${DEPLOY_ENV[@]}"} forge script script/DeployPot.s.sol --rpc-url "$RPC" --broadcast --private-key "$K_DEPLOYER" >"$STATE/deploy.log" 2>&1) \
    || { tail -20 "$STATE/deploy.log" >&2; fail "the deploy script failed"; }
  # The file is shared by every run on this machine and is git-ignored: take our copy at once and read only that.
  cp "$POT/deployments/pot-31337.json" "$STATE/deployments.json" || fail "the deploy script wrote no deployments file"
  LAUNCHER="$(jq -r .launcher "$STATE/deployments.json" | tr 'A-F' 'a-f')"
  USD="$(jq -r .quote "$STATE/deployments.json" | tr 'A-F' 'a-f')"
  START_BLOCK="$(cast block-number --rpc-url "$RPC")"
  [[ "$(cast code --rpc-url "$RPC" "$LAUNCHER" | wc -c)" -gt 10 ]] || fail "no code at the Launcher $LAUNCHER"
  step "play dollar $USD, Launcher $LAUNCHER (block $START_BLOCK)"
  if [[ "$WORLD_KIND" == "pause" ]]; then
    [[ "$(jq -r .holderPause "$STATE/deployments.json")" != "0x0000000000000000000000000000000000000000" ]] || fail "HOLDER_PAUSE=1 gave no holder pause"
  fi
  PORT="$(free_port)"; HEALTH="$(free_port)"; METRICS="$(free_port)"

  # ── the app, built for this chain: once, and again only if a later world's contracts landed elsewhere ────────────────────────
  if [[ "$BUILT_FOR" != "$LAUNCHER" ]]; then
    step "building the app for this chain into a temporary folder"
    ( cd app && env CREATON_DEPLOYMENTS_FILE="$STATE/deployments.json" VITE_CREATON_RPC_URL="$PUBLIC_RPC" \
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
  BASE="http://localhost:$PORT"
  PUBLIC_BASE="http://$PUBLIC_HOST:$PORT"
  # The server's owner: a key made for this run (never written to a file); only its public half is used.
  OPERATOR_KEY="$(openssl rand -hex 32)"
  OPERATOR_PUB="$(cd app && OPERATOR_KEY="$OPERATOR_KEY" node --input-type=module -e "import {getPublicKey} from 'nostr-tools/pure'; import {hexToBytes} from 'nostr-tools/utils'; console.log(getPublicKey(hexToBytes(process.env.OPERATOR_KEY)))")" \
    || fail "could not derive the operator's public key"
  step "starting the relay on :$PORT (the chain reader on this chain: 2 confirmations, 1 s passes, a fresh record at least every 30 s)"
  env DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" BUZZ_AUTO_MIGRATE=true \
    BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
    BUZZ_BIND_ADDR="$BIND_HOST:$PORT" BUZZ_RELAY_URL="ws://$PUBLIC_HOST:$PORT" RELAY_URL="ws://$PUBLIC_HOST:$PORT" \
    BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
    BUZZ_WEB_DIR="$APP_DIST" BUZZ_WEB_SPA=full BUZZ_MEDIA_BASE_URL="http://$PUBLIC_HOST:$PORT/media" \
    BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_GIT_CONFORMANCE_PROBE=false \
    BUZZ_INVESTING=true RELAY_OWNER_PUBKEY="$OPERATOR_PUB" \
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
  curl -fsS -m 5 -H 'Accept: text/html' "$BASE/welcome" >"$STATE/page.html" 2>&1 || true
  grep -q '<div id="root"' "$STATE/page.html" || fail "the relay does not serve the app's page"
}

# Writes the environment a journey needs (what `--hold` and, when HOLD_ENV is set, `--serve` leave for an engineer). The operator's
# key is never in it.
write_world_env() {
  cat >"$1" <<EOF
BUZZ_REAL_RELAY_URL=$BASE
POT_RPC_URL=$RPC
POT_DEPLOYMENTS_FILE=$STATE/deployments.json
POT_STATE_DIR=$STATE
POT_CHECKS_FILE=$CHECKS_FILE
POT_REPO_ROOT=$REPO_ROOT
POT_DB_URL=$DB_URL
POT_HELPER_ADDRESS=$(cast wallet address --private-key "$K_HELPER" | tr 'A-F' 'a-f')
EOF
}

# ── --serve: leave the world running for a person ───────────────────────────────────────────────────────────────────
if [[ -n "$SERVE" ]]; then
  world_up
  ( while true; do sleep 2; cast rpc --rpc-url "$RPC" evm_mine >/dev/null 2>&1; done ) &
  MINER_PID=$!
  step "leaving a project on the chain for you to try"
  ( cd app && env BUZZ_REAL_RELAY_URL="$PUBLIC_BASE" POT_RPC_URL="$RPC" POT_DEPLOYMENTS_FILE="$STATE/deployments.json" \
      POT_STATE_DIR="$STATE" POT_CHECKS_FILE="$CHECKS_FILE" POT_REPO_ROOT="$REPO_ROOT" POT_DB_URL="$DB_URL" POT_SERVE=1 \
      POT_WORLD_KIND="$WORLD_KIND" \
      "$BOUNDED" 300 node_modules/.bin/playwright test --config=playwright.pot-full.config.ts --reporter=line --trace off seed ) \
    || { tail -20 "$STATE/relay.log" >&2; fail "could not leave a project on the chain"; }
  LINK="$(jq -r .link "$STATE/serve.json")"
  [[ -n "${HOLD_ENV:-}" ]] && write_world_env "$HOLD_ENV"
  STEP4_NOTE=""
  if [[ "$WORLD_KIND" == "pause" ]]; then
    STEP4_NOTE="  This world was deployed with HOLDER_PAUSE=1: the project has the holders' pause. The steps are in TRY-IT.md, part 4.8.
"
  fi
  cat <<EOF

[pot-full-loop] READY. Everything here is a local test chain and play money. Leave this window open; press Ctrl-C to stop it all.
The page is plain http on this network, so a passkey and the Copy press cannot be tried on it (TRY-IT.md, part 1).

  The app (open this on the phone):   $PUBLIC_BASE$LINK
  The chain, for the phone's wallet:  network "Local test network", RPC $PUBLIC_RPC, chain id 31337, symbol ETH
      (the app offers to add it when the wallet does not know it; a phone wallet may refuse an http address)
  Accounts for the wallet: anvil's public development accounts, counted from 0. Use 2, 3, 6, 8, 9, 10 ... and leave 0, 1, 4, 5 and 7
      alone (the contracts, the first backer, the demo's worker and the server's helper use them). The key of account 2 is printed by
      cast wallet private-key --mnemonic "test test test test test test test test test test test junk" --mnemonic-index 2
  They are public and worth nothing: never import a real account's key anywhere near this.

  The chain's clock (to try the notice before a task, the worker's step and the room after taking out): move it, then wait two seconds
  for the next block:
      cast rpc --rpc-url $PUBLIC_RPC evm_increaseTime 1500000
  The server and the page keep their own clocks, so after a jump the project's record reads as old and Back waits until the next
  record. Move the clock only when TRY-IT.md says.

${STEP4_NOTE}  The numbered steps, with what working looks like, are in docs/next-version/TRY-IT.md.

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
      POT_WORLD_KIND="$WORLD_KIND" \
      ${SHOTS_DIR:+POT_SHOTS_DIR="$SHOTS_DIR"} \
      "$BOUNDED" "$RUN_TIMEOUT" node_modules/.bin/playwright test --config=playwright.pot-full.config.ts \
      --reporter=list --trace off "$@" )
  code=$?
  local checks extra
  checks="$(grep -c '^ok' "$CHECKS_FILE" 2>/dev/null || true)"; checks="${checks:-0}"
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
  write_world_env "$HOLD_ENV"
  echo "[pot-full-loop] HOLDING world $WORLD. Environment for a journey: $HOLD_ENV. The relay log: $STATE/relay.log. Press Ctrl-C to stop it all."
  while kill -0 "$RELAY_PID" 2>/dev/null && kill -0 "$ANVIL_PID" 2>/dev/null; do sleep 2; done
  fail "the chain or the server stopped"
elif [[ $# -gt 0 ]]; then
  world_up
  run_journey "$@"
  world_down
else
  # Step 1's journey, step 2's task queue, step 3's one and step 4's one, each in a world of its own (the chain's clock is moved by days in
  # most of them, and a world that is days ahead of the server's clock cannot be reused).
  for journey in pot-full.spec pot-tasks.spec pot-room.spec pot-pause.spec; do
    WORLD_KIND=default
    [[ "$journey" == pot-pause.spec ]] && WORLD_KIND=pause
    world_up
    run_journey "$journey"
    world_down
  done
fi
CHECKS="$(grep -c '^ok' "$CHECKS_FILE" 2>/dev/null || true)"; CHECKS="${CHECKS:-0}"
EXTRA="$(awk '/^plus /{s+=$2} END{print s+0}' "$CHECKS_FILE" 2>/dev/null)"
echo
echo "pot-full-loop: $((CHECKS + EXTRA)) checks passed."
