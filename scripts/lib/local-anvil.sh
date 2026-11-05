#!/usr/bin/env bash
#
# scripts/lib/local-anvil.sh — start a scratch anvil that is provably this script's own. Sourced by
# scripts/web-trading-e2e.sh and scripts/secondary-keeper-e2e.sh.
#
# A random port can already be held by another anvil. The new one then fails to bind, the chain-id probe is answered by
# the neighbour, and the journey would deploy onto it and warp its clock. So the port is picked by asking the kernel for a
# free one, an explicit port is refused when anything holds it, and the chain counts as started only when this process is
# alive and its own log says it is listening on that port.
#
# The caller defines `fail` (print a message and exit non-zero). ⚠️  DEV ONLY: a local chain on 127.0.0.1.

# Prints a free high loopback port.
free_loopback_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

# start_local_anvil <port> <log>: boots anvil (chain id 31337) on 127.0.0.1:<port>, sets ANVIL_PID, and returns only once
# that process reports it is listening. Fails when the port is already held, or the process exits or never listens.
start_local_anvil() {
  local port="$1" log="$2" _
  python3 -c 'import socket, sys; s=socket.socket(); s.bind(("127.0.0.1", int(sys.argv[1]))); s.close()' "$port" 2>/dev/null \
    || fail "port ${port} is already in use: not starting a chain next to another one (unset ANVIL_PORT to pick a free port)"
  anvil --host 127.0.0.1 --port "$port" --chain-id 31337 >"$log" 2>&1 &
  ANVIL_PID=$!
  for _ in $(seq 1 100); do
    kill -0 "$ANVIL_PID" 2>/dev/null || { tail -20 "$log"; fail "anvil exited before it was listening on port ${port}"; }
    grep -q "Listening on 127.0.0.1:${port}" "$log" && return 0
    sleep 0.2
  done
  tail -20 "$log"
  fail "anvil never reported listening on port ${port}"
}
