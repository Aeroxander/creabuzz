# Shared by run.sh and backup.sh (sourced from this folder): which compose files make up this stack, how to call
# compose, and the checks every command makes first.

# A value from .env (the last line that sets it), or nothing.
env_value() {
  [[ -f .env ]] || return 0
  grep -E "^${1}=" .env | tail -n 1 | cut -d= -f2- || true
}

# Creaton (compose.creaton.yml) is on when BUZZ_COMPOSE_CREATON=true in the shell or in .env: once a stack runs the
# Creaton image, forgetting the flag on one command must not start the upstream image against its database.
creaton_on() {
  local value="${BUZZ_COMPOSE_CREATON:-}"
  [[ -n "$value" ]] || value="$(env_value BUZZ_COMPOSE_CREATON)"
  [[ "$value" == "true" ]]
}

# HTTPS (compose.caddy.yml) is read the same way: a `restart` that forgot the flag would recreate the relay with its
# port published and nothing answering on 443, and passkeys need HTTPS.
tls_on() {
  local value="${BUZZ_COMPOSE_TLS:-}"
  [[ -n "$value" ]] || value="$(env_value BUZZ_COMPOSE_TLS)"
  [[ "$value" == "true" ]]
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

COMPOSE_FILES=(-f compose.yml)
if tls_on; then
  COMPOSE_FILES+=(-f compose.caddy.yml)
fi
if creaton_on; then
  COMPOSE_FILES+=(-f compose.creaton.yml)
fi
if [[ "${BUZZ_COMPOSE_DEV:-false}" == "true" ]]; then
  COMPOSE_FILES+=(-f compose.dev.yml)
fi

compose() {
  docker compose --env-file .env "${COMPOSE_FILES[@]}" "$@"
}

# Only that .env exists: enough to build the image, which takes none of its secrets (and the owner key is made with
# the built image, so a first start builds before every CHANGE_ME is filled in).
require_env_file() {
  if [[ ! -f .env ]]; then
    cat >&2 <<'MSG'
Missing deploy/compose/.env.

Copy .env.example to .env and replace every CHANGE_ME value (README.md says how
to make each one). Do not start production with generated secrets missing.
MSG
    exit 1
  fi
}

# The settings every command needs, without the policy files: what backup and restore check, so that the terms and
# privacy note (a legal text someone may be in the middle of editing) never stand in the way of keeping or recovering
# the data.
require_env_settings() {
  require_env_file
  local left
  # BUZZ_BACKUP_AGE_RECIPIENT is the one setting allowed to stay CHANGE_ME here: only `backup` needs it, and it says so
  # itself (backup.sh, require_backup_key), so a server can start before the owner has made the backup key.
  left="$(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME' .env | grep -vE '^[[:space:]]*BUZZ_BACKUP_AGE_RECIPIENT=' |
    sed -E 's/^[[:space:]]*/  /; s/=.*//' || true)"
  if [[ -n "$left" ]]; then
    {
      echo "deploy/compose/.env still contains CHANGE_ME placeholders:"
      echo "$left"
      echo "Put in the server's host name and generate stable secrets first; the secrets must not rotate on restart."
    } >&2
    exit 1
  fi
  # An .env copied from an older example still names its example host, which no browser can reach.
  left="$(grep -E '^[[:space:]]*(BUZZ_DOMAIN|RELAY_URL|BUZZ_MEDIA_BASE_URL|BUZZ_MEDIA_SERVER_DOMAIN|BUZZ_CORS_ORIGINS)=.*buzz\.example\.com' .env |
    sed -E 's/^[[:space:]]*/  /; s/=.*//' || true)"
  if [[ -n "$left" ]]; then
    {
      echo "deploy/compose/.env still has the example host name (buzz.example.com) in:"
      echo "$left"
      echo "Put the server's own host name in each of them first."
    } >&2
    exit 1
  fi
  if tls_on; then
    require_private_relay_port
  fi
}

# The settings, and the served policy files (placeholders and the Last updated stamp): what start, restart, upgrade and
# the other commands that run the server check.
require_env() {
  require_env_settings
  if creaton_on; then
    load_policies
  fi
}

