#!/usr/bin/env bash
# Backs up and restores a real, running Creaton stack (deploy/compose), in a scratch copy of the bundle with its own
# project name, port and volumes, so nothing of a real deployment is touched:
#
#   start -> the terms reach sign-up -> a post, an image and git data -> backup -> verify -> a changed file is caught
#   -> restore refuses without --yes and under another server key -> every volume wiped, the data is gone
#   -> restore -> the post, the image (as an image) and the git data are back, and the server takes new posts.
#
# Needs Docker and the image: `cd deploy/compose && ./run.sh build`, or IMAGE=<name>. Env: IMAGE, PORT, KEEP=1 (leave
# the stack and the scratch folder for a look).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-creaton-relay:local}"
PORT="${PORT:-3417}"
export COMPOSE_PROJECT_NAME="creaton-backup-test-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/creaton-backup-test.XXXXXX")"
BASE="http://localhost:$PORT"

step() { printf '\033[36m[backup-test]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[31m[backup-test] FAILED: %s\033[0m\n' "$*" >&2
  exit 1
}

docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "no image $IMAGE (cd deploy/compose && ./run.sh build)"
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then fail "port $PORT is in use (PORT=<another>)"; fi

cleanup() {
  if [[ "${KEEP:-}" == "1" ]]; then
    echo "kept: $WORK (project $COMPOSE_PROJECT_NAME)"
    return
  fi
  (cd "$WORK/compose" 2>/dev/null && docker compose --env-file .env -f compose.yml -f compose.creaton.yml down -v >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step "a scratch copy of deploy/compose in $WORK (project $COMPOSE_PROJECT_NAME, port $PORT)"
mkdir -p "$WORK/compose/policies"
cp "$ROOT"/deploy/compose/{compose.yml,compose.creaton.yml,compose-env.sh,run.sh,backup.sh} "$WORK/compose/"
cd "$WORK/compose"
hex() { openssl rand -hex 32; }
OWNER_KEY="$(hex)"
OWNER_PUB="$(cd "$ROOT/web" && node --input-type=module -e \
  "import { getPublicKey } from 'nostr-tools/pure'; console.log(getPublicKey(Uint8Array.from(Buffer.from('$OWNER_KEY', 'hex'))))")"
cat >.env <<ENV
BUZZ_COMPOSE_CREATON=true
CREATON_IMAGE=$IMAGE
BUZZ_DOMAIN=localhost
RELAY_URL=ws://localhost:$PORT
BUZZ_MEDIA_BASE_URL=$BASE/media
BUZZ_MEDIA_SERVER_DOMAIN=localhost:$PORT
BUZZ_CORS_ORIGINS=$BASE
BUZZ_REQUIRE_AUTH_TOKEN=true
BUZZ_REQUIRE_RELAY_MEMBERSHIP=true
BUZZ_ALLOW_NIP_OA_AUTH=true
BUZZ_AUTO_MIGRATE=true
BUZZ_GIT_CONFORMANCE_PROBE=true
BUZZ_PUSH_ENABLED=false
RUST_LOG=buzz_relay=warn
RELAY_OWNER_PUBKEY=$OWNER_PUB
BUZZ_RELAY_PRIVATE_KEY=$(hex)
BUZZ_GIT_HOOK_HMAC_SECRET=$(hex)
POSTGRES_DB=buzz
POSTGRES_USER=buzz
POSTGRES_PASSWORD=$(openssl rand -hex 16)
REDIS_PASSWORD=$(openssl rand -hex 16)
BUZZ_S3_ACCESS_KEY=$(openssl rand -hex 10)
BUZZ_S3_SECRET_KEY=$(openssl rand -hex 20)
BUZZ_S3_BUCKET=buzz-media
BUZZ_HTTP_PORT=$PORT
BUZZ_V1_ENABLED=true
BUZZ_TERMS_FILE=policies/terms.md
BUZZ_PRIVACY_FILE=policies/privacy.md
ENV
printf '# Terms for the backup test\n\nLine two: "quotes", $dollars and a colon: kept.\n' >policies/terms.md
printf '# Privacy for the backup test\n\nWe keep backups.\n' >policies/privacy.md
data() { (cd "$ROOT/web" && node tests/deploy/backup-data.mjs "$@" "$BASE" "$OWNER_KEY" ${SAVED:+"$SAVED"}); }
git_marker() {
  docker compose --env-file .env -f compose.yml -f compose.creaton.yml run --rm --no-deps -T --user 0 \
    --entrypoint /bin/sh relay -c "$1"
}

step "a draft's [placeholder] stops the start"
printf 'Run by [Operator name].\n' >policies/draft.md
sed -i.bak 's|^BUZZ_TERMS_FILE=.*|BUZZ_TERMS_FILE=policies/draft.md|' .env
if ./run.sh start >"$WORK/draft.log" 2>&1; then fail "started with a draft's placeholder in the terms"; fi
grep -q "placeholders" "$WORK/draft.log" || fail "the refusal did not name the placeholders: $(cat "$WORK/draft.log")"
mv .env.bak .env

step "starting the stack"
./run.sh start >"$WORK/start.log" 2>&1 || { tail -30 "$WORK/start.log"; fail "the stack did not start"; }
# Served as a page: the heading on its own line proves the file's lines arrived as they are.
TERMS="$(curl -fsS "$BASE/api/join-policy/terms")" || fail "the server shows no terms"
grep -q '<h1>Terms for the backup test</h1>' <<<"$TERMS" && grep -q 'dollars and a colon: kept' <<<"$TERMS" \
  || fail "the terms did not reach the server whole: $(head -c 400 <<<"$TERMS")"

step "a post, an image and git data"
SAVED="$(data seed)" || fail "could not seed"
data check >/dev/null || fail "the seeded data cannot be read back before any backup"
git_marker 'echo kept > /data/git/backup-test-marker && chown 1000:1000 /data/git/backup-test-marker'

step "backup"
./run.sh backup "$WORK/backup" || fail "backup failed"
for file in postgres.dump git.tar.gz env about.txt MANIFEST.sha256; do
  [[ -s "$WORK/backup/$file" ]] || fail "the backup has no $file"
done
[[ -n "$(find "$WORK/backup/media" -type f | head -n 1)" ]] || fail "the backup has no media"
grep -q "^events=[1-9]" "$WORK/backup/about.txt" || fail "about.txt counts no events: $(cat "$WORK/backup/about.txt")"
./run.sh verify-backup "$WORK/backup" >/dev/null || fail "a fresh backup does not match its manifest"

step "a changed file is caught"
cp -R "$WORK/backup" "$WORK/changed"
echo tampered >>"$WORK/changed/git.tar.gz"
if ./run.sh verify-backup "$WORK/changed" >/dev/null 2>&1; then fail "verify passed a changed backup"; fi

step "restore refuses without --yes, and under another server key"
if ./run.sh restore "$WORK/backup" >/dev/null 2>&1; then fail "restore ran without --yes"; fi
cp -R "$WORK/backup" "$WORK/otherkey"
sed -i.bak "s|^BUZZ_RELAY_PRIVATE_KEY=.*|BUZZ_RELAY_PRIVATE_KEY=$(hex)|" "$WORK/otherkey/env" && rm "$WORK/otherkey/env.bak"
(cd "$WORK/otherkey" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | sed 's|^\./||' | while IFS= read -r p; do
  if command -v sha256sum >/dev/null; then sha256sum "$p"; else shasum -a 256 "$p"; fi
done) >"$WORK/otherkey/MANIFEST.sha256"
if ./run.sh restore "$WORK/otherkey" --yes >"$WORK/otherkey.log" 2>&1; then fail "restored under another server key"; fi
grep -q "BUZZ_RELAY_PRIVATE_KEY" "$WORK/otherkey.log" || fail "the refusal did not say why: $(cat "$WORK/otherkey.log")"
data check >/dev/null || fail "a refused restore changed the data"

step "every volume wiped, then a fresh start: the data is gone"
docker compose --env-file .env -f compose.yml -f compose.creaton.yml down -v >/dev/null 2>&1
./run.sh start >"$WORK/start2.log" 2>&1 || { tail -30 "$WORK/start2.log"; fail "the empty stack did not start"; }
data absent >/dev/null || fail "the data survived wiping the volumes, so the restore below would prove nothing"
if git_marker 'test -e /data/git/backup-test-marker'; then fail "the git data survived wiping the volumes"; fi

step "restore"
./run.sh restore "$WORK/backup" --yes || fail "restore failed"
data check || fail "the restored server does not have the data"
git_marker 'test "$(cat /data/git/backup-test-marker)" = kept && test "$(stat -c %u /data/git/backup-test-marker)" = 1000' \
  || fail "the git data was not restored as it was"
curl -fsS "http://localhost:$PORT/api/join-policy/terms" | grep -q "Line two" || fail "the terms are gone after the restore"
SAVED="" data seed >/dev/null || fail "the restored server does not take a new post"

step "PASSED: backup, verify and restore on a real stack"
