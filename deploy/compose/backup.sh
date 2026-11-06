#!/usr/bin/env bash
# Back up and restore this compose stack's data (README.md, "Backups"). Usually run through run.sh:
#
#   ./run.sh backup [DIR]        While the server runs: the database, then the media bucket, then the git data, then
#                                the settings (.env, the policy files and their stamps), with a manifest of checksums.
#                                Default DIR: backups/<UTC time>. Copy DIR off this machine.
#   ./run.sh restore DIR --yes   Replace this stack's database, media and git data with DIR's: stops the server,
#                                restores, starts it again and waits until it is ready.
#   ./run.sh verify-backup DIR   Check DIR's files against its manifest.
#
# The database is dumped first, so the media and git copies taken after it hold everything it refers to: files are
# only ever added, and a file newer than the dump is harmless where one missing from it would not be. Redis is not
# backed up: it holds only what the server can lose (presence, rate windows, caches), and a restore empties it so
# nothing in it describes the time after the backup.
#
# A backup holds every secret in .env and every private message: keep it where only the operator can read it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# shellcheck source=compose-env.sh
. ./compose-env.sh

step() { printf '\033[36m[backup]\033[0m %s\n' "$*"; }
die() {
  printf '\033[31m[backup] %s\033[0m\n' "$*" >&2
  exit 1
}

# The relay image this stack runs, as compose resolves it.
relay_image() {
  compose config --images relay 2>/dev/null | head -n 1
}

backup() {
  require_env_settings
  local dir="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
  [[ ! -e "$dir" ]] || die "$dir already exists; name a new folder"
  umask 077
  mkdir -p "$dir"
  dir="$(cd "$dir" && pwd)"

  step "the database and the object store (started if they are not running)"
  compose up -d --wait postgres minio >/dev/null

  step "database -> postgres.dump"
  # Written to a file in the container, not streamed: a dump written to a pipe has no data offsets, and some restores
  # need them. Read back before it is copied out: a dump that cannot be listed cannot be restored.
  compose exec -T postgres sh -c \
    'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --file=/tmp/backup.dump &&
     pg_restore --list /tmp/backup.dump >/dev/null' \
    || die "the database could not be dumped and read back"
  compose cp postgres:/tmp/backup.dump "$dir/postgres.dump" >/dev/null
  compose exec -T postgres rm -f /tmp/backup.dump
  local migration events
  migration="$(compose exec -T postgres sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" -Atc "select coalesce(max(version), 0) from _sqlx_migrations"' 2>/dev/null || echo unknown)"
  events="$(compose exec -T postgres sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" -Atc "select count(*) from events"' 2>/dev/null || echo unknown)"

  step "media bucket -> media/"
  mkdir -p "$dir/media"
  compose run --rm --no-deps -T -v "$dir/media:/backup" --entrypoint /bin/sh minio-init -euc '
    mc alias set local http://minio:9000 "$BUZZ_S3_ACCESS_KEY" "$BUZZ_S3_SECRET_KEY" >/dev/null
    mc mirror --quiet "local/$BUZZ_S3_BUCKET" /backup' >/dev/null

  step "git data -> git.tar.gz"
  compose run --rm --no-deps -T --user 0 -v "$dir:/backup" --entrypoint tar relay \
    -czf /backup/git.tar.gz -C /data/git .

  step "settings -> env, policies/"
  cp .env "$dir/env"
  local setting file
  for setting in BUZZ_TERMS_FILE BUZZ_PRIVACY_FILE; do
    file="$(env_value "$setting")"
    if [[ -n "$file" && -f "$file" ]]; then
      mkdir -p "$dir/policies"
      cp "$file" "$dir/policies/"
      # Its Last updated stamp (./run.sh policy-stamp) goes with it.
      if [[ -f "$(policy_stamp_path "$file")" ]]; then
        mkdir -p "$dir/policies/.stamps"
        cp "$(policy_stamp_path "$file")" "$dir/policies/.stamps/"
      fi
    fi
  done

  local image
  image="$(relay_image)"
  cat >"$dir/about.txt" <<ABOUT
taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
compose_project=$(compose config --format json 2>/dev/null | sed -n 's/^ *"name": "\(.*\)",$/\1/p' | head -n 1)
relay_image=$image
relay_image_id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || echo unknown)
source_revision=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" 2>/dev/null | sed -n 's/^BUZZ_SOURCE_SHA=//p' | head -n 1)
database_migration=$migration
events=$events
ABOUT

  step "manifest -> MANIFEST.sha256"
  (cd "$dir" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | sed 's|^\./||' | while IFS= read -r path; do
    sha256 "$path"
  done) >"$dir/MANIFEST.sha256"

  step "done: $dir ($(du -sh "$dir" | cut -f1), $events events, migration $migration)"
  echo "Copy this folder off this machine. It holds every secret in .env and every private message."
}

