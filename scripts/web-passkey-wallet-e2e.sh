#!/usr/bin/env bash
#
# ⚠️  NOT IN ANY GATE (2026-10-31, docs/v3-review/DEPRECATION-2026-10-31.md): scripts/mvp-gate.sh does not run it and
# nothing runs it on a schedule, so it may have broken since it was last changed. Run it before relying on it.
# Linking a passkey account as a payment wallet; web-passkey-contributor-e2e (in the gate) covers passkey accounts on contributor screens.
#
# scripts/web-passkey-wallet-e2e.sh — linking a PASSKEY account as a payment wallet, in a real browser with a virtual
# passkey, against a stand-in chain node that judges the account's signature the way the deployed Kernel 0.3.3 and its
# passkey validator do. No real chain, no keys, nothing spent.
#
# The build needs a chain configured, so this builds the web app with one, runs web/tests/e2e/passkey-wallet.spec.ts, and
# then rebuilds the default build, because every other browser test expects it.
#
# The real account's answer (a real deployed Kernel 0.3.3 on Sepolia) is checked, read-only, by
# `node scripts/kernel-1271-live-check.mjs`.
#
# Usage:  scripts/web-passkey-wallet-e2e.sh [playwright args]

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/web"
step() { printf '\033[36m[web-passkey-wallet]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[web-passkey-wallet] %s\033[0m\n' "$*" >&2; exit 1; }

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi

restore() {
  step "rebuilding the default build"
  node_modules/.bin/vite build >/dev/null 2>&1 || printf '\033[31mthe default rebuild failed: run pnpm build\033[0m\n' >&2
}
trap restore EXIT

step "building the web app with a chain configured"
VITE_ZERODEV_CHAIN_ID=31337 VITE_CHAIN_RPC_URL=http://127.0.0.1:8545 node_modules/.bin/vite build >/dev/null 2>&1 \
  || fail "web build failed"

step "running the browser spec"
E2E_PASSKEY_WALLET=1 node_modules/.bin/playwright test tests/e2e/passkey-wallet.spec.ts --project=passkey-wallet --reporter=list "$@"
