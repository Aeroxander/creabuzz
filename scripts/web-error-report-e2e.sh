#!/usr/bin/env bash
#
# scripts/web-error-report-e2e.sh — error reporting, in a real browser.
#
# The collector's address is baked into the web build, so this builds the app pointed at a stand-in address and runs
# web/tests/e2e/error-report.spec.ts, which answers that address itself: a real uncaught error and a real unhandled rejection
# must arrive as small scrubbed notes (path only, no keys, no cookies), and a collector that is down must change nothing.
# No chain, no database, no download.
#
# It leaves a build pointed at the stand-in address in web/dist: run `pnpm build` again before the standard browser suite.
#
# Usage:  scripts/web-error-report-e2e.sh [playwright args]

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/web"
step() { printf '\033[36m[web-error-report]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[web-error-report] %s\033[0m\n' "$*" >&2; exit 1; }

COLLECTOR="http://127.0.0.1:42071/errors"
if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi
step "building the web app, pointed at $COLLECTOR"
VITE_ERROR_REPORT_URL="$COLLECTOR" VITE_APP_RELEASE=e2e node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
step "running the browser spec"
E2E_ERROR_COLLECTOR="$COLLECTOR" \
  node_modules/.bin/playwright test tests/e2e/error-report.spec.ts --project=smoke --reporter=list "$@"
step "done; run pnpm build before the standard suite"
