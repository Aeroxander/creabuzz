#!/usr/bin/env bash
#
# scripts/mvp-gate.sh — every end-to-end journey the product has, one after another, with one verdict at the end.
#
# Each journey boots its own throwaway chain and/or a real server and database, and plays a story against the real
# contracts (contracts/pot) and the real relay: the app in a real browser, the server's chain reader, the phone path with a
# passkey account. This runs them all so "does the whole product still work"
# is one command. The unit and browser suites run separately (`just ci`); this is the part that needs a chain or a real
# server.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, local chains, nothing else. Needs foundry and the built contracts (`just pot-build`);
# the journeys with a server also need Postgres and Redis (`just services`) and the built relay and command line.
#
# It only ever stops or deletes what it started. Each journey runs in its own process group, and when it ends (or this is
# interrupted) that group, and nothing else, is stopped. It never kills by name or by port: anything already running
# (another task's chain, a preview server) is left alone, and a journey that needs a port someone else holds is
# reported as blocked with who holds it. Anvil keeps scratch state on disk and leaves it behind when it is stopped; every
# anvil a journey starts is pointed at a directory this run made (`--cache-path`), and that directory is all that is
# removed. Nothing is ever deleted from anvil's shared default location: another run's state there is not ours to judge.
#
# Usage:  scripts/mvp-gate.sh [--pilot | --later] [--list] [journey ...]   (no journeys named: all of them)
#           --pilot  only the journeys the product's core depends on (the "Pilot" set below): run this green on the
#                    build you host before inviting anyone
#           --later  only the other journeys: the chain reader, the phone path
#           --list   print the journeys it would run, and run nothing
#           --outside print the journey scripts no set runs, each with the reason, and run nothing
#         A journey script (scripts/*-e2e.sh) in no set and with no reason is reported as a WARNING on standard error.
#         In CI: .github/workflows/mvp-gate.yml.
# Env:   LOG_DIR (default: a temp directory; each journey's full log is kept there)
#         JOURNEY_PORTS "journey:port ..." — ports a journey needs free before it starts (the shipped journeys all take free
#                    ports; scripts/test-mvp-gate.sh uses this with stand-ins)
#         KEEP_GATE_STATE=1 keeps the run's own scratch directory (its anvil state) instead of removing it
#         JOURNEY_DIR where the journey scripts are (default: scripts; scripts/test-mvp-gate.sh points it at stand-ins)

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
LOG_DIR="${LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG_DIR"
# Everything this run makes on disk besides its logs lives under one directory it created, and only that is removed.
STATE_ROOT="$(mktemp -d)"
ANVIL_CACHE="$STATE_ROOT/anvil-cache"
SHIM_DIR="$STATE_ROOT/bin"
mkdir -p "$ANVIL_CACHE" "$SHIM_DIR"
# Journeys start `anvil` by name. This stand-in sends its on-disk state to this run's own directory and then runs the real
# one, so the state is provably ours without searching for it afterwards.
REAL_ANVIL="$(PATH="${FOUNDRY_BIN:-}:$HOME/.foundry/bin:$PATH" command -v anvil 2>/dev/null || true)"
if [[ -n "$REAL_ANVIL" ]]; then
  cat >"$SHIM_DIR/anvil" <<SHIM
#!/usr/bin/env bash
exec "$REAL_ANVIL" --cache-path "$ANVIL_CACHE" "\$@"
SHIM
  chmod +x "$SHIM_DIR/anvil"
  export PATH="$SHIM_DIR:$PATH"
  # Several journeys put their own foundry directory first; keep this one ahead of it.
  export FOUNDRY_BIN="$SHIM_DIR${FOUNDRY_BIN:+:$FOUNDRY_BIN}"
fi

# Job control puts each journey in a process group of its own, so stopping "its processes" is stopping that group.
set -m
JOURNEY_PGID=""

# Stop the journey's whole process group (its chain, its server, its browser), and only that.
stop_group() {
  [[ -n "$JOURNEY_PGID" ]] || return 0
  kill -TERM -- "-$JOURNEY_PGID" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-$JOURNEY_PGID" 2>/dev/null || true
  JOURNEY_PGID=""
}

finish() {
  stop_group
  [[ "${KEEP_GATE_STATE:-}" == "1" ]] || rm -rf "$STATE_ROOT"
}
trap finish EXIT
trap 'exit 130' INT TERM

# Pilot: the product's core. The app against a real server and database with nothing mocked (Start, the week's update, a
# stranger joining from a project's link), and the whole join-and-leave loop in a real browser against a real chain, the
# real relay with its chain reader and the app built for that chain (a project from its start to a Take out, tasks and exit
# notes).
PILOT=(
  app-real-loop-e2e
  pot-full-loop
)
# Later: the loops that each prove one layer on its own. The contracts through `cast` (pot-chain-loop), the chain reader
# against the contracts' own views (chain-loop-pot), the app's money calls on the real contracts (pot-app-loop), the phone
# path with a passkey account (phone-loop, in Node; pot-app-phone-e2e, in a browser) and the server's query of work-check
# records (work-check-query-e2e).
LATER=(
  pot-chain-loop
  chain-loop-pot
  pot-app-loop
  phone-loop
  pot-app-phone-e2e
  work-check-query-e2e
)
# Journey scripts that are in neither set, each with the reason. A *-e2e.sh script in none of PILOT, LATER and this list
# is reported as a warning on every run, so a new journey cannot quietly read as tested. scripts/test-mvp-gate.sh fails
# while any script in scripts/ has no home.
OUTSIDE=()
ALL=("${PILOT[@]}" "${LATER[@]}")

