#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# shellcheck source=compose-env.sh
. ./compose-env.sh

backup_hint() {
  cat <<'MSG'
Back up these before upgrades and on a regular schedule:

- deploy/compose/.env, especially BUZZ_RELAY_PRIVATE_KEY, DB/Redis/S3 secrets, and BUZZ_GIT_HOOK_HMAC_SECRET
- The owner private key if bootstrap generated one for RELAY_OWNER_PUBKEY
- Postgres data (prefer pg_dump or a quiesced volume snapshot)
- MinIO/S3 bucket contents for media and git objects
- buzz-git-data volume (BUZZ_GIT_REPO_PATH=/data/git)
- Caddy data/config volumes if using compose.caddy.yml

Keep Postgres + object/git state snapshots from the same maintenance window.

./run.sh backup takes the database, the media bucket, the git data and the
settings (.env and the policy files) in that order, packs them into one file
backups/<UTC time>.tar.age encrypted to the public key BUZZ_BACKUP_AGE_RECIPIENT
(with a sidecar backups/<UTC time>.sha256); copy both off this machine. Only the
private key, which must not be on this server, opens it. The owner key and
Caddy's certificates are not in it (Caddy gets new certificates by itself).
MSG
}

# A Creaton server with no terms or privacy note shows people none at sign-up. That is allowed (a private test), so it
# does not stop the command, but it must not go unnoticed on a server people are invited to.
warn_missing_policies() {
  creaton_on || return 0
  local setting what missing=() missing_what=""
  for setting in BUZZ_TERMS_FILE BUZZ_PRIVACY_FILE; do
    [[ -n "$(env_value "$setting")" ]] && continue
    missing+=("$setting")
    [[ "$setting" == BUZZ_TERMS_FILE ]] && what="terms" || what="privacy note"
    missing_what="${missing_what:+$missing_what or }$what"
  done
  ((${#missing[@]})) || return 0
  printf '\033[1;31m%s\033[0m\n' \
    "WARNING: ${missing[*]} not set in deploy/compose/.env, so sign-up shows no ${missing_what}." \
    "Before you invite anyone: copy the draft from docs/policies/ into deploy/compose/policies/, fill in every [bracket]," \
    "set ${missing[*]} to its path in .env, and run ./run.sh restart (README.md, \"First start\")." >&2
}

# Backups older than DAYS days, by the folder's or file's age: the privacy note says how long backups are kept, and nothing
# else deletes them. Only what `backup` names (backups/<UTC time>, a plain folder, or backups/<UTC time>.tar.age with its
# .sha256 sidecar) is touched.
prune_backups() {
  local days="${1:-}"
  [[ "$days" =~ ^[0-9]+$ ]] || {
    echo "Usage: ./run.sh prune-backups DAYS" >&2
    exit 1
  }
  [[ -d backups ]] || return 0
  local item removed=0
  while IFS= read -r item; do
    echo "removing $item"
    rm -rf -- "$item"
    if [[ "$item" == *.tar.age ]]; then
      rm -f -- "${item%.tar.age}.sha256"
    fi
    removed=$((removed + 1))
  done < <(
    {
      find backups -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T[0-9]*Z' -mtime +"$days"
      find backups -mindepth 1 -maxdepth 1 -type f -name '[0-9]*T[0-9]*Z.tar.age' -mtime +"$days"
    } | LC_ALL=C sort
  )
  echo "$removed backup(s) older than $days days removed from backups/. Copies kept off this machine are not touched."
}

# One uploaded file in the bundled media store, by its hash (the 64 characters in its /media/<hash>.<ext> address):
# the file, its thumbnail and its records. Removing a post does not remove its pictures, and the server has no way to
# delete a file, so a takedown ends here (docs/operator-takedown-and-data-requests.md). Files are stored once per hash,
# so this removes it wherever it was posted.
remove_media() {
  local sha="${1:-}" confirm="${2:-}"
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Usage: ./run.sh remove-media <64-character hash> [--yes]" >&2
    exit 1
  }
  local remove=false
  [[ "$confirm" == "--yes" ]] && remove=true
  compose run --rm --no-deps -T -e SHA="$sha" -e REMOVE="$remove" --entrypoint /bin/sh minio-init -euc '
    mc alias set local http://minio:9000 "$BUZZ_S3_ACCESS_KEY" "$BUZZ_S3_SECRET_KEY" >/dev/null
    found="$(mc find "local/$BUZZ_S3_BUCKET" --path "*$SHA*")"
    if [ -z "$found" ]; then
      echo "No file with that hash in the media store."
      exit 0
    fi
    echo "$found"
    if [ "$REMOVE" != true ]; then
      # Upload records (kept only with BUZZ_MEDIA_UPLOAD_RECORDS on) say who uploaded it and when: read them before
      # they go, for a report.
      echo "$found" | grep "/_uploads/" | while IFS= read -r record; do mc cat "$record"; echo; done
      echo "Nothing removed. Run again with --yes to remove the objects above."
      exit 0
    fi
    echo "$found" | while IFS= read -r object; do mc rm --quiet "$object"; done
    echo "Removed. Backups taken before now still hold it until they are pruned."'
}

# The web app's settings (VITE_*) are read when the image is built and end up in the page. The server's secrets may still
# be CHANGE_ME at a first build (the owner key is made with the built image), but a page setting left as one would be
# served as it is, and `restart` does not rebuild: fixing .env afterwards changes nothing until the next build.
require_page_settings() {
  local left
  left="$(grep -E '^[[:space:]]*VITE_[A-Za-z0-9_]*=.*CHANGE_ME' .env | sed -E 's/^[[:space:]]*/  /; s/=.*//' || true)"
  [[ -z "$left" ]] && return 0
  {
    echo "deploy/compose/.env still has CHANGE_ME in the web app's settings, which are built into the page:"
    echo "$left"
    echo "Put the real values in, then run ./run.sh build again."
  } >&2
  exit 1
}

# The web app settings the image takes (the build arguments of ../../Dockerfile and compose.creaton.yml): the same list, so
# the check below sees what the build will see and nothing else.
WEB_SETTINGS=(
  VITE_LAUNCHPAD_CHAIN_ID VITE_CHAIN_RPC_URL VITE_CONTRIBUTOR_KITS VITE_HISTORY_FROM_BLOCKS
  VITE_SECONDARY_MARKET_FACTORY VITE_TRADING_TRIAL VITE_TEST_QUOTE_TOKENS
  VITE_INVESTING VITE_BACKING_POOL_FACTORY VITE_CONTRIBUTOR_KIT_V3 VITE_BACKING_QUOTE_TOKEN
  VITE_WORK_BOUNTIES VITE_OPEN_BOUNTIES VITE_CREATE_TOKENS VITE_CREATE_FAUCETS
  VITE_COURTS VITE_PAYOUTS_FACTORIES VITE_REMIX_BONDS
  VITE_ZERODEV_PROJECT_ID VITE_ZERODEV_CHAIN_ID VITE_ZERODEV_API_KEY VITE_BUNDLER_URL
  VITE_ERROR_REPORT_URL VITE_APP_RELEASE VITE_RELAY_URL VITE_COMMUNITY_API_ORIGIN
  VITE_CREATON_CHAIN_ID VITE_CREATON_LAUNCHER VITE_CREATON_DOLLAR VITE_CREATON_RPC_URL
  VITE_CREATON_PASSKEY_ACCOUNT VITE_CREATON_BUNDLER_URL VITE_CREATON_SPONSOR_URL
)

# What the image carries: `runtime-creaton` (the Creaton app, the default) or `runtime` (the old web app), by
# CREATON_IMAGE_TARGET in the shell or .env (compose.creaton.yml reads the same name).
image_target() {
  local target
  target="$(build_setting CREATON_IMAGE_TARGET)"
  printf '%s' "${target:-runtime-creaton}"
}

# The app's network from the file the deploy script wrote (contracts/pot/deployments/pot-<chain>.json), named by
# CREATON_DEPLOYMENTS_FILE in .env (a path from this folder). It fills in VITE_CREATON_CHAIN_ID, _LAUNCHER and _DOLLAR where
# the shell and .env name nothing: a value set by hand wins, as it does for the app's own build. A file that is named but
# is not one stops here, loudly: an app built with no network shows no money at all.
export_deployments_settings() {
  local file chain launcher dollar
  file="$(build_setting CREATON_DEPLOYMENTS_FILE)"
  [[ -n "$file" ]] || return 0
  [[ -f "$file" ]] || {
    echo "CREATON_DEPLOYMENTS_FILE=$file: no such file (paths are from deploy/compose)." >&2
    exit 1
  }
  chain="$(grep -oE '"chainId"[[:space:]]*:[[:space:]]*"?[0-9]+' "$file" | grep -oE '[0-9]+$' | head -n 1 || true)"
  launcher="$(grep -oE '"launcher"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{40}"' "$file" | grep -oE '0x[0-9a-fA-F]{40}' | head -n 1 || true)"
  dollar="$(grep -oE '"quote"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{40}"' "$file" | grep -oE '0x[0-9a-fA-F]{40}' | head -n 1 || true)"
  if [[ -z "$chain" || -z "$launcher" || -z "$dollar" ]]; then
    echo "CREATON_DEPLOYMENTS_FILE=$file is not a deployments file: it needs a chainId, a launcher and a quote (the file contracts/pot/script/DeployPot.s.sol writes)." >&2
    exit 1
  fi
  [[ -n "$(build_setting VITE_CREATON_CHAIN_ID)" ]] || export VITE_CREATON_CHAIN_ID="$chain"
  [[ -n "$(build_setting VITE_CREATON_LAUNCHER)" ]] || export VITE_CREATON_LAUNCHER="$launcher"
  [[ -n "$(build_setting VITE_CREATON_DOLLAR)" ]] || export VITE_CREATON_DOLLAR="$dollar"
}

app_refused() {
  {
    echo "$1"
    echo "Fix the Creaton app's settings in .env (docs/next-version/DEPLOY-TEST-NETWORK.md), then run ./run.sh build again."
  } >&2
  exit 1
}

# The Creaton app's settings (VITE_CREATON_*), checked before the long build the way the image checks them again: a
# launcher without its chain, a passkey switch without its bundler, an address with a key in it. Prints what the app will
# offer. With the old web app as the image's target (CREATON_IMAGE_TARGET=runtime) it says so and checks nothing.
check_app_settings() {
  local chain launcher dollar rpc passkey bundler sponsor name value
  if [[ "$(image_target)" != runtime-creaton ]]; then
    echo "The image carries the old web app (CREATON_IMAGE_TARGET=$(image_target)): the VITE_CREATON_* settings are not read."
    return 0
  fi
  chain="$(build_setting VITE_CREATON_CHAIN_ID)"
  launcher="$(build_setting VITE_CREATON_LAUNCHER)"
  dollar="$(build_setting VITE_CREATON_DOLLAR)"
  rpc="$(build_setting VITE_CREATON_RPC_URL)"
  passkey="$(build_setting VITE_CREATON_PASSKEY_ACCOUNT)"
  bundler="$(build_setting VITE_CREATON_BUNDLER_URL)"
  sponsor="$(build_setting VITE_CREATON_SPONSOR_URL)"
  if [[ -n "$chain$launcher$dollar" ]]; then
    [[ -n "$chain" && -n "$launcher" ]] ||
      app_refused "VITE_CREATON_CHAIN_ID and VITE_CREATON_LAUNCHER go together (VITE_CREATON_DOLLAR with them): one without the other builds an app with no money screens."
    [[ "$chain" =~ ^[1-9][0-9]*$ ]] || app_refused "VITE_CREATON_CHAIN_ID=$chain is not a network number."
    [[ "$launcher" =~ ^0x[0-9a-fA-F]{40}$ ]] || app_refused "VITE_CREATON_LAUNCHER is not a 0x address of 40 hex digits."
    [[ -z "$dollar" || "$dollar" =~ ^0x[0-9a-fA-F]{40}$ ]] || app_refused "VITE_CREATON_DOLLAR is not a 0x address of 40 hex digits."
  fi
  for name in VITE_CREATON_RPC_URL VITE_CREATON_BUNDLER_URL VITE_CREATON_SPONSOR_URL; do
    value="$(build_setting "$name")"
    [[ -z "$value" ]] && continue
    [[ "$value" =~ ^https?://[^[:space:]@]+$ ]] || app_refused "$name must be an http(s) address with no name, password or space in it."
    if grep -Eiq '[?&][^=&]*(key|token|secret|auth|password)' <<<"$value"; then
      app_refused "$name carries a key in its address, and every setting is public in the page: put the key in a proxy and name the proxy."
    fi
  done
  if [[ "$passkey" == 1 ]]; then
    [[ -n "$chain" && -n "$rpc" && -n "$bundler" ]] ||
      app_refused "VITE_CREATON_PASSKEY_ACCOUNT=1 needs VITE_CREATON_CHAIN_ID, VITE_CREATON_RPC_URL and VITE_CREATON_BUNDLER_URL: without all three the phone account cannot send."
  elif [[ -n "$passkey" ]]; then
    app_refused "VITE_CREATON_PASSKEY_ACCOUNT is 1 or left out (got: $passkey)."
  fi
  echo "This build of the Creaton app:"
  if [[ -n "$launcher" ]]; then
    echo "  Network: $chain, Launcher $launcher${dollar:+, dollar $dollar}"
  else
    echo "  Network: none (no money screens: the app is the social part alone)"
  fi
  echo "  Chain node for the page: ${rpc:-none}"
  if [[ "$passkey" == 1 ]]; then
    echo "  Phone accounts send with a passkey: bundler $bundler, fees ${sponsor:+asked at $sponsor}${sponsor:-asked at the bundler}"
  else
    echo "  Phone accounts: off (people send from a wallet in their browser)"
  fi
  [[ -n "$launcher" && -z "$rpc" ]] && echo "  Note: no VITE_CREATON_RPC_URL, so the page cannot read the chain itself."
  return 0
}

# With the network named, the page's node must answer for that network and hold the Launcher: a node on another network or an
# address with nothing at it would be built into the page and found by the first person who opens a project. Bounded waits.
check_app_node() {
  local chain launcher rpc answer got code
  [[ "$(image_target)" == runtime-creaton ]] || return 0
  chain="$(build_setting VITE_CREATON_CHAIN_ID)"
  launcher="$(build_setting VITE_CREATON_LAUNCHER)"
  rpc="$(build_setting VITE_CREATON_RPC_URL)"
  if [[ -z "$launcher" || -z "$rpc" ]]; then
    echo "The app's chain node is not checked (it needs VITE_CREATON_LAUNCHER and VITE_CREATON_RPC_URL)."
    return 0
  fi
  echo "Checking the page's chain node (network $chain, Launcher $launcher)..."
  answer="$(node_call "$rpc" '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}')" ||
    app_refused "VITE_CREATON_RPC_URL: no answer within 15 seconds to a request for its network (curl says why above)."
  got="$(sed -nE 's/.*"result"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]+)".*/\1/p' <<<"$answer")"
  [[ -n "$got" ]] || app_refused "VITE_CREATON_RPC_URL did not say which network it is. It answered: ${answer:0:300}"
  ((got == chain)) || app_refused "VITE_CREATON_RPC_URL is on network $((got)), but the build is for network $chain."
  answer="$(node_call "$rpc" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"eth_getCode\",\"params\":[\"$launcher\",\"latest\"]}")" ||
    app_refused "VITE_CREATON_RPC_URL: no answer within 15 seconds to a request for the Launcher's code (curl says why above)."
  code="$(sed -nE 's/.*"result"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]*)".*/\1/p' <<<"$answer")"
  [[ -n "$code" ]] || app_refused "VITE_CREATON_RPC_URL did not answer a request for the Launcher's code. It answered: ${answer:0:300}"
  [[ "$code" != 0x && "$code" != 0x0 ]] ||
    app_refused "Nothing is deployed at the Launcher $launcher on network $chain, as that node sees it: wrong address, wrong network or a node that is behind."
  echo "The chain node answers on network $chain and holds the Launcher."
}

# The settings check the image runs first (web/scripts/check-deploy-env.mjs), run here on the same settings before the
# long build: a half-set trial block (a market factory without VITE_TRADING_TRIAL, or the reverse), a half-set investing
# block (VITE_INVESTING without its three addresses, or an address without it), a kit without a chain
# node, a malformed address. It prints what the build will offer, and stops on what does not fit together. With no
# Node.js 22.6 or newer on this machine it says so and goes on, since the image's own build runs the same check and stops
# there; with the checkout's script missing there is nothing to build from, so it stops.
check_web_settings() {
  local script="../../web/scripts/check-deploy-env.mjs" name value status=0 args=() answer
  [[ -f "$script" ]] || {
    echo "$script is missing: ./run.sh build needs the whole checkout (the image is built from it)." >&2
    exit 1
  }
  if ! command -v node >/dev/null 2>&1 || ! node --experimental-strip-types -e 0 >/dev/null 2>&1; then
    echo "Node.js 22.6 or newer is not on this machine, so the web app's settings are not checked here; the image's build checks them again and stops there."
    return 0
  fi
  for name in "${WEB_SETTINGS[@]}"; do
    value="$(build_setting "$name")"
    [[ -n "$value" ]] && args+=("$name=$value")
  done
  # Only the settings above, and the contributor-only switch the image sets itself: nothing else of this shell reaches it.
  answer="$(env -i PATH="$PATH" HOME="${HOME:-/}" ${args[@]+"${args[@]}"} VITE_CONTRIBUTOR_ONLY=1 \
    node --experimental-strip-types --no-warnings "$script" 2>&1)" || status=$?
  if ((status != 0)); then
    {
      echo "$answer"
      echo
      echo "The web app's settings in deploy/compose/.env do not fit together (docs/sepolia-testnet.md, section 3)."
      echo "Fix them, then run ./run.sh build again."
    } >&2
    exit 1
  fi
  echo "$answer"
}

# A web app setting as the build sees it: from the shell, else from .env (compose reads the shell first), without the
# quotes around it.
build_setting() {
  local value="${!1:-}"
  [[ -n "$value" ]] || value="$(env_value "$1")"
  if [[ "$value" =~ ^\'(.*)\'$ || "$value" =~ ^\"(.*)\"$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# One JSON-RPC request to the page's chain node, with bounded waits.
node_call() {
  curl -sS --connect-timeout 5 --max-time 15 -H 'Content-Type: application/json' --data "$2" "$1"
}

# The kit's logs from block FROM to TO (a block number in hex, or latest): the request the page sends first.
kit_history() {
  node_call "$1" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"eth_getLogs\",\"params\":[{\"address\":\"$2\",\"fromBlock\":\"$(printf '0x%x' "$3")\",\"toBlock\":\"$4\"}]}"
}

# Whether a JSON-RPC answer is a list of logs (an empty one counts), not an error.
is_log_list() {
  grep -Eq '"result"[[:space:]]*:[[:space:]]*\[' <<<"$1"
}

node_refused() {
  {
    echo "VITE_CHAIN_RPC_URL: $1"
    echo "Contributor projects read their history from this node in every visitor's browser. Fix the node or the"
    echo "settings in .env, then run ./run.sh build again (docs/sepolia-testnet.md, section 3)."
  } >&2
  exit 1
}

# With contributor projects on, the page reads the contributor kit's history from VITE_CHAIN_RPC_URL from the deploy
# block onward. A wrong or unreachable node would be built into the page and found only by the first person who opens a
# project, so the build asks it first: which network it is, and the kit's history from that block.
check_chain_node() {
  local kits rpc chain kit from answer got paged
  kits="$(build_setting VITE_CONTRIBUTOR_KITS)"
  if [[ -z "$kits" ]]; then
    echo "Contributor projects are off (VITE_CONTRIBUTOR_KITS is not set): the chain node is not checked."
    return 0
  fi
  rpc="$(build_setting VITE_CHAIN_RPC_URL)"
  [[ -n "$rpc" ]] || node_refused "not set, but VITE_CONTRIBUTOR_KITS is."
  chain="$(build_setting VITE_LAUNCHPAD_CHAIN_ID)"
  chain="${chain:-11155111}"
  [[ "$chain" =~ ^[0-9]+$ ]] || node_refused "VITE_LAUNCHPAD_CHAIN_ID=$chain is not a network number."
  kit="$(sed -nE "s/.*\"$chain\"[[:space:]]*:[[:space:]]*\"(0x[0-9a-fA-F]{40})\".*/\1/p" <<<"$kits")"
  [[ -n "$kit" ]] || node_refused "VITE_CONTRIBUTOR_KITS names no contributor kit address for network $chain."
  from="$(sed -nE "s/.*\"$chain\"[[:space:]]*:[[:space:]]*\"?([0-9]+).*/\1/p" <<<"$(build_setting VITE_HISTORY_FROM_BLOCKS)")"
  [[ -n "$from" ]] || node_refused "VITE_HISTORY_FROM_BLOCKS names no start block for network $chain."

  echo "Checking the page's chain node (network $chain, contributor kit $kit from block $from)..."
  answer="$(node_call "$rpc" '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}')" ||
    node_refused "no answer within 15 seconds to a request for its network (curl says why above)."
  got="$(sed -nE 's/.*"result"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]+)".*/\1/p' <<<"$answer")"
  [[ -n "$got" ]] || node_refused "did not say which network it is. It answered: ${answer:0:300}"
  ((got == chain)) || node_refused "is on network $((got)), but the build is for network $chain."

  answer="$(kit_history "$rpc" "$kit" "$from" latest)" ||
    node_refused "no answer within 15 seconds to a history request from block $from (curl says why above)."
  if is_log_list "$answer"; then
    echo "The chain node answers on network $chain and reads the kit's history from block $from."
    return 0
  fi
  # A node may refuse the whole range at once: the page then reads it in pages, narrowing down to 10 blocks
  # (MIN_PAGE in web/src/features/launchpad/lib/log-pages.ts), so only a node that refuses even that is a stop.
  paged=""
  for span in 1000 100 10; do
    paged="$(kit_history "$rpc" "$kit" "$from" "$(printf '0x%x' "$((from + span - 1))")")" ||
      node_refused "no answer within 15 seconds to a history request from block $from (curl says why above)."
    is_log_list "$paged" && break
  done
  is_log_list "$paged" ||
    node_refused "refused the kit's history from block $from, even 10 blocks at a time. It answered: ${paged:0:300}"
  echo "The chain node refused the kit's whole history at once (${answer:0:200}); the page will read it in pages."
  echo "Check that its range lasts for the run: docs/sepolia-testnet.md, section 3."
}

# The keys (64-character hex) whose projects are the operator's own, comma-separated: the owner's, the operators', and any
# in BUZZ_PILOT_EXCLUDE (set it when Creaton's own project was started from another account). The pilot commands leave
# these projects out of every number, because the pilot measures other people.
pilot_exclude() {
  local name value item items keys=()
  for name in RELAY_OWNER_PUBKEY RELAY_OPERATOR_PUBKEYS BUZZ_PILOT_EXCLUDE; do
    value="$(build_setting "$name")"
    [[ -n "$value" ]] || continue
    IFS=',' read -r -a items <<<"$value"
    for item in "${items[@]}"; do
      item="${item//[[:space:]]/}"
      [[ -n "$item" ]] || continue
      [[ "$item" =~ ^[0-9a-fA-F]{64}$ ]] || {
        echo "$name in .env has \"${item:0:20}\", which is not a 64-character hex key (an npub does not work here: use its hex form)." >&2
        return 1
      }
      keys+=("$(tr 'A-F' 'a-f' <<<"$item")")
    done
  done
  (IFS=','; printf '%s' "${keys[*]:-}")
}

# Run the pilot's read-only queries (pilot/*.sql, after pilot/base.sql) on the stack's database: LATE_DAYS (a founder is late
# after this many days without a weekly update), SUMMARY (on or off: the totals under the table), CSV (on or off), then the
# query files. Nothing is written: the views base.sql makes are temporary. BUZZ_PILOT_AS_OF (seconds since 1970) sets the
# clock for tests; without it, now.
pilot_run() {
  local late_days="$1" summary="$2" csv="$3" exclude asof format=()
  shift 3
  exclude="$(pilot_exclude)" || return 1
  asof="${BUZZ_PILOT_AS_OF:-$(date +%s)}"
  [[ "$asof" =~ ^[0-9]+$ ]] || {
    echo "BUZZ_PILOT_AS_OF must be whole seconds since 1970." >&2
    return 1
  }
  [[ "$csv" == on ]] && format=(--csv)
  cat pilot/base.sql "$@" | compose exec -T postgres sh -c \
    'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" "$@"' psql \
    -X -q -P pager=off ${format[@]+"${format[@]}"} -v ON_ERROR_STOP=1 \
    -v "exclude=${exclude}" -v "asof=${asof}" -v "late_days=${late_days}" -v "summary=${summary}" -f -
}

# --days N and --csv, as `founders` and `due` take them. Sets PILOT_DAYS and PILOT_CSV.
pilot_options() {
  PILOT_DAYS=7
  PILOT_CSV=off
  while (($#)); do
    case "$1" in
      --csv) PILOT_CSV=on ;;
      --days)
        [[ "${2:-}" =~ ^[0-9]+$ && "$2" -ge 1 && "$2" -le 365 ]] || {
          echo "--days takes a whole number of days, 1 to 365." >&2
          return 1
        }
        PILOT_DAYS="$2"
        shift
        ;;
      *)
        echo "Unknown option: $1" >&2
        return 1
        ;;
    esac
    shift
  done
}

# The reports the communities' moderators passed on to the owner (with --all, every report), newest first.
escalated_reports() {
  local which=(--escalated)
  if [[ "${1:-}" == "--all" ]]; then
    which=()
    shift
  fi
  compose exec -T relay /usr/local/bin/buzz-admin reports ${which[@]+"${which[@]}"} "$@"
}

case "${1:-help}" in
  start|up)
    require_env
    warn_missing_policies
    compose up -d --wait
    ;;
  stop|down)
    compose down
    ;;
  restart)
    require_env
    warn_missing_policies
    compose up -d --wait --force-recreate relay
    ;;
  pull)
    require_env
    if creaton_on; then
      # The Creaton relay image is built here (`build`), not pulled.
      compose pull --ignore-buildable
    else
      compose pull
    fi
    ;;
  build)
    require_env_file
    require_page_settings
    export_deployments_settings
    check_app_settings
    check_app_node
    check_web_settings
    check_chain_node
    BUZZ_SOURCE_SHA="$(git -C ../.. rev-parse --short HEAD 2>/dev/null || echo unknown)" compose build relay
    ;;
  upgrade)
    require_env
    warn_missing_policies
    if creaton_on; then
      # The settings first, so a half-set one stops it before the backup and the long build.
      export_deployments_settings
      check_app_settings
      check_app_node
      check_web_settings
      # A backup first: an upgrade can run database migrations that an older image cannot undo.
      ./backup.sh backup
      compose pull --ignore-buildable
      BUZZ_SOURCE_SHA="$(git -C ../.. rev-parse --short HEAD 2>/dev/null || echo unknown)" compose build relay
    else
      compose pull
    fi
    compose up -d --wait
    backup_hint
    ;;
  backup|restore|verify-backup)
    ./backup.sh "$@"
    ;;
  policy-stamp)
    # Record the terms and privacy note as they are now, once their Last updated line is right (README.md, "First start").
    require_env_file
    load_policies stamp
    ;;
  prune-backups)
    prune_backups "${2:-}"
    ;;
  remove-media)
    require_env
    remove_media "${2:-}" "${3:-}"
    ;;
  psql)
    # The database, for the operator's requests (docs/operator-takedown-and-data-requests.md). Takes psql's own options;
    # without a terminal (SQL piped in), it reads standard input.
    require_env
    shift
    tty=()
    [[ -t 0 ]] || tty=(-T)
    compose exec ${tty[@]+"${tty[@]}"} postgres sh -c 'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" "$@"' psql "$@"
    ;;
  logs)
    shift || true
    compose logs -f "${@:-relay}"
    ;;
  status|ps)
    compose ps
    ;;
  config)
    require_env
    compose config
    ;;
  backup-hint)
    backup_hint
    ;;
  add-member)
    docker compose exec relay /usr/local/bin/buzz-admin add-member --pubkey "${2:?Usage: ./run.sh add-member <npub-or-hex> [--role member|admin]}" "${@:3}"
    ;;
  remove-member)
    docker compose exec relay /usr/local/bin/buzz-admin remove-member --pubkey "${2:?Usage: ./run.sh remove-member <npub-or-hex> [--role member|admin]}" "${@:3}"
    ;;
  list-members)
    docker compose exec relay /usr/local/bin/buzz-admin list-members
    ;;
  reports)
    # The reports communities' moderators passed on to the server's owner (with --all, every report), newest first,
    # read from the database. The web app's list of them needs BUZZ_ADMIN_HOST, which the HTTPS (Caddy) stack does
    # not serve, so on that stack this is the way to read them.
    require_env
    shift
    escalated_reports "$@"
    ;;
  founders)
    # One row per founder's project: weekly updates and how they came, promises kept or missed, help asked and offered,
    # tasks accepted. Read from the database; the operator's own project is left out (pilot_exclude).
    require_env
    shift
    pilot_options "$@" || exit 1
    pilot_run "$PILOT_DAYS" "$([[ "$PILOT_CSV" == on ]] && echo off || echo on)" "$PILOT_CSV" pilot/founders.sql
    ;;
  due)
    # Founders whose last weekly update is 7 or more days old, with how many days late: the list to message by hand.
    require_env
    shift
    pilot_options "$@" || exit 1
    pilot_run "$PILOT_DAYS" off "$PILOT_CSV" pilot/due.sql
    ;;
  daily)
    # The owner's list for the morning and the evening of a pilot: who is due, what happened in the last day, and the
    # reports waiting. A section that fails is said and the rest still print, then the command fails.
    require_env
    shift
    pilot_options "$@" || exit 1
    daily_status=0
    printf '== Creaton daily list, %s\n\n== Founders due for a weekly update (%s or more days)\n' "$(date -u '+%Y-%m-%d %H:%M UTC')" "$PILOT_DAYS"
    pilot_run "$PILOT_DAYS" off off pilot/due.sql || daily_status=1
    printf '\n== The last 24 hours\n'
    pilot_run "$PILOT_DAYS" off off pilot/activity.sql || daily_status=1
    printf '\n== Reports passed on to you\n'
    escalated_reports || daily_status=1
    ((daily_status == 0)) || echo "A section above failed: its list is not to be read as empty." >&2
    exit "$daily_status"
    ;;
  help|-h|--help)
    cat <<'MSG'
