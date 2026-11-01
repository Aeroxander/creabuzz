#!/usr/bin/env bash
#
# scripts/mvp-gate.sh — every end-to-end journey the launchpad has, one after another, with one verdict at the end.
#
# Each journey boots its own throwaway chain (and, for the economy one, a real server and database), builds the web app
# against it, and plays a story in real browsers: a founder, contributors, reviewers and a backer. The social journey
# (web-social-hosted-e2e) needs no chain: it runs the social suite on a real server set up as the pilot server is
# (invite-only, contributor-only web app, the hosted request limits). This runs them all so "does the whole product still
# work" is one command. The browser, contract and unit suites run separately (`just ci`); this is the part that needs a
# chain or a real server.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, local chains, nothing else. Needs foundry; the economy and social journeys also
# need Postgres and Redis (`just services`). The Sepolia-fork journey forks a public Sepolia node (SEPOLIA_RPC_URL to choose
# one); a public node can drop a read, so a single failure there is worth one rerun before it is called a bug.
#
# It only ever stops or deletes what it started. Each journey runs in its own process group, and when it ends (or this is
# interrupted) that group, and nothing else, is stopped. It never kills by name or by port: anything already running
# (another task's chain, a preview server on :4173) is left alone, and a journey that needs a port someone else holds is
# reported as blocked with who holds it. Anvil keeps scratch state on disk and leaves it behind when it is stopped; every
# anvil a journey starts is pointed at a directory this run made (`--cache-path`), and that directory is all that is
# removed. Nothing is ever deleted from anvil's shared default location: another run's state there is not ours to judge.
#
# Usage:  scripts/mvp-gate.sh [--pilot | --later] [--list] [journey ...]   (no journeys named: all of them)
#           --pilot  only what the hosted contributor pilot depends on (the "Pilot" set below): run this green on the
#                    build you host before inviting anyone (docs/v3-review/PILOT-RUNBOOK.md, step 10)
#           --later  only the raise, milestone and optional-feature journeys, for after the pilot
#           --list   print the journeys it would run, and run nothing
#           --outside print the journey scripts no set runs, each with the reason, and run nothing
#         A journey script (scripts/*-e2e.sh) in no set and with no reason is reported as a WARNING on standard error.
#         In CI: .github/workflows/mvp-gate.yml (not pushed; docs/v3-review/MVP-GATE-CI.md).
# Env:   LOG_DIR (default: a temp directory; each journey's full log is kept there)
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

# Not covered here, so the pilot runbook's hand checks are the only ones (docs/v3-review/PILOT-RUNBOOK.md, "Before it"):
# a reviewer approving or objecting from a passkey account (the passkey journey's reviewers use a wallet), the passkey
# name link checked by a real invite-only server (that journey stubs the server), and the image's own build (journeys
# build the web app with vite directly; web/src/features/launchpad/lib/deploy-env-image.test.mjs keeps the image's
# settings in step with the build check). Error reports reaching a collector
# (web-error-report-e2e) and invite links (web-invite-only-e2e) are journeys here since 2026-10-31.
# Still hand tests (docs/v3-review/MVP-GATE-CI.md, "Not covered"): the passkey name link (kind 37017) checked by a real
# server (it needs a passkey account stack on a chain the server can reach; web-restricted-holder-e2e covers real-server
# passkey sign-up and sign-in again only), and "Your work" read from a real server (web-passkey-contributor-e2e opens it
# from the navigation and finds the awarded Shares, against a stubbed server).
#
# Pilot: what the hosted contributor pilot depends on. What a pilot member sees in the contributor-only build against a
# stubbed server (web-pilot-e2e: no raise, sale or AI-helper screens, and what replaced them), the social suite as the
# pilot server runs it, invite links (every pilot member joins by one), error reports reaching a collector, a contributor
# project from the command line and from pages, from passkey accounts as the hosted image is built, work reviewed and
# paid, and a holder who is muted or banned keeping their rights (web-restricted-holder-e2e, the tested fallback in
# docs/v3-review/HOLDER-ACCESS-MODEL.md). With --pilot, web-contributor-e2e runs in its contributor-only mode
# (PILOT_BUILD=1): the web app built as the hosted image builds it, with none of the optional features, so the pilot gate
# plays what the pilot ships. Every other run builds it with the optional features on (bounties, payouts, remixes, the
# court, CREATE).
PILOT=(
  web-pilot-e2e
  web-social-hosted-e2e
  web-invite-only-e2e
  web-error-report-e2e
  cli-no-raise-e2e
  web-contributor-e2e
  web-passkey-contributor-e2e
  web-work-e2e
  web-paid-work-e2e
  web-restricted-holder-e2e
)
# Later: raises, milestone locks, the optional features and what the pilot server does not offer. None of these is
# reachable in the hosted build or on the pilot server (D137): weekly rounds and money behind a post are test-network
# features, a community of your own (self-serve) is off on the pilot server, and the Shares transfer-validator journey is
# the LBAMM evaluation's (its lock-guard steps still run here, nightly).
LATER=(
  cli-milestone-e2e
  web-record-e2e
  web-milestone-e2e
  web-dao-launch-e2e
  web-challenge-e2e
  web-dao-journey-e2e
  web-economy-e2e
  web-sepolia-fork-e2e
  web-rounds-e2e
  web-post-bounty-e2e
  web-self-serve-e2e
  shares-erc20c-e2e
)
# Journey scripts that are in neither set, each with the reason. A *-e2e.sh script in none of PILOT, LATER and this list
# is reported as a warning on every run, so a new journey cannot quietly read as tested. scripts/test-mvp-gate.sh fails
# while any script in scripts/ has no home.
OUTSIDE=(
  "web-social-e2e|the social suite itself: the gate runs it as web-social-hosted-e2e (HOSTED=1, as the pilot server runs)"
  "web-decisions-e2e|raise-era (a launch-kit DAO); the contributor journeys open, vote and run decisions (DEPRECATION-2026-10-31.md #34)"
  "web-discussion-e2e|raise-era (a launch-kit DAO); a project's Discussion tab is covered by web/tests/e2e/feed.spec.ts (DEPRECATION-2026-10-31.md #34)"
  "web-passkey-wallet-e2e|a passkey account as a payment wallet against a stand-in chain; web-passkey-contributor-e2e covers passkey accounts on the pilot's screens (DEPRECATION-2026-10-31.md #34)"
)
ALL=("${PILOT[@]}" "${LATER[@]}")

