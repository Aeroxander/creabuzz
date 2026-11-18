# AX backend provider for Buzz remote agents

Status: **skeleton** (`crates/buzz-backend-ax`). Provider-protocol conforming
(`info`/`deploy` over stdin/stdout, `docs/remote-agents.md` §Provider
Protocol), manifest generation unit-tested, no control-plane integration
beyond shelling out to the `ax` CLI. Design doc for review; not yet wired
into the desktop's provider discovery (it is: drop
`buzz-backend-ax` onto `PATH`).

Companion to:
- `docs/remote-agents.md` — the binding provider contract (invariants I1–I5,
  axiom M1, §Provider Protocol, §Conformance).
- The AX review in this session's notes: egress warn-and-continue + allow-all
  default, plaintext Task env, lifecycle-model tension.

## Why a provider instead of harness-in-pod

AX Tasks are the sandbox; `docs/backend-ax.md` follows the industry thesis
(Rivet's *run your harness outside the sandbox*; unreal-agent's proxy
operations manager) only halfway for v1: the provider contract requires the
*deployed agent* — a `buzz-acp` harness holding the nsec, publishing relay
presence — so v1 runs the harness as the Task's command. The **tool
boundary** (sandbox = exec/fs only, secrets stay harness-side) is the v2
direction in §Evolution; v1 already implements the parts that are visible
without moving the harness:

- explicit egress Gateway (the sandbox reaches only the relay + model API),
- identity env constructed from top-level payload fields only,
- operator-visible residual exposure of the nsec in Task env (AX v1alpha1
  has no secretRef for Task env — §Secrets).

## Mapping the five invariants

| Invariant | How this provider holds it |
|---|---|
| **I1** identity fail-closed | Blank/undecodable nsec refused in `identity::from_nsec` before any CLI contact; env identity built only from top-level payload fields; user `env_vars` checked against reserved names and refused on collision. |
| **I2** no secrets in configuration | Provider config is validated upstream by the desktop; this provider adds its own rule: `image` must be digest-pinned, `egress_allowlist` required non-empty. No credential fields exist in the schema. AX cluster credentials are never in config — the `ax` CLI resolves from the ambient kube context (I2 corollary). |
| **I3** presence is the status | No status query after deploy. `agent_id` = `<atespace>/<task>` is the bookkeeping axis; liveness is relay presence from the harness. |
| **I4** at most one live instance per key per scope | Task name is deterministic from the decoded pubkey (`buzz-<pubkey[..32]>`); one per atespace. `ax apply` is create-or-update, so a repeat deploy converges to the same Task (no duplicates within the scope). |
| **I5** intentional exit is terminal | `BUZZ_ACP_EXIT_AFTER_INACTIVITY` wired from `inactivity_seconds` (default 900s) — the harness self-stops; no supervisor restarts it. |

**M1 (no management channel)** is held by *absence*: `spec.debug` defaults
off (AX guest services / `ax ssh` are a diagnostic the provider never turns
on), there is no status/exec/log op in the wire protocol, and post-deploy
control is relay messages only.

## The three AX frictions and how this provider handles them

1. **Egress warn-and-continue + allow-all default** (upstream
   `internal/controller/reconciler.go`): this provider *always* emits an
   explicit Gateway and **refuses to deploy without a non-empty
   `egress_allowlist`** (validation happens before any substrate contact).
   The remaining upstream risk — a policy-apply failure mid-run being
   warn-and-continue — is acknowledged in §Known gaps; the provider-level
   contract makes the allowlist deliberate, which is the half we control.
2. **Plaintext Task env** (no `secretRef` for Task env in `ax.io/v1alpha1`):
   the nsec rides `task.env` (stored in AX control-plane state). Residual
   exposure is documented in §Secrets. The egress Gateway is the mitigation
   that matters most: the only hosts the sandbox can reach are the relay and
   the model API, so an attacker inside the sandbox cannot ship the key to
   an arbitrary host; what it can still do with the key inside the relay is
   governed by Buzz's own authority layer (pledged grants, budgets, the
   info-flow broker).
3. **Lifecycle model** (ax suspend/resume, `ax ssh`, worker reassignment):
   the provider never uses suspend/resume or debug; presence-is-status means
   an ax worker migration is invisible to Buzz except via the harness's
   presence re-publication after restart (within the 180s bounded window of
   I3).