# With HTTPS on, Caddy is the only way in: compose.caddy.yml removes the relay's own port. A published relay port (an
# extra override, or a Compose too old for `!reset`) would serve the site over plain http beside it, so it stops here.
require_private_relay_port() {
  local rendered
  rendered="$(compose config relay)" || exit 1
  # The relay's block in the rendered services, and a `ports:` key directly under it.
  if awk '/^[^ ]/ { section = $1 }
          section == "services:" && /^  [^ ]/ { relay = ($1 == "relay:") }
          relay && /^    ports:/ { found = 1 }
          END { exit !found }' <<<"$rendered"; then
    cat >&2 <<'MSG'
BUZZ_COMPOSE_TLS=true, but the relay's own port is still published: people could
reach the site over plain http beside Caddy. Remove the relay's `ports:` from any
extra compose file, and check `docker compose version` is v2.24.4 or newer.
MSG
    exit 1
  fi
}

# The blanks left in a draft: one line per blank, "LINE: text". A blank is a [bracket] that is not a Markdown link
# (a "]" followed straight by "("): "[Operator name]", "[30] days", one that runs over two lines, an opening "[" never
# closed, a closing "]" never opened. A link's text may hold brackets or run over lines. Code fences (``` or ~~~ lines)
# and `code spans` are skipped, and "\[" is a literal bracket. POSIX awk only (it runs on macOS as it is).
policy_placeholders() {
  awk '
    function report(line, text) {
      gsub(/[ \t]+/, " ", text)
      if (length(text) > 80) text = substr(text, 1, 77) "..."
      print line ": " text
    }
    BEGIN { depth = 0; fence = "" }
    {
      row = $0
      lead = row
      sub(/^ */, "", lead)
      mark = substr(lead, 1, 3)
      if (fence != "") {
        if (mark == fence) fence = ""
        next
      }
      if (mark == "```" || mark == "~~~") { fence = mark; next }
      code = 0
      n = length(row)
      for (i = 1; i <= n; i++) {
        c = substr(row, i, 1)
        if (c == "\\") { if (depth) buf = buf c substr(row, i + 1, 1); i++; continue }
        if (c == "`") { code = !code; if (depth) buf = buf c; continue }
        if (code) { if (depth) buf = buf c; continue }
        if (c == "[") {
          if (depth == 0) { start = NR; buf = "" }
          depth++
          buf = buf c
        } else if (c == "]") {
          if (depth == 0) { report(NR, substr(row, 1, i)); continue }
          buf = buf c
          depth--
          if (depth == 0 && substr(row, i + 1, 1) != "(") report(start, buf)
        } else if (depth) buf = buf c
      }
      if (depth) buf = buf " "
    }
    END { if (depth) report(start, buf) }
  ' "$1"
}

# A policy file's "Last updated" line: "Last updated: 5 March 2026", also written in bold or italics
# ("**Last updated:** ..."). The first such line counts; the date is the text after the colon.
POLICY_DATE_LINE='^[ \t*_]*last updated[ \t*_]*:'

# The date on a policy file's Last updated line, or nothing when there is no such line or no date on it.
policy_last_updated() {
  awk -v pat="$POLICY_DATE_LINE" '
    tolower($0) ~ pat {
      line = $0
      sub(/\r$/, "", line)
      match(tolower(line), pat)
      line = substr(line, RLENGTH + 1)
      sub(/^[ \t*_]+/, "", line)
      sub(/[ \t*_]+$/, "", line)
      print line
      exit
    }' "$1"
}

# A hash of a policy file's text without its Last updated line, so that the date can change on its own.
policy_text_hash() {
  awk -v pat="$POLICY_DATE_LINE" '
    !done && tolower($0) ~ pat { done = 1; next }
    { print }' "$1" | sha256 | cut -d' ' -f1
}

# Where ./run.sh policy-stamp keeps what it recorded about a policy file: beside it, in .stamps/.
policy_stamp_path() {
  printf '%s/.stamps/%s.stamp' "$(dirname "$1")" "$(basename "$1")"
}

