#!/usr/bin/env bash
#
# deploy/ovh/keeper/install.sh — sets up the settlement keeper on the server (README.md in this folder says why and how).
#
#   sudo deploy/ovh/keeper/install.sh                   install: cast at the pinned version, the keeper script, the unit and timer
#   sudo deploy/ovh/keeper/install.sh dry-run <market>  one pass that sends nothing (KEEPER_DRY_RUN=1), in the unit's own sandbox
#   sudo deploy/ovh/keeper/install.sh enable <market>   start the 30-minute timer for one market (one timer per market)
#        deploy/ovh/keeper/install.sh status            the timers, anything failed, and the last log lines
#
# Options for install: --plain-password   read the password from a root-only file instead of a systemd-creds sealed one
#                      --skip-cast        do not touch cast (it is already installed another way)
#                      --stage <dir>      copy everything under <dir> instead of the real system, run nothing (tests)
#
# It never asks for, reads or writes a key or a password: those are put in /etc/creaton-keeper by hand (README.md, steps
# 4 to 6). Safe to run again: it replaces the script, unit and timer with the checkout's, and leaves keeper.env, the
# keystore and the password alone.

set -euo pipefail

# The cast release the repository is pinned to (docs/v3-review/V5-IMPLEMENTATION.md: Forge 1.4.3-stable) and the sha256 of
# its official release tarball, taken from https://github.com/foundry-rs/foundry/releases/tag/v1.4.3 on 2026-11-07. A
# different version needs both changed here.
FOUNDRY_VERSION="v1.4.3"
FOUNDRY_SHA256_AMD64="325ba04dc5cb41c110723b00ac291f8269f8cd785028299aad8252ef980961a7"
FOUNDRY_SHA256_ARM64="209492cb4ebd723d9eac002fa30f41f53c8810105b67d3c32fe8201cf70f89d4"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
CONF_DIR=/etc/creaton-keeper
LIB_DIR=/usr/local/lib/creaton-keeper
UNIT_DIR=/etc/systemd/system
CAST_PATH=/usr/local/bin/cast

STAGE=""
PLAIN_PASSWORD=0
SKIP_CAST=0
COMMAND="install"
MARKET=""

