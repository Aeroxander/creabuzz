#!/usr/bin/env bash
# Back up and restore this compose stack's data (README.md, "Backups"). Usually run through run.sh:
#
#   ./run.sh backup [NAME]       While the server runs: the database, then the media bucket, then the git data, then
#                                the settings (.env, the policy files and their stamps), with a manifest of checksums.
#                                That folder is then packed into one file, encrypted to BUZZ_BACKUP_AGE_RECIPIENT (an
#                                age public key in .env), and the plain folder is removed (also when the backup fails
#                                or is stopped before the encrypted file exists; if it cannot be removed, the script
#                                names it and exits non-zero):
#                                  backups/<UTC time>.tar.age   the encrypted backup
#                                  backups/<UTC time>.sha256    its sidecar: the hash of the .tar.age, and the hash of
#                                                               the MANIFEST.sha256 packed inside it
#                                Copy both off this machine. Only the matching private key, which must never be on
#                                this server, can open the .tar.age.
#                                With no key set the backup is refused, unless BUZZ_BACKUP_ALLOW_UNENCRYPTED=true is
#                                set on purpose (a local test or rehearsal): then it stays a plain folder.
#   ./run.sh restore FILE --yes  Replace this stack's database, media and git data with the backup's: stops the server,
#                                restores, starts it again and waits until it is ready. FILE is a .tar.age (needs
#                                AGE_IDENTITY_FILE=<private key file>; decrypted into a temp folder that is removed
#                                afterwards) or a plain backup folder made before backups were encrypted.
#   ./run.sh verify-backup FILE  A .tar.age: checks its hash against the sidecar, which needs no key; with
#                                AGE_IDENTITY_FILE set it also opens it and checks every file against the manifest.
#                                A plain folder: checks its files against its manifest.
#
# The database is dumped first, so the media and git copies taken after it hold everything it refers to: files are
# only ever added, and a file newer than the dump is harmless where one missing from it would not be. Redis is not
# backed up: it holds only what the server can lose (presence, rate windows, caches), and a restore empties it so
# nothing in it describes the time after the backup.
#
# A backup holds every secret in .env and every private message: encrypted, it is safe to copy off the machine; a plain
# folder is not, so keep it where only the operator can read it.
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

# Where a backup is opened (decrypted) for verify-backup or restore; removed however this script ends.
TMP_DIR=""
# The unfinished plain backup folder of an encrypted backup, and its half-written .partial file. The folder holds every
# secret in .env and the whole database, so it is removed however this script ends before the encrypted file is in
# place: an error, Ctrl-C or a TERM from cron. Empty once it is gone, and always empty for a deliberate plain backup.
PLAIN_DIR=""
PARTIAL_FILE=""
PLAIN_REMOVE_FAILED=false

# Removes a plain backup folder, as the operator first and, if that fails, as root in a container: the media bucket is
# filled by a container that runs as root, and the operator cannot delete the root-owned folders inside it. Returns
# non-zero, after saying which folder is left, only when both fail.
remove_plain_dir() {
  local dir="$1"
  if rm -rf -- "$dir" 2>/dev/null && [[ ! -e "$dir" ]]; then
    return 0
  fi
  if compose run --rm --no-deps -T --user 0 -v "$dir:/plain" --entrypoint /bin/sh relay -euc \
    'find /plain -mindepth 1 -delete' >/dev/null 2>&1 && rm -rf -- "$dir" 2>/dev/null && [[ ! -e "$dir" ]]; then
    return 0
  fi
  printf '\033[31m[backup] the plain backup folder %s could not be removed. It holds every secret in .env and the whole database: delete it now (sudo rm -rf %s).\033[0m\n' "$dir" "$dir" >&2
  return 1
}

