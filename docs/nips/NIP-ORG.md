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

## Relay behavior

- Relay ingest validates envelope shape for `37010`–`37012` exactly as it
  does for other structured records (JSON-object content, tag caps, bounded
  `d`), and registers the kinds in `crates/buzz-core/src/kind.rs`. The three
  are **global-only**: like projects and launch records they are addressed by
  `(pubkey, kind, d)` and a stray `h` never channel-scopes them.
- **Grant-chain verification is opt-in and scoped.** The relay validates
  `37011` attenuation *only* for org-scoped writes that claim delegated
  authority. It does **not** resolve NIP-OA owners generally, and it does
  **not** rewrite authorship. A relay that does not enforce grants simply
  stores and forwards them; clients can still verify chains locally.
- Reads request explicit `kinds`
  (`{kinds: [37010, 37011, 37012]}`, or the single kind a surface needs); the
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

