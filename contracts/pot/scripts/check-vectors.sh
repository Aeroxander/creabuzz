#!/usr/bin/env bash
# Regenerates the model vectors in memory and fails if model/vectors.json (committed) differs: the file must be exactly what
# the reference model says. After a change to the model or the scenarios, run `python3 -I model/gen_vectors.py` and commit.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../model"
python3 -I gen_vectors.py --check