cleanup() {
  [[ -z "$TMP_DIR" ]] || rm -rf -- "$TMP_DIR"
  [[ -z "$PARTIAL_FILE" ]] || rm -f -- "$PARTIAL_FILE"
  if [[ -n "$PLAIN_DIR" && "$PLAIN_REMOVE_FAILED" != true && -e "$PLAIN_DIR" ]]; then
    remove_plain_dir "$PLAIN_DIR" || true
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

# A setting as the shell has it, else as .env has it, without quotes around it.
config_value() {
  local value="${!1:-}"
  [[ -n "$value" ]] || value="$(env_value "$1")"
  if [[ "$value" =~ ^\'(.*)\'$ || "$value" =~ ^\"(.*)\"$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# The age public key backups are encrypted to ("" for a plain backup, only with the deliberate override). Refuses, before
# anything is touched, when there is no usable key.
BACKUP_RECIPIENT=""
require_backup_key() {
  local recipient override
  recipient="$(config_value BUZZ_BACKUP_AGE_RECIPIENT)"
  override="$(config_value BUZZ_BACKUP_ALLOW_UNENCRYPTED)"
  if [[ -z "$recipient" || "$recipient" == CHANGE_ME* ]]; then
    [[ "$override" == true ]] && return 0
    {
      echo "Backups are encrypted, and BUZZ_BACKUP_AGE_RECIPIENT is not set in deploy/compose/.env."
      echo "Make the key on your own computer (install age first: brew install age, or sudo apt-get install -y age):"
      echo "    age-keygen -o creaton-backup.key"
      echo "Keep creaton-backup.key in your password manager. The private key must not live on this server: with it, anyone"
      echo "who gets a backup can read every secret and private message in it. age-keygen prints the public key (it starts"
      echo "with age1); put that in .env as BUZZ_BACKUP_AGE_RECIPIENT=age1..., then run the backup again."
      echo "Only for a local test or rehearsal: BUZZ_BACKUP_ALLOW_UNENCRYPTED=true makes a plain backup instead."
    } >&2
    exit 1
  fi
  [[ "$recipient" =~ ^age1[a-z0-9]+$ ]] ||
    die "BUZZ_BACKUP_AGE_RECIPIENT is not an age public key (it starts with age1). It is the public line age-keygen prints, never the private key."
  command -v age >/dev/null 2>&1 || die "age is not installed on this machine: sudo apt-get install -y age (Ubuntu), or brew install age"
  printf 'x' | age -r "$recipient" >/dev/null 2>&1 || die "BUZZ_BACKUP_AGE_RECIPIENT is not a valid age public key: copy the age1... line age-keygen printed again"
  BACKUP_RECIPIENT="$recipient"
}

# The relay image this stack runs, as compose resolves it.
relay_image() {
  compose config --images relay 2>/dev/null | head -n 1
}

backup() {
  require_env_settings
  require_backup_key
  local dir="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
  [[ ! -e "$dir" ]] || die "$dir already exists; name a new folder"
  [[ -z "$BACKUP_RECIPIENT" || ! -e "$dir.tar.age" ]] || die "$dir.tar.age already exists; name a new one"
  umask 077
  mkdir -p "$dir"
  dir="$(cd "$dir" && pwd)"
  # From here until the encrypted file is in place, any way out of this script removes the plain folder (cleanup above).
  [[ -z "$BACKUP_RECIPIENT" ]] || PLAIN_DIR="$dir"

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

  if [[ -z "$BACKUP_RECIPIENT" ]]; then
    step "done: $dir ($(du -sh "$dir" | cut -f1), $events events, migration $migration)"
    echo "WARNING: this backup is NOT encrypted (BUZZ_BACKUP_ALLOW_UNENCRYPTED=true). Do not copy it off a test machine."
    echo "It holds every secret in .env and every private message."
    return 0
  fi

  verify_folder "$dir" >/dev/null
  encrypt_backup "$dir"
  step "done: $dir.tar.age ($(du -sh "$dir.tar.age" | cut -f1), $events events, migration $migration)"
  echo "Copy $dir.tar.age and $dir.sha256 off this machine. The file is encrypted to the public key in .env;"
  echo "only the private key (creaton-backup.key, kept off this server) opens it: without that key the backup is lost."
}

# Packs the finished folder into DIR.tar.age, encrypted to the public key, and writes DIR.sha256 beside it. The plain
# folder is removed once the encrypted file is written, non-empty and an age file; if encrypting fails it is removed too,
# since a plain copy of every secret must not pile up under backups/ (nothing is left but the error). The key to open it is not on
# this machine, so there is no trial decrypt here; the sidecar's hashes (the .tar.age's, and the MANIFEST.sha256 packed
# inside it) are what verify-backup checks later, and verify-backup with the key opens it.
encrypt_backup() {
  local dir="$1" parent name out manifest_hash
  parent="$(dirname "$dir")"
  name="$(basename "$dir")"
  out="$dir.tar.age"
  manifest_hash="$(sha256 "$dir/MANIFEST.sha256" | cut -d' ' -f1)"

  step "encrypting -> $name.tar.age"
  PARTIAL_FILE="$out.partial"
  if ! tar -cf - -C "$parent" "$name" | age -r "$BACKUP_RECIPIENT" -o "$out.partial"; then
    die "the backup could not be encrypted; the unfinished plain folder is removed, so run the backup again"
  fi
  if [[ ! -s "$out.partial" || "$(head -c 21 "$out.partial")" != "age-encryption.org/v1" ]]; then
    die "the encrypted file is empty or not an age file; the unfinished plain folder is removed, so run the backup again"
  fi
  mv "$out.partial" "$out"
  PARTIAL_FILE=""
  {
    (cd "$parent" && sha256 "$name.tar.age")
    echo "manifest_sha256=$manifest_hash"
  } >"$dir.sha256"
  # The encrypted file is in place. If the folder cannot be removed (see remove_plain_dir) the script stops with an
  # error that names it, so cron sees a failure and the operator is told which folder to delete.
  if remove_plain_dir "$dir"; then
    PLAIN_DIR=""
  else
    PLAIN_REMOVE_FAILED=true
    exit 1
  fi
}

# A plain backup folder against its manifest. LABEL names it in messages (a folder opened from a .tar.age is a temp folder).
verify_folder() {
  local dir="${1:?Usage: ./run.sh verify-backup DIR}" label="${2:-$1}"
  [[ -f "$dir/MANIFEST.sha256" ]] || die "$label has no MANIFEST.sha256: not a backup made by this script"
  local missing
  for missing in postgres.dump git.tar.gz env about.txt; do
    [[ -f "$dir/$missing" ]] || die "$label has no $missing"
  done
  (cd "$dir" && sha256 -c --quiet MANIFEST.sha256) || die "$label does not match its manifest"
  step "$label matches its manifest ($(wc -l <"$dir/MANIFEST.sha256" | tr -d ' ') files)"
}

# An encrypted backup against its sidecar (<name>.sha256, beside it): the .tar.age's hash. Sets SIDECAR_MANIFEST_HASH to
# the manifest hash the sidecar records. With REQUIRED=no a missing sidecar is a warning, not a stop.
SIDECAR_MANIFEST_HASH=""
check_sidecar() {
  local file="$1" required="${2:-yes}" dir base side want got
  dir="$(cd "$(dirname "$file")" && pwd)"
  base="$(basename "$file")"
  side="$dir/${base%.tar.age}.sha256"
  SIDECAR_MANIFEST_HASH=""
  if [[ ! -f "$side" ]]; then
    [[ "$required" == yes ]] || {
      echo "Note: $file has no sidecar (${base%.tar.age}.sha256), so its outer hash was not checked."
      return 0
    }
    die "$file has no sidecar (${base%.tar.age}.sha256, kept beside it): without it the file cannot be checked. Copy both together."
  fi
  want="$(sed -n '1s/ .*//p' "$side")"
  got="$(cd "$dir" && sha256 "$base" | cut -d' ' -f1)"
  [[ -n "$want" && "$want" == "$got" ]] || die "$file does not match its sidecar $side: it changed or was damaged after the backup was taken"
  SIDECAR_MANIFEST_HASH="$(sed -n 's/^manifest_sha256=//p' "$side" | head -n 1)"
  step "$file matches its sidecar"
}

# Decrypts FILE with AGE_IDENTITY_FILE into a new temp folder (removed when this script ends, however it ends) and sets
# OPENED_DIR to the backup folder inside. The folder is the one the sidecar's manifest hash describes.
OPENED_DIR=""
require_identity() {
  [[ -n "${AGE_IDENTITY_FILE:-}" ]] ||
    die "this needs the private key: set AGE_IDENTITY_FILE=/path/to/creaton-backup.key (the key file from age-keygen; it is never kept on this server)"
  [[ -f "$AGE_IDENTITY_FILE" ]] || die "AGE_IDENTITY_FILE=$AGE_IDENTITY_FILE: no such file"
  command -v age >/dev/null 2>&1 || die "age is not installed on this machine: sudo apt-get install -y age (Ubuntu), or brew install age"
}
open_encrypted() {
  local file="$1" found="" entry
  require_identity
  umask 077
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/creaton-backup.XXXXXX")"
  step "decrypting $file (into a temp folder that is removed afterwards)"
  age -d -i "$AGE_IDENTITY_FILE" "$file" | tar -xf - -C "$TMP_DIR" ||
    die "$file could not be decrypted: wrong private key, or the file is damaged"
  for entry in "$TMP_DIR"/*/; do
    [[ -d "$entry" ]] && found="${entry%/}"
  done
  [[ -n "$found" ]] || die "$file holds no backup folder"
  OPENED_DIR="$found"
  # The manifest inside must be the one the sidecar recorded when the backup was taken.
  if [[ -n "$SIDECAR_MANIFEST_HASH" && -f "$OPENED_DIR/MANIFEST.sha256" ]] &&
    [[ "$(sha256 "$OPENED_DIR/MANIFEST.sha256" | cut -d' ' -f1)" != "$SIDECAR_MANIFEST_HASH" ]]; then
    die "the manifest inside $file is not the one recorded in its sidecar: the contents were changed after the backup was taken"
  fi
}

verify() {
  local target="${1:?Usage: ./run.sh verify-backup DIR|FILE.tar.age}"
  if [[ -d "$target" ]]; then
    verify_folder "$target"
  elif [[ -f "$target" && "$target" == *.tar.age ]]; then
    if [[ -z "${AGE_IDENTITY_FILE:-}" ]]; then
      check_sidecar "$target"
      echo "The contents were not opened: set AGE_IDENTITY_FILE=/path/to/creaton-backup.key to open the file and check every file against its manifest."
    else
      check_sidecar "$target" no
      open_encrypted "$target"
      verify_folder "$OPENED_DIR" "$target"
    fi
  else
    die "$target: no such backup (a backup folder, or a .tar.age file)"
  fi
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
  local src="${1:?Usage: ./run.sh restore DIR|FILE.tar.age --yes}" dir encrypted=false
  if [[ "${2:-}" != "--yes" ]]; then
    die "restore replaces this stack's database, media and git data with $src's. Run it again with --yes."
  fi
  require_env_settings
  if [[ -d "$src" ]]; then
    verify_folder "$src"
    dir="$(cd "$src" && pwd)"
  elif [[ -f "$src" && "$src" == *.tar.age ]]; then
    encrypted=true
    require_identity
    check_sidecar "$src" no
    open_encrypted "$src"
    verify_folder "$OPENED_DIR" "$src"
    dir="$OPENED_DIR"
  else
    die "$src: no such backup (a backup folder, or a .tar.age file)"
  fi
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
    if [[ "$encrypted" == true ]]; then
      die "this .env has a different BUZZ_RELAY_PRIVATE_KEY from the backup's. On a new machine: age -d -i creaton-backup.key $src | tar -xf - (in an empty folder), cp <that folder>/env .env, check it, and run restore again."
    fi
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
  step "restored from $src"
  if [[ -d "$dir/policies" ]]; then
    echo "The backup also held the policy files it was taken with. Files this machine already had were kept."
  fi
}

case "${1:-}" in
  backup) backup "${2:-}" ;;
  restore) restore "${2:-}" "${3:-}" ;;
  verify-backup) verify "${2:-}" ;;
  *)
    echo "Usage: $0 backup [NAME] | restore DIR|FILE.tar.age --yes | verify-backup DIR|FILE.tar.age" >&2
    exit 1
    ;;
esac
