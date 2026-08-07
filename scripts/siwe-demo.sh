#!/usr/bin/env bash
# =============================================================================
# siwe-demo.sh — Boot the full creabuzz SIWE stack and launch the desktop app
# =============================================================================
# Usage: ./scripts/siwe-demo.sh
#
# 1. Starts Docker services (postgres, redis, minio)
# 2. Builds the relay if needed, starts it with SIWE + auto-migrate enabled
# 3. Installs desktop deps + sidecar stubs, derives the dev config
# 4. Launches the desktop app via `tauri dev` (foreground; Ctrl-C to stop)
#
# Requires: Docker Desktop running, cmake (for the desktop build).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()     { echo -e "${BLUE}[siwe-demo]${NC} $*"; }
success() { echo -e "${GREEN}[siwe-demo]${NC} $*"; }
warn()    { echo -e "${YELLOW}[siwe-demo]${NC} $*"; }
error()   { echo -e "${RED}[siwe-demo]${NC} $*" >&2; }

# ---- Preflight --------------------------------------------------------------

if ! command -v docker &>/dev/null; then
  error "Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
  exit 1
fi

if ! docker info &>/dev/null; then
  error "Docker daemon is not running. Start Docker Desktop and try again."
  exit 1
fi

cd "${REPO_ROOT}"

# ---- Load .env --------------------------------------------------------------

if [[ -f ".env" ]]; then
  log "Loading .env..."
  set -o allexport
  # shellcheck disable=SC1091
  source .env
  set +o allexport
else
  warn "No .env found — copying .env.example. Review SIWE settings before continuing."
  cp .env.example .env
  set -o allexport
  # shellcheck disable=SC1091
  source .env
  set +o allexport
fi

# SIWE must be on for the demo.
export BUZZ_EVM_AUTH="${BUZZ_EVM_AUTH:-true}"
# The relay skips migrations unless auto-migrate is on; SIWE needs 0027/0028.
export BUZZ_AUTO_MIGRATE="${BUZZ_AUTO_MIGRATE:-true}"

# ---- 1. Start services ------------------------------------------------------

log "Starting Docker services and waiting for health..."
docker compose up -d postgres redis minio minio-init

attempts=0
max_attempts=20
until docker exec buzz-postgres pg_isready -h localhost -p 5432 -U buzz -d buzz >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [[ ${attempts} -ge ${max_attempts} ]]; then
    error "Postgres did not accept connections after ${max_attempts} attempts"
    exit 1
  fi
  log "Postgres not ready yet, retrying in 2s... (${attempts}/${max_attempts})"
  sleep 2
done
success "Docker services healthy (postgres, redis, minio)"

# ---- 2. Build + start the relay ---------------------------------------------

RELAY_BIN="${REPO_ROOT}/target/debug/buzz-relay"
if [[ ! -x "${RELAY_BIN}" ]]; then
  log "Building relay (first run — this takes a while)..."
  if [[ -x "${REPO_ROOT}/bin/cargo" ]]; then
    "${REPO_ROOT}/bin/cargo" build -p buzz-relay
  else
    cargo build -p buzz-relay
  fi
  success "Relay built"
fi

# Stop any stale relay so a fresh one binds the ports.
if pgrep -f "target/debug/buzz-relay" >/dev/null 2>&1; then
  log "Stopping existing relay process..."
  pkill -f "target/debug/buzz-relay" || true
  sleep 3
fi

log "Starting relay on ws://localhost:3000 with SIWE enabled..."
# Launch in a fresh session so the process survives the invoking shell exiting
# (a plain `nohup … &` stays in the caller's process group and gets SIGTERM'd
# when that shell/agent finishes). start_new_session = macOS-safe `setsid`.
python3 - <<PYEOF
import os, subprocess
with open('/tmp/buzz-relay.log', 'wb') as log:
    proc = subprocess.Popen(
        ['${RELAY_BIN}'],
        stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        env=dict(os.environ), start_new_session=True,
    )
open('/tmp/buzz-relay.pid', 'w').write(str(proc.pid))
print('relay pid', proc.pid)
PYEOF

attempts=0
until curl -sf "http://localhost:3000/auth/siwe/nonce" -H "Host: localhost:3000" >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [[ ${attempts} -ge ${max_attempts} ]]; then
    error "Relay did not come up on :3000. Check /tmp/buzz-relay.log"
    exit 1
  fi
  log "Waiting for relay... (${attempts}/${max_attempts})"
  sleep 2
