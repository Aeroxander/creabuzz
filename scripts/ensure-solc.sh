#!/usr/bin/env bash
#
# scripts/ensure-solc.sh — make sure the solc that contracts/foundry.toml pins for first-party code is installed where
# forge looks for it (svm's directory). Forge versions older than the compiler do not know it exists and stop with
# "No solc version exists that matches the version requirement"; this installs it from the official Solidity binaries
# host, after checking its SHA-256 against that host's own release list. Does nothing when it is already there.
#
# Usage: scripts/ensure-solc.sh [version]   (default: the `=x.y.z` pin in contracts/foundry.toml)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(sed -nE 's/.*paths = "src\/\*\*", version = "=([0-9.]+)".*/\1/p' "$REPO_ROOT/contracts/foundry.toml")}"
[[ -n "$VERSION" ]] || { echo "ensure-solc: no solc pin found in contracts/foundry.toml"; exit 2; }
case "$(uname -s)" in
  Darwin) PLATFORM=macosx-amd64; SVM="$HOME/Library/Application Support/svm" ;;
  Linux) PLATFORM=linux-amd64; SVM="${SVM_HOME:-$HOME/.svm}" ;;
  *) echo "ensure-solc: unsupported platform $(uname -s)"; exit 2 ;;
esac
TARGET="$SVM/$VERSION/solc-$VERSION"
if [[ -x "$TARGET" ]]; then exit 0; fi
LIST="$(curl -sSfL "https://binaries.soliditylang.org/$PLATFORM/list.json")"
read -r FILE SHA < <(node -e '
  const j = JSON.parse(process.argv[1]);
  const b = j.builds.find((x) => x.version === process.argv[2]);
  if (!b) process.exit(3);
  console.log(b.path, b.sha256.replace(/^0x/, ""));
' "$LIST" "$VERSION") || { echo "ensure-solc: solc $VERSION is not on the release list"; exit 2; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -sSfL "https://binaries.soliditylang.org/$PLATFORM/$FILE" -o "$TMP/solc"
GOT="$(shasum -a 256 "$TMP/solc" | cut -d' ' -f1)"
[[ "$GOT" == "$SHA" ]] || { echo "ensure-solc: checksum mismatch for $FILE ($GOT != $SHA)"; exit 2; }
mkdir -p "$SVM/$VERSION"
install -m 0755 "$TMP/solc" "$TARGET"
echo "ensure-solc: installed solc $VERSION at $TARGET"