Usage: ./run.sh <command>

Commands:
  start         Start Buzz with docker compose up -d --wait
  stop          Stop containers without deleting volumes
  restart       Recreate the relay after env/image changes (it does not
                rebuild: after changing a VITE_ setting, run build first)
  pull          Pull configured images
  build         Build the Creaton relay image from this checkout (Creaton
                only). It first runs the web app's settings check (a half-set
                trading block is refused). With contributor projects on, it
                also checks that VITE_CHAIN_RPC_URL is on the right network and reads the
                contributor kit's history
  upgrade       Pull and restart, then print backup reminders (Creaton: back
                up, then pull, build and restart)
  logs [svc]    Follow logs (default: relay)
  status        Show compose service status
  config        Render merged compose config
  backup-hint   Print the production backup checklist
  backup [NAME] Back up the database, media, git data and settings while the
                server runs, into backups/<UTC time>.tar.age (or NAME.tar.age),
                encrypted to the public key BUZZ_BACKUP_AGE_RECIPIENT in .env; the
                plain folder is removed. Refused without that key (README.md,
                "First start", step 9)
  restore FILE --yes
                Replace this stack's data with a backup's (stops the server
                meanwhile). FILE is a .tar.age (needs AGE_IDENTITY_FILE=<the
                private key file>) or an older plain backup folder
  verify-backup FILE
                A .tar.age: check its hash against its sidecar (no key needed);
                with AGE_IDENTITY_FILE set, also open it and check every file
                against its manifest. A plain folder: check it against its manifest
  policy-stamp  Record the terms and privacy note as they are, after updating
                their Last updated line; start and upgrade refuse text that
                changed without it
  prune-backups DAYS
                Delete backups (folders and .tar.age files with their sidecars)
                older than DAYS days
  psql [options]
                Open the database (or run SQL piped in)
  remove-media HASH [--yes]
                List (or, with --yes, delete) one uploaded file, its thumbnail
                and its records in the bundled media store

  add-member <npub-or-hex> [--role member|admin]
                Add a relay member (default role: member)
  remove-member <npub-or-hex> [--role member|admin]
                Remove a relay member
  list-members  List all relay members
  reports [--all] [--limit N]
                List the reports passed on to the server's owner (with
                --all, every report), newest first (default 50, up to 200)
  founders [--days N] [--csv]
                One row per founder's project: weekly updates and when each
                came (a gap over N days, default 7, is "after late flag"),
                promises kept or missed, help asked and offered, tasks
                accepted. The server owner's own project is left out (RELAY_
                OWNER_PUBKEY, RELAY_OPERATOR_PUBKEYS, BUZZ_PILOT_EXCLUDE).
                Read-only. --csv prints the table alone, for the pilot report
  due [--days N] [--csv]
                Founders N or more days (default 7) since their last weekly
                update, with how many days late: the list to message by hand
  daily         The owner's list for each morning and evening: due, the last
                24 hours, and the reports passed on to you

  Note: when adding multiple members in a loop, add `sleep 1` between
  invocations to avoid same-second timestamp collisions in the kind:13534
  roster event. Do not use parallel adds (e.g. xargs -P).

Environment switches (in the shell, or in .env for TLS and Creaton):
  BUZZ_COMPOSE_TLS=true   Include compose.caddy.yml for automatic HTTPS
  BUZZ_COMPOSE_CREATON=true
                          Include compose.creaton.yml (README.md, "Creaton")
  BUZZ_COMPOSE_DEV=true   Include compose.dev.yml for local admin ports/tools
  CREATON_IMAGE_TARGET=runtime
                          Build the old web app into the Creaton image (default: runtime-creaton, the new app)
  CREATON_DEPLOYMENTS_FILE=<path>
                          The deploy script's file for the app's network (paths from this folder), read by build and upgrade
MSG
    ;;
  *)
    echo "Unknown command: $1" >&2
    echo "Run ./run.sh help" >&2
    exit 1
    ;;
esac
