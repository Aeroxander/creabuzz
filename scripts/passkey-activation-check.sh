#!/usr/bin/env bash
#
# Step 0 of the desktop passkey activation runbook.
#
# The ceremony bridge is built (desktop/src-tauri/src/passkey_ceremony.rs);
# what remains is a whole domain chain. This script verifies every link of that
# chain this repo can verify, prints the exact fix per broken link, and always
# prints the manual steps that only Apple tooling / the release repo can do.
#
#   1. BUZZ_PASSKEY_RP_ID  — set, a bare domain, not the RFC 2606 *.invalid
#                            placeholder.
#   2. AASA served         — GET https://$BUZZ_PASSKEY_RP_ID/.well-known/
#                            apple-app-site-association returns 200,
#                            application/json, no-cache, and a
#                            webcredentials.apps entry of
#                            <BUZZ_PASSKEY_TEAM_ID>.<bundle id>.
#   3. Entitlement         — desktop/src-tauri/Entitlements.plist carries
#                            webcredentials:$BUZZ_PASSKEY_RP_ID.
#   4. Remaining manual steps, printed verbatim.
#
# The runbook these steps belong to lives in the header of
# desktop/src-tauri/src/commands/passkey.rs (steps 1-6).
#
# Exit status: 0 when every verifiable link holds, 1 when any link is broken.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTITLEMENTS="$ROOT/desktop/src-tauri/Entitlements.plist"
TAURI_CONF="$ROOT/desktop/src-tauri/tauri.conf.json"
AASA_URL_PATH="/.well-known/apple-app-site-association"

failures=0

ok()   { printf '  OK    %s\n' "$1"; }
warn() { printf '  WARN  %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  printf '        fix: %s\n' "$2"
  failures=$((failures + 1))
}
skip() {
  printf '  SKIP  %s\n' "$1"
  printf '        fix: %s\n' "$2"
}

# Read one key from the repo's .env (the file `just` loads for the relay) so
# this script sees what the relay will actually be configured with. Parsing
# instead of sourcing keeps a .env from executing arbitrary shell here.
env_file_value() {
  local key="$1" line
  if [[ ! -f "$ROOT/.env" ]]; then
    return 0
  fi
  line="$(grep -E "^${key}=" "$ROOT/.env" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    return 0
  fi
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

# Print one AASA body's app ids, one per line; an unparseable or wrongly shaped
# body prints exactly one `__ERROR__<reason>` line instead of ids.
aasa_app_ids() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$1" <<'PY'
import json
import sys

try:
    with open(sys.argv[1]) as handle:
        doc = json.load(handle)
except Exception as exc:  # noqa: BLE001 - the message is the diagnostic
    print("__ERROR__body is not valid JSON: %s" % exc)
    raise SystemExit(0)
if not isinstance(doc, dict) or not isinstance(doc.get("webcredentials"), dict):
    print('__ERROR__no top-level "webcredentials" object')
    raise SystemExit(0)
apps = doc["webcredentials"].get("apps")
if not isinstance(apps, list) or not apps:
    print("__ERROR__webcredentials.apps is missing or empty")
    raise SystemExit(0)
for app in apps:
    print(app if isinstance(app, str) else "__ERROR__non-string app id")
PY
  elif command -v jq >/dev/null 2>&1; then
    jq -r '(.webcredentials.apps // empty)[]? | if type == "string" then . else "__ERROR__non-string app id" end' "$1" 2>/dev/null \
      || printf '__ERROR__body is not valid JSON or lacks webcredentials.apps\n'
  else
    printf '__ERROR__python3 or jq is required to parse the AASA body\n'
  fi
}

echo "passkey activation check — step 0 of the runbook"
echo "  runbook: desktop/src-tauri/src/commands/passkey.rs (header, steps 1-6)"
echo

