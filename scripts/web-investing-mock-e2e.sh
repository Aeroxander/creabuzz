#!/usr/bin/env bash
#
# scripts/web-investing-mock-e2e.sh — investing in the browser: web/tests/e2e/investing.spec.ts against two builds of the web
# app and a stand-in chain node (tests/helpers/fake-backing-chain.ts), with a stubbed server.
#
#   on   the hosted image's shape (VITE_CONTRIBUTOR_ONLY=1) with VITE_INVESTING=1 and the pool factory, the pool kit and the
#        backing token named: every state of the Backing block, the steps it sends, the scorecard, phones, accessibility.
#   off  the same addresses and no VITE_INVESTING: the block must not render and the chain must not be asked about a pool.
#        (The settings check refuses this half-set build at deploy time; here it is built with vite directly, because it is
#        the one build that proves the switch alone is what turns investing on.)
#
# Each build goes to a folder of its own and is served on a port of its own (E2E_DIST / E2E_PORT in web/playwright.config.ts),
# so it never replaces web/dist and never needs :4173. No chain, server or database is needed: the node and the server are
# stand-ins. The same pages against the real contracts are `scripts/web-backing-e2e.sh`.
#
# Usage:  scripts/web-investing-mock-e2e.sh [playwright args, e.g. -g "scorecard"]
# Env:    INVESTING_ON_PORT (default 4187), INVESTING_OFF_PORT (default 4188), PW_CHROMIUM_PATH (a Chromium to use),
#         INVESTING_WORK (a folder to keep the two builds in, and reuse with SKIP_BUILD=1; default: a temp folder removed
#         afterwards), ONLY=on|off (run one of the two builds),
#         SPEC=tests/e2e/investing-shots.spec.ts with INVEST_SHOTS=<folder> (screenshots of each state, for looking at)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ON_PORT="${INVESTING_ON_PORT:-4187}"
OFF_PORT="${INVESTING_OFF_PORT:-4188}"
step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

for port in "$ON_PORT" "$OFF_PORT"; do
  if lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port $port is already serving something: it would be tested instead of this build (lsof -ti tcp:$port)"
  fi
done

if [[ -n "${INVESTING_WORK:-}" ]]; then
  WORK="$INVESTING_WORK"
  mkdir -p "$WORK"
else
  [[ "${SKIP_BUILD:-}" == "1" ]] && fail "SKIP_BUILD=1 needs INVESTING_WORK, the folder holding the builds to reuse"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
fi

# The addresses the spec's stand-in node answers for (tests/helpers/fake-backing-chain.ts, FIXTURE).
FACTORY="0x$(printf 'fa%.0s' {1..20})"
KIT="0x$(printf 'b2%.0s' {1..20})"
TOKEN="0x$(printf 'c0%.0s' {1..20})"

cd "$REPO_ROOT/web"
build() { # build <folder> [extra env...]
  local out="$1"
  shift
  env -i PATH="$PATH" HOME="$HOME" VITE_CONTRIBUTOR_ONLY=1 VITE_LAUNCHPAD_CHAIN_ID=31337 \
    VITE_BACKING_POOL_FACTORY="{\"31337\":\"${FACTORY}\"}" VITE_CONTRIBUTOR_KIT_V3="{\"31337\":\"${KIT}\"}" \
    VITE_BACKING_QUOTE_TOKEN="{\"31337\":\"${TOKEN}\"}" VITE_TEST_QUOTE_TOKENS="{\"31337\":\"${TOKEN}\"}" "$@" \
    node_modules/.bin/vite build --outDir "$out" --emptyOutDir >"$out.log" 2>&1 || { tail -20 "$out.log"; fail "web build failed"; }
}

ONLY="${ONLY:-}"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  if [[ "$ONLY" != "off" ]]; then
    step "building the switch-on build (contributor-only, as the hosted image builds it)"
    build "$WORK/on" VITE_INVESTING=1
  fi
  if [[ "$ONLY" != "on" ]]; then
    step "building the build that names the addresses and leaves the switch unset"
    build "$WORK/off"
  fi
fi

status=0
if [[ "$ONLY" != "off" ]]; then
  [[ -f "$WORK/on/index.html" ]] || fail "no build in $WORK/on"
  step "running the spec against the switch-on build on :$ON_PORT"
  E2E_INVESTING_BUILD=on E2E_DIST="$WORK/on" E2E_PORT="$ON_PORT" \
    node_modules/.bin/playwright test "${SPEC:-tests/e2e/investing.spec.ts}" --project=investing --reporter=list "$@" || status=$?
fi
if [[ "$ONLY" != "on" ]]; then
  [[ -f "$WORK/off/index.html" ]] || fail "no build in $WORK/off"
  step "running the spec against the switch-off build on :$OFF_PORT"
  E2E_INVESTING_BUILD=off E2E_DIST="$WORK/off" E2E_PORT="$OFF_PORT" \
    node_modules/.bin/playwright test "${SPEC:-tests/e2e/investing.spec.ts}" --project=investing --reporter=list "$@" || status=$?
fi
exit "$status"