verify() {
  local dir="${1:?Usage: ./run.sh verify-backup DIR}"
  [[ -f "$dir/MANIFEST.sha256" ]] || die "$dir has no MANIFEST.sha256: not a backup made by this script"
  local missing
  for missing in postgres.dump git.tar.gz env about.txt; do
    [[ -f "$dir/$missing" ]] || die "$dir has no $missing"
  done
  (cd "$dir" && sha256 -c --quiet MANIFEST.sha256) || die "$dir does not match its manifest"
  step "$dir matches its manifest ($(wc -l <"$dir/MANIFEST.sha256" | tr -d ' ') files)"
}

# Copy the backup's policy files and stamps to where .env names them, for the ones this machine does not have.
restore_policies() {
  local dir="$1" setting file stamp
  for setting in BUZZ_TERMS_FILE BUZZ_PRIVACY_FILE; do
    file="$(env_value "$setting")"
    [[ -n "$file" ]] || continue
    if [[ ! -f "$file" && -f "$dir/policies/$(basename "$file")" ]]; then
      mkdir -p "$(dirname "$file")"
      cp "$dir/policies/$(basename "$file")" "$file"
      step "policy file $file <- the backup (this machine had none)"
    fi
    stamp="$(policy_stamp_path "$file")"
    if [[ ! -f "$stamp" && -f "$dir/policies/.stamps/$(basename "$stamp")" ]]; then
      mkdir -p "$(dirname "$stamp")"
      cp "$dir/policies/.stamps/$(basename "$stamp")" "$stamp"
    fi
  done
}

restore() {
  local dir="${1:?Usage: ./run.sh restore DIR --yes}"
  if [[ "${2:-}" != "--yes" ]]; then
    die "restore replaces this stack's database, media and git data with $dir's. Run it again with --yes."
  fi
  require_env_settings
  verify "$dir"
  dir="$(cd "$dir" && pwd)"
  # On a new machine the policy files and their stamps are not there yet: bring back what the backup holds, never over
  # a file or stamp this machine has. Then the server starts with the same check as any start, before anything is
  # replaced, so a policy file that cannot be served stops the restore while the data is still untouched.
  restore_policies "$dir"
  if creaton_on; then
    load_policies
  fi

  # The server's own key signs its records; restoring under another key would make it a different server to every
  # client. On a new machine, copy the backup's env to .env first (and set this machine's own values in it).
  if [[ "$(grep -E '^BUZZ_RELAY_PRIVATE_KEY=' "$dir/env" | tail -n 1)" != "$(grep -E '^BUZZ_RELAY_PRIVATE_KEY=' .env | tail -n 1)" ]]; then
    die "this .env has a different BUZZ_RELAY_PRIVATE_KEY from the backup's. On a new machine: cp $dir/env .env, check it, and run restore again."
  fi
  sed 's/^/  backup: /' "$dir/about.txt"

  step "stopping the server"
  compose stop relay >/dev/null
  compose up -d --wait postgres minio redis >/dev/null

  step "database <- postgres.dump"
  compose exec -T postgres sh -c \
    'dropdb --username="$POSTGRES_USER" --if-exists --force "$POSTGRES_DB" && createdb --username="$POSTGRES_USER" --owner="$POSTGRES_USER" "$POSTGRES_DB"'
  compose cp "$dir/postgres.dump" postgres:/tmp/restore.dump >/dev/null
  compose exec -T postgres sh -c \
    'pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-owner --exit-on-error /tmp/restore.dump;
     status=$?; rm -f /tmp/restore.dump; exit $status' \
    || die "the database could not be restored (the server is stopped; restore again, or from another backup)"

  step "media bucket <- media/ (exactly: objects not in the backup are removed)"
  compose run --rm --no-deps -T -v "$dir/media:/backup:ro" --entrypoint /bin/sh minio-init -euc '
    mc alias set local http://minio:9000 "$BUZZ_S3_ACCESS_KEY" "$BUZZ_S3_SECRET_KEY" >/dev/null
    mc mb --ignore-existing "local/$BUZZ_S3_BUCKET" >/dev/null
    mc anonymous set none "local/$BUZZ_S3_BUCKET" >/dev/null
    mc mirror --quiet --overwrite --remove /backup "local/$BUZZ_S3_BUCKET"' >/dev/null

  step "git data <- git.tar.gz"
  compose run --rm --no-deps -T --user 0 -v "$dir:/backup:ro" --entrypoint /bin/sh relay -euc '
    find /data/git -mindepth 1 -delete
    tar -xzf /backup/git.tar.gz -C /data/git
    chown -R 1000:1000 /data/git'

  step "emptying Redis (presence, rate windows and caches from after the backup)"
  compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHALL' >/dev/null

  step "starting the server"
  compose up -d --wait >/dev/null
  step "restored from $dir"
  if [[ -d "$dir/policies" ]]; then
    echo "The backup also holds the policy files it was taken with ($dir/policies). Files this machine already had were kept."
  fi
}

case "${1:-}" in
  backup) backup "${2:-}" ;;
  restore) restore "${2:-}" "${3:-}" ;;
  verify-backup) verify "${2:-}" ;;
  *)
    echo "Usage: $0 backup [DIR] | restore DIR --yes | verify-backup DIR" >&2
    exit 1
    ;;
esac
