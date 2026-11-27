#!/usr/bin/env bash
# Files this branch changed, one per line, for the scoped pre-push lanes in
# lefthook.yml. The base is the merge-base with the first of origin/main and
# origin/lite that shares history with HEAD (the lite branch shares none with
# origin/main), else HEAD^1 — the same order as `resolveBase` in
# scripts/check-file-sizes-core.mjs.
set -euo pipefail

for ref in origin/main origin/lite; do
  if git merge-base "$ref" HEAD >/dev/null 2>&1; then
    exec git diff --name-only "$ref...HEAD"
  fi
done

# No remote base: a branch with a parent changed what its last commit changed;
# a lone root commit changed everything.
git diff --name-only HEAD^1 HEAD 2>/dev/null || git ls-files
