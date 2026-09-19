# ORG_COMMUNITY_PLAN.md — Paperclip-inspired, community-native org

> Supersedes the framing of `ORG_PHASES_2_4_PLAN.md` (kept below as Phases 2–4
> UI detail). Direction: **take inspiration from Paperclip, do not embed it**.
> The relay event log is the only system of record for anything a community
> shares. Authoritative docs: [VISION_ORG.md](VISION_ORG.md),
> [docs/paperclip-parity-plan.md](docs/paperclip-parity-plan.md),
> [docs/nips/NIP-ORG.md](docs/nips/NIP-ORG.md),
> [docs/paperclip-bridge.md](docs/paperclip-bridge.md).

## The one-sentence direction

Port Paperclip's *operational control plane* — org chart, tasks, approvals,
budgets, audit, "what is happening / does it need me / what do I do" — onto
Buzz's native event kinds (`37010`–`37013`, `44011`, `46010`–`46012`, `44200`)
so the org belongs to the whole community, and demote the Paperclip bridge
(`crates/buzz-paperclip`, desktop window, managed-agents surface) to an
**optional one-way import + private sandbox**.

## Status — Phase 0 implemented and committed

All Phase 0 fixes are implemented and committed on feat/org-graph
(four scoped workers plus direct fixes), all gates green: workspace `cargo check`,
clippy clean on every touched crate (sdk/cli/db/relay/paperclip/mcp;
remaining warnings are pre-existing launchpad/llm_gateway), desktop tsc +
biome + 6513 unit tests, web typecheck + tests, migration-count test
pinned for 0047, desired-state `schema/schema.sql` synced, desktop Tauri
crate compiles.

Implemented: budget enforcement rewritten (subject-keyed lookup, persisted
consumption, durable budget_approvals row + best-effort kind:46010, window
validation, authorship rule); grant verifier hardened (containment, numeric
root standing, expiry) with camelCase wire format across node/grant/budget/
contribution kinds; desktop readers/writers moved to camelCase with
revoked-aware parsing, house-pattern deletions, cycle-safe tree, full seat
rendering, contribution read surface, a11y fixes, mobile kind constants,
PaperclipView docked-window ownership; bridge demotion (paperclip:-prefix
skip, truncation reporting, 0600 state, loud write-key warning, docs status
block, deprecated bridge subcommand).

Remaining follow-ups (recorded, non-blocking):
- Wire grant/deny (46011/46012) resolution to budget_approvals rows.
- Task-counter enforcement hook in the kind-44011 ingest path.
- AppState-level ingest integration test for the budget flow.
- Desktop `fetchEvents` has no abort-signal parameter (needs shared API change).
- `flutter analyze` not run in this environment (pub resolution unavailable).

## Verdict on the existing changes (feat/org-graph working tree)

All gates pass: workspace cargo check, clippy (core+sdk), desktop tsc,
desktop biome (288 files), desktop unit suite 6499/6499, px-text /
file-size / pubkey-truncation gates, web tsc + 160 unit tests. Architecture is right: kinds registered with
compile-time checks, org events are community-level global-only, the
workflow approval-gate wiring is a genuinely atomic single-tx persist with a
TOCTOU-guarded resume, and the bridge's documented guarantees are real and
test-backed. But the changeset is **not mergeable as-is**: budget
enforcement crashes ingest, grant attenuation can be widened, the client
reader never sees revoked grants, and the bridge is still a standing
bidirectional sync that the vision docs forbid. Details in Phase 0 and
Phase 6; fix those before any new UI.

---

## Phase 0 — Make the existing changes conform (before any new UI)

### 0A. Relay/backend blockers (fold before anything else)

1. **Budget lookup SQL is invalid — crashes every kind-44200 ingest.**
   `budget.rs` binds a JSON string as `ARRAY[$2::text[]]` against JSONB
   `events.tags`; the cast fails (`malformed array literal`) and jsonb
   `@>` text[] has no operator. Use the jsonb containment bind from
   `feed.rs:369`. Verified live on the dev DB.
