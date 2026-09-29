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

- `kind` is `"role" | "team" | "agent_seat"` (snake_case on the wire; the
  CLI flag spelling `agent-seat` is an input alias only and is never written
  to an event).
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

#### Authority anchor (who may publish a node)

Nodes, grants and budgets are addressed by `(author, d)` but *referenced* by
the bare `d` (`parent`, `via`, `parentGrant`, `subject`). If any member could
publish any `d`, any member could shadow a legitimate node by publishing a
newer record with the same id. The relay therefore anchors authority to a
single root of trust — **owner → seats → agents**:

- The **community owner/admin** may publish any node, including roots.
- Anyone else may publish only a **child** of a node they hold a seat in
  (`holders`; `agentSeats` never confer authority), where that parent is
  itself anchored, the child's `scope.canGrant` is no wider than its
  parent's, and no other author already publishes a node under the same `d`.
- A node is **anchored** when its author is the owner/admin or holds a seat
  in an anchored parent. A reference (`parent`, `via`) resolves to an
  *anchored* candidate for that `d` — never to the newest unanchored one.
- Agent seats never anchor anything. Reviewing, budgeting and creating nodes
  are human authority.

The walk is bounded (depth, candidate count and total lookups) and fails
closed: a graph the relay cannot fully resolve denies the write. Clients MUST
apply the same resolution when rendering (do not key nodes by bare `d`; key by
`(author, d)` and prefer the anchored candidate).

Node publication authority is enforced at ingest **always** (it is not
governed by `ORG_GRANT_ENFORCEMENT`, below).

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
- **Reserved verbs.** Only some verbs are consulted when an agent acts:
  `spend:<amount>` is enforced onchain by the allowance contract, and the
  governance and run counters are enforced through budgets. The `read:` and
  `task:` verbs, and the node scope flags `readBelow` and `assignBelow`, are
  **reserved**: they are recorded, and their delegation is verified for
  attenuation like any other, but no relay or harness reads them at runtime.
  Channel membership remains the only read gate. A client MUST NOT present a
  reserved verb as an enforced restriction.
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
- **Parent resolution is by signer, not by id.** `parentGrant` names only a
  `d`. A verifier resolves it to the candidate whose *stored author equals
  its own `content.issuer`*, whose `grantee` equals the child grant's issuer,
  and whose whole chain verifies. A record that merely shares the id (a
  different author) is never the parent. The incoming event's signer MUST
  equal its `content.issuer`.
