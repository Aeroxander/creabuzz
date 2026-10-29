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

# A Creaton server with no terms or privacy note shows people none at sign-up. That is allowed (a private test), so it
# does not stop the command, but it must not go unnoticed on a server people are invited to.
warn_missing_policies() {
  creaton_on || return 0
  local setting missing=()
  for setting in BUZZ_TERMS_FILE BUZZ_PRIVACY_FILE; do
    [[ -n "$(env_value "$setting")" ]] || missing+=("$setting")
  done
  ((${#missing[@]})) || return 0
  printf '\033[1;31m%s\033[0m\n' \
    "WARNING: ${missing[*]} not set in .env: sign-up will show no terms or privacy note." \
    "Do not invite anyone until both are set (README.md, \"First start\")." >&2
}

# Backups older than DAYS days, by the folder's age: the privacy note says how long backups are kept, and nothing else
# deletes them. Only folders named the way `backup` names them (backups/<UTC time>) are touched.
prune_backups() {
  local days="${1:-}"
  [[ "$days" =~ ^[0-9]+$ ]] || {
    echo "Usage: ./run.sh prune-backups DAYS" >&2
    exit 1
  }
  [[ -d backups ]] || return 0
  local dir removed=0
  while IFS= read -r dir; do
    echo "removing $dir"
    rm -rf -- "$dir"
    removed=$((removed + 1))
  done < <(find backups -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T[0-9]*Z' -mtime +"$days" | LC_ALL=C sort)
  echo "$removed backup(s) older than $days days removed from backups/. Copies kept off this machine are not touched."
}

# One uploaded file in the bundled media store, by its hash (the 64 characters in its /media/<hash>.<ext> address):
# the file, its thumbnail and its records. Removing a post does not remove its pictures, and the server has no way to
# delete a file, so a takedown ends here (docs/operator-takedown-and-data-requests.md). Files are stored once per hash,
# so this removes it wherever it was posted.
remove_media() {
  local sha="${1:-}" confirm="${2:-}"
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Usage: ./run.sh remove-media <64-character hash> [--yes]" >&2
    exit 1
  }
  local remove=false
  [[ "$confirm" == "--yes" ]] && remove=true
  compose run --rm --no-deps -T -e SHA="$sha" -e REMOVE="$remove" --entrypoint /bin/sh minio-init -euc '
    mc alias set local http://minio:9000 "$BUZZ_S3_ACCESS_KEY" "$BUZZ_S3_SECRET_KEY" >/dev/null
    found="$(mc find "local/$BUZZ_S3_BUCKET" --path "*$SHA*")"
    if [ -z "$found" ]; then
      echo "No file with that hash in the media store."
      exit 0
    fi
    echo "$found"
    if [ "$REMOVE" != true ]; then
      # Upload records (kept only with BUZZ_MEDIA_UPLOAD_RECORDS on) say who uploaded it and when: read them before
      # they go, for a report.
      echo "$found" | grep "/_uploads/" | while IFS= read -r record; do mc cat "$record"; echo; done
      echo "Nothing removed. Run again with --yes to remove the objects above."
      exit 0
    fi
    echo "$found" | while IFS= read -r object; do mc rm --quiet "$object"; done
    echo "Removed. Backups taken before now still hold it until they are pruned."'
}

case "${1:-help}" in
  start|up)
    require_env
    warn_missing_policies
    compose up -d --wait
    ;;
  stop|down)
    compose down
    ;;
  restart)
    require_env
    warn_missing_policies
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
    require_env_file
    BUZZ_SOURCE_SHA="$(git -C ../.. rev-parse --short HEAD 2>/dev/null || echo unknown)" compose build relay
    ;;
  upgrade)
    require_env
    warn_missing_policies
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
  prune-backups)
    prune_backups "${2:-}"
    ;;
  remove-media)
    require_env
    remove_media "${2:-}" "${3:-}"
    ;;
  psql)
    # The database, for the operator's requests (docs/operator-takedown-and-data-requests.md). Takes psql's own options;
    # without a terminal (SQL piped in), it reads standard input.
    require_env
    shift
    tty=()
    [[ -t 0 ]] || tty=(-T)
    compose exec ${tty[@]+"${tty[@]}"} postgres sh -c 'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" "$@"' psql "$@"
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
  prune-backups DAYS
                Delete backups/<UTC time> folders older than DAYS days
  psql [options]
                Open the database (or run SQL piped in)
  remove-media HASH [--yes]
                List (or, with --yes, delete) one uploaded file, its thumbnail
                and its records in the bundled media store

  add-member <npub-or-hex> [--role member|admin]
                Add a relay member (default role: member)
  remove-member <npub-or-hex> [--role member|admin]
                Remove a relay member
  list-members  List all relay members

  Note: when adding multiple members in a loop, add `sleep 1` between
  invocations to avoid same-second timestamp collisions in the kind:13534
  roster event. Do not use parallel adds (e.g. xargs -P).

Environment switches (in the shell, or in .env for TLS and Creaton):
  BUZZ_COMPOSE_TLS=true   Include compose.caddy.yml for automatic HTTPS
  BUZZ_COMPOSE_CREATON=true
                          Include compose.creaton.yml (README.md, "Creaton")
  BUZZ_COMPOSE_DEV=true   Include compose.dev.yml for local admin ports/tools
MSG
    ;;
  *)
    echo "Unknown command: $1" >&2
    echo "Run ./run.sh help" >&2
    exit 1
    ;;
esac
