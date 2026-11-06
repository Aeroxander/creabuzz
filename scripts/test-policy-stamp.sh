#!/usr/bin/env bash
# The "Last updated" check in deploy/compose/compose-env.sh (check_policy_stamp) and ./run.sh policy-stamp: the terms'
# and privacy note's Last updated line must change whenever the served text changes. policy-stamp records a hash of each
# file (without its Last updated line) and the date found, in <policy folder>/.stamps/. The start guard refuses a file
# with no stamp, a file whose text changed since the stamp, and policy-stamp itself refuses to record changed text under
# an unchanged date. No Docker needed: `docker` is a stand-in that always succeeds.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/creaton-policy-stamp.XXXXXX")"
trap 'rm -rf "${TEST_DIR}"' EXIT

mkdir -p "${TEST_DIR}/compose/policies" "${TEST_DIR}/bin"
cp "${REPO_ROOT}/deploy/compose/run.sh" "${REPO_ROOT}/deploy/compose/backup.sh" "${REPO_ROOT}/deploy/compose/compose-env.sh" \
  "${TEST_DIR}/compose/"
printf '#!/usr/bin/env bash\nexit 0\n' >"${TEST_DIR}/bin/docker"
chmod +x "${TEST_DIR}/bin/docker"
export PATH="${TEST_DIR}/bin:${PATH}"
cd "${TEST_DIR}/compose"
printf 'BUZZ_COMPOSE_CREATON=true\nBUZZ_TERMS_FILE=policies/terms.md\nBUZZ_PRIVACY_FILE=policies/privacy.md\n' >.env

fail() {
  echo "FAIL: $1" >&2
  cat "${TEST_DIR}/out" >&2 || true
  exit 1
}

run() { ./run.sh "$@" >"${TEST_DIR}/out" 2>&1; }
ok() { run "$@" || fail "$* was refused"; }
refused() { # command, then the fragments the message must hold
  local cmd="$1"
  shift
  if run "$cmd"; then fail "$cmd went through"; fi
  local part
  for part in "$@"; do
    grep -qF -- "$part" "${TEST_DIR}/out" || fail "$cmd: the refusal does not say '$part'"
  done
}

terms() { printf 'Last updated: %s\n\n%s\n' "$1" "$2" >policies/terms.md; }
privacy() { printf '**Last updated:** %s\n\n%s\n' "$1" "$2" >policies/privacy.md; }

terms "1 March 2026" "Terms text."
privacy "1 March 2026" "Privacy text."

# No stamp yet: refused once, and told to stamp after the approved text is in place.
refused config "policies/terms.md" "no stamp" "policy-stamp" "approved"
ok policy-stamp
[[ -f policies/.stamps/terms.md.stamp && -f policies/.stamps/privacy.md.stamp ]] || fail "policy-stamp wrote no stamp files"
grep -q "1 March 2026" policies/.stamps/privacy.md.stamp || fail "the stamp does not hold the date (bold markers parsed wrongly)"
ok config

# Unchanged text passes, and so does a changed date on its own.
ok start
terms "2 March 2026" "Terms text."
ok config
ok policy-stamp

# Changed text, same date: refused, names the file, says what to do. policy-stamp will not record it either.
terms "2 March 2026" "Terms text, changed."
refused config "policies/terms.md" "Last updated" "policy-stamp"
refused policy-stamp "policies/terms.md" "Last updated"
if grep -q "privacy.md" "${TEST_DIR}/out"; then fail "the refusal names the privacy note, which did not change"; fi
refused start "policies/terms.md" "Last updated"
refused upgrade "policies/terms.md" "Last updated"

# Changed text, new date, but not stamped: refused until policy-stamp records it.
terms "3 March 2026" "Terms text, changed."
refused config "policies/terms.md" "policy-stamp"
ok policy-stamp
ok config

# The privacy note is checked on its own, by its own file name.
privacy "1 March 2026" "Privacy text, changed."
refused config "policies/privacy.md" "Last updated"
privacy "4 March 2026" "Privacy text, changed."
ok policy-stamp
ok config

# A missing or empty Last updated line: policy-stamp says so, and so does the start guard.
printf 'No date here.\n' >policies/terms.md
refused policy-stamp "policies/terms.md" "Last updated"
refused config "policies/terms.md" "Last updated"
printf 'Last updated:\n\nText.\n' >policies/terms.md
refused policy-stamp "policies/terms.md" "Last updated"
# A date still in a [bracket] is the placeholder guard's, which comes first.
printf 'Last updated: [date]\n\nText.\n' >policies/terms.md
refused config "policies/terms.md:1:" "[date]"
refused policy-stamp "policies/terms.md:1:" "[date]"

# A backup holds the stamps beside the policy files it takes.
terms "5 March 2026" "Terms text, again."
ok policy-stamp
ok backup "${TEST_DIR}/backup"
[[ -f "${TEST_DIR}/backup/policies/.stamps/terms.md.stamp" ]] || fail "the backup holds no stamp for the terms"
[[ -f "${TEST_DIR}/backup/policies/.stamps/privacy.md.stamp" ]] || fail "the backup holds no stamp for the privacy note"
grep -q "policies/.stamps/terms.md.stamp" "${TEST_DIR}/backup/MANIFEST.sha256" || fail "the stamp is not in the manifest"

# A backup is never held up by the legal text: an edited, not yet stamped policy file still backs up (start, restart and
# upgrade are the commands that refuse it).
terms "6 March 2026" "Terms text, edited and not stamped yet."
refused start "policies/terms.md" "policy-stamp"
ok backup "${TEST_DIR}/backup-unstamped"
[[ -f "${TEST_DIR}/backup-unstamped/policies/terms.md" ]] || fail "the backup of an unstamped edit holds no terms"
ok policy-stamp

# Restoring on a new machine, which has no policy files and no stamps yet, brings back what the backup holds and starts:
# the stub docker takes no dump, so the folder is made by hand in the shape verify-backup checks.
fake="${TEST_DIR}/backup-fake"
mkdir -p "${fake}/media" "${fake}/policies/.stamps"
touch "${fake}/postgres.dump" "${fake}/git.tar.gz" "${fake}/about.txt"
cp .env "${fake}/env"
cp policies/terms.md policies/privacy.md "${fake}/policies/"
cp policies/.stamps/* "${fake}/policies/.stamps/"
(cd "${fake}" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | sed 's|^\./||' | xargs sha256sum >MANIFEST.sha256)
rm -rf policies
refused start "no such file"
ok restore "${fake}" --yes
[[ -f policies/terms.md && -f policies/.stamps/terms.md.stamp && -f policies/.stamps/privacy.md.stamp ]] ||
  fail "restore did not bring back the policy files and their stamps"
ok config
# A stamp this machine already has is never replaced by the backup's.
printf 'hash=other\nlast_updated=1 January 2020\n' >policies/.stamps/terms.md.stamp
run restore "${fake}" --yes || true
grep -q "hash=other" policies/.stamps/terms.md.stamp || fail "restore replaced a stamp this machine already had"

echo "PASS: the Last updated check refuses a missing stamp and changed text under an unchanged date, and accepts the rest"
