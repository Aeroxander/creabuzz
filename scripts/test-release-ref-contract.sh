#!/usr/bin/env bash
# scripts/test-release-ref-contract.sh — the relay release only runs at the tag it names (scripts/verify-release-ref.sh), and
# the image workflow takes no caller-selected source ref.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
verify="${repo_root}/scripts/verify-release-ref.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git -C "$tmp" init -q
git -C "$tmp" config user.name test
git -C "$tmp" config user.email test@example.com
echo first >"$tmp/file"
git -C "$tmp" add file
git -C "$tmp" commit -qm first
git -C "$tmp" tag -m "relay release" relay-v1.2.3

(
  cd "$tmp"
  GITHUB_REF=refs/tags/relay-v1.2.3 "$verify" relay-v 1.2.3
)

if (
  cd "$tmp"
  GITHUB_REF=refs/heads/main "$verify" relay-v 1.2.3
); then
  echo "branch-backed release was accepted" >&2
  exit 1
fi

echo second >>"$tmp/file"
git -C "$tmp" commit -qam second
if (
  cd "$tmp"
  GITHUB_REF=refs/tags/relay-v1.2.3 "$verify" relay-v 1.2.3
); then
  echo "release accepted HEAD after the tag commit" >&2
  exit 1
fi

git -C "$tmp" tag -m "relay release" relay-v2.0.0
(
  cd "$tmp"
  GITHUB_REF=refs/tags/relay-v2.0.0 "$verify" relay-v 2.0.0
)

if grep -q 'inputs\.ref' "$repo_root/.github/workflows/docker.yml"; then
  echo "publisher workflow still accepts a caller-selected source ref" >&2
  exit 1
fi
grep -q 'verify-release-ref\.sh' "$repo_root/.github/workflows/docker.yml"

echo "release ref contract passed"
