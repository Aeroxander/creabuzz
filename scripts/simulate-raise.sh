#!/usr/bin/env bash
#
# scripts/simulate-raise.sh — run the agent-based raise simulation (scripts/simulate-raise.mjs) from one command.
#
# Activates the hermit toolchain, builds the contracts if their artifacts are missing or stale, and runs the simulation
# on its own throwaway anvil. Exit code 0 means zero invariant breaks; the report lands in target/simulate-raise/.
#
# ⚠️  DEV ONLY: a local anvil it boots and stops itself. Never a real network.
#
# Usage: scripts/simulate-raise.sh [--steps 3000] [--seed 7] [--agents 24] [--report path]
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${FOUNDRY_BIN:+${FOUNDRY_BIN}:}${HOME}/.foundry/bin:${PATH}"
for tool in forge anvil node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }
done
[[ -d packages/creaton-core/node_modules && -d web/node_modules ]] || { echo "run pnpm install first"; exit 2; }
# The simulation deploys from contracts/out (including the test-only six-decimal USDC); forge build is incremental.
(cd contracts && FOUNDRY_LINT_LINT_ON_BUILD=false forge build >/dev/null) || { echo "forge build failed"; exit 2; }
exec node scripts/simulate-raise.mjs "$@"
