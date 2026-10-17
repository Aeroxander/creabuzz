#!/usr/bin/env bash
#
# scripts/mvp-gate.sh — every end-to-end journey the launchpad has, one after another, with one verdict at the end.
#
# Each journey boots its own throwaway chain (and, for the economy one, a real server and database), builds the web app
# against it, and plays a story in real browsers: a founder, contributors, reviewers and a backer. This runs them all so
# "does the whole product still work" is one command. The browser, contract and unit suites run separately (`just ci`);
# this is the part that needs a chain.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, local chains, nothing else. Needs foundry; the economy journey also needs
# Postgres and Redis (`just services`). The Sepolia-fork journey forks a public Sepolia node (SEPOLIA_RPC_URL to choose
# one); a public node can drop a read, so a single failure there is worth one rerun before it is called a bug.
#
# It only ever stops or deletes what it started. Each journey runs in its own process group, and when it ends (or this is
# interrupted) that group, and nothing else, is stopped. It never kills by name or by port: anything already running
# (another task's chain, a preview server on :4173) is left alone, and a journey that needs a port someone else holds is
# reported as blocked with who holds it. Anvil keeps scratch state on disk and leaves it behind when it is stopped; every
# anvil a journey starts is pointed at a directory this run made (`--cache-path`), and that directory is all that is
# removed. Nothing is ever deleted from anvil's shared default location: another run's state there is not ours to judge.
#
# Usage:  scripts/mvp-gate.sh [journey ...]   (no arguments: all of them)
# Env:    LOG_DIR (default: a temp directory; each journey's full log is kept there)
#         KEEP_GATE_STATE=1 keeps the run's own scratch directory (its anvil state) instead of removing it
#         JOURNEY_DIR where the journey scripts are (default: scripts; scripts/test-mvp-gate.sh points it at stand-ins)

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
LOG_DIR="${LOG_DIR:-$(mktemp -d)}"
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

ALL=(
  cli-no-raise-e2e
  cli-milestone-e2e
  web-record-e2e
  web-milestone-e2e
  web-work-e2e
  web-paid-work-e2e
  web-dao-launch-e2e
  web-dao-journey-e2e
  web-economy-e2e
  web-sepolia-fork-e2e
)
JOURNEYS=("$@")
[[ ${#JOURNEYS[@]} -eq 0 ]] && JOURNEYS=("${ALL[@]}")

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
  # The browser specs of several journeys are served from :4173. A server already there is not ours to stop: it may be
  # another task's, and it would serve an old build, so the journey is not run against it.
  holder="$(port_holder 4173)"
  if [[ -n "$holder" ]]; then
    blocked+=("$journey")
    printf '\033[33mBLOCKED\033[0m %s: port 4173 is held by %s\n' "$journey" "$holder"
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
