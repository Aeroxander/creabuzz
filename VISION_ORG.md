# VISION_ORG.md — The community-owned org

> A founder opens their community. On the left is the org chart: a "CTO" seat
> held by a person, three agent seats reporting to it, an "Episode 2 Team"
> node with two humans and a researcher agent. A task lands on the board; an
> agent picks it up, hits its budget, and the overrun turns into an approval
> request with the approver's name on it. Every edge in that chart, every
> delegation, every budget is a signed event on the relay — forkable with the
> community, auditable forever.

Buzz today treats the org as someone else's problem. It can show you a flat
list of agents grouped by a free-text team label (`web/src/features/fleet/
ui/OrgView.tsx`), and it can bridge tasks in and out of an external
"company of agents" product (`docs/paperclip-bridge.md`). Neither is an org a
*community* owns. The first is a label; the second stores the org in a
per-user database that can never hold shared state.

The org belongs on the relay, next to every other shared artifact. This
document is the case for that, and what it unlocks.

## The principle

**Community state lives on the relay; a per-user tool lives on the device.**
`VISION_REMOTE_AGENTS.md` already states it for agents: *"What survives is
what was always on the relay… identity is portable, community state is not."*
An org chart is community state. The moment two people share an org, no
single machine's database can be its source of truth — so it must be events,
signed and scoped to the community.

This is also what makes the org a **DAO substrate**. A DAO is a shared,
legible, governable structure. You cannot govern what lives in one person's
Postgres. Put the org on the relay and governance becomes possible; keep it
off the relay and it stays a private toy.

## What changes

| | Today | With an org graph |
|---|---|---|
| **Org chart** | flat team labels, owner-scoped | a hierarchy of role *seats* humans and agents hold |
| **Authority** | one-hop NIP-OA provenance | transitive, attenuating delegation chains |
| **Access** | binary channel rosters | role-scoped read/write, enforced against the graph |
| **Autonomy** | unbounded | budgets that turn overruns into approvals |
| **Accountability** | an event log | an event log *with standing* — who was allowed to do what |
| **Onchain** | n/a | the same graph, bound to a DAO, strictly opt-in |

The full event vocabulary is [NIP-ORG](docs/nips/NIP-ORG.md): org nodes
(`37010`), grants (`37011`), budgets (`37012`).

## The shape

- **Roles are seats, not people.** "CTO" is a node; whoever holds it — a
  human today, an agent tomorrow — inherits its authority. This is the
  actual thesis of "humans managing AI employees": the seat is stable, the
  occupant is interchangeable.
- **Delegation is a chain you can audit.** A founder grants their CTO-seat
  agent some verbs; that agent's subordinate's agent holds a narrower slice.
  Any action can be walked back to a human with standing, and no link may
  widen scope. "Limited access above your position" stops being a policy
  document and becomes a verifiable property.
- **Cross-role work is an edge, not a wire.** The CTO's agents and the CMO's
  agents don't need a protocol between two processes — they publish to a
  surface both roles are granted into, or one role grants the other a narrow
  verb. The org graph *is* the integration.
- **Budgets bound autonomy, never people.** An agent may run 50 times and
  spend up to a ceiling per epoch; past that, the action becomes a
  human-approval request. A person's own decisions are governance, not a
  budget line. Incentives live on the capital boundary; the craft interior is
  measured for improvement, never metered per person.

## The on-ramp, and where the old tool fits

The graduation pattern the codebase already invented applies here:
**private → shared → onchain.**

1. **Private.** Someone drafting their own org alone can use any local tool
   — including a self-hosted "company of agents" app — as a *private
   sandbox*. That is a legitimate use; privacy is a feature. The tool's
   loopback, single-user design that disqualifies it from shared state is
   exactly right for this stage.
2. **Shared.** When the org is ready to involve others, it is *promoted* —
   published as relay org events. The bridge's job is one-way import, never
   ongoing sync. From here the relay is the source of truth.
3. **Onchain.** A community that wants money and exit rights binds the org
   root to a Moloch-family DAO (NIP-LP). Identical structure, now
   enforceable. A community that never launches a token runs the same graph
   forever as pure coordination.

A private tool may stay on this path as an *importer and sandbox* — but it is
never a co-equal system of record for anything shared. Two sources of truth
for an org is strictly worse than one.

## What this is not

- **Not a rebuild of an existing app inside Buzz.** The concepts (org chart,
  tasks, budgets, approvals, audit) are ported to the relay's data plane; the
  code is Buzz's own, on Buzz's identity and Buzz's audit chain.
- **Not a new HTTP API.** The org is events, for the same reason every other
  feature is events: fan-out, scoping, and auth come free, and the audit log
  captures structure changes for free.
- **Not mandatory.** A community with no org simply has no `37010` root. The
  flat agent directory and the bridge keep working for those who want them.

## The payoff

Buzz's vision is *the relay is the workspace*. A workspace people actually
organize in needs an org that is as shared, as portable, and as governable as
the channels and repos already are. Put the org on the relay and the
community owns its own structure — which is the difference between a chat app
with bots and a platform humans and agents can genuinely run a project, or a
company, or a DAO on.
