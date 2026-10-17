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
# It only ever stops what it started. Each journey runs in its own process group, and when it ends (or this is
# interrupted) that group, and nothing else, is stopped. It never kills by name or by port: anything already running
# (another task's chain, a preview server on :4173) is left alone, and a journey that needs a port someone else holds is
# reported as blocked with who holds it. Anvil leaves scratch state under ~/.foundry/anvil/tmp when it is stopped; only
# state created during this run is removed, and none at all while any anvil this run did not start is still running.
#
# Usage:  scripts/mvp-gate.sh [journey ...]   (no arguments: all of them)
# Env:    LOG_DIR (default: a temp directory; each journey's full log is kept there)
#         KEEP_ANVIL_STATE=1 leaves the scratch state alone
#         JOURNEY_DIR where the journey scripts are (default: scripts; scripts/test-mvp-gate.sh points it at stand-ins)
#         ANVIL_TMP where anvil keeps scratch state (default: ~/.foundry/anvil/tmp)

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
LOG_DIR="${LOG_DIR:-$(mktemp -d)}"
ANVIL_TMP="${ANVIL_TMP:-$HOME/.foundry/anvil/tmp}"
# What was already there, and when this run began: only state that appeared after this point can be this run's.
MARKER="$(mktemp)"
BEFORE="$(mktemp)"
ls -1 "$ANVIL_TMP" 2>/dev/null | sort >"$BEFORE" || true

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

# Anvil processes that are running now. By the time this is called every group this run started has been stopped, so any
# that remain belong to someone else.
foreign_anvils() { pgrep -x anvil 2>/dev/null || true; }

remove_own_anvil_state() {
  [[ "${KEEP_ANVIL_STATE:-}" == "1" ]] && return 0
  [[ -d "$ANVIL_TMP" ]] || return 0
  local others
  others="$(foreign_anvils)"
  if [[ -n "$others" ]]; then
    printf 'left anvil scratch state in place: anvil is still running that this run did not start (pid %s)\n' \
      "$(echo "$others" | tr '\n' ' ')" >&2
    return 0
  fi
  local dir
  find "$ANVIL_TMP" -maxdepth 1 -name 'anvil-state-*' -newer "$MARKER" 2>/dev/null | while read -r dir; do
    # Not there when this run began: it was made by something that ran since.
    grep -qxF "$(basename "$dir")" "$BEFORE" && continue
    rm -rf "$dir"
  done
}

finish() {
  stop_group
  remove_own_anvil_state
  rm -f "$MARKER" "$BEFORE"
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
  # Whatever the journey left behind (a chain, a preview server) goes with its group.
  stop_group
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
