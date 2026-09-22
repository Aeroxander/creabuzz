NIP-ORG
=======

Community Org Graph — roles, delegation chains, and budgets

`draft` `optional` `relay`

**Depends on**: NIP-01 (basic event format, addressable events), NIP-29
(community membership and the `h` group tag — used elsewhere for channel
scoping and channel-level access), NIP-OA (agent provenance — how an agent's
events carry an owner attestation). Interacts with NIP-LP (a launch's opt-in
onchain binding), the agent-fleet kinds `44010`/`44011` (capabilities and
tasks), and the workflow approval kinds `46010`–`46012`.

**Shapes precedent**: org records are **community-level, global-only objects**
— the same addressing as a project (`30621`, NIP-MP) or a launch record
(`37001`, NIP-LP): addressed by `(pubkey, kind, d)`, stored with no channel
association, and read with explicit `kinds`. The org belongs to the whole
community, not to one channel, so these kinds carry no routing tag.

## Abstract

This NIP defines the event vocabulary for a **community-owned organizational
structure** on the relay: a hierarchy of **org nodes** (roles such as "CTO"
or "Episode 2 Team"), **grants** that delegate scoped authority along that
hierarchy (a human → their agent; a role → a subordinate human; a role → a
peer role's agent), and **budgets** that bound how much autonomy (spend,
compute, runs) a node or agent may exercise before needing human approval.

The relay is the system of record. The org graph, every delegation edge, and
every budget are signed, community-level Nostr events — legible, forkable,
and auditable on the relay's hash-chain audit log. No per-user database ever
holds shared org state.

The structure is **chain-optional**. A community can run its org purely as
coordination data (the default). Opting into an onchain DAO binds the org
root to a Moloch-family DAO (see NIP-LP); roles map to shares, budgets map to
treasury allowances, and the exit right is ragequit. The graph is identical
on- and off-chain; the onchain step adds money and exit, nothing else.

## Motivation

Humans and agents increasingly work *together* in a community, but the
platform's permission model is flat: you are a community member, and you are
in a channel roster, or you are not. There is no answer to the questions an
organization asks every day:

- *Who does this agent work for, and what is it allowed to do?* (provenance
  exists via NIP-OA, but authority does not)
- *Can this subordinate's agent read the leadership channel?* (channel
  rosters are per-channel and binary, not role-aware)
- *How much may this agent spend or run before a human must approve?*
  (nothing bounds autonomy)
- *What did the org decide, and who had the standing to decide it?* (the
  audit log records events, not authority)

The existing agent-team kinds (`30176`–`30178`) are **owner-authored and
flat**: one workspace owner groups their own personas. They cannot express a
*shared, cross-owner* structure, because each event lives under a single
author's key. An org is precisely the thing that is not owned by one key.

This NIP makes the org a first-class, community-level, multi-writer object.
It is the coordination-layer answer to "how do humans and AI agents work
together in a DAO" — with the onchain step strictly opt-in.

## Design rules

1. **The relay is the record.** Org structure, delegation, and budgets are
   Nostr events on the community's relay. They inherit realtime fan-out, the
   auth pipeline, and the audit hash chain for free. No new HTTP data plane.

   They are **community-level**, not channel-scoped: one org belongs to the
   whole community, exactly as a project (`30621`) or a launch record
   (`37001`) does. A stray `h` tag is never routing for these kinds.

2. **Roles are seats, not people.** An org node names a *role* ("CTO",
   "Animator", "Verifier Panel"). Humans and agents *hold* seats. The same
   node is occupied by whichever identities its current record lists, so an
   agent can hold a role today and a human tomorrow without restructuring.

3. **Authority is transitive and attenuating.** A grant may only ever convey
   a *subset* of what its issuer holds. Walking the grant chain from any
   authorized action back to a human root must never pass through a link that
   widens scope. This is how "limited access above your position" is made
   concrete and auditable.

4. **Provenance and authority are separate.** NIP-OA answers "whose agent
   signed this" and is unchanged. NIP-ORG answers "was this agent permitted
   to do this here." An event may carry both; neither rewrites the other.

5. **Budgets bound autonomy, not people.** Budgets cap what an *agent* or a
   *role's delegated power* may do autonomously. Humans are never
   budget-capped by the platform. This is the capital-boundary rule: the
   craft interior is measured for improvement, never metered per person.