## `provider_config` v1

Mirrors the K8s binding's shape conventions (`docs/remote-agents.md`
§`provider_config`): flat, scalar-only, no secrets.

| field | meaning | default |
|---|---|---|
| `ax_server` | AX control-plane gRPC address; empty = `ax ctx` auto-detect | — |
| `atespace` | deployment scope | `default` |
| `image` | digest-pinned runner image (sprig + `ax-task-runner` ABI) | **required** |
| `egress_allowlist` | `host[:port]` host rules — **required, non-empty** | — |
| `command` | optional Task command override (ax-native entrypoint) | — |
| `cpu_request` / `memory_request` / `cpu_limit` / `memory_limit` | resource bounds | 500m / 1Gi / 2 / 4Gi |
| `inactivity_seconds` | idle self-termination (I5) | 900 |
| `debug` | AX guest services (diagnostic only) | false |

## Launch data and the env contract

The `launch` block resolves like the K8s binding
(`buzz-backend-kubernetes/src/env.rs`):

- identity: `BUZZ_PRIVATE_KEY`/`NOSTR_PRIVATE_KEY`/`BUZZ_AUTH_TAG`/
  `BUZZ_RELAY_URL` from top-level payload fields — never from `env_vars`;
  a reserved-key collision in user env is a deploy refusal.
- owner gate: `auth_tag` or `launch.ownerPubkey` MUST resolve, else refuse
  (without an owner the agent cannot honor `!shutdown`).
- harness command: `launch.command`/`args` → `BUZZ_ACP_AGENT_COMMAND`/
  `BUZZ_ACP_AGENT_ARGS` (comma-joined, same unrepresentable-comma rule as
  the K8s binding) + `BUZZ_ACP_MCP_COMMAND=buzz-dev-mcp`.
- respond-to gate: modes `owner-only|allowlist|anyone|nobody` validated
  provider-side; allowlist mode requires a list; wired as
  `BUZZ_ACP_RESPOND_TO(_ALLOWLIST)`.
- user `env_vars` merge last (tier 3).

## Secrets

AX v1alpha1 stores the Task in its control-plane state (Redis) and every
Task env line is returned by the in-sandbox metadata server. **Do not run
this provider against a `ax-server` you do not trust with the agent's key.**
The egress Gateway bounds what a compromised sandbox can send the key to;
Buzz's authority layer bounds what it can do with the key inside the relay.
The K8s binding's §Secrets reasoning (`docs/remote-agents.md`) applies here
with the Gateway as the additional, substrate-specific mitigation.

## Deploy

`deploy` = render manifest → `ax apply -f -` (stdin). `agent_id` =
`<atespace>/<task-name>`. The `ax` CLI must be on the provider's PATH
(self-augment like the K8s binding's kubeconfig `exec` plugins if launched
from a GUI context). Identity is derived before any CLI contact.

## Known gaps (skeleton)

- `ax apply` failures surface raw CLI stderr (scrubbed upstream by the
  desktop, spec §Provider Output Is Untrusted) — no structured
  reconciliation/gc loop yet (the K8s binding's `reconcile.rs` is the model).
- No `undeploy` (matches the protocol: deletion orphans, GC + I5 bound the
  cost; a future `buzz-backend-ax` GC would reap abandoned Tasks by label).
- Upstream egress policy-apply failure is warn-and-continue; the provider
  makes the allowlist deliberate but cannot fix the reconciler.

## Evolution: harness-outside-sandbox (v2)

The reviewer-noted direction (Rivet *run your harness outside the sandbox*,
unreal-agent's proxy operations manager): the harness runs on Buzz's trusted
side (desktop or a relay-host actor), the AX Task becomes a *tool target*
— AX's guest services (process + filesystem over the atenet router)
already provide the exec/fs operations a tool translator would dispatch
serialized operations to (the unreal-agent seam). Payoffs: the nsec never
enters the cluster (§Secrets disappears), the Task is disposable. Trade:
presence and durability move to the trusted side, which is a different
feature from the provider contract (a "remote workspace for a hosted
agent") and needs its own design before the harness itself stops shipping
inside Tasks.
