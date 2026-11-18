#!/usr/bin/env bash
#
# deploy/ovh/keeper/test.sh — checks the keeper's server files without a server, a chain or a key.
#
#   1. install.sh --stage puts the script, unit, dry-run unit, timer and settings file where the server needs them, with
#      the right modes, twice over (running it again is safe), and refuses to enable or dry-run before the key, password
#      and node are in place;
#   2. the units say what the owner decided: a oneshot pass, settle only (KEEPER_OPEN=0), the key as a keystore credential
#      and the password as a sealed credential (or a root-only file with --plain-password), nothing on a command line;
#   3. the timer runs every 30 minutes and is one per market;
#   4. systemd-analyze verify accepts the files (skipped, loudly, where systemd-analyze is not installed);
#   5. a stubbed dry run: the real secondary-keeper.sh is run with exactly the environment the staged unit gives it, against
#      a fake cast, and says what it would settle while sending nothing and never reading the listing (settle only).
# Usage: deploy/ovh/keeper/test.sh      (bash; systemd-analyze optional)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
INSTALL="$HERE/install.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/creaton-keeper-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
MARKET="0x$(printf 'ab%.0s' {1..20})"

bash -n "$INSTALL" || fail "install.sh does not parse"
bash -n "$HERE/test.sh" || fail "test.sh does not parse"

STAGE="$WORK/stage"
mkdir -p "$STAGE"
"$INSTALL" --stage "$STAGE" >"$WORK/out" 2>&1 || { cat "$WORK/out" >&2; fail "install.sh --stage failed"; }
SERVICE="$STAGE/etc/systemd/system/creaton-keeper@.service"
DRY="$STAGE/etc/systemd/system/creaton-keeper-dry@.service"
TIMER="$STAGE/etc/systemd/system/creaton-keeper@.timer"
SCRIPT="$STAGE/usr/local/lib/creaton-keeper/secondary-keeper.sh"
ENVFILE="$STAGE/etc/creaton-keeper/keeper.env"
for file in "$SERVICE" "$DRY" "$TIMER" "$SCRIPT" "$ENVFILE"; do [[ -s "$file" ]] || fail "not installed: ${file#"$STAGE"}"; done

mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
[[ "$(mode "$ENVFILE")" == 600 ]] || fail "keeper.env is not mode 600"
[[ "$(mode "$STAGE/etc/creaton-keeper")" == 700 ]] || fail "the settings folder is not mode 700"
[[ "$(mode "$SCRIPT")" == 755 ]] || fail "the keeper script is not mode 755"
cmp -s "$SCRIPT" "$REPO_ROOT/scripts/secondary-keeper.sh" || fail "the installed script is not the checkout's"

# Running it again changes nothing the owner put there, and refreshes the rest.
echo "RPC_URL=https://node.example/key" >"$ENVFILE"
echo "x" >>"$SCRIPT"
"$INSTALL" --stage "$STAGE" >"$WORK/out" 2>&1 || fail "install.sh --stage failed the second time"
grep -q '^RPC_URL=https://node.example/key$' "$ENVFILE" || fail "a second install overwrote keeper.env"
cmp -s "$SCRIPT" "$REPO_ROOT/scripts/secondary-keeper.sh" || fail "a second install did not refresh the script"

# What the units say.
for want in 'Type=oneshot' 'DynamicUser=yes' 'KEEPER_OPEN=0' 'KEEPER_DRY_RUN=0' 'MARKET=%i' 'KEEPER_KEYSTORE=%d/keystore' \
            'KEEPER_PASSWORD_FILE=%d/password' 'LoadCredential=keystore:/etc/creaton-keeper/keystore.json' \
            'LoadCredentialEncrypted=password:/etc/creaton-keeper/password.cred' 'ExecStart=/usr/local/lib/creaton-keeper/secondary-keeper.sh --once' \
            'EnvironmentFile=/etc/creaton-keeper/keeper.env' 'TimeoutStartSec=' 'NoNewPrivileges=yes' 'ProtectSystem=strict'; do
  grep -qF -- "$want" "$SERVICE" || fail "the unit does not say: $want"
