#!/usr/bin/env bash
#
# scripts/test-mvp-gate.sh — proves the journey runner only touches what it started.
#
# The runner stops each journey's process group and nothing else, never kills by name or port, reports a port someone else
# holds as blocked instead of freeing it (:4173 for most journeys, :3199 for the social one), and sends the anvil state of
# the journeys it runs to a directory of its own, which is all it deletes. This runs it against stand-in journeys that
# leak a child, hold a port, and make scratch state, beside bystanders that must survive: a process, a server on :4173 or
# :3199, and state that another actor creates while the run is in progress. It also checks the social journey is in the
# full run and that its script is the social suite with HOSTED=1, that a journey script in no set and with no reason is
# warned about (and that every journey script in scripts/ has a home), and that --outside gives each left-out one a reason.
#
# Everything here is a stand-in the test started itself, and only those PIDs are ever stopped: if :4173 or :3199 is
# already held by something else, that part is skipped rather than risked. No chain, browser or database needed.
# Usage: scripts/test-mvp-gate.sh

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
GATE="$REPO_ROOT/scripts/mvp-gate.sh"
failures=0
OWN_PIDS=() # only processes this test started itself
cleanup() {
  for pid in "${OWN_PIDS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

check() { # check "what" <0 when it held>
  if [[ $2 -eq 0 ]]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); fi
}
alive() { kill -0 "$1" 2>/dev/null; }
yes_if() { if "$@"; then echo 0; else echo 1; fi; }

mkdir -p "$WORK/journeys" "$WORK/fakebin" "$WORK/foreign-state" "$WORK/logs"
# A stand-in anvil: records where it was told to keep its state, and keeps some there.
cat >"$WORK/fakebin/anvil" <<'FAKE'
#!/usr/bin/env bash
cache=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--cache-path" ]]; then cache="$2"; shift; fi
  shift
done
echo "$cache" >>"$ANVIL_CACHE_LOG"
[[ -n "$cache" ]] && mkdir -p "$cache/anvil-state-fake" && echo x >"$cache/anvil-state-fake/0x1.json"
: >"$ANVIL_READY_FILE"
exec sleep 3000
FAKE
chmod +x "$WORK/fakebin/anvil"
cat >"$WORK/journeys/leaky.sh" <<'JOURNEY'
#!/usr/bin/env bash
# Starts a chain that outlives it, and, while it runs, another actor makes its own anvil state elsewhere.
rm -f "$ANVIL_READY_FILE"
anvil --port 1 &
chain_pid=$!
echo "$chain_pid" >"$LEAKED_PID_FILE"
for _ in $(seq 1 100); do
  [[ -f "$ANVIL_READY_FILE" ]] && break
  kill -0 "$chain_pid" 2>/dev/null || { echo 'Error: stand-in chain exited before readiness'; exit 1; }
  sleep 0.1
done
[[ -f "$ANVIL_READY_FILE" ]] || { echo 'Error: stand-in chain readiness timed out'; exit 1; }
mkdir -p "$FOREIGN_STATE/anvil-state-made-during-the-run"
exit 0
JOURNEY
# The social journey's stand-in: the real one needs Postgres, Redis and :3199.
cat >"$WORK/journeys/web-social-hosted-e2e.sh" <<'JOURNEY'
#!/usr/bin/env bash
exit 0
JOURNEY
cat >"$WORK/journeys/failing.sh" <<'JOURNEY'
#!/usr/bin/env bash
echo "Error: stand-in failure"
exit 1
JOURNEY
chmod +x "$WORK/journeys/"*.sh

export JOURNEY_DIR="$WORK/journeys" LOG_DIR="$WORK/logs" FOUNDRY_BIN="$WORK/fakebin" \
  LEAKED_PID_FILE="$WORK/leaked.pid" ANVIL_CACHE_LOG="$WORK/cache-paths.txt" FOREIGN_STATE="$WORK/foreign-state" \
  ANVIL_READY_FILE="$WORK/anvil-ready"

# Bystanders that were there first: a process, and state that was already on disk.
sleep 3000 & BYSTANDER=$!; OWN_PIDS+=("$BYSTANDER")
mkdir -p "$FOREIGN_STATE/anvil-state-there-before"