- **Equity records are not grants.** A kind:37011 event with
  `"type": "equity"` records an ownership stake (the Project Board's equity
  grant) and carries `"verbs": []`. It is exempt from chain verification and
  authority views MUST ignore it — an equity record never delegates power.


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
    "tasks": { "create": 20, "approve": 0 },
    "governance": { "proposal": 2, "vote": 10, "execute": 2 },
    "messages": 500,
    "llmCalls": 200,
    "llmCostCents": 500
  },
  "onchain": {
    "chain": "eip155:8453",
    "contract": "0x...",
    "subject": "<the agent's 32-byte pubkey, same value as content.subject>"
  },
  "onExceed": "require-approval"
}
```

Governance-action caps (the S3 supervision gate): `limits.governance` ceilings
bind the **observable governance actions** an agent takes — `proposal` counts
kind:47004 records the agent authors; `vote` and `execute` count kind:47005
receipts with `table` `vote` / `execute`. Over a ceiling with
`onExceed: "require-approval"` the action is rejected and becomes a 46010
approval request — HITL, and OAv2 §4.6's supervision rate limit in the same
mechanism. Humans pass untouched (rule 5: budgets never apply to a human's
own actions — the subject binding sees no budget).

Delegation (kind:47005, `table: "delegate"`) is deliberately **not** a gated
class: it is the owner's assignment of their own voting power — revocable by
re-delegating (majeur's `delegates()` defaults to self) — and rule 5 keeps it
outside budget supervision. The gate covers an agent's ACTIONS
(proposal/vote/execute); the owner's control of their own votes is not an
action to approve.

- `window` is `"epoch" | "day" | "week" | "month"`. `day`/`week`/`month` are
  **fixed epochs**, not calendar periods: a window starts at
  `floor(unix_time / len) * len` with `len` = 86 400 / 604 800 / 2 592 000
  seconds — the same numbering the onchain allowance uses (see *Epoch
  mapping* below), so the relay, the contract and every client agree on when a
  window rolls over. `epoch` is the all-time cumulative counter and never
  resets; a budget that must lapse carries an explicit expiry instead. An
  unknown `window` is rejected at ingest.
- **Counters.** The relay meters, per subject and window: `runs`, `tasks`
  (`create` / `approve`), `governance` (`proposal` / `vote` / `execute`),
  `messages` (chat messages of kind 9 and 40002 authored by the agent) and
  `llmCalls` (calls through the relay's LLM gateway, which is metered before
  the upstream is contacted) and `llmCostCents` (US cents spent through the
  gateway, charged after each call from the upstream's reported token usage
  and the operator's price table; one call can overshoot the limit by its own
  cost and the next is then refused, and a relay with no price table refuses an
  agent covered by a cost limit instead of running it unmetered). `spend` is
  enforced onchain (below), not by the relay.
- Budgets apply to **agents and delegated scopes, never to a human's own
  actions** (design rule 5). A human's spending is a governance act (a vote,
  a treasury allowance), not a budget.
- `onExceed: "require-approval"` routes the would-be action into the
  workflow approval kinds (`46010` request → `46011`/`46012` grant/deny), so
  a budget overrun becomes a durable, auditable approval request rather than
  a silent stop or a silent spend. `approve: 0` (as above) means every
  approval needs a human. Vocabulary note (WEF Foundations): the approval
  cards are **HITL** (human-in-the-loop — final decisions need explicit
  approval), while budget-bounded autonomous execution is **HOTL**
  (human-on-the-loop — agents act within bounds, humans monitor and can
  override). The distinction is worth naming so panels stop inventing words.
- The relay enforces budgets it can observe (event-kind ceilings, run
  counts, messages, LLM gateway calls); spend ceilings are enforced where
  value actually moves — the allowance contract's `spend()` / `spendTo()`
  (below). A budget a surface cannot observe is advisory and MUST be rendered
  as such.

#### Who may publish a budget, and the community default

- The community owner/admin, or a **human holding a seat in an anchored org
  node**, may publish a budget for any agent.
- An agent may publish a budget for **itself** — but only ever to *add*
  constraints: enforcement applies the **strictest** limit among every budget
  covering the subject, so a subject-signed budget can never loosen or
  displace an authority-signed one.
- `subject: "*"` is the **community default budget**. It applies to every
  agent that has no authority-signed budget of its own, so an agent is bounded
  from the moment it joins, without anyone remembering to configure it. It may
  be published by the **owner/admin only**, and it cannot carry an `onchain`
  binding (an allowance binds one agent's key).
- When several budgets cover a subject the relay enforces the strictest of
  each limit; the default is consulted only when no authority-signed budget
  names the agent.
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
authorized spender calls the contract's `spendTo(subject, token, epoch, amount, to)`
over the key above, which debits the epoch allowance **and pays `to` from the
treasury (`transferFrom(treasury, to, amount)`) in the same transaction**, so
ledger and transfer revert together — there is no separate
"settle later" step a key could skip. (`spend()` remains as the pure
accounting entry point; a deployment that uses it without `spendTo` is
advisory and MUST be labelled so.) The contract is the ledger; Nostr is the record —
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
- **Self-review prohibition** (ERC-8004's rule): a reviewer or feedback
  submitter MUST NOT be the subject's owner or an approved operator for the
  agent. A founder cannot grade their own agent — otherwise the signal is a
  self-report and every consumer must treat it as one.
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

### Contribution record review & multi-reviewer resolution

Review disposal for a kind:37013 record is itself a publication: a reviewer
accepts, rejects, or appeals by republishing the record with the **same
`d` tag** — every prior field copied, `reviewStatus` updated (appeals
append to `appealHistory`) — under the **reviewer's own key**. NIP-33 LWW
is author-keyed, so a review by a signer other than the original author
creates a parallel record; that is the intended mechanism, and it makes
review authority legible (the reviewer signs in their own name) rather
than an impersonation of the drafter.

Because parallel records exist, clients MUST resolve the canonical record
per action:

1. Group kind:37013 events by `d` tag (the action id).
2. The **newest `created_at` wins**; a tie is broken by the lowest event
   id (deterministic across clients).
3. Ledgers, review queues, and ladder counts render or consume only the
   canonical record. Superseded versions are visible history at most,
   never double-counted.

Ladder counting (§ Performance-linked autonomy) already consumes only the
canonical record per action, so a fork can neither double-count credit nor
resurrect a rejected verdict.

Review authority:

- A disposition counts only when it is signed by a key with **review
  authority** *and* that key is **not the contribution's subject**. Review
  authority is: the community owner/admin, or a **human** holding a seat in
  an anchored org node (`holders`; agent seats never review). A contributor
  therefore can never approve their own work, whatever their standing.
- The **relay** applies this rule where it consumes reviews — when it
  evaluates a performance-linked ladder it tallies, per action, the newest
  review by an authorized reviewer other than the subject (ties: lowest event
  id); the subject's own `reviewStatus` is never trusted, and an action with
  no authorized review counts as neither accepted nor rejected. Ingest still
  admits the record (a parallel record by an unauthorized signer is harmless
  history), so the rule bites at the decision, not at the write.
- A client MUST label a disposition published by a key without verified
  review authority as unverified (the desktop review queue does), and MUST
  apply the same tally when it shows ladder progress.

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
- **Who may write the graph is always enforced.** Ingest applies the
  [authority anchor](#authority-anchor-who-may-publish-a-node) to `37010`
  nodes and the [budget publication rule](#who-may-publish-a-budget-and-the-community-default)
  to `37012` budgets. This does not depend on any switch: an unanchored write
  is rejected, so a member cannot shadow the owner's node or set a budget on
  an agent they have no authority over.
- **Grant-chain verification is on by default and scoped.** The relay
  validates `37011` attenuation, root standing and expiry for every grant
  that claims delegated authority (equity records, `"type": "equity"`, are
  exempt). It does **not** resolve NIP-OA owners generally, and it does
  **not** rewrite authorship. Operators may set `ORG_GRANT_ENFORCEMENT=off`
  to store and forward grants unchanged; clients MUST still verify chains
  locally, because a relay may run with enforcement off.
- **Budgets are metered where the relay sees the action.** Runs, task,
  proposal, message and LLM-gateway counters are checked at ingest / gateway
  entry against the strictest applicable budget (see *Who may publish a
  budget*). An overrun becomes a durable approval request (`46010`), never a
  silent drop.
- **The LLM gateway is inside the budget model.** The optional
  `/llm/chat/completions` proxy authenticates the caller as a community
  member, applies a per-caller rate limit and daily call cap (the agent's own
  `llmCalls` budget when one covers it, otherwise the operator default),
  clamps `max_tokens`, may pin the model, and meters the call *before*
  contacting the upstream. It never returns the operator's upstream key.
- **Relay-side reads on the community's behalf see only what every member
  could read.** Jobs the relay runs for the community (agent-wiki distillation,
  diagnostics) are scoped to open channels; private and DM channels are never
  read.
- Reads request explicit `kinds`
  (`{kinds: [37010, 37011, 37012, 37013, 37014]}`, or the single kind a
  surface needs); the
  relay's p-gate rejects unscoped reads. No channel filter is involved — the
  org is community-level, so the community boundary is the relay host.

## Client behavior

- Clients render the org chart by reducing the `37010` forest into a tree,
  resolving seats to profiles/usernames.
- Client resolvers stay in step with the relay through a shared corpus:
  `scripts/org-authority-corpus.json` is generated from the Rust resolver
  (`just regen-org-corpus`) and replayed by the desktop and web `orgAuthority`
  twins, covering anchoring, canonical node choice, grant chains, node and
  budget publication, authority holders, verb entailment and the review tally.
- Before attributing an action to delegated authority, a client **MUST**
  verify the grant chain locally (attenuation + root standing), because
  enforcement may be off. The chain is small and the walk is cheap.
- Cross-role communication is ordinary messaging into a surface both roles
  are granted into, or a direct `37011` from one role's node to another
  role's agent seat. It is an edge in the graph, not a wire between
  processes.

## Seeding the org from a template

`buzz templates apply` may carry an `org:` block so a fresh community starts
with a working authority structure instead of an empty graph:

```yaml
org:
  root:
    name: "Vanilla App Studio"
    blurb: "The studio's founders"
  seats:
    - persona: app-dev            # title defaults to the persona's name
    - persona: qa-reviewer
      title: "QA"
  default_budget:
    window: day                   # epoch | day | week | month (default day)
    runs: 200
    tasks_create: 20
    messages: 300
    llm_calls: 200
```

- `root` → one `37010` role node with `d = "root"`, held by the applying
  owner/admin (an anchored author).
- Each seat → one `37010` node of kind `agent_seat` with
  `d = "seat-<persona-id>"` and `parent = "root"`, **vacant** (`agentSeats: []`)
  until the persona's agent key exists; attaching the deployed agent fills it.
- `defaultBudget` → one `37012` budget with `d = "default-agents"` and
  `subject: "*"` (the community default, owner/admin-signed).

Apply is idempotent: it queries the signer's existing `37010`/`37012` `d`
values and skips what already exists, so re-running (or `--resume`) never
duplicates or clobbers a seat an owner has since edited.

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