say() { printf '%s\n' "$*"; }
die() { printf 'keeper install: %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    install | status) COMMAND="$1" ;;
    dry-run | enable)
      COMMAND="$1"
      shift
      (($#)) || die "$COMMAND needs the market's address"
      MARKET="$1"
      ;;
    --plain-password) PLAIN_PASSWORD=1 ;;
    --skip-cast) SKIP_CAST=1 ;;
    --stage)
      shift
      (($#)) || die "--stage needs a folder"
      STAGE="$1"
      ;;
    *) die "unknown argument '$1' (see the top of this file)" ;;
  esac
  shift
done

# Where a system path lands: itself, or under the stage folder.
dest() { printf '%s%s' "$STAGE" "$1"; }

if [[ -z "$STAGE" && "$COMMAND" != status && "$(id -u)" -ne 0 ]]; then
  die "run it as root (sudo)"
fi
if [[ -z "$STAGE" && "$COMMAND" != status ]]; then
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found: this is for a systemd machine (Ubuntu 24.04)"
fi

# Copy one file: mode, source, destination (a system path). Owned by root on a real install.
put() {
  local mode="$1" src="$2" target
  target="$(dest "$3")"
  mkdir -p "$(dirname "$target")"
  if [[ -z "$STAGE" ]]; then
    install -m "$mode" -o root -g root "$src" "$target"
  else
    install -m "$mode" "$src" "$target"
  fi
}

require_market() {
  [[ "$MARKET" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "'$MARKET' is not a market address (0x and 40 hex digits)"
}

# Which credential line the installed unit uses for the password, and the file it names.
password_file() {
  local unit
  unit="$(dest "$UNIT_DIR/creaton-keeper@.service")"
  [[ -f "$unit" ]] || die "$unit is not installed yet: run install.sh first"
  sed -nE 's/^LoadCredential(Encrypted)?=password:(.+)$/\2/p' "$unit" | head -n 1
}

# Refuse to enable or dry-run a machine that lacks what a pass needs, saying which piece.
require_setup() {
  local missing=0 file
  for file in "$CONF_DIR/keeper.env" "$CONF_DIR/keystore.json" "$(password_file)"; do
    if [[ ! -s "$(dest "$file")" ]]; then
      say "missing or empty: $file" >&2
      missing=1
    fi
  done
  ((missing == 0)) || die "put those in place first (README.md, steps 4 to 6)"
  if grep -q 'CHANGE_ME' "$(dest "$CONF_DIR/keeper.env")"; then
    die "$CONF_DIR/keeper.env still says CHANGE_ME: put the node's address in"
  fi
  grep -q '^RPC_URL=.' "$(dest "$CONF_DIR/keeper.env")" || die "$CONF_DIR/keeper.env has no RPC_URL= line"
}

# cast at the pinned version, from the official release, checked against the pinned sha256 before anything is unpacked.
install_cast() {
  local want="${FOUNDRY_VERSION#v}" have="" arch sum work tarball
  if [[ -x "$CAST_PATH" ]]; then
    have="$("$CAST_PATH" --version 2>/dev/null | head -n 1 || true)"
    if [[ "$have" == *"$want"* ]]; then
      say "cast $want is already at $CAST_PATH"
      return 0
    fi
  fi
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64; sum="$FOUNDRY_SHA256_AMD64" ;;
    aarch64 | arm64) arch=arm64; sum="$FOUNDRY_SHA256_ARM64" ;;
    *) die "no cast release is pinned for $(uname -m)" ;;
  esac
  command -v curl >/dev/null 2>&1 || die "curl is needed to download cast"
  work="$(mktemp -d)"
  tarball="$work/foundry.tar.gz"
  say "downloading cast $want ($arch) from the official foundry release..."
  curl -fsSL --connect-timeout 15 --max-time 600 \
    -o "$tarball" "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${arch}.tar.gz" ||
    { rm -rf "$work"; die "the download failed (curl says why above)"; }
  if [[ "$(sha256sum "$tarball" | cut -d' ' -f1)" != "$sum" ]]; then
    rm -rf "$work"
    die "the downloaded file's sha256 is not the pinned one: nothing was installed"
  fi
  tar -xzf "$tarball" -C "$work" cast || { rm -rf "$work"; die "could not unpack cast from the download"; }
  install -m 0755 -o root -g root "$work/cast" "$CAST_PATH"
  rm -rf "$work"
  have="$("$CAST_PATH" --version 2>/dev/null | head -n 1 || true)"
  [[ "$have" == *"$want"* ]] || die "cast was installed but reports '$have', not $want"
  say "installed $have at $CAST_PATH"
}

do_install() {
  if [[ -z "$STAGE" && "$SKIP_CAST" -eq 0 ]]; then
    install_cast
  fi

  mkdir -p "$(dest "$CONF_DIR")"
  chmod 0700 "$(dest "$CONF_DIR")"
  put 0755 "$REPO_ROOT/scripts/secondary-keeper.sh" "$LIB_DIR/secondary-keeper.sh"

  local service="$HERE/creaton-keeper@.service" unit_tmp
  unit_tmp="$(mktemp)"
  if ((PLAIN_PASSWORD)); then
    sed 's|^LoadCredentialEncrypted=password:/etc/creaton-keeper/password.cred$|LoadCredential=password:/etc/creaton-keeper/password|' "$service" >"$unit_tmp"
    grep -q '^LoadCredential=password:/etc/creaton-keeper/password$' "$unit_tmp" || { rm -f "$unit_tmp"; die "could not switch the unit to a plain password file"; }
  else
    cp "$service" "$unit_tmp"
  fi
  put 0644 "$unit_tmp" "$UNIT_DIR/creaton-keeper@.service"
  rm -f "$unit_tmp"
  # The same unit with the one switch turned: a pass that sends nothing, for rehearsing in the real sandbox.
  unit_tmp="$(mktemp)"
  sed -e 's|^Description=Creaton settlement keeper for market %i (one pass)$|Description=Creaton settlement keeper for market %i (dry run: sends nothing)|' \
      -e 's|KEEPER_DRY_RUN=0|KEEPER_DRY_RUN=1|' "$(dest "$UNIT_DIR/creaton-keeper@.service")" >"$unit_tmp"
  grep -q 'KEEPER_DRY_RUN=1' "$unit_tmp" || { rm -f "$unit_tmp"; die "could not make the dry-run unit"; }
  put 0644 "$unit_tmp" "$UNIT_DIR/creaton-keeper-dry@.service"
  rm -f "$unit_tmp"
  put 0644 "$HERE/creaton-keeper@.timer" "$UNIT_DIR/creaton-keeper@.timer"

  if [[ ! -e "$(dest "$CONF_DIR/keeper.env")" ]]; then
    put 0600 "$HERE/keeper.env.example" "$CONF_DIR/keeper.env"
    say "created $CONF_DIR/keeper.env: put the node's address in it (README.md, step 6)"
  fi

  if [[ -z "$STAGE" ]]; then
    systemctl daemon-reload
    say "installed. Next: the keystore, password and node address (README.md, steps 4 to 6), then:"
    say "  sudo $0 dry-run <market>   then   sudo $0 enable <market>"
  else
    say "staged under $STAGE; nothing was run"
  fi
}

do_dry_run() {
  require_market
  require_setup
  if [[ -n "$STAGE" ]]; then
    say "(stage) would run: systemctl start creaton-keeper-dry@${MARKET}.service"
    return 0
  fi
  local status=0
  systemctl start "creaton-keeper-dry@${MARKET}.service" || status=$?
  journalctl -u "creaton-keeper-dry@${MARKET}.service" -n 20 --no-pager -o cat || true
  if ((status != 0)); then
    die "the dry run failed (exit $status): the lines above say why. Nothing was sent."
  fi
  say "the dry run passed: the unit started, read the market and sent nothing."
}

do_enable() {
  require_market
  require_setup
  if [[ -n "$STAGE" ]]; then
    say "(stage) would run: systemctl enable --now creaton-keeper@${MARKET}.timer"
    return 0
  fi
  systemctl enable --now "creaton-keeper@${MARKET}.timer"
  systemctl list-timers "creaton-keeper@${MARKET}.timer" --no-pager
}

do_status() {
  systemctl list-timers 'creaton-keeper@*' --no-pager || true
  say
  systemctl --failed --no-pager 'creaton-keeper@*' || true
  say
  journalctl -u 'creaton-keeper@*' -n 20 --no-pager -o short-iso || true
}

case "$COMMAND" in
  install) do_install ;;
  dry-run) do_dry_run ;;
  enable) do_enable ;;
  status) do_status ;;
esac
