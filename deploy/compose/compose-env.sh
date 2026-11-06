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

require_env() {
  require_env_file
  local left
  left="$(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME' .env | sed -E 's/^[[:space:]]*/  /; s/=.*//' || true)"
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
  if creaton_on; then
    load_policies
  fi
  if tls_on; then
    require_private_relay_port
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

# The terms and privacy note for sign-up, read from the files .env names (BUZZ_TERMS_FILE, BUZZ_PRIVACY_FILE) into the
# variables compose.creaton.yml passes to the server. A draft's [placeholders] left in a file stop the command, each
# listed with its file and line: a published "[Operator name]" or "[email]" would tell people nothing.
load_policies() {
  local setting file variable blanks
  for setting in BUZZ_TERMS_FILE:BUZZ_TERMS_OF_SERVICE_MARKDOWN BUZZ_PRIVACY_FILE:BUZZ_PRIVACY_POLICY_MARKDOWN; do
    file="$(env_value "${setting%%:*}")"
    variable="${setting#*:}"
    [[ -n "$file" ]] || continue
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
    export "$variable=$(cat "$file")"
  done
}
