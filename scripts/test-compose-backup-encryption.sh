#!/usr/bin/env bash
# Backups are encrypted at rest (deploy/compose/backup.sh): ./run.sh backup packs its folder into
# backups/<name>.tar.age, encrypted to the PUBLIC key BUZZ_BACKUP_AGE_RECIPIENT, so the server holds nothing that can
# open a backup. This test runs the real run.sh and backup.sh against a stand-in `docker` that writes fixture data, so it
# needs no Docker and no network. It covers:
#
#   - backup (and upgrade, which backs up first) refuses with no key, with the CHANGE_ME placeholder and with a key that
#     is not one, before touching anything; start does not need the key; every other CHANGE_ME still stops start
#   - BUZZ_BACKUP_ALLOW_UNENCRYPTED=true is the one way around it, and says so
#   - the encrypted file exists, the plain folder is gone, nothing readable is in the file, the sidecar's hash matches
#   - verify-backup without the private key checks the sidecar hash; a changed file, or a missing sidecar, fails
#   - verify-backup with AGE_IDENTITY_FILE opens it and checks the manifest; changes inside the archive fail
#   - restore needs --yes and AGE_IDENTITY_FILE, uses the decrypted data, and leaves no temp folder, also on failure
#   - plain-folder backups still verify and restore; prune-backups removes both forms
#   - a backup that fails (a docker step) or is stopped (TERM) before the encrypted file exists leaves no plain folder
#     and no .partial file; a folder the operator cannot delete (root-owned media files) is removed through a container,
#     and when that fails too the script exits non-zero and names the folder
#
# Needs the `age` program (apt-get install -y age / brew install age). Without it the cases that need it are skipped,
# loudly, and the script exits 1 unless ALLOW_SKIP_AGE=1.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/creaton-backup-enc.XXXXXX")"
trap 'rm -rf "${TEST_DIR}"' EXIT

C="${TEST_DIR}/compose"
mkdir -p "$C" "${TEST_DIR}/bin" "${TEST_DIR}/tmp" "${TEST_DIR}/keys"
cp "${REPO_ROOT}/deploy/compose/run.sh" "${REPO_ROOT}/deploy/compose/backup.sh" "${REPO_ROOT}/deploy/compose/compose-env.sh" "$C/"
export TMPDIR="${TEST_DIR}/tmp"
unset AGE_IDENTITY_FILE BUZZ_BACKUP_AGE_RECIPIENT BUZZ_BACKUP_ALLOW_UNENCRYPTED

FAILS=0
fail() {
  echo "FAIL: $1" >&2
  FAILS=$((FAILS + 1))
}
pass() { echo "ok:   $1"; }
check() { # description, then a command: passes when it succeeds
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}
sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# The stand-in docker: logs every call, and writes what the real containers would put in the backup folder.
cat >"${TEST_DIR}/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"${DOCKER_LOG}"
# Test switches: fail any call whose arguments contain DOCKER_FAIL_ON; send TERM to the calling script on DOCKER_TERM_ON.
if [[ -n "${DOCKER_FAIL_ON:-}" && "$*" == *"$DOCKER_FAIL_ON"* ]]; then exit 1; fi
if [[ -n "${DOCKER_TERM_ON:-}" && "$*" == *"$DOCKER_TERM_ON"* ]]; then
  kill -TERM "$PPID"
  exit 0
fi
args=("$@")
n=${#args[@]}
for ((i = 0; i < n; i++)); do
  case "${args[i]}" in
    cp)
      if [[ "${args[i + 1]}" == postgres:* ]]; then
        printf 'PLAINTEXT-MARKER-DUMP' >"${args[i + 2]}"
      else
        echo "RESTORE_DUMP=$(cat "${args[i + 1]}")" >>"${DOCKER_LOG}"
      fi
      exit 0
      ;;
    -v)
      v="${args[i + 1]}"
      if [[ "$v" == *:/plain ]]; then
        # The root container that empties a plain folder the operator could not delete.
        /bin/rm -rf "${v%:/plain}"/* "${v%:/plain}"/.[!.]* 2>/dev/null
      fi
      if [[ "$v" == *:/backup ]]; then
        host="${v%:/backup}"
        if [[ "$host" == */media ]]; then
          printf 'media-object' >"$host/obj1"
        elif [[ "$*" == *"--entrypoint tar"* ]]; then
          printf 'PLAINTEXT-MARKER-GIT' >"$host/git.tar.gz"
        fi
      fi
      ;;
    config)
      [[ "${args[i + 1]}" == "--images" ]] && echo "creaton-relay:test"
      exit 0
      ;;
    inspect) exit 1 ;;
  esac
