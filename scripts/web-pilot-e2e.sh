#!/usr/bin/env bash
#
# scripts/web-pilot-e2e.sh — the pilot build in the browser: web/tests/e2e/pilot-build.spec.ts against the web app built
# the way the hosted image builds it (VITE_CONTRIBUTOR_ONLY=1), with a stubbed server and chain.
#
# The mocked suite runs the default build, which offers raises; this is the one browser check of what pilot members see.
# It builds into a folder of its own and serves it on a port of its own (E2E_DIST / E2E_PORT in web/playwright.config.ts),
# so it never replaces web/dist and never needs :4173: it can run beside the shared suite or a journey.
#
# No chain, server or database needed.
#
# Usage:  scripts/web-pilot-e2e.sh [playwright args]
# Env:    PILOT_PORT (default 4186), PILOT_DIST (default: a temp folder, removed afterwards; name one to keep the build),
#         SKIP_BUILD=1 (reuse PILOT_DIST as it is)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PILOT_PORT:-4186}"
step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

if [[ -n "${PILOT_DIST:-}" ]]; then
  DIST="$PILOT_DIST"
else
  [[ "${SKIP_BUILD:-}" == "1" ]] && fail "SKIP_BUILD=1 needs PILOT_DIST, the build to reuse"
  DIST="$(mktemp -d)"
  trap 'rm -rf "$DIST"' EXIT
fi

# A server already on the port would be reused by Playwright and serve some other build.
if lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port $PORT is already serving something: it would be tested instead of the pilot build (lsof -ti tcp:$PORT)"
fi

cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app as the hosted image does (VITE_CONTRIBUTOR_ONLY=1) into $DIST"
  env VITE_CONTRIBUTOR_ONLY=1 node_modules/.bin/vite build --outDir "$DIST" --emptyOutDir >"$DIST.build.log" 2>&1 \
    || { tail -20 "$DIST.build.log"; fail "web build failed"; }
  rm -f "$DIST.build.log"
fi
[[ -f "$DIST/index.html" ]] || fail "no build in $DIST"

step "running the pilot spec on :$PORT"
E2E_PILOT_BUILD=1 E2E_DIST="$DIST" E2E_PORT="$PORT" \
  node_modules/.bin/playwright test tests/e2e/pilot-build.spec.ts --project=pilot --reporter=list "$@"
