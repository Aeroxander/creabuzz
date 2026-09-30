# Agentic governance — decision routing as the spine

`draft` `design` `web` `desktop` `cli` `contracts`

Design contract for the governance slice. Principle source: the
legitimacy-infrastructure paper ("DAOs are legitimacy infrastructure for new
organizational forms", provided 2026-09-26) — v1's failure was applying one
market-like aggregation (one-token-one-vote) to every decision; v2 earns
legitimacy through **technical guarantees + legible information systems**,
with design constraints that prevent harmful participation and observational
boundaries that make every action visible, interpretable, attributable.

Extends `docs/dao-launchpad-plan.md` (majeur mechanics, futarchy scoping),
`VISION_ORG.md` (the community-owned org), `docs/token-lifecycle-design.md`
(the honesty patterns), `docs/agent-activity-sharing.md` + the
information-flow broker design (tiered visibility), and answers the audit-log
gap named in `docs/paperclip-parity-status.md`.

## 0. The litmus test

Every governance surface ships with three legible facts:

1. **Which mechanism** decided this (and why that mechanism fits the decision).
2. **Who held what authority** (the acting grant chain, verifiable).
3. **Where the receipts are** (tx + mirror + audit entry).

A surface that cannot answer all three for a stranger is democracy theater
and does not ship. This test is the acceptance criterion for every panel in
§4.

## 1. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | **Decision routing over ballots.** Proposal kind selects the native mechanism (§2). Never a generic yes/no across decision types. | **decided** |
| D2 | **Ragequit is always visible** on every governance surface — the dissent door legitimizes the rest. | **decided** |
| D3 | **Delegation is first-class:** majeur's split delegation surfaces in the main flow, not a settings page. Agents may be delegates under attenuating, revocable grants. | **decided** |
| D4 | **Every governance action emits a receipt** (47005 vocabulary, §5) + an audit-chain entry. The observational boundary is the product. | **decided** |
| D5 | **Authority is visible:** proposal and vote cards render the acting grant chain — who acted, under which grant, with what budget/scope, bound to what evidence. | **decided** |
| D6 | **Quorum math in plain language** before any vote: snapshot block, quorum (bps or absolute), FOR>AGAINST, minYes, TTL, timelock — the exact majeur rules, spelled out. | **decided** |
| D7 | **Futarchy stays scoped to budget/subDAO allocation only** (reaffirmed from the launchpad plan; the paper's "mechanism per information structure" is the reason). | **decided** |
| D8 | **Mirror-only fallback:** every action degrades honestly to record-only (treasury action against the recorded verdict) when the launch is not wired onchain — the same rule as the tranche join (`claim-submit.ts`). | **decided** |
| D9 | **Agent reasoning stays tiered** in governance contexts: channel sees verb/object/outcome; full chain of thought is owner-only. Raw reasoning never enters shared channels (information-flow rule). | **decided** |
| D10 | Vote-mirror vocabulary: extend the 47005 receipt tables vs new kinds; delegation UX granularity; agent vote policy (mandate vs advisory). | open (§6) |

## 2. The decision-routing map (the spine)

The 47004 proposal record already distinguishes `plain | futarchy-budget |
signal` — that marker IS the routing key. Each kind gets its native
mechanism, chosen to match the decision's information structure:

| Decision | Why that mechanism | Surface | Onchain target |
|---|---|---|---|
| **`signal`** — sentiment, roadmap taste | Distributed knowledge: deliberation aggregates it; a vote misprices it | Discussion thread + linked git issue; outcome = a wiki standup summary. **No ballot.** | none |
| **`plain`** — parameters, general policy | Bounded yes/no with stakes: majeur's ruleset (N-1 snapshot, quorum bps/absolute, FOR>AGAINST + minYes, TTL + timelock, execute-by-votes or permits) | Proposal card + D6 quorum math + authority chain | majeur `submitProposal` / `submitVote` / `processProposal` |
| **`futarchy-budget`** — budget & subDAO allocation | Forecasting, not opinion: markets price outcomes better than ballots | Card + market state, futarchy-marked | majeur futarchy reward pools (per-proposal; YES auto-resolves on execute, NO via `resolve`) |
| **Membership / contribution entry** | Contribution evidence, not token weight: tribute joins by contribution; badges tier by delivery | Org-board join flow (Tribute lock → vote → claim shares/loot) + soulbound badge | majeur Tribute peripheral |
| **Recurring budget ops** | Delegated execution, not deliberation: a vote per invoice is theater | Treasury panel (exists: allowances + TapVest bars) | `setAllowance` / `spendAllowance` |
| **Dissent / exit** | The market that disciplines all of the above | RagequitPanel (exists) — **linked from every governance surface (D2)** | majeur `ragequit` |
| **Emergency** | Circuit breaker, not governance | Admin card with the invalidation window spelled out | majeur `bumpConfig` |

**Delegation surface (D3):** proportional split delegation by seat/topic,
rendering each delegate's authority chain; agent delegates show their grant
scope, cap, expiry, and revocation entry (the existing revocation curtain).

## 3. The agentic layer

What makes this *agentic* governance rather than chat next to a ballot:

- **A1 Agent proposer.** Drafts proposals from the knowledge graph — wiki
  standups, milestone state (`unlock-plans` join), contribution records
  (37013). The draft lands as a channel thread first (deliberation, the
  `signal` path), and only then becomes an onchain proposal. **Status
  (2026-09-28):** the sourcing loop ships as **B1**
  (docs/persona-drafting-loop.md): `decision` blocks in wiki pages →
  deterministic composer (verbatim-evidence rule, strictly-parse-or-drop) →
  `47004 state: "agent-draft"` records under the `governance.proposal` budget
  gate → human counter-signs one `openProposal` envelope. The channel-thread
  deliberation step remains the `signal` path.
- **A2 Agent delegates.** Hold delegated votes strictly under attenuating
  NIP-ORG grants (scope, cap, expiry), revocable at any time. The grant chain
  is rendered on every vote they cast (D5). **Status (2026-09-27):** the
  delegation surface ships — `encodeDelegate`/`encodeDelegatesView`
  (cast-pinned), the `DelegationCard` (equity-map dropdown incl. agent
  wallets, "back to myself" reclaim, current-delegate read, 47005 `delegate`
  receipt). Revocable by design: majeur's `delegates()` defaults to self and
  re-delegating reclaims. Plain delegation only — the vendored majeur has no
  split delegation (`delegateAllExplicit` is a majeur upgrade to watch).
- **A3 Agent executor.** A narrow tool surface (`processProposal`,
  `resolve`, allowance draws) used after quorum/timelock. Human gates are the
  existing 46010 approval cards — the VISION_ORG scene: an agent hits a bound,
  the overrun becomes a named approval request.
- **A4 Tiered reasoning (D9).** Proposal rationale in the channel is
  verb/object/outcome; the full chain of thought is owner-only telemetry. A
  governance leak is the worst leak.
- **A5 Quorum watch.** Agents nudge on quorum risk and TTL deadlines as
  channel messages with explicit agent identity — turnout work is exactly the
  toil agents should absorb. **Status (2026-09-27):** the watch ships —
  `web/lib/quorum-watch.ts` + `desktop/lib/quorumWatch.ts` (the two visible
  gates: the FOR>AGAINST margin and the `minYes` floor; the bps quorum is
  adjudicated by the DAO at tally time and the copy says so), the badge on
  BOTH platforms' proposal cards (leading / needs-votes / at-risk / expired
  with a compact clock), and `nudgeReminderParts` — the agent-authored NIP-ER
  reminder shape (tags valid per `validate_event_reminder`). The
  agent-authored send loop is the runtime integration: an agent reads the
  watch and publishes the reminder.

## 4. Slice plan

| Slice | Deliverable | Acceptance |
|---|---|---|
| **S0 Schemas** | This doc; `vote-tx.ts` contract sketched; 47005 receipt vocabulary extended (`proposal` / `vote` / `execute` tables, `tx`-tagged like `claim`/`verdict`); proposal record's `onchain` binding field specified (`{chain, dao, proposalId}`, mirroring 37010's pattern) | vocabulary PR'd; litmus test written into the panel checklist |
| **S1 Mechanics** | `vote-tx.ts` composers (cast-pinned to vendored majeur: `computeProposalId` offline == `Moloch.proposalId` onchain, `openProposal` / `castVote` / `queue` / `executeByVotes` / `state` view), `JourneyGov.s.sol` governance leg appended to `scripts/journey-float.sh` | golden pins vs `cast sig`; journey leg green and chain-verified — **done 2026-09-27** (10/10 composer tests; live-node check: `quorumBps` 500→600 via a real proposal). `buzz launchpad propose|vote|process` CLI + 47005 receipt composers follow in S1b |
| **S2 Panels** | Decision-routed cards in `LaunchProposalsPanel` (desktop) + web launch page: per-kind action row, D6 quorum math, D5 authority chain, D2 ragequit shortcut, sender-picker vote; mirror-only fallback copy (D8) | a stranger answers the litmus test from the UI alone (three facts visible without a tooltip) |
| **S3 Agentic** | A1–A5: proposer/executor personas with narrow tools, reminder loop, tiered reasoning wiring | one proposal goes agent-draft → thread → onchain → human/agent votes → agent-execute, receipts at every step, on anvil |