done
if [[ "$*" == *psql* ]]; then echo 7; fi
exit 0
STUB
chmod +x "${TEST_DIR}/bin/docker"
# A stand-in `rm` that cannot delete the folder named in RM_FAIL_DIR while it still has something in it (as when the
# media bucket's root container left root-owned folders inside); everything else is the real rm.
cat >"${TEST_DIR}/bin/rm" <<'STUB'
#!/usr/bin/env bash
if [[ -n "${RM_FAIL_DIR:-}" ]]; then
  for a in "$@"; do
    if [[ "$a" == "$RM_FAIL_DIR" && -d "$a" && -n "$(ls -A "$a")" ]]; then
      echo "rm: cannot remove '$a/media/x': Permission denied" >&2
      exit 1
    fi
  done
fi
exec /bin/rm "$@"
STUB
chmod +x "${TEST_DIR}/bin/rm"
export PATH="${TEST_DIR}/bin:${PATH}"
export DOCKER_LOG="${TEST_DIR}/docker.log"
: >"$DOCKER_LOG"

RELAY_KEY="$(printf 'ab%.0s' {1..32})"
SECRET_MARKER="PLAINTEXT-MARKER-SECRET-4f9a"
write_env() { # extra .env lines
  {
    printf 'BUZZ_COMPOSE_CREATON=true\nBUZZ_RELAY_PRIVATE_KEY=%s\nPOSTGRES_PASSWORD=%s\n' "$RELAY_KEY" "$SECRET_MARKER"
    local line
    for line in "$@"; do echo "$line"; done
  } >"$C/.env"
}
OUT="${TEST_DIR}/out"
run() { (cd "$C" && ./run.sh "$@") >"$OUT" 2>&1; }
run_with_identity() { # identity file, then the command
  local id="$1"
  shift
  (cd "$C" && AGE_IDENTITY_FILE="$id" ./run.sh "$@") >"$OUT" 2>&1
}
says() { grep -qF -- "$1" "$OUT"; }
docker_calls() { wc -l <"$DOCKER_LOG" | tr -d ' '; }
temp_left() { find "$TMPDIR" -mindepth 1 -maxdepth 1 | head -n 1; }
refuses() { # description, command..., then the fragments the message must hold (after a literal --)
  local what="$1" before="$(docker_calls)"
  shift
  local cmd=() frag=() seen=false a
  for a in "$@"; do
    if [[ "$a" == -- ]]; then seen=true; elif $seen; then frag+=("$a"); else cmd+=("$a"); fi
  done
  if run "${cmd[@]}"; then
    fail "$what: ${cmd[*]} went through"
    return
  fi
  for a in ${frag[@]+"${frag[@]}"}; do
    says "$a" || fail "$what: the refusal does not say '$a' (it said: $(head -c 300 "$OUT"))"
  done
  pass "$what"
}

# ─── The files that ship ───────────────────────────────────────────────────────────────────────────────────────────
if grep -qE '^BUZZ_BACKUP_AGE_RECIPIENT=CHANGE_ME_age_public_key$' "${REPO_ROOT}/deploy/compose/.env.creaton.example"; then
  pass ".env.creaton.example has BUZZ_BACKUP_AGE_RECIPIENT=CHANGE_ME_age_public_key"
else
  fail ".env.creaton.example has no BUZZ_BACKUP_AGE_RECIPIENT=CHANGE_ME_age_public_key line"
fi
check "cloud-init.yaml installs the age package" grep -qE '^  - age$' "${REPO_ROOT}/deploy/ovh/cloud-init.yaml"
check "deploy/ovh/README.md tells an existing server to install age" grep -q 'sudo apt-get install -y age' "${REPO_ROOT}/deploy/ovh/README.md"