# Every *-e2e.sh journey script in the journey folder that is in no set and has no reason above, one per line.
unhomed_journeys() {
  local path name known entry
  for path in "${JOURNEY_DIR:-scripts}"/*-e2e.sh; do
    [[ -e "$path" ]] || continue
    name="$(basename "$path" .sh)"
    known=0
    for entry in "${ALL[@]}" ${OUTSIDE[@]+"${OUTSIDE[@]%%|*}"}; do
      [[ "$entry" == "$name" ]] && { known=1; break; }
    done
    [[ "$known" == "1" ]] || printf '%s\n' "$name"
  done
}

SET=("${ALL[@]}")
LIST_ONLY=0
LIST_OUTSIDE=0
JOURNEYS=()
for arg in "$@"; do
  case "$arg" in
    --pilot) SET=("${PILOT[@]}") ;;
    --later) SET=("${LATER[@]}") ;;
    --list) LIST_ONLY=1 ;;
    --outside) LIST_OUTSIDE=1 ;;
    -*) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
    *) JOURNEYS+=("$arg") ;;
  esac
done
# On standard error, so `--list` stays a plain list of journeys.
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  printf '\033[33mWARNING\033[0m %s.sh is in no gate set and has no reason in OUTSIDE (scripts/mvp-gate.sh): nothing runs it\n' \
    "$name" >&2
done < <(unhomed_journeys)
if [[ "$LIST_OUTSIDE" == "1" ]]; then
  for entry in ${OUTSIDE[@]+"${OUTSIDE[@]}"}; do printf '%s: %s\n' "${entry%%|*}" "${entry#*|}"; done
  exit 0
fi
[[ ${#JOURNEYS[@]} -eq 0 ]] && JOURNEYS=("${SET[@]}")
if [[ "$LIST_ONLY" == "1" ]]; then
  printf '%s\n' "${JOURNEYS[@]}"
  exit 0
fi

# The ports a journey needs free before it starts, from JOURNEY_PORTS ("journey:port ..."). The shipped journeys each take
# free ports of their own, so none is named by default.
journey_ports() {
  local entry
  for entry in ${JOURNEY_PORTS:-}; do
    [[ "${entry%%:*}" == "$1" ]] && echo "${entry#*:}"
  done
  return 0
}

# Who holds a port, as "pid command", or nothing when it is free.
port_holder() {
  local pid
  pid="$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1)"
  [[ -n "$pid" ]] && printf '%s %s' "$pid" "$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-100)"
}

passed=()
failed=()
blocked=()
skipped=()
for journey in "${JOURNEYS[@]}"; do
  script="${JOURNEY_DIR:-scripts}/${journey}.sh"
  [[ -x "$script" ]] || { printf '\033[31mno such journey: %s\033[0m\n' "$journey" >&2; failed+=("$journey (missing)"); continue; }
  printf '\033[36m=== %s\033[0m\n' "$journey"
  # A server already on a port the journey needs is not ours to stop: it may be another task's, and it would serve an old
  # build, so the journey is not run against it.
  holder=""
  for port in $(journey_ports "$journey"); do
    holder="$(port_holder "$port")"
    [[ -n "$holder" ]] && break
  done
  if [[ -n "$holder" ]]; then
    blocked+=("$journey")
    printf '\033[33mBLOCKED\033[0m %s: port %s is held by %s\n' "$journey" "$port" "$holder"
    printf '  Stop it yourself (kill %s) or run this journey when it is free. This runner does not stop other processes.\n' "${holder%% *}"
    continue
  fi
  "$script" >"$LOG_DIR/$journey.log" 2>&1 &
  JOURNEY_PGID=$!
  wait "$JOURNEY_PGID"
  status=$?
  # Whatever the journey left behind (a chain, a preview server) goes with its group, and the chain's on-disk state is this
  # run's own directory, cleared before the next journey so a long run cannot fill the disk.
  stop_group
  find "$ANVIL_CACHE" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  if [[ $status -eq 0 ]]; then
    passed+=("$journey")
    printf '\033[32mPASS\033[0m %s\n' "$journey"
  else
    failed+=("$journey")
    printf '\033[31mFAIL\033[0m %s (log: %s/%s.log)\n' "$journey" "$LOG_DIR" "$journey"
    grep -E "✘|FAILED step|\\[.*\\] FAIL:|Error:" "$LOG_DIR/$journey.log" | sed 's/\x1b\[[0-9;]*m//g' | head -4
  fi
done

printf '\n%d passed, %d failed, %d blocked, %d skipped\n' "${#passed[@]}" "${#failed[@]}" "${#blocked[@]}" "${#skipped[@]}"
for s in "${skipped[@]}"; do printf '  skipped: %s\n' "$s"; done
for b in "${blocked[@]}"; do printf '  BLOCKED: %s (a port it needs is held by another process)\n' "$b"; done
for f in "${failed[@]}"; do printf '  FAILED:  %s\n' "$f"; done
printf 'logs: %s\n' "$LOG_DIR"
[[ ${#failed[@]} -eq 0 && ${#blocked[@]} -eq 0 ]]