rp_id="${BUZZ_PASSKEY_RP_ID:-$(env_file_value BUZZ_PASSKEY_RP_ID)}"
team_id="${BUZZ_PASSKEY_TEAM_ID:-$(env_file_value BUZZ_PASSKEY_TEAM_ID)}"
bundle_id="${BUZZ_PASSKEY_BUNDLE_ID:-$(env_file_value BUZZ_PASSKEY_BUNDLE_ID)}"
if [[ -z "$bundle_id" && -f "$TAURI_CONF" ]]; then
  bundle_id="$(grep -o '"identifier"[[:space:]]*:[[:space:]]*"[^"]*"' "$TAURI_CONF" \
    | head -n 1 \
    | sed 's/.*"identifier"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)"
fi

rp_ok=0

echo "[1/4] BUZZ_PASSKEY_RP_ID — the webcredentials domain (desktop runtime env)"
if [[ -z "$rp_id" ]]; then
  fail "BUZZ_PASSKEY_RP_ID is not set (checked the environment and $ROOT/.env)" \
    "add BUZZ_PASSKEY_RP_ID=<relay public host> to .env, e.g. BUZZ_PASSKEY_RP_ID=buzz.example.com — the relay's public host, and the exact domain the entitlement and AASA must use"
elif [[ "$rp_id" == *"://"* || "$rp_id" == */* ]]; then
  fail "BUZZ_PASSKEY_RP_ID=$rp_id is not a bare host" \
    "set the domain only, without scheme or path: BUZZ_PASSKEY_RP_ID=buzz.example.com (WebAuthn RP ids are domains; the relay serves the AASA at https://<domain>$AASA_URL_PATH)"
elif [[ "$rp_id" == *.invalid ]]; then
  fail "BUZZ_PASSKEY_RP_ID=$rp_id is an RFC 2606 .invalid placeholder — no real domain owns it" \
    "replace it with the domain you own over HTTPS: BUZZ_PASSKEY_RP_ID=buzz.example.com, then update desktop/src-tauri/Entitlements.plist to webcredentials:buzz.example.com before signing"
else
  ok "BUZZ_PASSKEY_RP_ID=$rp_id"
  rp_ok=1
fi

echo
echo "[2/4] AASA served at https://${rp_id:-<BUZZ_PASSKEY_RP_ID>}$AASA_URL_PATH"
if [[ "$rp_ok" -ne 1 ]]; then
  skip "the AASA cannot be fetched without a real domain" \
    "fix [1/4] first, then re-run this script"
else
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  aasa_url="https://$rp_id$AASA_URL_PATH"
  http_code=""
  if ! http_code="$(curl -sS --max-time 20 \
      -D "$tmp_dir/headers" -o "$tmp_dir/body" -w '%{http_code}' \
      "$aasa_url" 2>"$tmp_dir/curl.err")"; then
    fail "GET $aasa_url failed: $(tr '\n' ' ' <"$tmp_dir/curl.err" | sed 's/[[:space:]]*$//')" \
      "the RP domain must serve this exact path over HTTPS with a valid certificate and no redirect — deploy the relay (it serves the file once BUZZ_PASSKEY_TEAM_ID is set) or host desktop/src-tauri/aasa.example.json there"
  elif [[ "$http_code" != "200" ]]; then
    fail "GET $aasa_url returned HTTP $http_code" \
      "the relay serves this route only when BUZZ_PASSKEY_TEAM_ID is set — export BUZZ_PASSKEY_TEAM_ID=<Apple Team ID> on the relay (no secret; it is public in any signed build); AASA must not redirect"
  else
    ok "GET $aasa_url → 200"
    content_type="$(grep -i '^content-type:' "$tmp_dir/headers" | tr -d '\r' | tail -n 1 || true)"
    if [[ "$content_type" == *application/json* ]]; then
      ok "Content-Type: ${content_type#*: }"
    else
      fail "Content-Type is '${content_type:-<none>}' — Apple requires application/json on a path with no file extension" \
        "serve the file with Content-Type: application/json (the relay's handler sets it)"
    fi
    cache_control="$(grep -i '^cache-control:' "$tmp_dir/headers" | tr -d '\r' | tail -n 1 || true)"
    if [[ "$cache_control" == *no-cache* ]]; then
      ok "Cache-Control: ${cache_control#*: }"
    else
      warn "Cache-Control is '${cache_control:-<none>}' — set Cache-Control: no-cache so intermediaries revalidate (Apple's own AASA cache is ~24h regardless)"
    fi

    apps_output="$(aasa_app_ids "$tmp_dir/body")"
    if [[ "$apps_output" == __ERROR__* ]]; then
      fail "the AASA body has the wrong shape: ${apps_output#__ERROR__}" \
        "serve the body aasa_body builds (crates/buzz-relay/src/router.rs): {\"webcredentials\":{\"apps\":[\"<TEAMID>.<BUNDLEID>\"]}} — desktop/src-tauri/aasa.example.json is the pinned template"
    elif [[ -z "$team_id" ]]; then
      fail "BUZZ_PASSKEY_TEAM_ID is not set, so the served app id cannot be verified (served: $(printf '%s ' $apps_output))" \
        "set BUZZ_PASSKEY_TEAM_ID=<Apple Team ID> in .env on the relay so it serves \"<TEAMID>.${bundle_id:-<bundle id>}\""
    elif ! grep -Fxq "$team_id.$bundle_id" <<<"$apps_output"; then
      fail "webcredentials.apps does not contain \"$team_id.$bundle_id\" (served: $(printf '%s ' $apps_output))" \
        "the AASA must name the exact signed app: set BUZZ_PASSKEY_TEAM_ID to the Team ID that signs the build, and BUZZ_PASSKEY_BUNDLE_ID to the bundle id of that build (tauri.conf.json identifier: ${bundle_id:-unknown})"
    else
      ok "webcredentials.apps contains \"$team_id.$bundle_id\""
    fi
  fi
fi

echo
echo "[3/4] $ENTITLEMENTS — com.apple.developer.associated-domains"
if [[ "$rp_ok" -ne 1 ]]; then
  skip "the entitlement domain cannot be matched without BUZZ_PASSKEY_RP_ID" \
    "fix [1/4] first, then re-run this script"
elif [[ ! -f "$ENTITLEMENTS" ]]; then
  fail "entitlements file not found at $ENTITLEMENTS" \
    "the signed build must ship desktop/src-tauri/Entitlements.plist — restore it from the repo"
else
  entitled="$(grep -o '<string>webcredentials:[^<]*' "$ENTITLEMENTS" | sed 's#<string>##' || true)"
  if grep -Fxq "webcredentials:$rp_id" <<<"$entitled"; then
    ok "carries webcredentials:$rp_id"
  else
    fail "the entitlement does not carry webcredentials:$rp_id (found: ${entitled:-nothing})" \
      "substitute before signing: sed -i '' 's#<string>webcredentials:[^<]*#<string>webcredentials:$rp_id#' $ENTITLEMENTS  (macOS sed; the tracked placeholder must be replaced in the build that ships)"
  fi
fi

echo
echo "[4/4] REMAINING MANUAL STEPS — outside this repo, not verifiable here:"
cat <<'STEPS'
       1. Provisioning profile: the Apple Developer profile used to sign the
          desktop app must include the associated-domains capability for this
          app id. That profile lives in the release repo (squareup/buzz-releases)
          — this repo's Entitlements.plist is only half of the entitlement.
       2. Signed build: ship a Block-signed macOS build from buzz-releases with
          that profile. An ad-hoc/debug-signed app cannot satisfy
          com.apple.developer.associated-domains, so every ceremony fails at the
          platform boundary even when everything else checks out.
       3. Hardware: passkey PRF is macOS 15.0+ and needs Touch ID. Verify on the
          target Mac with the desktop `passkey_capability` report — it must show
          available=true, rpId=<BUZZ_PASSKEY_RP_ID>, blocker=null — then create
          and assert a passkey and confirm the recorded CeremonyProvenance
          (origin + rpId) matches the domain chain.
       4. Apple caches AASA fetches for up to ~24h — re-check [2/4] (and expect
          propagation lag) after any AASA or entitlement change.
STEPS

echo
if ((failures > 0)); then
  printf 'RESULT: %d broken link(s) in the in-repo chain — fix the FAIL lines above, then re-run.\n' "$failures"
  exit 1
fi
echo "RESULT: the in-repo chain is whole; the manual steps above still apply."
