# Paperclip parity in Buzz — port plan

> Goal: get Buzz as close as possible to Paperclip's **UI and features**,
> natively — with the relay (not a per-user database) as the system of
> record. This is the concrete plan behind [VISION_ORG.md](../VISION_ORG.md)
> and [NIP-ORG](nips/NIP-ORG.md).

Paperclip's own design doc defines the product: *"an operational control
plane: org charts, tasks, heartbeat runs, budgets, approvals, audit logs…
Every screen answers, in order: what is happening, does it need me, what do I
do about it."* That stance is worth copying verbatim — it is the right shape
for supervising a team of agents.

The move is **port the concepts, not the code, and not the store.** Buzz
already has the harder half (identity, tasks, approvals, roster, audit). What
it lacks is a handful of well-defined surfaces and two missing kinds.

## Feature parity map

| Paperclip feature | Buzz status today | Path to parity |
|---|---|---|
| **Org chart** | `OrgView.tsx` — flat team labels, owner-scoped | rebuild on `37010` nodes; tree layout, seat occupancy, role colors |
| **Tasks / board** | `WorkBoard.tsx` + `KanbanBoard.tsx` over `44011` + git issues | already strong; add per-role columns & assignee = seat |
| **Approvals** | workflow kinds `46010`–`46012`; `WorkBoard` grants/denies | first-class "Needs me" inbox; reviewer routing via org |
| **Audit log** | `buzz-audit` hash chain (backend) | an audit surface rendering chain entries + grant/budget events |
| **Roster / liveness** | `use-agent-roster.ts`, `FleetView.tsx` over `44010` heartbeats | largely done; fold seats into org nodes |
| **Agent memory** | `agent-memory.ts` (NIP-AE engrams) | surface per-seat memory on the org card |
| **Budgets** | **missing** | `37012` + a budgets view + enforcement at signing path |
| **Hierarchy / delegation** | **missing** (teams are flat) | `37011` grant chains; role-scoped read/write |
| **Heartbeat runs / routines** | **missing** as a first-class object | routine kind + "runs" feed (each run = a signed turn metric `44200`) |
| **Artifacts / work products** | partial (repos, media, wiki) | an artifacts column on the board; link outputs to tasks |
| **Skills** | agent harness skills exist | optional; a skills directory per community |

Two genuinely new kinds (`37011` grants, `37012` budgets) plus one
re-grounded surface (`37010` replacing flat team labels). Everything else is
composing what Buzz already ships.

## The screens to build (in the `fleet` feature)

1. **Org chart (`OrgView` v2).** Tree of `37010` nodes. Each card: role name,
   seat occupants (human avatars + agent avatars with liveness dot, already
   in `OrgView`), budget chip, "needs approval" count. Edit = publish a new
   `37010`. This is the centerpiece — the thing that makes it *feel* like
   Paperclip.
2. **"Needs me" inbox.** One stream of `46010` approval requests + budget
   overruns (`onExceed: require-approval`) addressed to seats the viewer
   holds. Approve/deny publishes `46011`/`46012`. This answers Paperclip's
   "does it need me" directly.
3. **Budgets view.** Per agent/seat: current window usage vs `37012` limits,
   sparkline, hard-stop vs require-approval toggle. Editing publishes a new
   `37012`.
4. **Runs feed.** Heartbeat/routine runs rendered as a timeline (each run a
   signed `44200` turn metric, owner-scoped), so an operator can scan "what
   is happening" without opening each agent.
5. **Audit view.** Render the hash-chain entries filtered to org/budget/
   grant kinds — every structural change, attributable and permanent.

The `WorkBoard`/`KanbanBoard` and `FleetView` stay; they gain role-aware
columns and seat assignees rather than being rebuilt.

## Data-plane build order

Each step is independently shippable and leaves the tree consistent.

1. **`37010` org nodes + kind registration** (`buzz-core/src/kind.rs`) and
   relay envelope validation. Read-only org UI renders the tree. No
   enforcement yet — pure data.
2. **`37011` grants + chain verification in `buzz-sdk`** (client-side), so
   attenuation is usable and testable before any relay enforcement. Unit
   tests pin the attenuation rules (widening rejected, revoked parents
   invalidate children, root-standing required).
3. **Relay grant-chain enforcement for org-scoped writes** — opt-in, behind
   a config flag, scoped to org kinds only (never a blanket NIP-OA change).
4. **`37012` budgets + the `onExceed → 46010` bridge.** Enforcement where
   observable (event-kind ceilings, run counts; spend at the signing path).
5. **Role-scoped channel/task read gates** — the "limited access" axis, on
   top of the org graph.
6. **One-way importer.** A paperclip company → relay org events, for teams
   migrating in. Strictly import; no standing sync.

## What we deliberately do NOT build

- **No bidirectional sync with a per-user database.** That is the mapping
  tax and the dual-source-of-truth failure this plan exists to avoid.
- **No embedded third-party server as the org store.** A loopback,
  single-tenant Postgres cannot hold community state; that is its design,
  not a bug we route around.
- **No budget caps on humans.** Budgets bound agent autonomy. A person's
  spend is governance (a vote / treasury allowance), not a meter.
- **No new HTTP API.** The org is events, per the repo rule.

## Relationship to the existing bridge

`crates/buzz-paperclip` and the desktop managed-agents surface (~7.3k lines)
become **import-only and optional**: valuable as a private sandbox and an
on-ramp, never a co-equal store of shared org state. That is a deliberate
scoping decision, not a silent drift, and it is recorded in
[VISION_ORG.md](../VISION_ORG.md). The desktop can keep launching a local
instance for solo drafting; the moment an org is shared, the relay owns it.

## Definition of done for "parity"

An operator can open a community and, without leaving Buzz: see the org as a
chart of roles and seats; see at a glance what is happening and what needs
them; approve or deny with their name attached; set a budget and trust an
overrun becomes a request, not a silent spend; and read back every structural
change from the audit log. When a community later opts into an onchain DAO,
the same chart — unchanged — is the thing that gets bound.