# Every *-e2e.sh journey script in the journey folder that is in no set and has no reason above, one per line.
unhomed_journeys() {
  local path name known entry
  for path in "${JOURNEY_DIR:-scripts}"/*-e2e.sh; do
    [[ -e "$path" ]] || continue
    name="$(basename "$path" .sh)"
    known=0
    for entry in "${ALL[@]}" "${OUTSIDE[@]%%|*}"; do
      [[ "$entry" == "$name" ]] && { known=1; break; }
    done
    [[ "$known" == "1" ]] || printf '%s\n' "$name"
  done
}

SET=("${ALL[@]}")
PILOT_MODE=0
LIST_ONLY=0
LIST_OUTSIDE=0
JOURNEYS=()
for arg in "$@"; do
  case "$arg" in
    --pilot) SET=("${PILOT[@]}"); PILOT_MODE=1 ;;
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
  for entry in "${OUTSIDE[@]}"; do printf '%s: %s\n' "${entry%%|*}" "${entry#*|}"; done
  exit 0
fi
[[ ${#JOURNEYS[@]} -eq 0 ]] && JOURNEYS=("${SET[@]}")
if [[ "$LIST_ONLY" == "1" ]]; then
  printf '%s\n' "${JOURNEYS[@]}"
  exit 0
fi

# The ports a journey serves on, which must be free before it starts. The browser specs of most journeys are served from
# :4173; the social journey's server is on :3199, the address the real-server specs and their seed scripts use.
journey_ports() {
  case "$1" in
    web-social-hosted-e2e) echo 3199 ;;
    # A real server on a free port, and no preview server.
    web-invite-only-e2e | web-self-serve-e2e | web-restricted-holder-e2e) ;;
    # A chain and the command line only, no browser.
    shares-erc20c-e2e) ;;
    # The pilot build, from a folder of its own, against a stubbed server.
    web-pilot-e2e) echo 4186 ;;
    *) echo 4173 ;;
  esac
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
  # --pilot runs web-contributor-e2e in the contributor-only build the hosted pilot ships (PILOT_BUILD=1; its spec reads
  # E2E_PILOT_BUILD and plays only what that build offers). Any other run builds it with the optional features on,
  # whatever the caller's shell says. scripts/test-mvp-gate.sh checks both.
  pilot_build=()
  [[ "$journey" == "web-contributor-e2e" && "$PILOT_MODE" == "1" ]] && pilot_build=(PILOT_BUILD=1)
  env -u PILOT_BUILD ${pilot_build[@]+"${pilot_build[@]}"} "$script" >"$LOG_DIR/$journey.log" 2>&1 &
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
