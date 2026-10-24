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

COMPOSE_FILES=(-f compose.yml)
if [[ "${BUZZ_COMPOSE_TLS:-false}" == "true" ]]; then
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

require_env() {
  if [[ ! -f .env ]]; then
    cat >&2 <<'MSG'
Missing deploy/compose/.env.

Copy .env.example to .env and replace every CHANGE_ME value, or run the bootstrap
script once it lands. Do not start production with generated secrets missing.
MSG
    exit 1
  fi
  if grep -Eq '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME' .env; then
    cat >&2 <<'MSG'
deploy/compose/.env still contains CHANGE_ME placeholders.
Generate stable secrets first; these values must not rotate on restart.
MSG
    exit 1
  fi
  if creaton_on; then
    load_policies
  fi
}

# The terms and privacy note for sign-up, read from the files .env names (BUZZ_TERMS_FILE, BUZZ_PRIVACY_FILE) into the
# variables compose.creaton.yml passes to the server. A draft's [placeholders] left in a file stop the command: a
# published "[Operator name]" or "[email]" would tell people nothing.
load_policies() {
  local setting file variable
  for setting in BUZZ_TERMS_FILE:BUZZ_TERMS_OF_SERVICE_MARKDOWN BUZZ_PRIVACY_FILE:BUZZ_PRIVACY_POLICY_MARKDOWN; do
    file="$(env_value "${setting%%:*}")"
    variable="${setting#*:}"
    [[ -n "$file" ]] || continue
    if [[ ! -f "$file" ]]; then
      echo "${setting%%:*}=$file: no such file (paths are from deploy/compose)." >&2
      exit 1
    fi
    # A bracketed word that is not a Markdown link: "[Operator name]", "[30] days", "[email]".
    if grep -nE '\[[^]]+\]([^(]|$)' "$file" >&2; then
      echo "$file still has a draft's [placeholders] (above); fill them in before serving it." >&2
      exit 1
    fi
    export "$variable=$(cat "$file")"
  done
}