echo "--- a journey that leaks a chain and the chain keeps state"
"$GATE" leaky >"$WORK/run1.out" 2>&1; status=$?
check "the run passes" $(yes_if [ $status -eq 0 ])
check "the stand-in chain actually reached readiness" $(yes_if [ -f "$ANVIL_READY_FILE" ])
check "the chain the journey leaked is stopped" $(yes_if bash -c '! kill -0 "$(cat "$0")" 2>/dev/null' "$LEAKED_PID_FILE")
check "an unrelated process is left running" $(yes_if alive "$BYSTANDER")
CACHE="$(head -1 "$ANVIL_CACHE_LOG" 2>/dev/null)"
check "the chain was told to keep its state in a directory of the run's own" $(yes_if [ -n "$CACHE" ])
check "that directory is not anvil's shared default" $(yes_if bash -c '[[ "$0" != "$HOME/.foundry/"* ]]' "$CACHE")
check "that directory is gone after the run" $(yes_if [ ! -e "$CACHE" ])
check "state another actor made during the run is untouched" $(yes_if [ -d "$FOREIGN_STATE/anvil-state-made-during-the-run" ])
check "state that was already there is untouched" $(yes_if [ -d "$FOREIGN_STATE/anvil-state-there-before" ])

echo "--- a server already on :4173 is reported, never stopped"
# Only a server this test started is ever stopped. If something else holds the port, skip rather than risk it.
if lsof -ti tcp:4173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "skip port 4173 is already in use by something this test did not start"
else
  python3 -m http.server 4173 --bind 127.0.0.1 >/dev/null 2>&1 & SERVER=$!
  OWN_PIDS+=("$SERVER")
  for _ in $(seq 1 20); do lsof -ti tcp:4173 -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
  HOLDER="$(lsof -ti tcp:4173 -sTCP:LISTEN | head -1)"
  if [[ "$HOLDER" != "$SERVER" ]]; then
    # The listener is not the process this test started (for example an interpreter wrapper): do not trust or stop it.
    echo "skip the listener on :4173 is not the server this test started"
  else
    "$GATE" leaky >"$WORK/run2.out" 2>&1; status=$?
    check "the journey is reported blocked and the run does not pass" $(yes_if bash -c '[[ $0 -ne 0 ]] && grep -q BLOCKED "$1"' "$status" "$WORK/run2.out")
    check "the message says who holds the port" $(yes_if grep -q "port 4173 is held by $SERVER" "$WORK/run2.out")
    check "the server on :4173 is still running" $(yes_if alive "$SERVER")
    # A journey that never serves on :4173 (the fixture's optional demo server is on :5173; the keeper test is a chain and
    # the command line only) must not be blocked by an unrelated preview server. web-trading-e2e does serve there.
    for name in v5-local-fixture secondary-keeper-e2e web-trading-e2e; do
      printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/journeys/$name.sh"
      chmod +x "$WORK/journeys/$name.sh"
    done
    "$GATE" v5-local-fixture secondary-keeper-e2e web-trading-e2e >"$WORK/run2b.out" 2>&1
    check "the fixture is not blocked by a server on :4173" $(yes_if grep -q "PASS.* v5-local-fixture" "$WORK/run2b.out")
    check "the keeper test is not blocked by a server on :4173" $(yes_if grep -q "PASS.* secondary-keeper-e2e" "$WORK/run2b.out")
    check "the web trading journey, which serves on :4173, is blocked by it" $(yes_if grep -q "BLOCKED.* web-trading-e2e: port 4173 is held by $SERVER" "$WORK/run2b.out")
  fi
  kill "$SERVER" 2>/dev/null
  for _ in $(seq 1 20); do lsof -ti tcp:4173 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
fi

echo "--- a server already on :3199 blocks the social journey, and only it"
if lsof -ti tcp:3199 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "skip port 3199 is already in use by something this test did not start"
else
  python3 -m http.server 3199 --bind 127.0.0.1 >/dev/null 2>&1 & SERVER=$!
  OWN_PIDS+=("$SERVER")
  for _ in $(seq 1 20); do lsof -ti tcp:3199 -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
  HOLDER="$(lsof -ti tcp:3199 -sTCP:LISTEN | head -1)"
  if [[ "$HOLDER" != "$SERVER" ]]; then
    echo "skip the listener on :3199 is not the server this test started"
  elif lsof -ti tcp:4173 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "skip port 4173 is held, so the other journey would be blocked for its own reason"
  else
    "$GATE" web-social-hosted-e2e leaky >"$WORK/run4.out" 2>&1; status=$?
    check "the social journey is reported blocked and the run does not pass" $(yes_if bash -c '[[ $0 -ne 0 ]] && grep -q "BLOCKED.* web-social-hosted-e2e: port 3199 is held by $1" "$2"' "$status" "$SERVER" "$WORK/run4.out")
    check "a journey that does not need :3199 still runs" $(yes_if grep -q "PASS.* leaky" "$WORK/run4.out")
    check "the server on :3199 is still running" $(yes_if alive "$SERVER")
  fi
  kill "$SERVER" 2>/dev/null
  for _ in $(seq 1 20); do lsof -ti tcp:3199 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
fi