2. **Budget consumption is never persisted.** `increment_budget_consumption`
   has zero callers; counters stay 0 and can never trip. Wire check +
   increment into the same transaction that accepts the event (AGENTS.md
   rules 1 and 5) — today there is no durable record of consumed budget.
3. **No durable approval request on exceed.** Enforcement returns
   `IngestError::Rejected` with a message telling the agent to file its own
   46010. NIP-ORG requires the overrun to *become* a durable kind:46010
   request. Create it relay-side (persistence-first, per the approval-gate
   pattern that already exists).
4. **Subject model mismatch.** Enforcement keys budgets by `d`-tag ==
   agent pubkey; the CLI/SDK put the subject in `content.subject` with an
   arbitrary slug `d`. A budget created via `buzz org budget create` can
   never be found by enforcement. Pick one model.
5. **Attenuation verifier allows widening (NIP MUST violation).**
   `verb_entailed_by` accepts `parent_arg.starts_with(child_arg)`, so
   `read:#l` is "entailed by" `read:#leadership`; prefix matching is not
   channel-set containment. Root-standing checks verb names only, so
   `spend:999999` passes under `canGrant: spend:100000`. `expires` is never
   consulted — expired grants verify clean. Fix all three; pin with tests.
6. **Wire format vs NIP-ORG.** SDK content structs serialize
   snake_case (`agent_seats`, `read_below`, `can_grant`, `parent_grant`,
   `on_exceed`); the NIP says `agentSeats`, `readBelow`, `canGrant`,
   `parentGrant`, `onExceed`. One spelling must win — and note
   `budget_enforcement.rs` reads `on_exceed`, so a NIP-conformant budget
   silently falls back to the default. (Same mismatch exists desktop-side;
   see 0C.)
7. **`.unwrap()`s in `budget_window_start`** (budget_enforcement.rs) —
   new unwraps in a production path violate the AGENTS.md gate.
8. "epoch" window maps to UNIX_EPOCH → an all-time counter that never
   resets; unknown window strings silently become epoch (window is not
   validated at ingest). Only the `runs` counter is checked;
   `tasks.create/approve` limits are dead config. Enforcement lookup
   silently truncates at 10 budgets per agent.

### 0B. Griefing / policy gap

Any MessagesWrite member can author a kind:37012 budget capping **any**
agent's subject. NIP-ORG is silent on budget authorship. Add a relay-side
rule (e.g. budget author must hold the node that seats the subject, or the
budgeted principal must counter-sign) before enforcement goes live.

### 0C. Desktop org-path conformance

1. **Grant verbs never deserialize.** `hooks.ts` publishes `verbs`,
   `orgModels.ts` reads `content.verb` — every grant renders with an empty
   verb list. Fix the reader; align field names with whatever 0A-6 decides.
2. **Revoked grants stay visible.** Revocation republishes kind:37011 with
   `revoked: true`, but the reader computes `revoked = event.kind === 5`
   and ignores the content field. Read `content.revoked`.
3. **Deletions don't follow the house pattern.** Node/budget deletion uses
   kind:5 with only a `d` tag. The established pattern
   (`features/projects/projectDeletion.ts`) is kind:5 with an `a` tag
   `<kind>:<pubkey>:<d>`, `created_at` > live head, and a
   replace-while-deleting recheck. Align.
4. **Content schema diverges from NIP-ORG** (as 0A-6): `agent_seats`,
   `parent_grant`, `issuer: ""` instead of the author pubkey.
5. **Tree-builder bugs** (`lib/tree.ts:35,79` and web `index-org.ts`):
   depth is assigned in a single Map pass, so a child listed before its
   parent gets the wrong depth; an A↔B parent cycle silently drops BOTH
   nodes from roots (web's docstring claims cycles are hoisted — they are
   not, only self-parent is).
6. **Seat-occupant read models diverge.** Desktop renders only the first
   `p` tag truncated to 8 chars; web parses `holders`/`agentSeats` from
   content. A multi-occupant node shows one occupant on desktop, all on
   web. Desktop also fixes indentation to a single occupant model.
7. **Contribution records are create-only.** `ContributionRecordForm`
   publishes kind:37013 but `useContributionRecordsQuery` is never
   called — nothing renders them (Phase 3 was supposed to be the read
   surface; until it lands, hide the create button or wire a minimal
   list).