# ─── Refusals: no key, the placeholder ─────────────────────────────────────────────────────────────────────────────
write_env
refuses "backup without a key is refused" backup "$C/b-nokey" -- BUZZ_BACKUP_AGE_RECIPIENT 'age-keygen -o creaton-backup.key' 'password manager' 'must not live on this server'
[[ ! -e "$C/b-nokey" ]] && pass "a refused backup made no folder" || fail "a refused backup left a folder"

write_env 'BUZZ_BACKUP_AGE_RECIPIENT=CHANGE_ME_age_public_key'
before="$(docker_calls)"
refuses "backup with the CHANGE_ME placeholder is refused" backup "$C/b-change" -- BUZZ_BACKUP_AGE_RECIPIENT 'age-keygen -o creaton-backup.key'
[[ "$(docker_calls)" == "$before" ]] && pass "a refused backup did not call Docker" || fail "a refused backup called Docker"

before="$(docker_calls)"
refuses "upgrade (which backs up first) is refused without a key" upgrade -- BUZZ_BACKUP_AGE_RECIPIENT
if sed -n "$((before + 1)),\$p" "$DOCKER_LOG" | grep -qE ' (pull|build|up) '; then
  fail "upgrade pulled, built or started something before its backup was refused"
else
  pass "upgrade changed nothing before its backup was refused"
fi

# start and restart do not need the key; every other CHANGE_ME still stops them.
if run start; then pass "start does not need the backup key"; else fail "start was stopped by the backup key placeholder: $(head -c 300 "$OUT")"; fi
if run restart; then pass "restart does not need the backup key"; else fail "restart was stopped by the backup key placeholder"; fi
write_env 'BUZZ_BACKUP_AGE_RECIPIENT=CHANGE_ME_age_public_key' 'REDIS_PASSWORD=CHANGE_ME_redis'
refuses "start still stops on any other CHANGE_ME" start -- REDIS_PASSWORD
says BUZZ_BACKUP_AGE_RECIPIENT && fail "the other-CHANGE_ME refusal lists the backup key too" || pass "the other-CHANGE_ME refusal does not list the backup key"

# ─── The deliberate override ───────────────────────────────────────────────────────────────────────────────────────
write_env 'BUZZ_BACKUP_AGE_RECIPIENT=CHANGE_ME_age_public_key' 'BUZZ_BACKUP_ALLOW_UNENCRYPTED=true'
if run backup "$C/b-plain"; then
  pass "BUZZ_BACKUP_ALLOW_UNENCRYPTED=true allows a plain backup"
  [[ -f "$C/b-plain/MANIFEST.sha256" && -f "$C/b-plain/env" ]] && pass "the plain backup is the folder it always was" || fail "the plain backup has no manifest or env"
  says 'NOT encrypted' && pass "the plain backup says it is not encrypted" || fail "the plain backup does not say it is not encrypted"
  [[ ! -e "$C/b-plain.tar.age" ]] && pass "a plain backup makes no encrypted file" || fail "a plain backup made an encrypted file"
else
  fail "the override did not allow a plain backup: $(head -c 300 "$OUT")"
fi

# ─── Old plain folders stay verifiable and restorable ──────────────────────────────────────────────────────────────
if [[ -d "$C/b-plain" ]]; then
  write_env 'BUZZ_BACKUP_AGE_RECIPIENT=CHANGE_ME_age_public_key'
  run verify-backup "$C/b-plain" && pass "a plain-folder backup still verifies" || fail "a plain-folder backup no longer verifies: $(head -c 300 "$OUT")"
  : >"$DOCKER_LOG"
  run restore "$C/b-plain" --yes && pass "a plain-folder backup still restores" || fail "a plain-folder backup no longer restores: $(head -c 300 "$OUT")"
  grep -q 'RESTORE_DUMP=PLAINTEXT-MARKER-DUMP' "$DOCKER_LOG" && pass "the plain restore used the folder's database dump" || fail "the plain restore did not use the folder's dump"
fi