echo "--- the social journey is in the full run, as the social suite with HOSTED=1"
check "the full run includes web-social-hosted-e2e" $(yes_if grep -qx '  web-social-hosted-e2e' "$GATE")
mkdir -p "$WORK/wrapper"
cp "$REPO_ROOT/scripts/web-social-hosted-e2e.sh" "$WORK/wrapper/"
cat >"$WORK/wrapper/web-social-e2e.sh" <<'SUITE'
#!/usr/bin/env bash
echo "HOSTED=${HOSTED:-} args=$*"
SUITE
chmod +x "$WORK/wrapper/web-social-e2e.sh"
HOSTED="" "$WORK/wrapper/web-social-hosted-e2e.sh" --grep feed >"$WORK/wrapper.out" 2>&1
check "the wrapper runs the social suite with HOSTED=1 and passes its arguments on" $(yes_if grep -qx "HOSTED=1 args=--grep feed" "$WORK/wrapper.out")

echo "--- the pilot set is what the hosted pilot depends on, and nothing raise-only"
mkdir -p "$WORK/list-logs"
PILOT_LIST="$(LOG_DIR="$WORK/list-logs" "$GATE" --pilot --list)"
for journey in web-pilot-e2e web-social-hosted-e2e web-invite-only-e2e web-error-report-e2e web-contributor-e2e web-passkey-contributor-e2e web-restricted-holder-e2e; do
  check "the pilot set includes $journey" $(yes_if grep -qx "$journey" <<<"$PILOT_LIST")
done
for journey in web-dao-launch-e2e web-economy-e2e web-sepolia-fork-e2e cli-milestone-e2e web-challenge-e2e; do
  check "the pilot set leaves out $journey" $(yes_if bash -c '! grep -qx "$0" <<<"$1"' "$journey" "$PILOT_LIST")
done
ALL_LIST="$(LOG_DIR="$WORK/list-logs" "$GATE" --list)"
check "the full run is the pilot set and then the later set" \
  $(yes_if [ "$ALL_LIST" == "$(printf '%s\n%s' "$PILOT_LIST" "$(LOG_DIR="$WORK/list-logs" "$GATE" --later --list)")" ])
missing=""
for journey in $ALL_LIST; do [[ -x "$REPO_ROOT/scripts/$journey.sh" ]] || missing+=" $journey"; done
check "every journey in the full run is a script here${missing:+ (missing:$missing)}" $(yes_if [ -z "$missing" ])
check "--list runs nothing" $(yes_if bash -c '[[ -z "$(ls -A "$0")" ]]' "$WORK/list-logs")

echo "--- a journey script in no set, with no reason, is reported; one with a home is not"
mkdir -p "$WORK/homes" "$WORK/homes-logs"
for name in web-social-hosted-e2e web-rounds-e2e web-decisions-e2e brand-new-e2e; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/homes/$name.sh"
  chmod +x "$WORK/homes/$name.sh"
done
JOURNEY_DIR="$WORK/homes" LOG_DIR="$WORK/homes-logs" "$GATE" --list >"$WORK/homes.out" 2>"$WORK/homes.err"
check "an unlisted journey script is named in a warning" \
  $(yes_if grep -q "WARNING.*brand-new-e2e.sh is in no gate set" "$WORK/homes.err")
check "the warning goes to standard error, so --list stays a plain list" \
  $(yes_if bash -c '! grep -q WARNING "$0"' "$WORK/homes.out")
check "journeys in a set, or outside one with a reason, are not warned about" \
  $(yes_if bash -c '[[ "$(grep -c WARNING "$0")" == 1 ]]' "$WORK/homes.err")
JOURNEY_DIR="$WORK/homes" LOG_DIR="$WORK/homes-logs" "$GATE" brand-new-e2e >"$WORK/homes-run.out" 2>&1; status=$?
check "the warning is given on a real run too, which still runs what it is asked to" \
  $(yes_if bash -c '[[ $0 -eq 0 ]] && grep -q "WARNING.*brand-new-e2e" "$1" && grep -q "PASS.* brand-new-e2e" "$1"' "$status" "$WORK/homes-run.out")
UNHOMED="$(cd "$REPO_ROOT" && env -u JOURNEY_DIR LOG_DIR="$WORK/list-logs" "$GATE" --list 2>&1 >/dev/null | grep WARNING | sed 's/\x1b\[[0-9;]*m//g')"
check "every journey script in scripts/ is in a set or has a reason${UNHOMED:+ ($UNHOMED)}" $(yes_if [ -z "$UNHOMED" ])
OUTSIDE_LIST="$(LOG_DIR="$WORK/list-logs" "$GATE" --outside)"
check "--outside gives each journey left out a reason" \
  $(yes_if bash -c '[[ -n "$0" ]] && ! grep -qvE "^[a-z0-9-]+-e2e: .{20,}" <<<"$0"' "$OUTSIDE_LIST")