done
if grep -v '^#' "$SERVICE" "$DRY" "$TIMER" "$STAGE/etc/creaton-keeper/keeper.env" | grep -Eiq 'private[-_]?key|--password[^-]|nsec|0x[0-9a-f]{64}'; then
  fail "a unit names a private key or puts a password on a command line"
fi
grep -q 'KEEPER_DRY_RUN=1' "$DRY" || fail "the dry-run unit does not set KEEPER_DRY_RUN=1"
grep -q 'KEEPER_OPEN=0' "$DRY" || fail "the dry-run unit is not settle only"
diff <(sed -e 's/KEEPER_DRY_RUN=1/KEEPER_DRY_RUN=0/' -e 's/(dry run: sends nothing)/(one pass)/' "$DRY") "$SERVICE" >/dev/null ||
  fail "the dry-run unit differs from the real one in more than the dry-run switch (its sandbox would prove nothing)"
grep -q '^OnCalendar=\*:0/30$' "$TIMER" || fail "the timer is not every 30 minutes"
grep -q '^Persistent=true$' "$TIMER" || fail "the timer does not catch up a missed pass"
grep -q '%i' "$TIMER" || fail "the timer is not one per market"

# A root-only password file instead of a sealed one.
PLAIN="$WORK/plain"
mkdir -p "$PLAIN"
"$INSTALL" --stage "$PLAIN" --plain-password >"$WORK/out" 2>&1 || fail "install.sh --plain-password failed"
grep -q '^LoadCredential=password:/etc/creaton-keeper/password$' "$PLAIN/etc/systemd/system/creaton-keeper@.service" || fail "--plain-password did not switch the unit"
if grep -q '^LoadCredentialEncrypted=' "$PLAIN/etc/systemd/system/creaton-keeper@.service"; then fail "--plain-password left the sealed line in"; fi
grep -q '^LoadCredential=password:/etc/creaton-keeper/password$' "$PLAIN/etc/systemd/system/creaton-keeper-dry@.service" || fail "--plain-password did not switch the dry-run unit"

# enable and dry-run refuse a bad address and a machine without the pieces, naming what is missing.
refused() { # refused <what> <text the refusal says> <install.sh arguments...>
  local what="$1" says="$2"
  shift 2
  if "$INSTALL" "$@" >"$WORK/out" 2>&1; then fail "install.sh went ahead: $what"; fi
  grep -qF -- "$says" "$WORK/out" || { cat "$WORK/out" >&2; fail "the refusal for '$what' does not say: $says"; }
}
refused "a market that is not an address" "is not a market address" --stage "$STAGE" enable not-an-address
refused "a dry run without the keystore" "missing or empty: /etc/creaton-keeper/keystore.json" --stage "$STAGE" dry-run "$MARKET"
refused "an enable without the password" "missing or empty: /etc/creaton-keeper/password.cred" --stage "$STAGE" enable "$MARKET"
printf '{"keystore":"stand-in"}' >"$STAGE/etc/creaton-keeper/keystore.json"
printf 'stand-in' >"$STAGE/etc/creaton-keeper/password.cred"
echo "RPC_URL=CHANGE_ME_SEPOLIA_NODE_URL" >"$ENVFILE"
refused "a node address left as CHANGE_ME" "still says CHANGE_ME" --stage "$STAGE" enable "$MARKET"
echo "RPC_URL=https://node.example/key" >"$ENVFILE"
"$INSTALL" --stage "$STAGE" dry-run "$MARKET" >"$WORK/out" 2>&1 || { cat "$WORK/out" >&2; fail "dry-run refused a machine that has everything"; }
grep -q "creaton-keeper-dry@${MARKET}.service" "$WORK/out" || fail "dry-run does not start the dry-run unit"
"$INSTALL" --stage "$STAGE" enable "$MARKET" >"$WORK/out" 2>&1 || fail "enable refused a machine that has everything"
grep -q "creaton-keeper@${MARKET}.timer" "$WORK/out" || fail "enable does not start the market's own timer"

