#!/bin/sh
# Offline build of the trusted PID-1 deadline supervisor for work-checks.
#
# Everything here is operator-initiated and offline: the container runs the
# CACHED rust:1-bookworm image (this script never pulls), compiles
# `check-supervisor.rs` statically, verifies the artifact is actually a
# statically-linked executable for the daemon's architecture by RUNNING it in
# an alpine container (which only succeeds for a truly self-contained
# binary), and writes the paired JSON manifest recording the SOURCE sha256,
# the BINARY sha256 and the size bound. The manifest is what the CLI
# re-verifies against the bytes it copies before anything runs.
#
# Usage: scripts/build-check-supervisor.sh [out-dir]     (default: target/)
# Exit: 0 on success. Any step failing is an error — no fallback to an image
# helper or host execution is possible or attempted.
set -eux

HERE=$(cd "$(dirname "$0")" && pwd)
OUT_DIR="${1:-$HERE/../target}"
SRC="$HERE/check-supervisor.rs"

command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 1; }
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }
mkdir -p "$OUT_DIR"

# The daemon's machine architecture decides the target: the supervisor runs
# INSIDE containers on the same VM, so its triple is linux/<daemon-arch>.
DAEMON_ARCH=$(docker version --format '{{.Server.Arch}}')

WORK=$(mktemp -d -t buzz-supervisor-build-XXXXXX)
trap 'rm -rf "$WORK"' EXIT
cp "$SRC" "$WORK/check-supervisor.rs"

# Offline compile inside the cached image: no pull; no network is needed (a
# direct rustc call, no cargo registry).
docker run --rm --pull never \
  -v "$WORK":/work -w /work \
  "rust:1-bookworm" \
  sh -c "rustc --edition 2021 check-supervisor.rs -C target-feature=+crt-static -C codegen-units=1 -C strip=symbols -o check-supervisor"
[ -f "$WORK/check-supervisor" ] || { echo "no binary produced" >&2; exit 1; }

chmod 0755 "$WORK/check-supervisor"
# The runtime proof: in alpine (no glibc) a non-static binary fails to exec.
docker run --rm --pull never \
  -v "$WORK":/probe -w /probe \
  --entrypoint /probe/check-supervisor \
  alpine:3.20 3 /bin/true

cp "$WORK/check-supervisor" "$OUT_DIR/buzz-check-supervisor"
chmod 0755 "$OUT_DIR/buzz-check-supervisor"

# Manifest: input hashes and the size bound for the CLI's trust check. The
# source hash identifies the exact committed/trusted input; the binary hash
# the exact runtime artifact: the CLI refuses to run anything but this pair.
SRC_SHA=$(shasum -a 256 "$SRC" | awk '{print $1}')
BIN_SHA=$(shasum -a 256 "$OUT_DIR/buzz-check-supervisor" | awk '{print $1}')
BIN_SIZE=$(stat -f%z "$OUT_DIR/buzz-check-supervisor" 2>/dev/null \
  || stat -c%s "$OUT_DIR/buzz-check-supervisor")
cat > "$OUT_DIR/buzz-check-supervisor.manifest.json" <<EOF
{"profile": "trusted-rust-pid1-v1", "sourceSha256": "$SRC_SHA", "binarySha256": "$BIN_SHA", "sizeBytes": $BIN_SIZE, "target": "linux/$DAEMON_ARCH", "deadlineExit": 124, "childSignalGuard": "pid-1-default-disposition"}
EOF

chmod 0644 "$OUT_DIR/buzz-check-supervisor.manifest.json"
echo "supervisor built: $OUT_DIR/buzz-check-supervisor"
echo "manifest: $OUT_DIR/buzz-check-supervisor.manifest.json"
