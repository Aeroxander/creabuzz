# prime-acp-shim

ACP stdio server that delegates to `prime-agent --mode rpc`, so `buzz-acp`
(or Zed, JetBrains, any ACP client) can drive Prime Agent. Zero dependencies
— Node 20+ built-ins only.

```text
buzz-acp ──ACP stdio──▶ prime-acp-shim ──JSONL stdio──▶ prime-agent --mode rpc
```

## Protocol mapping

| ACP | RPC |
|---|---|
| `initialize` | `{ protocolVersion: 2, agentCapabilities, _meta.steering }` |
| `session/new` | `{ sessionId }` (child spawned eagerly so a missing binary fails fast) |
| `session/prompt` | RPC `prompt`; text/tool deltas stream back as `session/update`; `agent_end` → `{ stopReason: end_turn }` |
| `session/cancel` | RPC `abort`; pending prompt answers `cancelled` |
| `_session/steering` | RPC `steer` |

Backend failures answer the pending prompt with a JSON-RPC error — never a
fake `end_turn` with an empty transcript.

## Hardening

- Process-group kill for every child on every exit path.
- 10 MB line caps on ACP stdin and RPC stdout (fail closed).
- Secrets travel via inherited env only; nothing is logged or echoed.

## Use

```bash
export BUZZ_ACP_AGENT_COMMAND=/path/to/prime-acp-shim.mjs  # zero-arg runtime
buzz-acp
```

Requires `prime-agent` on `PATH` (`PRIME_AGENT_COMMAND` overrides),
authenticated (`prime-agent`, then `/login`).

`buzz-prime.json` is a Tier-3 custom-harness definition (drop into
`<app-data>/custom_harnesses/`).

## Tests

```bash
node --test ./*.test.mjs
```

`test-support/` holds the scripted fake backend and wrapper builder. They
live outside any scanned test glob on purpose: the Node runner loads every
file under a scanned directory as a suite, and a helper that waits on
stdin would hang the run forever.