# systemd's own check of the files (the options exist in systemd 255, the specifiers expand, the paths are absolute).
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze --root="$STAGE" verify "/etc/systemd/system/creaton-keeper@${MARKET}.service" \
    "/etc/systemd/system/creaton-keeper-dry@${MARKET}.service" "/etc/systemd/system/creaton-keeper@${MARKET}.timer" >"$WORK/out" 2>&1 || true
  # The staged folder is not a whole system, so verify always adds that the machine's own targets (sysinit.target ...) are
  # missing; every other line (an unknown option, a bad value, a missing program) is a mistake in the files.
  if grep -Ev '^$|Failed to create .*/start: Unit .* not found\.$' "$WORK/out" >"$WORK/problems"; then
    cat "$WORK/problems" >&2
    fail "systemd-analyze verify found a problem"
  fi
  echo "systemd-analyze verify: $(systemd-analyze --version | head -n 1)"
else
  echo "SKIP: systemd-analyze is not installed, so the units were not checked by systemd itself"
fi

# A stubbed dry run of the real script with the unit's own environment.
BIN="$WORK/bin"
CRED="$WORK/credentials"
mkdir -p "$BIN" "$CRED"
cat >"$BIN/cast" <<'STUB'
#!/usr/bin/env bash
cmd="$1"; shift
printf '%s %s\n' "$cmd" "$*" >>"$CAST_LOG"
case "$cmd" in
  sig) ;;
  block) echo 500 ;;
  call)
    case "$2" in
      "roundCount()(uint256)") echo 1 ;;
      rounds*) printf '0\n0\n0\n0\n100\n1000\n0\n0\n0\nfalse\nfalse\n' ;;
      *) echo "the keeper read $2, which a settle-only pass must not" >&2; exit 9 ;;
    esac ;;
  *) echo "the keeper ran cast $cmd, which a dry run must not" >&2; exit 9 ;;
esac
STUB
chmod +x "$BIN/cast"
export CAST_LOG="$WORK/cast.log"
: >"$CAST_LOG"
# The environment the unit gives the script: every Environment= word, with %i and %d filled in, and the node from keeper.env.
unit_env=()
while IFS= read -r line; do
  for word in ${line#Environment=}; do
    word="${word//%i/$MARKET}"
    word="${word//%d/$CRED}"
    unit_env+=("$word")
  done
done < <(grep '^Environment=' "$DRY")
[[ " ${unit_env[*]} " == *" KEEPER_DRY_RUN=1 "* ]] || fail "the dry-run unit's environment lost KEEPER_DRY_RUN=1"
# The script puts FOUNDRY_BIN first on PATH; the stub stands in for /usr/local/bin.
env -i PATH="/usr/bin:/bin" "${unit_env[@]}" FOUNDRY_BIN="$BIN" RPC_URL=https://node.example/key CAST_LOG="$CAST_LOG" \
  bash "$SCRIPT" --once >"$WORK/out" 2>&1 || { cat "$WORK/out" >&2; fail "the stubbed dry run failed"; }
grep -q "dry run: would send settle(round 1)" "$WORK/out" || { cat "$WORK/out" >&2; fail "the dry run did not say it would settle round 1"; }
if grep -Eq '^(send|estimate) ' "$CAST_LOG"; then fail "the dry run sent or estimated a transaction"; fi
if grep -q "listing()" "$CAST_LOG"; then fail "a settle-only pass read the listing"; fi

echo "PASS: install.sh stages the keeper (script, units, timer, settings) safely twice over and refuses an unready machine;"
echo "      the units are settle only with the key and password as credentials; a stubbed dry run settles nothing"
