#!/usr/bin/env bash
#
# scripts/web-markets-e2e.sh — the Markets page WITH prices, in the browser.
#
# The price service's address is baked into the web build, so this builds the app pointed at a stand-in address and runs
# web/tests/e2e/markets-prices.spec.ts, which answers that address itself with real-shaped pool and candle data. No chain,
# no database and no download: it checks what the page does with prices (the pool's orientation, the move over the day,
# the volume, the order, "not traded yet"), not the price service itself (that is `scripts/market-index-e2e.sh`).
#
# It leaves a build pointed at the stand-in address in web/dist: run `pnpm build` again before the standard browser suite.
#
# Usage:  scripts/web-markets-e2e.sh [playwright args]

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/web"
step() { printf '\033[36m[web-markets]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[web-markets] %s\033[0m\n' "$*" >&2; exit 1; }

SERVICE="http://127.0.0.1:42070"
if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi
step "building the web app, pointed at $SERVICE"
VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="0x2222222222222222222222222222222222222222" VITE_PRICE_INDEXER_URL="$SERVICE" \
  node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
step "running the browser spec"
E2E_PRICE_SERVICE="$SERVICE" \
  node_modules/.bin/playwright test tests/e2e/markets-prices.spec.ts --project=smoke --reporter=list "$@"
step "done; run pnpm build before the standard suite"