for journey in web-rounds-e2e web-post-bounty-e2e web-self-serve-e2e shares-erc20c-e2e; do
  check "the later set runs $journey, which no gate ran before" $(yes_if grep -qx "$journey" <<<"$(LOG_DIR="$WORK/list-logs" "$GATE" --later --list)")
done

echo "--- --pilot builds the contributor journey as the hosted image does exactly when its spec can play that build"
cat >"$WORK/journeys/web-contributor-e2e.sh" <<'JOURNEY'
#!/usr/bin/env bash
echo "PILOT_BUILD=${PILOT_BUILD:-}" >>"$PILOT_BUILD_LOG"
JOURNEY
chmod +x "$WORK/journeys/web-contributor-e2e.sh"
export PILOT_BUILD_LOG="$WORK/pilot-build.txt"
# The spec plays the contributor-only build because it reads E2E_PILOT_BUILD (the raise-era card and the remix step are
# not in that build), so --pilot sets PILOT_BUILD=1. A spec that did not read it would fail the pilot gate every time, so
# then --pilot must not set it.
if grep -q "E2E_PILOT_BUILD" "$REPO_ROOT/web/tests/e2e/contributor-journey.spec.ts"; then
  EXPECTED_PILOT_BUILD="PILOT_BUILD=1"
else
  EXPECTED_PILOT_BUILD="PILOT_BUILD="
fi
if lsof -ti tcp:4173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "skip port 4173 is already in use, so the contributor journey's stand-in would be blocked"
else
  : >"$PILOT_BUILD_LOG"
  env -u PILOT_BUILD "$GATE" --pilot web-contributor-e2e >"$WORK/run5.out" 2>&1
  check "--pilot runs web-contributor-e2e with $EXPECTED_PILOT_BUILD (what its spec can play)" \
    $(yes_if grep -qx "$EXPECTED_PILOT_BUILD" "$PILOT_BUILD_LOG")
  : >"$PILOT_BUILD_LOG"
  env -u PILOT_BUILD "$GATE" web-contributor-e2e >"$WORK/run6.out" 2>&1
  check "a run without --pilot does not set PILOT_BUILD" $(yes_if grep -qx "PILOT_BUILD=" "$PILOT_BUILD_LOG")
fi
# What PILOT_BUILD=1 does in the real script: the hosted image's settings only, and no optional feature named to the spec.
PILOT_BRANCH="$(awk '/^if \[\[ "\$\{PILOT_BUILD:-\}" == "1" \]\]; then/,/^fi$/' "$REPO_ROOT/scripts/web-contributor-e2e.sh")"
check "PILOT_BUILD=1 builds with VITE_CONTRIBUTOR_ONLY=1" $(yes_if grep -q "VITE_CONTRIBUTOR_ONLY=1" <<<"$PILOT_BRANCH")
check "PILOT_BUILD=1 names no optional feature to the build" \
  $(yes_if bash -c '! grep -qE "VITE_(DAO_LAUNCH_KITS|WORK_BOUNTIES|PAYOUTS_FACTORIES|REMIX_BONDS|COURTS|CREATE_)" <<<"$0"' "$PILOT_BRANCH")
check "PILOT_BUILD=1 names no optional feature to the spec, and tells it the build is the pilot's" \
  $(yes_if grep -qx "  OPTIONAL_SPEC=(E2E_PILOT_BUILD=1)" <<<"$PILOT_BRANCH")
check "the build takes only what is named (env -i)" \
  $(yes_if grep -q 'env -i PATH="$PATH" HOME="$HOME" "${BUILD_ENV\[@\]}"' "$REPO_ROOT/scripts/web-contributor-e2e.sh")

echo "--- a failing journey fails the run"
"$GATE" failing >"$WORK/run3.out" 2>&1; status=$?
check "a failing journey makes the run fail" $(yes_if bash -c '[[ $0 -ne 0 ]] && grep -q "FAILED:  failing" "$1"' "$status" "$WORK/run3.out")

echo "--- the CI job keeps object storage running for the journeys"
WORKFLOW="$REPO_ROOT/.github/workflows/mvp-gate.yml"
if [[ -f "$WORKFLOW" ]]; then
  # `docker compose up --exit-code-from minio-init` stops MinIO as well once the bucket is made.
  check "the CI job makes the bucket without stopping MinIO" \
    $(yes_if bash -c '! grep -v "^ *#" "$0" | grep -q -- "--exit-code-from" && grep -q "docker compose run --rm minio-init" "$0"' "$WORKFLOW")
  check "the CI job checks MinIO is still running after the bucket is made" \
    $(yes_if grep -q 'docker compose ps --status running --services | grep -qx minio' "$WORKFLOW")
fi

echo
if [[ $failures -eq 0 ]]; then echo "all checks passed"; else echo "$failures check(s) failed"; fi
[[ $failures -eq 0 ]]