# ─── Everything below needs the age program ────────────────────────────────────────────────────────────────────────
if ! command -v age >/dev/null 2>&1 || ! command -v age-keygen >/dev/null 2>&1; then
  echo "SKIPPED LOUDLY: the age program is not installed, so the encryption and round-trip cases did NOT run." >&2
  echo "Install it (sudo apt-get install -y age, or brew install age) and run this again." >&2
  if [[ "${ALLOW_SKIP_AGE:-}" == 1 ]]; then
    ((FAILS == 0)) && exit 0
  fi
  exit 1
fi

KEY="${TEST_DIR}/keys/backup.key"
OTHER_KEY="${TEST_DIR}/keys/other.key"
age-keygen -o "$KEY" >/dev/null 2>&1
age-keygen -o "$OTHER_KEY" >/dev/null 2>&1
PUB="$(age-keygen -y "$KEY")"
OTHER_PUB="$(age-keygen -y "$OTHER_KEY")"

write_env 'BUZZ_BACKUP_AGE_RECIPIENT=age1notakey'
refuses "a recipient that is not an age key is refused before any work" backup "$C/b-bad" -- BUZZ_BACKUP_AGE_RECIPIENT
[[ ! -e "$C/b-bad" ]] && pass "no folder was made for a bad key" || fail "a folder was made for a bad key"

write_env "BUZZ_BACKUP_AGE_RECIPIENT=$PUB"
B="${TEST_DIR}/store"
mkdir -p "$B"
if run backup "$B/20260101T030000Z"; then
  pass "backup with a key succeeds"
else
  fail "backup with a key failed: $(head -c 400 "$OUT")"
fi
ENC="$B/20260101T030000Z.tar.age"
SIDE="$B/20260101T030000Z.sha256"
[[ -s "$ENC" ]] && pass "the encrypted file exists and is not empty" || fail "no encrypted file at $ENC"
[[ ! -e "$B/20260101T030000Z" ]] && pass "the plain folder is gone" || fail "the plain folder is still there"
[[ -z "$(ls "$B" | grep -v -E '\.(tar\.age|sha256)$' || true)" ]] && pass "nothing but the file and its sidecar is left" || fail "extra files left: $(ls "$B")"
[[ "$(head -c 21 "$ENC" 2>/dev/null)" == "age-encryption.org/v1" ]] && pass "the file is an age file" || fail "the file does not start as an age file"
if grep -qaE 'PLAINTEXT-MARKER|BUZZ_RELAY_PRIVATE_KEY|postgres.dump' "$ENC" 2>/dev/null; then
  fail "the encrypted file holds readable text from the backup"
else
  pass "no readable secret, file name or data in the encrypted file"
fi
[[ -s "$SIDE" ]] && pass "the sidecar exists" || fail "no sidecar at $SIDE"
want="$(sed -n '1s/ .*//p' "$SIDE" 2>/dev/null)"
got="$(cd "$B" && sha 20260101T030000Z.tar.age | cut -d' ' -f1)"
[[ -n "$want" && "$want" == "$got" ]] && pass "the sidecar holds the encrypted file's hash" || fail "the sidecar hash '$want' is not the file's '$got'"
grep -qE '^manifest_sha256=[0-9a-f]{64}$' "$SIDE" 2>/dev/null && pass "the sidecar holds the manifest's hash" || fail "the sidecar has no manifest_sha256 line"
if [[ -n "$(find "$B" -perm -004 -type f 2>/dev/null | head -n 1)" ]]; then fail "a backup file is readable by everyone"; else pass "backup files are private to the operator"; fi
[[ -z "$(temp_left)" ]] && pass "backup left no temp folder" || fail "backup left a temp folder: $(temp_left)"


# ─── A backup that does not finish leaves no plain folder ──────────────────────────────────────────────────────────
# The plain folder holds env (every secret) and the whole database. A nightly job that keeps failing must not pile it up.
no_leftovers() { # description, store folder
  if [[ -z "$(ls -A "$2")" ]]; then pass "$1: nothing is left in the backup folder"; else fail "$1: left behind: $(ls -A "$2" | tr '\n' ' ')"; fi
}
F="${TEST_DIR}/failstore"
mkdir -p "$F"
: >"$DOCKER_LOG"
if DOCKER_FAIL_ON='--images' run backup "$F/20260102T030000Z"; then
  fail "a backup whose docker step failed reported success"
