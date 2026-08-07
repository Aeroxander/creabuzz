#!/usr/bin/env bash
# =============================================================================
# siwe-stop.sh — Stop everything siwe-demo.sh started
# =============================================================================
# Usage: ./scripts/siwe-stop.sh [--docker]
#
# 1. Stops the desktop app (tauri dev / vite / buzz-desktop)
# 2. Stops the relay (buzz-relay)
# 3. With --docker, also stops the Docker services (postgres, redis, minio)
#
# Without --docker the Docker volumes are kept so the next siwe-demo.sh run
# reuses the same Postgres data (registered EVM identities persist).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()     { echo -e "${BLUE}[siwe-stop]${NC} $*"; }
success() { echo -e "${GREEN}[siwe-stop]${NC} $*"; }
warn()    { echo -e "${YELLOW}[siwe-stop]${NC} $*"; }
error()   { echo -e "${RED}[siwe-stop]${NC} $*" >&2; }

STOP_DOCKER=0
if [[ "${1:-}" == "--docker" ]]; then STOP_DOCKER=1; fi

# ---- 1. Stop the desktop app (tauri dev / vite / buzz-desktop) --------------

# Kill tauri dev first so it tears down the vite server it owns, then any
# stragglers. Match against this worktree's paths to avoid killing unrelated
# vite instances in other apps.
DESKTOP_DIR="${REPO_ROOT}/desktop"

log "Stopping the desktop app (tauri dev / vite / buzz-desktop)..."
pkill -f "tauri dev --config" 2>/dev/null || true
pkill -f "${DESKTOP_DIR}/node_modules/.bin/vite" 2>/dev/null || true
pkill -f "${DESKTOP_DIR}/.*/vite" 2>/dev/null || true
pkill -f "buzz-desktop" 2>/dev/null || true
sleep 2

if pgrep -f "${DESKTOP_DIR}.*vite" >/dev/null 2>&1 || pgrep -f "buzz-desktop" >/dev/null 2>&1; then
  warn "Some desktop processes still running; sending SIGKILL..."
  pkill -9 -f "${DESKTOP_DIR}.*vite" 2>/dev/null || true
  pkill -9 -f "buzz-desktop" 2>/dev/null || true
fi
success "Desktop app stopped"

# ---- 2. Stop the relay ------------------------------------------------------

log "Stopping the relay (buzz-relay)..."
if pgrep -f "target/debug/buzz-relay" >/dev/null 2>&1; then
  pkill -f "target/debug/buzz-relay" 2>/dev/null || true
  sleep 2
  if pgrep -f "target/debug/buzz-relay" >/dev/null 2>&1; then
    pkill -9 -f "target/debug/buzz-relay" 2>/dev/null || true
  fi
fi
success "Relay stopped"

# ---- 3. Stop Docker services (optional) --------------------------------------

if [[ ${STOP_DOCKER} -eq 1 ]]; then
  if command -v docker &>/dev/null && docker info >/dev/null 2>&1; then
    log "Stopping Docker services (postgres, redis, minio)..."
    (cd "${REPO_ROOT}" && docker compose stop postgres redis minio minio-init 2>&1 || true)
    success "Docker services stopped (volumes preserved)"
  else
    warn "Docker not running — skipping."
  fi
else
  log "Leaving Docker services running (use --docker to stop them)."
fi

cat <<'EOF'

─────────────────────────────────────────────────────────────────────────────
✅ Stopped: desktop app (tauri dev), relay (buzz-relay).
   Docker services: left running (data preserved).

To stop Docker too, run:  ./scripts/siwe-stop.sh --docker
To start everything again: ./scripts/siwe-demo.sh
─────────────────────────────────────────────────────────────────────────────
EOF
