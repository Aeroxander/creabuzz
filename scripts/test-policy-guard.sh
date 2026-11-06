#!/usr/bin/env bash
# The start guard in deploy/compose/compose-env.sh (load_policies) refuses a terms or privacy file that still has a
# draft's [placeholders]: a bracket pair on one line, a pair that spans two lines, an open bracket never closed and a
# close bracket never opened. A Markdown link [text](url) (also with a bracket inside its text) and a code fence or code
# span are fine. The refusal lists each file, line number and text. When BUZZ_TERMS_FILE or BUZZ_PRIVACY_FILE is unset,
# run.sh warns and names the setting. No Docker needed: `docker` is a stand-in.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/creaton-policy-guard.XXXXXX")"
trap 'rm -rf "${TEST_DIR}"' EXIT

mkdir -p "${TEST_DIR}/compose/policies" "${TEST_DIR}/bin"
cp "${REPO_ROOT}/deploy/compose/run.sh" "${REPO_ROOT}/deploy/compose/compose-env.sh" "${TEST_DIR}/compose/"
printf '#!/usr/bin/env bash\nexit 0\n' >"${TEST_DIR}/bin/docker"
chmod +x "${TEST_DIR}/bin/docker"
export PATH="${TEST_DIR}/bin:${PATH}"

fail() {
  echo "FAIL: $1" >&2
  cat "${TEST_DIR}/out" >&2 || true
  exit 1
}

# Runs `config` with the terms file set to the given text (the privacy file is always clean). Both files end with a
# Last updated line and are stamped (./run.sh policy-stamp, which a file with a blank cannot get), so only the blank
# decides the outcome (scripts/test-policy-stamp.sh tests the date and the stamp).
run_with() {
  printf '%s\nLast updated: 1 March 2026\n' "$1" >"${TEST_DIR}/compose/policies/terms.md"
  printf 'Clean privacy note, see [the terms](terms.md).\nLast updated: 1 March 2026\n' \
    >"${TEST_DIR}/compose/policies/privacy.md"
  printf 'BUZZ_COMPOSE_CREATON=true\nBUZZ_TERMS_FILE=policies/terms.md\nBUZZ_PRIVACY_FILE=policies/privacy.md\n' \
    >"${TEST_DIR}/compose/.env"
  rm -rf "${TEST_DIR}/compose/policies/.stamps"
  (cd "${TEST_DIR}/compose" && ./run.sh policy-stamp) >/dev/null 2>&1 || true
  (cd "${TEST_DIR}/compose" && ./run.sh config) >"${TEST_DIR}/out" 2>&1
}

refused() { # name, text, expected "line:text" fragment
  if run_with "$2"; then fail "$1: the guard let it through"; fi
  grep -q "policies/terms.md:$3" "${TEST_DIR}/out" || fail "$1: the refusal does not list file:line:text '$3'"
}

accepted() { # name, text
  run_with "$2" || fail "$1: the guard refused a file with no placeholder"
}

refused "one-line bracket" $'Run by.\nBy [Operator name] here.\n' '2:'
refused "two-line bracket" $'Intro\nWrite to [abuse and\ntakedown email] soon.\n' '2:.*abuse and'
refused "stray open bracket" $'Intro\nWrite to [abuse email soon.\n' '2:.*abuse email'
refused "stray close bracket" $'Intro\nWrite to abuse email] soon.\n' '2:.*abuse email'
refused "bracket then a space and parenthesis" $'Pay [30] (days) later.\n' '1:.*\[30\]'
refused "second placeholder after a link" $'See [terms](t.md) and [email].\n' '1:.*\[email\]'
refused "bracket after a code fence" $'```\n[inside]\n```\nOutside [here].\n' '4:.*\[here\]'

accepted "clean file" $'Plain text.\n\nMore text.\n'
accepted "markdown link" $'See [the terms](https://example.com/t) now.\n'
accepted "bracket inside link text" $'See [terms [1]](https://example.com/t) now.\n'
accepted "link text over two lines" $'See [the\nterms](https://example.com/t) now.\n'
accepted "code fence" $'```\n[Operator name] and [ stray\n```\nDone.\n'
accepted "code span" $'Write `[email]` as shown.\n'
accepted "escaped brackets" $'A \\[literal\\] pair.\n'

# Every blank is listed, not only the first.
if run_with $'[a]\nfine\n[b\nc]\n'; then fail "a file with several blanks went through"; fi
grep -q "terms.md:1:" "${TEST_DIR}/out" && grep -q "terms.md:3:" "${TEST_DIR}/out" || fail "not every blank is listed"
grep -q "Fill in or remove" "${TEST_DIR}/out" || fail "the refusal does not say what to do next"

# The warning when the files are not set names the setting(s) and what to do before inviting anyone.
printf 'BUZZ_COMPOSE_CREATON=true\nBUZZ_PRIVACY_FILE=policies/privacy.md\n' >"${TEST_DIR}/compose/.env"
(cd "${TEST_DIR}/compose" && ./run.sh policy-stamp) >/dev/null 2>&1 || fail "the privacy note could not be stamped"
(cd "${TEST_DIR}/compose" && ./run.sh start) >"${TEST_DIR}/out" 2>&1 || true
grep -q "BUZZ_TERMS_FILE" "${TEST_DIR}/out" || fail "the warning does not name the unset BUZZ_TERMS_FILE"
grep -q "shows no terms\." "${TEST_DIR}/out" || fail "the warning does not say what sign-up lacks"
grep -q "Before you invite anyone" "${TEST_DIR}/out" || fail "the warning does not say what to do before inviting anyone"
if grep -q "BUZZ_PRIVACY_FILE" "${TEST_DIR}/out"; then fail "the warning names BUZZ_PRIVACY_FILE, which is set"; fi

echo "PASS: the policy guard catches every kind of blank and accepts links, fences and clean files"