else
  pass "a backup whose docker step failed (after the env copy) fails"
fi
grep -q -- '--images' "$DOCKER_LOG" && pass "the failure came after the settings were copied into the folder" || fail "the failing step was not reached, so the test proves nothing"
no_leftovers "a failed backup" "$F"
[[ -z "$(temp_left)" ]] && pass "a failed backup left no temp folder" || fail "a failed backup left a temp folder"

: >"$DOCKER_LOG"
if DOCKER_TERM_ON='cp postgres:' run backup "$F/20260103T030000Z"; then
  fail "a backup that was sent TERM reported success"
else
  pass "a backup stopped by TERM (cron, Ctrl-C) ends with an error"
fi
grep -q 'cp postgres:' "$DOCKER_LOG" && pass "the signal came while the plain folder held the database dump" || fail "the signal step was not reached"
no_leftovers "a stopped backup" "$F"

# The encryption itself fails (age cannot write): the plain folder goes, and so does the half-written file.
mkdir -p "${TEST_DIR}/failage"
cat >"${TEST_DIR}/failage/age" <<AGESTUB
#!/usr/bin/env bash
if [[ "\$*" == *" -o "* ]]; then cat >/dev/null; echo partial >"\${@: -1}"; exit 1; fi
exec "$(command -v age)" "\$@"
AGESTUB
chmod +x "${TEST_DIR}/failage/age"
if (cd "$C" && PATH="${TEST_DIR}/failage:$PATH" ./run.sh backup "$F/20260104T030000Z") >"$OUT" 2>&1; then
  fail "a backup whose encryption failed reported success"
else
  pass "a backup whose encryption failed ends with an error"
  says 'could not be encrypted' && pass "and says so" || fail "the encryption failure is not named: $(head -c 300 "$OUT")"
fi
no_leftovers "a backup whose encryption failed" "$F"

# The plain folder holds something the operator cannot delete: it is removed through a root container instead.
: >"$DOCKER_LOG"
if RM_FAIL_DIR="$F/20260105T030000Z" run backup "$F/20260105T030000Z"; then
  pass "a plain folder the operator cannot delete is removed through a container, and the backup finishes"
  grep -q ':/plain' "$DOCKER_LOG" && pass "the root container did the removal" || fail "the container removal was not used"
  [[ ! -e "$F/20260105T030000Z" && -s "$F/20260105T030000Z.tar.age" && -s "$F/20260105T030000Z.sha256" ]] \
    && pass "the plain folder is gone and the encrypted file and sidecar are there" || fail "after the container removal: $(ls -A "$F")"
else
  fail "the container removal did not save the backup: $(head -c 400 "$OUT")"
fi
rm -f "$F"/20260105T030000Z.*

# ... and when that fails too the script exits non-zero and names the folder it could not remove.
: >"$DOCKER_LOG"
if RM_FAIL_DIR="$F/20260106T030000Z" DOCKER_FAIL_ON=':/plain' run backup "$F/20260106T030000Z"; then
  fail "a backup that left its plain folder behind reported success"
else
  pass "a backup that cannot remove its plain folder exits with an error"
  says "$F/20260106T030000Z could not be removed" && pass "and names the folder to delete" || fail "the message does not name the folder: $(head -c 400 "$OUT")"
  says 'done:' && fail "it printed the done message" || pass "and does not print the done message"
fi
[[ -d "$F/20260106T030000Z" ]] && pass "the folder really is still there (the message is true)" || fail "the folder is gone, so the message was wrong"
/bin/rm -rf "$F"

# A backup with no name goes to backups/<UTC time>.tar.age.
if run backup && ls "$C"/backups/[0-9]*T[0-9]*Z.tar.age >/dev/null 2>&1; then pass "a default backup is backups/<UTC time>.tar.age"; else fail "a default backup is not backups/<UTC time>.tar.age: $(head -c 300 "$OUT")"; fi
rm -rf "$C/backups"

