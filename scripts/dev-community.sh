#!/usr/bin/env bash
# =============================================================================
# dev-community.sh — provision a local community so the web app can connect
# =============================================================================
# Usage: ./scripts/dev-community.sh [owner-pubkey-hex]
#
# The relay binds every connection to a community by its Host header and
# fails closed when none matches ("no community is configured for this
# host"). That is right for production and surprising on localhost, so this
# script seeds the loopback hosts a dev relay serves.
#
# Dev only: it writes into $DATABASE_URL (like scripts/loop-test.sh) and
# refuses non-loopback hosts.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

# Load DATABASE_URL from .env when the shell has none.
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
: "${DATABASE_URL:?set DATABASE_URL (or keep it in .env)}"

HOSTS="${DEV_COMMUNITY_HOSTS:-localhost:3000 127.0.0.1:3000}"
OWNER_PK="${1:-${DEV_OWNER_PUBKEY:-}}"

for host in $HOSTS; do
  case "$host" in
    localhost:*|127.0.0.1:*|localhost|127.0.0.1) ;;
    *)
      echo "dev-community: refusing non-loopback host '$host' (dev only)" >&2
      exit 1
      ;;
  esac
done

sql() {
  psql "$DATABASE_URL" -X -q -t -A -c "$1"
}

echo "[dev-community] migrating (idempotent)"
cargo run -q -p buzz-admin -- migrate >/dev/null

for host in $HOSTS; do
  sql "insert into communities (host) values ('$host') on conflict do nothing" >/dev/null
  echo "[dev-community] community ready for host: $host"
done

if [[ -n "$OWNER_PK" ]]; then
  for host in $HOSTS; do
    CID="$(sql "select id from communities where host = '$host'")"
    sql "insert into relay_members (community_id, pubkey, role) values ('$CID', decode('$OWNER_PK','hex'), 'owner') on conflict do nothing" >/dev/null
    sql "insert into users (community_id, pubkey) values ('$CID', decode('$OWNER_PK','hex')) on conflict do nothing" >/dev/null
    echo "[dev-community] owner seeded for $host: $OWNER_PK"
  done
else
  echo "[dev-community] no owner seeded (pass a pubkey: ./scripts/dev-community.sh <hex>)"
fi

echo "[dev-community] done — reload the web app."