6. **Onchain is a binding, not a rebuild.** The off-chain org and the onchain
   DAO are two readings of one graph. A community that never launches a token
   loses nothing.

## The kinds

| Kind | Name | Shape | Purpose |
|------|------|-------|---------|
| `37010` | Org node | parameterized replaceable, `d` = node id | role/team/agent seat in the org chart |
| `37011` | Org grant | parameterized replaceable, `d` = grant id | scoped, revocable delegation of authority |
| `37012` | Budget | parameterized replaceable, `d` = subject id | bound on autonomous action (spend/runs/tasks) |
| `37013` | Contribution record | parameterized replaceable, `d` = action id | verified contribution profile for credit settlement |
| `37014` | Budget spend receipt | parameterized replaceable, `d` = spend id | Nostr mirror of a spend settled against an onchain allowance |

All five are community-level, global-only records: addressed by
`(pubkey, kind, d)`, stored with no channel association, and never
channel-scoped by a stray `h`.

### `37010` — Org Node (addressable, community-level)

A node in the org graph. Addressed by `(author-pubkey, 37010, d)` where `d`
is the node's stable id. Community-level: the org spans the whole community,
so the record carries no channel/routing tag and is stored globally.

```json
{
  "v": 1,
  "name": "CTO",
  "kind": "role",
  "parent": "<d of parent node>",
  "holders": ["<npub-hex>"],
  "agentSeats": ["<npub-hex>"],
  "scope": {
    "readBelow": true,
    "assignBelow": true,
    "canGrant": ["read", "task", "spend:<amount-per-epoch>"]
  },
  "ui": { "color": "...", "icon": "...", "blurb": "..." }
}
```

- `kind` is `"role" | "team" | "agent-seat"`.
- The org is a **forest** of nodes; `parent` links form the hierarchy
  (omitted on a root, typically the founder's seat). A community's org chart
  is the set of `37010` events it holds, read-side resolved last-write-wins
  per `d`.
- `holders` / `agentSeats` are the seat occupants (agent seats are NIP-OA
  keys).
- `scope.canGrant` declares which verbs this node may delegate. A node can
  only issue grants for verbs in its own `canGrant`, and a grant can only
  convey a subset — attenuation is enforced in `37011` validation.

Replacement follows NIP-33: a newer `37010` for the same `(author, d)`
supersedes. Org edits are ordinary publishes, so they are signed and
audit-logged like any other write.

### `37011` — Org Grant (addressable, community-level)

A signed, scoped, revocable delegation of authority from an issuer to a
grantee. Addressed by `(issuer-pubkey, 37011, d)`. This is the transitive
edge that NIP-OA's single hop cannot express.

```json
{
  "v": 1,
  "issuer": "<npub-hex>",
  "grantee": "<npub-hex>",
  "via": "<d of org node the issuer acts through>",
  "verbs": ["read:#leadership", "task:create", "spend:100000"],
  "parentGrant": "<id of the grant this one is a subset of>",
  "expires": 1798765432,
  "revoked": false
}
```

- `grantee` is a human **or** an agent key. `parentGrant` omitted = a root
  grant issued directly from standing.
- `verbs` is a list of **scoped capabilities**, each `name` or
  `name:argument` (a channel scope, a spend ceiling, a task verb).
- **Attenuation (MUST):** if `parentGrant` is present, every verb here MUST
  be entailed by some verb in the parent chain — same name and an argument no
  broader (`spend:50000` under `spend:100000` is valid; `spend:200000` is
  not; `read:#eng` under `read:#leadership` requires `#eng ⊆ #leadership`).
  A verifier walks `parentGrant` links to a root and confirms the chain never
  widens. A chain that widens, or whose root lacks standing, is invalid.
- **Root standing (MUST):** a grant with no `parentGrant` is valid only if
  its issuer holds (or is seated in) an org node whose `scope.canGrant`
  covers the verbs. Authority always bottoms out at a human-held seat.
- **Revocation** is republication of the same `(issuer, d)` with
  `"revoked": true`, or expiry. Revoking a grant transitively invalidates
  every grant naming it, because their chain no longer reaches a valid root.


### `37012` — Budget (addressable, community-level)

A bound on autonomous action for an agent or a delegated scope. Addressed by
`(author, 37012, d)` where `d` names the budgeted principal or scope.

```json
{
  "v": 1,
  "subject": "<agent npub-hex> | <org node d> | <grant id>",
  "window": "epoch",
  "limits": {
    "spend": { "amount": 100000, "unit": "usd-cents" },
    "runs": 50,
    "tasks": { "create": 20, "approve": 0 }
  },
  "onchain": {
    "chain": "eip155:8453",
    "contract": "0x...",
    "subject": "<the agent's 32-byte pubkey, same value as content.subject>"
  },
  "onExceed": "require-approval"
}
```

- `window` is `"epoch" | "day" | "week" | "month"`.
- Budgets apply to **agents and delegated scopes, never to a human's own
  actions** (design rule 5). A human's spending is a governance act (a vote,
  a treasury allowance), not a budget.