8. **Accessibility (AGENTS.md rule 7).** Tree expand/collapse button has
   no accessible name and no `aria-expanded` (OrgChart.tsx:233); all
   three dropdown triggers are icon-only with no name; OrgNodeForm and
   OrgBudgetForm declare `role=radiogroup` whose children are plain
   Buttons — not `role=radio` with `aria-checked`, so selection is
   invisible to assistive tech.
9. **Desktop org reads are snapshot-only** (staleTime 60s, no live
   subscription) while web keeps a live subscription — desktop misses
   other members' org edits. Add a live subscription with backfill/live
   overlap (PR #3995 pattern).
10. **Mobile kinds drift.** `mobile/lib/shared/relay/nostr_models.dart`
    gained 44010/44011/44200/46xxx but not 37010–37013. Add them now so
    the drift does not start.
11. **PaperclipView unmount cleanup** closes the paperclip window
    unconditionally on tab switch, even one the user opened detached
    ("Open in a window"); the ResizeObserver also repositions undocked
    windows. Only close windows the view owns.
12. Nits: duplicate const assert for `KIND_ORG_BUDGET` in `kind.rs`; kind
    doc comments claim "`h` = community" while NIP-ORG defines these kinds
    as community-level global-only (no `h` routing tag); `fetchOrgEvents`
    drops the abort signal; kind 37013 is missing from
    `docs/nips/NIP-ORG.md` (the doc covers only 37010–37012); CLI list
    commands `take(limit)` before sorting (arbitrary subset, not newest N);
    CLI human/AI fractions unvalidated; `AppShell.helpers.test.mjs` covers
    `/paperclip` misroutes but not `/org`; web e2e spec calls org nodes
    "for the selected channel" (they are community-level); web header
    labels role nodes "teams"; desktop node fetch limit 500 vs web 1000;
    `ORG_EVENT_KINDS` exported unused; inbox previews for 46001/46005/46006
    show raw JSON content.

---

## Phase 1 — Desktop org UI (done, pending Phase 0 fixes)

Route `/org`, `OrgChart`, forms, mutations, `lib/tree.ts` — as documented in
`ORG_PHASES_2_4_PLAN.md`.

## Phase 2 — Grant chains + budget consumption (UI)

As specified in `ORG_PHASES_2_4_PLAN.md` §2, with two amendments:

- **Grant chain verification must match `buzz-sdk` exactly** — after Phase
  0A-5 fixes the SDK. Reuse the same entailment/root-standing/expiry rules;
  port into a shared TS module with tests pinned to the same cases.
- **Budget consumption Option A** (compute from kind:44200 metrics) stays,
  but the relay's `budget_consumption` table (migration 0047) is the real
  source; when the relay exposes consumption over WS/HTTP, swap the hook
  (Option B) and delete the client-side counting.

## Phase 3 — Contribution records + review workflow (UI)

As specified in `ORG_PHASES_2_4_PLAN.md` §3. Additions:

- Review LWW updates must copy **all** prior fields (not just status) so
  the republished record does not silently drop dimensions/evidence.
- Gate review actions behind a `review` verb grant check once Phase 5
  enforcement exists; until then render an "unverified reviewer" hint
  instead of pretending access control exists.

## Phase 4 — Polish, onboarding, integration

As specified in `ORG_PHASES_2_4_PLAN.md` §4, plus:

- Onboarding wizard state must be community-scoped (community id in the
  persistence key) or it leaks across communities.
- Member sidebar org-role badges: read-only cross-reference; keep badge
  semantics accessible (one label owner).

## Phase 5 — Enforcement (relay)

From `docs/paperclip-parity-plan.md` build order, after Phase 0:

1. Relay grant-chain enforcement for org-scoped writes — opt-in config
   flag, org kinds only, using the fixed attenuation verifier.
2. Budget enforcement where observable; `onExceed: require-approval` always
   produces a durable kind:46010 request (never log-only, never bare
   reject); validate `window`; wire the task counters or drop them.
3. Role-scoped channel/task read gates on top of the org graph.

## Phase 6 — Bridge demotion (Paperclip becomes an on-ramp)

Review verdict on the bridge as built: engineering quality is high (every
guarantee in `docs/paperclip-bridge.md` verified in code and test against
the real Paperclip source), but it is the **old architecture** — a standing
bidirectional sync daemon (`Command::Bridge`, `--cycles 0`), which
contradicts VISION_ORG.md's "one-way import, never ongoing sync". Reconcile
explicitly before merge:

1. **Decide the apply direction's fate.** Keep `sync` as the one-shot
   importer; mark `bridge` deprecated/gated; update
   `docs/paperclip-bridge.md` to record the import-only decision (today the
   doc still endorses "both directions"). Alternatively re-scope the pivot
   in writing if task (44011) sync is deliberately exempt.
2. **Fix the MCP apply fork.** `buzz_set_task_status` publishes a task row
   with `d = paperclip:<issue>` and no `source=paperclip` tag; the apply
   side then treats it as a fresh Buzz task and creates a *second*
   Paperclip issue (idempotency key is the new event id, so Paperclip
   cannot dedupe it). Fix: `decide()` in `apply.rs` skips any `d` with
   `D_PREFIX` ("paperclip:").
3. **Report apply-side truncation.** The apply feed read is capped at 500
   rows with no completeness signal (the projection side has one); older
   unbound tasks silently never apply. Add an incompleteness flag to
   `ApplyReport`.
4. Smaller: `--write-api-key` silently defaults to the read key (fail loud
   instead); bridge state file written 0644 → 0600; CLI key flags leak via
   process listing (document "use env"); `KIND_MESSAGE: u16 = 9` hard-coded
   in `buzz-community-mcp` instead of the `buzz-core` registry;
   `contracts/lib/continuous-clearing-auction` submodule is `-dirty`
   (check whose uncommitted content that is).
5. Verified clean: no bridge/MCP/adapter file touches org kinds
   37010–37013; `adapters/` is an unrelated sound ACP shim; workflow
   approval-gate wiring follows the durable-retry-record pattern.

---

## Phase 7 — The value layer (onchain spend enforcement)

> Status: implemented and verified against a live local anvil — see the
> commits below and the honest not-wired list in the PR description.

The audit found one thing stored on Nostr that needs onchain teeth:
kind-37012 **spend ceilings** are recorded but enforced nowhere (runs and
task counters are enforced at the relay; NIP-ORG explicitly assigns spend to
"where value actually moves"). Dev target: a local anvil chain
(`contracts/foundry.toml` already pins `http://127.0.0.1:8545`).

The split, per NIP-LP's rule ("the chain is the ledger; Nostr is the
record"): the kind-37012 budget stays the coordination record; a minimal
`OrgAllowance.sol` contract is the enforcement ledger; a kind-37014 Budget
Spend Receipt mirrors each onchain spend back as an event.

Fixed data contract:
- `37012` content gains optional
  `"onchain": { "chain", "contract", "subject" }` (subject = the 32-byte
  agent pubkey as bytes32 — no keccak).
- Allowance key = `(bytes32 subject, address token, uint64 epoch)`;
  dev epoch mapping: day = unix/86400, week = unix/604800,
  month = unix/2592000.
- Harness checks onchain allowance before a spend action executes
  (fail-closed), records the spend as the authorized spender, and publishes
  the `37014` receipt. Opt-in via env config; unset = today's behavior.
- Deliberate dev simplification: the contract is the ledger; token custody
  stays with the treasury EOA. The DAO-bound upgrade replaces the owner
  with DAO governance (NIP-ORG onchain section) and moves custody onchain.

---


An operator opens a community and, without leaving Buzz: sees the org as a
chart of roles and seats; sees what needs them; approves or denies with
their name attached; sets a budget and trusts an overrun becomes a request,
not a silent spend; and reads every structural change from the audit log.
A Paperclip instance is optional, local, and never authoritative.

## Quality gates

```bash
. ./bin/activate-hermit
just ci
# desktop-only fast loop:
cd desktop && pnpm tsc --noEmit && pnpm biome check src/features/org --write
```
