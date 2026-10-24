#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# shellcheck source=compose-env.sh
. ./compose-env.sh

backup_hint() {
  cat <<'MSG'
Back up these before upgrades and on a regular schedule:

- deploy/compose/.env, especially BUZZ_RELAY_PRIVATE_KEY, DB/Redis/S3 secrets, and BUZZ_GIT_HOOK_HMAC_SECRET
- The owner private key if bootstrap generated one for RELAY_OWNER_PUBKEY
- Postgres data (prefer pg_dump or a quiesced volume snapshot)
- MinIO/S3 bucket contents for media and git objects
- buzz-git-data volume (BUZZ_GIT_REPO_PATH=/data/git)
- Caddy data/config volumes if using compose.caddy.yml

Keep Postgres + object/git state snapshots from the same maintenance window.

./run.sh backup takes the database, the media bucket, the git data and the
settings (.env and the policy files) in one folder, in that order; copy that
folder off this machine. The owner key and Caddy's certificates are not in it
(Caddy gets new certificates by itself).
MSG
}

case "${1:-help}" in
  start|up)
    require_env
    compose up -d --wait
    ;;
  stop|down)
    compose down
    ;;
  restart)
    require_env
    compose up -d --wait --force-recreate relay
    ;;
  pull)
    require_env
    if creaton_on; then
      # The Creaton relay image is built here (`build`), not pulled.
      compose pull --ignore-buildable
    else
      compose pull
    fi
    ;;
  build)
    require_env
    BUZZ_SOURCE_SHA="$(git -C ../.. rev-parse --short HEAD 2>/dev/null || echo unknown)" compose build relay
    ;;
  upgrade)
    require_env
    if creaton_on; then
      # A backup first: an upgrade can run database migrations that an older image cannot undo.
      ./backup.sh backup
      compose pull --ignore-buildable
      BUZZ_SOURCE_SHA="$(git -C ../.. rev-parse --short HEAD 2>/dev/null || echo unknown)" compose build relay
    else
      compose pull
    fi
    compose up -d --wait
    backup_hint
    ;;
  backup|restore|verify-backup)
    ./backup.sh "$@"
    ;;
  logs)
    shift || true
    compose logs -f "${@:-relay}"
    ;;
  status|ps)
    compose ps
    ;;
  config)
    require_env
    compose config
    ;;
  backup-hint)
    backup_hint
    ;;
  add-member)
    docker compose exec relay /usr/local/bin/buzz-admin add-member --pubkey "${2:?Usage: ./run.sh add-member <npub-or-hex> [--role member|admin]}" "${@:3}"
    ;;
  remove-member)
    docker compose exec relay /usr/local/bin/buzz-admin remove-member --pubkey "${2:?Usage: ./run.sh remove-member <npub-or-hex> [--role member|admin]}" "${@:3}"
    ;;
  list-members)
    docker compose exec relay /usr/local/bin/buzz-admin list-members
    ;;
  help|-h|--help)
    cat <<'MSG'
Usage: ./run.sh <command>

Commands:
  start         Start Buzz with docker compose up -d --wait
  stop          Stop containers without deleting volumes
  restart       Recreate the relay after env/image changes
  pull          Pull configured images
  build         Build the Creaton relay image from this checkout (Creaton only)
  upgrade       Pull and restart, then print backup reminders (Creaton: back
                up, then pull, build and restart)
  logs [svc]    Follow logs (default: relay)
  status        Show compose service status
  config        Render merged compose config
  backup-hint   Print the production backup checklist
  backup [DIR]  Back up the database, media, git data and settings while the
                server runs (default backups/<UTC time>)
  restore DIR --yes
                Replace this stack's data with a backup's (stops the server
                meanwhile)
  verify-backup DIR
                Check a backup's files against its manifest

  add-member <npub-or-hex> [--role member|admin]
                Add a relay member (default role: member)
  remove-member <npub-or-hex> [--role member|admin]
                Remove a relay member
  list-members  List all relay members

  Note: when adding multiple members in a loop, add `sleep 1` between
  invocations to avoid same-second timestamp collisions in the kind:13534
  roster event. Do not use parallel adds (e.g. xargs -P).

Environment switches:
  BUZZ_COMPOSE_TLS=true   Include compose.caddy.yml for automatic HTTPS
  BUZZ_COMPOSE_DEV=true   Include compose.dev.yml for local admin ports/tools
MSG
    ;;
  *)
    echo "Unknown command: $1" >&2
    echo "Run ./run.sh help" >&2
    exit 1
    ;;
esac
