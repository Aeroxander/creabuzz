#!/usr/bin/env bash
# =============================================================================
# siwe-demo.sh — Boot the full creabuzz SIWE stack and launch the desktop app
# =============================================================================
# Usage: ./scripts/siwe-demo.sh
#
# 1. Starts Docker services (postgres, redis, minio)
# 2. Builds the relay if needed, starts it with SIWE + auto-migrate enabled
# 3. Builds the desktop app if needed (frontend + Tauri binary)
# 4. Launches the desktop app
# 5. Prints how to verify SIWE registration
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

# ---- 3. Build the desktop app -----------------------------------------------

DESKTOP_DIR="${REPO_ROOT}/desktop"
DESKTOP_BIN="${DESKTOP_DIR}/src-tauri/target/debug/buzz-desktop"

# The Tauri build embeds the frontend, so both must exist.
if [[ ! -x "${DESKTOP_BIN}" || ! -d "${DESKTOP_DIR}/dist" ]]; then
  log "Building the desktop app (frontend + Tauri binary — takes a while)..."

  # Sidecar stubs so the Tauri build compiles without the real binaries.
  TARGET="$(rustc -vV 2>/dev/null | sed -n 's|host: ||p')"
  if [[ -z "${TARGET}" ]]; then TARGET="aarch64-apple-darwin"; fi
  mkdir -p "${DESKTOP_DIR}/src-tauri/binaries"
  for bin in buzz-acp buzz-agent buzz-dev-mcp git-credential-nostr buzz buzz-backend-kubernetes; do
    touch "${DESKTOP_DIR}/src-tauri/binaries/${bin}-${TARGET}"
  done

  if ! command -v cmake &>/dev/null; then
    warn "cmake not found — installing via Homebrew (needed for the desktop build)."
    brew install cmake
  fi

  # Frontend. Prefer corepack pnpm (repo pins pnpm@11.4) with a recent Node.
  build_frontend() {
    (cd "${DESKTOP_DIR}" && npm run build)
  }
  if [[ -x "${REPO_ROOT}/bin/pnpm" ]]; then
    log "Using hermit pnpm for the frontend build..."
    PATH="${REPO_ROOT}/bin:$PATH" build_frontend
  elif command -v corepack &>/dev/null; then
    log "Using corepack pnpm for the frontend build..."
    for NODE in "$HOME/.nvm/versions/node/v24.12.0/bin" "$HOME/.nvm/versions/node/v24.14.0/bin" /opt/homebrew/opt/node/bin; do
      if [[ -x "${NODE}/node" ]]; then
        export PATH="${NODE}:$PATH"
        break
      fi
    done
    (cd "${DESKTOP_DIR}" && corepack pnpm install >/dev/null 2>&1 && npm run build)
  else
    build_frontend
  fi
  success "Frontend built"

  # Tauri Rust binary.
  if [[ -x "${REPO_ROOT}/bin/cargo" ]]; then
    (cd "${DESKTOP_DIR}/src-tauri" && "${REPO_ROOT}/bin/cargo" build)
  else
    (cd "${DESKTOP_DIR}/src-tauri" && cargo build)
  fi
  success "Desktop app built"
fi

# ---- 4. Launch the desktop app ----------------------------------------------

if pgrep -f "buzz-desktop" >/dev/null 2>&1; then
  warn "An existing buzz-desktop instance is running — leaving it as-is."
else
  log "Launching the desktop app..."
  python3 - <<PYEOF
import subprocess
with open('/tmp/buzz-desktop.log', 'wb') as log:
    subprocess.Popen(
        ['${DESKTOP_BIN}'],
        stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
print('desktop launched detached')
PYEOF
  sleep 3
fi
success "Desktop app launched"

# ---- 5. Next steps ----------------------------------------------------------

cat <<'EOF'

──────────────────────────────────────────────────────────────────────────────
✅ Everything is running.

In the desktop app, first-run onboarding:
  1. Click "Sign in with Ethereum"
  2. Enter the community URL: ws://localhost:3000
  3. The app generates an EVM key (stored in your macOS Keychain), derives the
     ZeroDev account, signs the SIWE message, and provisions membership.

Verify registration:
  docker exec buzz-postgres psql -U buzz -d buzz -c \
    "SELECT pubkey, encode(evm_address,'hex') AS evm FROM evm_identities ORDER BY created_at DESC LIMIT 3;"

Logs:
  relay:    /tmp/buzz-relay.log
  desktop:  /tmp/buzz-desktop.log
──────────────────────────────────────────────────────────────────────────────
EOF
