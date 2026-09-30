# Paperclip parity status — can a DAO run on this?

Audited 2026-09-21 against committed HEAD + live walkthrough +
docs/paperclip-parity-plan.md and docs/paperclip-ux-reference.md.

## Parity matrix

| Paperclip feature | Status | Where / gap |
|---|---|---|
| Org chart | PARITY | 37010 canvas with pan/zoom/fit, drill-in, liveness dots; wizard creates it |
| Hierarchy / delegation | PARITY | 37011 attenuating chains; TS + relay verification; grant drawer + revocation curtain |
| Budgets | PARITY | 37012 + consumption bars (70/90 truthful), overrun -> durable approval request, onchain spend ledger |
| Approvals / what-needs-me | PARITY | 46010 cards in inbox with inline approve/deny, aging, resolved-state reads |
| Dashboard / what-is-happening | PARITY | Org dashboard: banners, live agents, metrics, activity feed |
| Contribution records | PARITY | 37013 + classifier proposal + review UI (accept/reject/appeal) |
| Heartbeat runs / liveness | PARTIAL | 3-tier liveness in org UI; web fleet still binary 3-min (unify) |
| Audit log surface | MISSING | backend hash chain + kinds exist; no UI rendering chain entries |
| Agent memory | PARTIAL | NIP-AE engrams exist per-agent; not surfaced on org cards |
| Artifacts / work products | PARTIAL | repos/media/wiki exist; no board column linking outputs to tasks |
| Onchain DAO binding | PARITY (dev) | OrgBinding summon + buzz org bind + relay authority; production governance-proposal handover pending (documented dev simplification) |
| Onboarding | PARITY | Wizard publishes real events, honest step strip, review |
| Task board / issues | PARTIAL | 44011 tasks + WorkBoard exist; per-role columns and seat assignees not yet |

## DAO end-to-end journey — works today vs human workaround

1. Create org — wizard/CLI: WORKS
2. Seat agents/humans — node create with holders/seats: WORKS
3. Delegate authority — grant chains, verified, revoked history: WORKS
4. Budget autonomy — runs/tasks/spend with approval routing: WORKS
5. Overrun -> needs-me — durable request + inline approve/deny: WORKS
6. Contribute — classifier draft -> human review -> 37013: WORKS
7. Settle / bound DAO — OrgBinding summon + bind root + allowances: WORKS (dev anvil; governance handover pending)
8. Exit (ragequit) — majeur ragequit exists onchain; no UI affordance in the app yet: HUMAN WORKAROUND (cast call)

## Top gaps for a Paperclip team to move in
1. Audit-log UI (evidence spine) — every structural change.
2. Task board per-role columns + seat assignees.
3. Ragequit/exit UI on a bound org.
4. Agent memory surfaced on org cards.
5. Artifacts column linking outputs to tasks.

## One-line answer
A DAO can run the full operational loop on this today (org -> delegate ->
budget -> approve -> contribute -> bind); the gaps are evidence/audit
surfacing, board depth, and onchain exit flow polish — all additive,
none structural.