## 5. Receipt vocabulary (D4)

Extend `milestone-receipt.ts`'s pattern rather than new kinds — the relay's
envelope validation (tx-tagged, launch `a`-scoped) already governs 47005 and
the feed already pairs claim/verdict into timelines:

- `proposalReceiptParts` — table `proposal`, tags `proposal` (record id),
  `onchain` (proposalId when bound), `tx` (submission tx).
- `voteReceiptParts` — table `vote`, tags `proposal`, `vote`
  (`for|against|abstain` — closed vocabulary like `approve|reject`), `tx`.
  Voters may mirror their own vote; agents under delegation carry their grant
  id as an extra tag.
- `delegateReceiptParts` — table `delegate`, tags `delegate`, `tx`. The
  delegation is the OWNER's assignment of their own voting power, revocable
  by re-delegating; deliberately NOT a budget-gated class (the gate supervises
  agent ACTIONS, never an owner's control of their votes).
- `executeReceiptParts` — table `execute`, tags `proposal`, `tx`.

## 6. Open questions (D10)

1. **Vote-mirror vocabulary** — extend 47005 (recommended, §5) vs new kinds;
   confirm no relay envelope change is needed for the new tables.
2. **Delegation granularity** — per-seat vs per-topic vs per-proposal-window.
   Split delegation supports proportional mixes; v1 could ship per-seat and
   keep the others as the record's shape.
3. **Agent vote policy** — agents vote only under an explicit human-granted
   delegation (recommended; grants already carry the authority) vs
   advisory-only (agents propose, humans always click). A3/A2 assume the
   former with revocation as the backstop.
4. **Futarchy plumbing depth** — v1 ships `signal` + `plain` + allowances +
   ragequit; `futarchy-budget` cards render market state read-only until the
   market peripheral work (launchpad plan P3) lands.
5. **Quorum-math source** — render from the record's params vs read the live
   DAO config (`MolochViewHelper`-style reads); read-only chain reads win for
   honesty but the record should carry the advertised params for pre-deploy
   proposals (mismatch flagged in the UI).

## 7. Sources

- The legitimacy-infrastructure paper (user-provided, 2026-09-26): the
  litmus test's three facts come from its "observational boundaries" and
  "design constraints" pair; D1 from its mechanism-mismatch critique.
- `docs/dao-launchpad-plan.md` §Majeur (proposal ruleset, futarchy scoping,
  Tribute, split delegation, bumpConfig), §4 (dao-ext wrapper rule).
- `VISION_ORG.md` (A3's scene), `docs/token-lifecycle-design.md` (D8's honesty
  rule), `docs/agent-activity-sharing.md` (D9/A4), the information-flow
  broker design (leak severity ordering), `docs/paperclip-parity-status.md`
  (the audit surface D4 answers).