- `onExceed: "require-approval"` routes the would-be action into the
  workflow approval kinds (`46010` request → `46011`/`46012` grant/deny), so
  a budget overrun becomes a durable, auditable approval request rather than
  a silent stop or a silent spend. `approve: 0` (as above) means every
  approval needs a human.
- The relay enforces budgets it can observe (event-kind ceilings, run
  counts); spend ceilings are enforced where value actually moves (the
  harness's signing path, or onchain allowances for a bound DAO). A budget a
  surface cannot observe is advisory and MUST be rendered as such.
- A budget MAY carry a `performanceLink` ladder that scales its limits with
  the subject's accepted contribution records — see [Performance-linked
  autonomy](#performance-linked-autonomy-budget-ladders).

### Onchain spend bindings

A budget's SPEND ceiling MAY declare an optional `onchain` binding:

- `chain` — `eip155:<chainId>` (EIP-155 chain id), or the literal
  `"anvil-31337"` in local dev.
- `contract` — the deployed allowance contract address (`0x…`;
  `OrgAllowance.sol`).
- `subject` — the budgeted agent's 32-byte pubkey. It MUST equal the budget's
  `content.subject`; the contract keys allowances over
  `(bytes32 subject, address token, uint64 epoch)`.

A budget without `onchain` is enforced where the surface can observe it, or
is advisory. A budget **with** `onchain` is enforced at the value layer: the
harness's authorized spender calls the contract's `spend()` over the key
above **before** the action executes, so the contract rejects any spend over
the epoch allowance. The contract is the ledger; Nostr is the record —
NIP-LP's rule, applied here unchanged. Each settled spend is mirrored as a
kind:37014 receipt (below); the receipt is advisory and the chain is
authoritative, so clients MUST cross-check the contract before acting on
money.

**Epoch mapping.** The contract's `uint64 epoch` key maps to the budget
`window`:

| `window` | Epoch counter |
|----------|---------------|
| `day` | `unix_time / 86400` |
| `week` | `unix_time / 604800` |
| `month` | `unix_time / 2592000` |
| `epoch` | the governance epoch counter — the DAO-bound upgrade; there is no time-derived formula |

The dev windows are deterministic so an off-chain client can compute the
same allowance slot the contract checks. The `epoch` window is deliberately
not time-derived: a governance epoch begins when the bound DAO (NIP-LP)
upgrades it, and only the DAO's own decision procedure defines its boundary.

### Performance-linked autonomy (budget ladders)

A budget MAY carry an optional `performanceLink` object: a pre-authorized
escalation ladder that ties the subject's autonomy to its verified
contribution record. This is the NIP-ORG answer to "agents earn autonomy by
doing good work" — the credit ledger (`37013`) becomes the input to the
permission system, with the human decision made once, at ladder-signing
time, and every subsequent step deterministic.

Publishing a budget with a `performanceLink` IS the human approval. Every
tier is a standing pre-authorization the budget author could have granted
directly, so the root-standing rule applies to the highest tier: a ladder
can never reach authority its author does not hold. No evaluator signature
exists anywhere in the design — evaluation is a pure function over signed
events, and any client MUST derive the same active limits from the same
inputs.

```json
{
  "v": 1,
  "subject": "<agent npub-hex>",
  "window": "week",
  "limits": {
    "spend": { "amount": 100000, "unit": "usd-cents" },
    "runs": 50,
    "tasks": { "create": 20, "approve": 0 }
  },
  "onExceed": "require-approval",
  "performanceLink": {
    "window": "week",
    "dimensions": ["build"],
    "tiers": [
      { "minAccepted": 3,
        "limits": { "spend": { "amount": 200000, "unit": "usd-cents" },
                    "runs": 80, "tasks": { "create": 30, "approve": 0 } } },
      { "minAccepted": 10,
        "limits": { "spend": { "amount": 500000, "unit": "usd-cents" },
                    "runs": 200, "tasks": { "create": 60, "approve": 2 } } }
    ],
    "onViolation": "revoke",
    "violationThreshold": { "rejected": 1 }
  }
}
```

Field semantics:

- `performanceLink.window` — the window contribution counts are taken
  over (same vocabulary as the budget `window`; the two windows are
  independent: a monthly budget may ladder on weekly contributions).
- `performanceLink.dimensions` — optional. When present, only records
  carrying at least one of the named dimensions count toward the ladder.
- `performanceLink.tiers` — 1–8 entries, `minAccepted` strictly ascending.
  Each tier's `limits` is the active budget while that tier holds. Every
  component the base budget caps MUST be capped by the tier at >= the base
  value; a tier MAY introduce a component the base leaves uncapped (that is
  a pre-authorized widening the author signed for).
- `performanceLink.onViolation` — what happens when the violation threshold
  is crossed: `"base"` (fall back to the base limits until the window
  heals, the default), `"require-approval"` (zero autonomy, every action
  routed through the workflow approval kinds), or `"revoke"` (zero
  autonomy, hard-rejected — no approval path).
- `performanceLink.violationThreshold` — rejected records in the window
  that trigger `onViolation`. `rejected` MUST be >= 1. Omitting the
  threshold means rejections never gate the ladder.

Counting rules (deterministic; all inputs are signed events):

- A record counts for the subject when the kind:37013 event's signer is
  the budget `subject` (or the record's `p` tag names the subject).
- Only `reviewStatus: "accepted"` counts toward `minAccepted`; only
  `reviewStatus: "rejected"` counts toward the violation threshold.
  `pending` and `appealed` records count as neither.
- Records are deduplicated per action: the newest version per record `d`
  tag wins (parameterized replaceable, NIP-33 LWW), and soft-deleted
  records never count.
- The window is the interval `[now - window_len, now)` using the same
  window-length mapping as the budget epoch table (`day` / `week` /
  `month`; `epoch` is cumulative).

Resolution rules:

- If the violation threshold is crossed, `onViolation` applies.
- Otherwise the active tier is the highest tier with `minAccepted <=`
  the accepted count; below the first tier, the base `limits` hold.
- A consumer that cannot parse a `performanceLink` MUST fall back to the
  base limits and MUST NOT treat the unparseable ladder as widening
  anything (fail closed to the signed base).

Enforcement mapping:

- The relay MUST evaluate the ladder where it enforces kind and task
  counters (counts are one deterministic query over its own event store)
  and MUST apply `onViolation: "revoke"` as a hard reject.
- Spend ceilings stay enforced at the value layer: the onchain allowance
  contract is bound at the *maximum* tier's spend when the budget is
  published, while the harness evaluates the active tier before calling
  `spend()`. The contract remains the ledger; the ladder lives in Nostr
  exactly like every other budget input.
- Republishing the budget under the same `(pubkey, 37012, d)` replaces
  the ladder (NIP-33 LWW). Tightening a ladder is always allowed;
  *widening* one is a new authorization decision by the budget author
  and inherits the author-root-standing check on ingest.

### `37014` — Budget Spend Receipt (addressable, community-level)

The receipt mirror of an onchain spend: each successful `spend()` against an
allowance bound to a kind:37012 budget is published as one `37014`. It is
the NIP-ORG analogue of NIP-LP's `47005` chain-state receipt. Addressed by
`(author, 37014, d)` where `d` is the spend id. Community-level and
global-only, exactly like `37010`–`37013`: no channel association, and a
stray `h` never channel-scopes it.

```json
{
  "v": 1,
  "subject": "<the agent's 32-byte pubkey, same value as the 37012 subject>",
  "token": "0x...",
  "amount": 2500,
  "unit": "usd-cents",
  "epoch": 7,
  "window": "week",
  "txHash": "0x...",
  "contract": "0x..."
}
```

- `subject`, `token`, `epoch` reproduce the contract's allowance key;
  `txHash` names the chain transaction that settled the spend (the analogue
  of NIP-LP's rule that every receipt names its `tx`), and `contract` names
  the ledger it settled on. `window` records which budget window the `epoch`
  counter maps to.
- Tags: `["d", <spend-id>]` (required, exactly one) and
  `["p", <subject-pubkey>]` (the budgeted agent).
- **Advisory.** The contract is the ledger; Nostr is the record. A client
  MUST verify the `txHash` against the chain before treating a spend as
  settled. Receipts are ordinary member writes — the relay validates only
  the shared org envelope and never re-derives the spend from the chain.
- Replacement follows NIP-33: a newer `37014` for the same
  `(author, d)` supersedes, so a corrected receipt (e.g. a re-mirrored
  `txHash`) replaces the stale one without deleting the audit trail — the
  superseded event remains on the relay's hash-chain audit log.

## Relay behavior

- Relay ingest validates envelope shape for `37010`–`37014` exactly as it
  does for other structured records (JSON-object content, tag caps, bounded
  `d`), and registers the kinds in `crates/buzz-core/src/kind.rs`. The five
  are **global-only**: like projects and launch records they are addressed by
  `(pubkey, kind, d)` and a stray `h` never channel-scopes them.
- **Grant-chain verification is opt-in and scoped.** The relay validates
  `37011` attenuation *only* for org-scoped writes that claim delegated
  authority. It does **not** resolve NIP-OA owners generally, and it does
  **not** rewrite authorship. A relay that does not enforce grants simply
  stores and forwards them; clients can still verify chains locally.
- Reads request explicit `kinds`
  (`{kinds: [37010, 37011, 37012, 37013, 37014]}`, or the single kind a
  surface needs); the
  relay's p-gate rejects unscoped reads. No channel filter is involved — the
  org is community-level, so the community boundary is the relay host.

## Client behavior

- Clients render the org chart by reducing the `37010` forest into a tree,
  resolving seats to profiles/usernames.
- Before attributing an action to delegated authority, a client **MUST**
  verify the grant chain locally (attenuation + root standing), because
  enforcement may be off. The chain is small and the walk is cheap.
- Cross-role communication is ordinary messaging into a surface both roles
  are granted into, or a direct `37011` from one role's node to another
  role's agent seat. It is an edge in the graph, not a wire between
  processes.

## Opt-in onchain binding

A community MAY bind its org root to a Moloch-family DAO (see NIP-LP's
launch record and the vendored `majeur` contracts). The binding is a single
`37010` field on the root node:

```json
"onchain": { "chain": "<chain-id>", "dao": "0x...", "boundAt": 1798765432 }
```

On binding: node `holders` map to DAO shares, `budgets` map to treasury
allowances (`setAllowance`/`spendAllowance`), and the exit right is ragequit.
The org graph itself is unchanged — governance simply becomes enforceable.
This is what makes "true onchain DAO" strictly opt-in: a project that never
binds runs the identical structure as pure coordination data.

## Non-goals

- **Not a rewrite of NIP-OA.** Provenance (`auth` tag) and authority
  (grants) are orthogonal and both unchanged in meaning.
- **Not impersonation or key derivation.** Grants delegate *authority*, never
  identity; a grantee's events remain authored by the grantee.
- **Not an HR system.** Nodes express roles and reporting lines for work and
  authority, not compensation or employment.
- **Not a token-governance mechanism by itself.** Onchain governance is
  delegated to the bound DAO (NIP-LP); this NIP supplies the structure the
  DAO reads.

## Rationale (why events, why the relay)

A second system of record is worse than either alone: a per-user database can
never hold shared org state, and a new HTTP API forfeits fan-out, scoping,
and the audit chain. Making the org a set of community-level events keeps
the org where every other shared artifact already lives, makes every
structural change a signed audit-log entry, and makes the whole graph
forkable with the community that owns it. That — not any single feature — is
what makes the org *community-owned*.

