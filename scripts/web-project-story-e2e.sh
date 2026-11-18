#!/usr/bin/env bash
# The v5 project-story and explicit proof reads against signed fixtures and a stubbed node.
# This is UI coverage, not proof of a live-chain workflow. No wallet funds or public writes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${STORY_PORT:-4196}"
SHOTS="${STORY_SHOTS:-$ROOT/test-results/v5-project-story}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/creaton-story.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
if lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Blocked: port %s is already serving another build. Nothing was stopped.\n' "$PORT" >&2
  exit 1
fi
cd "$ROOT/web"
mkdir -p "$SHOTS"
# No inherited deployment configuration or credentials: this build uses only local stub fixtures.
env -i PATH="$PATH" HOME="$HOME" VITE_LAUNCHPAD_CHAIN_ID=31337 \
  VITE_CHAIN_RPC_URL=http://127.0.0.1:8545 \
  node_modules/.bin/vite build --outDir "$WORK/dist" --emptyOutDir
E2E_STUB_RPC=1 E2E_PORT="$PORT" E2E_DIST="$WORK/dist" E2E_SHOTS="$SHOTS" \
  node_modules/.bin/playwright test tests/e2e/v5-project-story.spec.ts --project=smoke --reporter=list "$@"
printf 'Screenshots: %s\n' "$SHOTS"