# The Last updated check (docs/policies/LAWYER-FEEDBACK-RESPONSE.md): the date on a served policy must change whenever
# its text does. MODE check (the default) refuses a file that has no stamp, or whose text changed since its stamp;
# MODE stamp records the file as it is now, but not text that changed under the same date, so the stamp cannot be used
# to get past the check.
check_policy_stamp() {
  local file="$1" mode="${2:-check}" date stamp hash recorded_hash recorded_date
  date="$(policy_last_updated "$file")"
  if [[ -z "$date" ]]; then
    echo "$file has no 'Last updated: <date>' line, or the line has no date. Put it near the top and run the command again." >&2
    exit 1
  fi
  stamp="$(policy_stamp_path "$file")"
  hash="$(policy_text_hash "$file")"
  if [[ -f "$stamp" ]]; then
    recorded_hash="$(sed -n 's/^hash=//p' "$stamp")"
    recorded_date="$(sed -n 's/^last_updated=//p' "$stamp")"
    if [[ "$hash" != "$recorded_hash" && "$date" == "$recorded_date" ]]; then
      {
        echo "$file has changed, but its Last updated line still says '$date'."
        echo "Update the Last updated line to today's date, then run ./run.sh policy-stamp."
      } >&2
      exit 1
    fi
  fi
  if [[ "$mode" == stamp ]]; then
    mkdir -p "$(dirname "$stamp")"
    printf 'hash=%s\nlast_updated=%s\n' "$hash" "$date" >"$stamp"
    echo "Recorded $file, last updated $date."
  elif [[ ! -f "$stamp" ]]; then
    {
      echo "$file has no stamp yet, so the Last updated check cannot tell whether its text changed."
      echo "Once the lawyer-approved text is in place, run ./run.sh policy-stamp, then run the command again."
    } >&2
    exit 1
  elif [[ "$hash" != "$recorded_hash" ]]; then
    {
      echo "$file has a new Last updated date ('$date') but no new stamp."
      echo "Run ./run.sh policy-stamp, then run the command again."
    } >&2
    exit 1
  fi
}

# The terms and privacy note for sign-up, read from the files .env names (BUZZ_TERMS_FILE, BUZZ_PRIVACY_FILE) into the
# variables compose.creaton.yml passes to the server. A draft's [placeholders] left in a file stop the command, each
# listed with its file and line: a published "[Operator name]" or "[email]" would tell people nothing. A file whose text
# changed without a new Last updated date (and a new stamp) stops it too. With MODE stamp (./run.sh policy-stamp) the
# same checks run, then each file is recorded and nothing is exported.
load_policies() {
  local mode="${1:-check}" setting file variable blanks found=false
  for setting in BUZZ_TERMS_FILE:BUZZ_TERMS_OF_SERVICE_MARKDOWN BUZZ_PRIVACY_FILE:BUZZ_PRIVACY_POLICY_MARKDOWN; do
    file="$(env_value "${setting%%:*}")"
    variable="${setting#*:}"
    [[ -n "$file" ]] || continue
    found=true
    if [[ ! -f "$file" ]]; then
      echo "${setting%%:*}=$file: no such file (paths are from deploy/compose)." >&2
      exit 1
    fi
    blanks="$(policy_placeholders "$file")"
    if [[ -n "$blanks" ]]; then
      {
        echo "$file still has a draft's [placeholders] or a stray bracket, at these lines:"
        while IFS= read -r line; do echo "  $file:$line"; done <<<"$blanks"
        echo "Fill in or remove each one (a link written [text](address) is fine), then run the command again."
      } >&2
      exit 1
    fi
    check_policy_stamp "$file" "$mode"
    [[ "$mode" == stamp ]] || export "$variable=$(cat "$file")"
  done
  if [[ "$mode" == stamp && "$found" == false ]]; then
    echo "BUZZ_TERMS_FILE and BUZZ_PRIVACY_FILE are not set in deploy/compose/.env, so there is nothing to record." >&2
    echo "Set them to the policy files (README.md, \"First start\", step 4), then run ./run.sh policy-stamp again." >&2
    exit 1
  fi
}