done
NONCE_RESPONSE="$(curl -sf "http://localhost:3000/auth/siwe/nonce" -H "Host: localhost:3000" || true)"
success "Relay is up — SIWE nonce endpoint responding: ${NONCE_RESPONSE}"

# ---- 3. Prepare the desktop app launch ---------------------------------------

DESKTOP_DIR="${REPO_ROOT}/desktop"

# Ensure frontend deps are present (needed for the Vite dev server + tauri CLI).
if [[ ! -d "${DESKTOP_DIR}/node_modules" ]]; then
  log "Installing desktop dependencies (first run — takes a while)..."
  if ! command -v cmake &>/dev/null; then
    warn "cmake not found — installing via Homebrew (needed for the desktop build)."
    brew install cmake
  fi
  # Prefer hermit pnpm; else corepack pnpm on a recent Node.
  if [[ -x "${REPO_ROOT}/bin/pnpm" ]]; then
    (cd "${DESKTOP_DIR}" && PATH="${REPO_ROOT}/bin:$PATH" pnpm install)
  elif command -v corepack &>/dev/null; then
    for NODE in "$HOME/.nvm/versions/node/v24.12.0/bin" "$HOME/.nvm/versions/node/v24.14.0/bin" /opt/homebrew/opt/node/bin; do
      if [[ -x "${NODE}/node" ]]; then export PATH="${NODE}:$PATH"; break; fi
    done
    (cd "${DESKTOP_DIR}" && CI=true corepack pnpm install)
  else
    (cd "${DESKTOP_DIR}" && pnpm install)
  fi
  success "Desktop dependencies installed"
fi

# Sidecar stubs so tauri dev compiles without the real binaries.
TARGET="$(rustc -vV 2>/dev/null | sed -n 's|host: ||p')"
if [[ -z "${TARGET}" ]]; then TARGET="aarch64-apple-darwin"; fi
mkdir -p "${DESKTOP_DIR}/src-tauri/binaries"
for bin in buzz-acp buzz-agent buzz-dev-mcp git-credential-nostr buzz buzz-backend-kubernetes; do
  touch "${DESKTOP_DIR}/src-tauri/binaries/${bin}-${TARGET}"
done

# Derive the dev config (Vite port, relay URL, tauri dev config). This is the
# canonical pipeline `just dev` uses — it points the webview at the Vite dev
# server so the frontend actually loads (running the bare debug binary serves
# no frontend and renders a blank/black window).
# shellcheck disable=SC1091
source "${REPO_ROOT}/scripts/instance-env.sh"

# ---- 4. Print next steps, then launch the app (foreground) -------------------

cat <<'EOF'

─────────────────────────────────────────────────────────────────────────────
✅ Stack is up (relay on ws://localhost:3000, SIWE enabled).

Next, the desktop app opens. In first-run onboarding:
  1. Click "Sign in with Ethereum"
  2. Enter the community URL: ws://localhost:3000
  3. The app generates an EVM key (stored in your macOS Keychain), derives the
     ZeroDev account, signs the SIWE message, and provisions membership.

Verify registration (in another terminal):
  docker exec buzz-postgres psql -U buzz -d buzz -c \
    "SELECT pubkey, encode(evm_address,'hex') AS evm FROM evm_identities ORDER BY created_at DESC LIMIT 3;"

Relay log:  /tmp/buzz-relay.log
Press Ctrl-C in this terminal to stop the desktop app (the relay keeps running).
─────────────────────────────────────────────────────────────────────────────
EOF

# Launch via tauri dev so the webview is served the real frontend. This runs in
# the foreground (blocking) — Ctrl-C stops the app.
log "Launching the desktop app via tauri dev (Vite port ${BUZZ_VITE_PORT}, relay ${BUZZ_RELAY_URL})..."
cd "${DESKTOP_DIR}"

if [[ -x "${REPO_ROOT}/bin/pnpm" ]]; then
  PATH="${REPO_ROOT}/bin:$PATH" pnpm exec tauri dev --config "$BUZZ_TAURI_CONFIG"
elif command -v corepack &>/dev/null; then
  for NODE in "$HOME/.nvm/versions/node/v24.12.0/bin" "$HOME/.nvm/versions/node/v24.14.0/bin" /opt/homebrew/opt/node/bin; do
    if [[ -x "${NODE}/node" ]]; then export PATH="${NODE}:$PATH"; break; fi
  done
  corepack pnpm exec tauri dev --config "$BUZZ_TAURI_CONFIG"
else
  pnpm exec tauri dev --config "$BUZZ_TAURI_CONFIG"
fi