# ─── verify-backup, without and with the private key ───────────────────────────────────────────────────────────────
if run verify-backup "$ENC"; then
  pass "verify-backup checks the sidecar hash without the private key"
  says 'not opened' && pass "and says the contents were not opened" || fail "it does not say the contents were not opened"
else
  fail "verify-backup of a good file failed without the key: $(head -c 300 "$OUT")"
fi

T="${TEST_DIR}/tamper"
mkdir -p "$T"
cp "$ENC" "$T/20260101T030000Z.tar.age"
cp "$SIDE" "$T/20260101T030000Z.sha256"
echo x >>"$T/20260101T030000Z.tar.age"
refuses "a changed encrypted file fails verify-backup" verify-backup "$T/20260101T030000Z.tar.age" -- 'does not match'
mkdir -p "$T/nosidecar"
cp "$ENC" "$T/nosidecar/20260101T030000Z.tar.age"
refuses "a file with no sidecar fails verify-backup" verify-backup "$T/nosidecar/20260101T030000Z.tar.age" -- sidecar
refuses "a file that does not exist fails verify-backup" verify-backup "$B/missing.tar.age" -- 'no such'

if run_with_identity "$KEY" verify-backup "$ENC"; then
  pass "verify-backup with AGE_IDENTITY_FILE opens the archive"
  says 'matches its manifest' && pass "and checks the manifest" || fail "it does not say the manifest matched"
else
  fail "verify-backup with the key failed: $(head -c 300 "$OUT")"
fi
[[ -z "$(temp_left)" ]] && pass "verify-backup removed its temp folder" || fail "verify-backup left a temp folder"

if run_with_identity "$OTHER_KEY" verify-backup "$ENC"; then fail "verify-backup opened an archive with the wrong key"; else pass "the wrong private key does not open the archive"; fi
[[ -z "$(temp_left)" ]] && pass "a failed decrypt left no temp folder" || fail "a failed decrypt left a temp folder: $(temp_left)"

# A change inside the archive (made by someone who can encrypt to the public key, which the server holds): the
# manifest catches a changed file, and the sidecar's manifest hash catches a rewritten manifest.
X="${TEST_DIR}/unpacked"
mkdir -p "$X"
age -d -i "$KEY" "$ENC" | tar -xf - -C "$X"
NAME=20260101T030000Z
repack() { # new archive name; encrypts $X/$NAME, writes a sidecar with the new file's hash and the original manifest hash
  tar -cf - -C "$X" "$NAME" | age -r "$PUB" -o "$T/$1.tar.age"
  printf '%s  %s.tar.age\nmanifest_sha256=%s\n' "$(cd "$T" && sha "$1.tar.age" | cut -d' ' -f1)" "$1" "$(sed -n 's/^manifest_sha256=//p' "$SIDE")" >"$T/$1.sha256"
}
echo tampered >>"$X/$NAME/git.tar.gz"
repack inner-file
if run_with_identity "$KEY" verify-backup "$T/inner-file.tar.age"; then fail "a file changed inside the archive passed verify-backup"; else pass "a file changed inside the archive fails verify-backup"; fi
(cd "$X/$NAME" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | sed 's|^\./||' | while IFS= read -r p; do sha "$p"; done) >"$X/$NAME/MANIFEST.sha256"
repack inner-manifest
if run_with_identity "$KEY" verify-backup "$T/inner-manifest.tar.age"; then
  fail "a rewritten manifest passed verify-backup with the key"
else
  pass "a rewritten manifest fails verify-backup with the key"
  says 'recorded in its sidecar' && pass "and the refusal names the sidecar's manifest hash" || fail "the refusal does not name the sidecar's manifest hash: $(head -c 300 "$OUT")"
fi

