#!/usr/bin/env bash
#
# scripts/web-challenge-e2e.sh — milestones that unlock unless holders object, from the WEB app against a REAL local
# chain, in real browsers.
#
# Boots its own dev chain on a throwaway port (the same `scripts/dev-chain.sh` a developer runs: Summoner + patched Majeur,
# the CCA factory, Permit2, the dev USDC and the DaoLaunchKit), builds the web app with that kit named, then runs
# web/tests/e2e/launchpad-challenge.spec.ts:
#   1. the founder launches a project whose milestones go to the holders (no panel to name);
#   2. two backers bid, the sale graduates, and they claim their Shares;
#   3. the founder publishes milestone one (evidence, bond, milestone); a backer objects and the backers hold it up, so it is
#      turned down and the bond is split; the founder publishes again with a longer window, nobody objects, and anyone
#      finishes it: the team's first part unlocks;
#   4. a backer objects once more inside the month, the backers uphold it, and what is still locked is burned.
# Every step is a button on the page and a transaction on the chain, and each is checked against the chain.
#
# ⚠️  DEV ONLY. Anvil dev keys (public), a local chain, nothing else.
#
# Requirements: foundry (forge, cast, anvil) on PATH, `~/.foundry/bin`, or in
# $FOUNDRY_BIN; node + web/node_modules; Chromium (set PW_CHROMIUM_PATH if the
# pinned Playwright wants a newer build than the machine has).
#
# Usage:  scripts/web-challenge-e2e.sh [playwright args, e.g. -g "reload"]
# Env:    ANVIL_PORT (default random high port), SKIP_BUILD=1 (reuse web/dist)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
for tool in forge cast anvil node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool (set FOUNDRY_BIN for foundry)"; exit 2; }
done

PORT="${ANVIL_PORT:-$((18000 + RANDOM % 1000))}"
RPC="http://127.0.0.1:${PORT}"
STATE="$(mktemp -d)"
DEPLOYMENTS="$REPO_ROOT/contracts/deployments"
BACKUP="$(mktemp -d)"
step() { printf '\033[36m[challenge-e2e]\033[0m %s\n' "$*"; }

# The dev chain rewrites the tracked deployment manifests (new transaction hashes
# every run). Put them back, so a test run leaves the working tree as it was.
cp -p "$DEPLOYMENTS"/*.json "$BACKUP"/ 2>/dev/null || true
# Stop the anvil this run started, and nothing else: the pid its own dev-chain recorded, and only while that pid is still an anvil
# on this run's port. Nothing is ever stopped because it happens to listen on a port (a stranger's node on a colliding port is not ours).
stop_own_anvil() {
  local pid
  pid="$(cat "$STATE/anvil.pid" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 0
  if ps -o command= -p "$pid" 2>/dev/null | grep -Eq "anvil.* --port[ =]${PORT}( |\$)"; then
    kill "$pid" 2>/dev/null || true
  fi
}
cleanup() {
  RPC_URL="$RPC" STATE_DIR="$STATE" ./scripts/dev-chain.sh down >/dev/null 2>&1 || true
  # `dev-chain.sh down` can leave the node running: stop the one this run started, by its recorded pid.
  stop_own_anvil
  for f in "$BACKUP"/*.json; do
    [[ -f "$f" ]] && cp -p "$f" "$DEPLOYMENTS/$(basename "$f")"
  done
  rm -rf "$STATE" "$BACKUP"
}
trap cleanup EXIT

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  echo "port 4173 is already serving something: a stale preview would run an old build."
  echo "Stop it (lsof -ti tcp:4173 | xargs kill) and run this again."
  exit 2
fi

step "booting a dev chain on ${RPC} (state in ${STATE})"
if ! RPC_URL="$RPC" STATE_DIR="$STATE" ./scripts/dev-chain.sh >"$STATE/dev-chain.out" 2>&1; then
  tail -60 "$STATE/dev-chain.out"
  echo "dev-chain failed"; exit 2
fi
manifest_role() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log((m.roles ?? []).find((r) => r.role === process.argv[2])?.address ?? "");
  ' "$1" "$2"
}
KIT="$(manifest_role "$DEPLOYMENTS/dao-launch-kit-31337.json" launch-kit)"
CURRENCY="$(manifest_role "$DEPLOYMENTS/dev-currency-31337.json" currency)"
[[ -n "$KIT" && -n "$CURRENCY" ]] || { echo "dev chain did not report a kit and a currency"; exit 2; }
step "kit ${KIT}  currency ${CURRENCY}"

cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  VITE_LOCAL_USDC="$CURRENCY" VITE_LAUNCHPAD_CHAIN_ID=31337 \
    VITE_DAO_LAUNCH_KITS="{\"31337\":\"${KIT}\"}" \
    node_modules/.bin/vite build >/dev/null 2>&1 || { echo "web build failed"; exit 2; }
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_CURRENCY="$CURRENCY" E2E_LAUNCH_KIT="$KIT" \
  node_modules/.bin/playwright test tests/e2e/launchpad-challenge.spec.ts --project=smoke --reporter=list "$@"
