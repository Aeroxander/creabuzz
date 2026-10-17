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
# Usage:  scripts/mvp-gate.sh [journey ...]   (no arguments: all of them)
# Env:    LOG_DIR (default: a temp directory; each journey's full log is kept there)

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
LOG_DIR="${LOG_DIR:-$(mktemp -d)}"
# Every anvil leaves its state under ~/.foundry/anvil/tmp when it is stopped; the ones this run made are removed at the end
# so a long gate cannot slowly fill the disk (nothing older than this marker is touched).
MARKER="$(mktemp)"
trap 'find "$HOME/.foundry/anvil/tmp" -maxdepth 1 -name "anvil-state-*" -newer "$MARKER" -exec rm -rf {} + 2>/dev/null; rm -f "$MARKER"' EXIT

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

passed=()
failed=()
skipped=()
for journey in "${JOURNEYS[@]}"; do
  script="scripts/${journey}.sh"
  [[ -x "$script" ]] || { printf '\033[31mno such journey: %s\033[0m\n' "$journey" >&2; failed+=("$journey (missing)"); continue; }
  # A stale preview server or chain from an earlier journey would make this one run against the wrong build.
  pkill -f "anvil --fork-url" 2>/dev/null || true
  pkill -f "anvil --host 127.0.0.1 --port 18" 2>/dev/null || true
  lsof -ti tcp:4173 2>/dev/null | xargs kill 2>/dev/null || true
  printf '\033[36m=== %s\033[0m\n' "$journey"
  if "$script" >"$LOG_DIR/$journey.log" 2>&1; then
    passed+=("$journey")
    printf '\033[32mPASS\033[0m %s\n' "$journey"
  else
    failed+=("$journey")
    printf '\033[31mFAIL\033[0m %s (log: %s/%s.log)\n' "$journey" "$LOG_DIR" "$journey"
    grep -E "✘|FAILED step|\\[.*\\] FAIL:|Error:" "$LOG_DIR/$journey.log" | sed 's/\x1b\[[0-9;]*m//g' | head -4
  fi
done

printf '\n%d passed, %d failed, %d skipped\n' "${#passed[@]}" "${#failed[@]}" "${#skipped[@]}"
for s in "${skipped[@]}"; do printf '  skipped: %s\n' "$s"; done
for f in "${failed[@]}"; do printf '  FAILED:  %s\n' "$f"; done
printf 'logs: %s\n' "$LOG_DIR"
[[ ${#failed[@]} -eq 0 ]]