# ─── restore ───────────────────────────────────────────────────────────────────────────────────────────────────────
: >"$DOCKER_LOG"
refuses "restore of an encrypted backup needs --yes" restore "$ENC" -- '--yes'
refuses "restore of an encrypted backup needs AGE_IDENTITY_FILE" restore "$ENC" --yes -- AGE_IDENTITY_FILE
grep -qE ' (stop|down) ' "$DOCKER_LOG" && fail "a refused restore stopped the server" || pass "a refused restore left the server alone"
if run_with_identity "${TEST_DIR}/keys/nothing.key" restore "$ENC" --yes; then fail "restore ran with an identity file that does not exist"; else pass "restore refuses an identity file that does not exist"; fi
: >"$DOCKER_LOG"
if run_with_identity "$OTHER_KEY" restore "$ENC" --yes; then fail "restore ran with the wrong private key"; else pass "restore refuses the wrong private key"; fi
grep -qE ' (stop|down) ' "$DOCKER_LOG" && fail "a restore with the wrong key stopped the server" || pass "a restore with the wrong key left the server alone"
[[ -z "$(temp_left)" ]] && pass "a restore that failed to decrypt left no temp folder" || fail "left a temp folder: $(temp_left)"

: >"$DOCKER_LOG"
if run_with_identity "$KEY" restore "$ENC" --yes; then
  pass "restore of an encrypted backup with the key succeeds"
  grep -q 'RESTORE_DUMP=PLAINTEXT-MARKER-DUMP' "$DOCKER_LOG" && pass "round trip: the database dump restored is the one that was backed up" || fail "round trip: the restored dump is not the backed-up one"
else
  fail "restore of an encrypted backup failed: $(head -c 500 "$OUT")"
fi
[[ -z "$(temp_left)" ]] && pass "restore removed its temp folder" || fail "restore left a temp folder: $(temp_left)"

# A restore that fails after decrypting (here: another server key in .env) still removes the decrypted folder.
write_env "BUZZ_BACKUP_AGE_RECIPIENT=$PUB"
sed 's/^BUZZ_RELAY_PRIVATE_KEY=.*/BUZZ_RELAY_PRIVATE_KEY=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd/' "$C/.env" >"$C/.env.new" && mv "$C/.env.new" "$C/.env"
if run_with_identity "$KEY" restore "$ENC" --yes; then fail "restore ran under another server key"; else pass "restore under another server key is refused"; fi
[[ -z "$(temp_left)" ]] && pass "a restore refused after decrypting removed its temp folder" || fail "left a temp folder: $(temp_left)"

# ─── prune-backups handles both forms ──────────────────────────────────────────────────────────────────────────────
P="$C/backups"
mkdir -p "$P/20200101T000000Z" "$P/20200102T000000Z.sidecar-test" "$P/not-a-backup"
touch "$P/20200101T000000Z/MANIFEST.sha256" "$P/20200201T000000Z.tar.age" "$P/20200201T000000Z.sha256" "$P/keepme.tar.age"
touch -t 202001010000 "$P/20200101T000000Z" "$P/20200201T000000Z.tar.age" "$P/20200201T000000Z.sha256" "$P/not-a-backup"
mkdir "$P/20990101T000000Z"
cp "$ENC" "$P/20990102T000000Z.tar.age"
cp "$SIDE" "$P/20990102T000000Z.sha256"
if run prune-backups 14; then pass "prune-backups runs"; else fail "prune-backups failed: $(head -c 300 "$OUT")"; fi
[[ ! -e "$P/20200101T000000Z" ]] && pass "an old plain folder is pruned" || fail "an old plain folder was kept"
[[ ! -e "$P/20200201T000000Z.tar.age" && ! -e "$P/20200201T000000Z.sha256" ]] && pass "an old encrypted file and its sidecar are pruned" || fail "an old encrypted file or its sidecar was kept"
[[ -d "$P/20990101T000000Z" && -f "$P/20990102T000000Z.tar.age" && -f "$P/20990102T000000Z.sha256" ]] && pass "recent backups of both forms are kept" || fail "a recent backup was pruned"
[[ -d "$P/not-a-backup" && -f "$P/keepme.tar.age" ]] && pass "files not named like a backup are left alone" || fail "prune touched a file not named like a backup"
says '2 backup(s)' && pass "prune counts both forms" || fail "prune counts wrongly: $(cat "$OUT")"

echo
if ((FAILS > 0)); then
  echo "$FAILS check(s) FAILED" >&2
  exit 1
fi
echo "PASS: encrypted backups, verify, restore and prune"
