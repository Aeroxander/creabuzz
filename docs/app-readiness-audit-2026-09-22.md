# App coherence & readiness audit — 2026-09-22

> **Superseded (2026-09-29).** These verdicts were written by the same
> author/agents that built the code and were optimistic in places: at the time,
> grants gated nothing at runtime, budgets metered only counters, the LLM
> gateway was uncapped, and there was no CI lane for the contracts. The
> product contract and the *enforced vs advisory* table now live in
> [`docs/dao-os.md`](dao-os.md); read this file as history, not as a current
> readiness claim.

Three parallel audits (desktop features, backend/CLI/protocol, docs-vs-reality)
against feat/org-graph at 76011dfda, spot-verified. Companion to
`docs/production-readiness-audit.md` (2026-09-21, org/DAO scope only).

## Verdict

The app is **wiring-complete and substantially production-ready at the
feature level**: zero dangling Tauri commands, zero phantom event kinds, no
todo!/unimplemented! in production paths, a real onboarding funnel, and
three end-to-end coherent flagships (org graph, git/projects, push
pipeline). The risks are **story-level incoherence**, not broken wiring:
features hidden behind experiments that onboarding never mentions, dead
read paths wired to kinds nothing emits, and summary documents that
describe a repo that no longer exists.

## Block production on (ranked)

1. **e2e_org.rs runs in no CI lane** — the WS conformance suite that pins
   LWW lifecycle, p-gate, and binding authority is repo-only. One relay
   refactor silently un-pins the security property. (Cheapest fix, highest
   leverage.)
2. **Multi-reviewer contribution forks are now an authority bug** — reviews
   are author-keyed NIP-33 LWW; a second reviewer forks the record. With
   37013 accepted-counts feeding budget ladders (76011dfda), a forked
   ledger forks autonomy. Needs a protocol decision (single-reviewer cap,
   or reviewer-set approval, or review events referencing the record).
3. **Classifier API key rotation** — pasted in chat once (2026-09-21);
   no evidence of rotation. Rotate and note it in the audit doc.
4. **Pre-existing P0 test failure** —
   `buzz-db --test observability_source::p0_pool_acquisitions` fails at
   HEAD: `event.rs` uses raw `.fetch_all(pool)` (introduced by the Agent
   Wiki/canvas work). Fix before it normalizes bypassing operation
   attribution.

## Fix-before-launch (cheap, story-critical)

1. Wire the two workflow approval buttons to the existing
   `useApprovalMutation` and delete the "not yet available in Desktop"
   card (`WorkflowApprovalCard.tsx:27`) — the product's peak moment is a
   dead end for ~20 lines of code.
2. Fix or remove `buzz workflows runs` — it queries kinds 46001–46003 that
   nothing publishes (its own doc comment admits it); the real run history
   is behind `GET /workflows/{id}/runs`, which the CLI never calls.
3. Gate the mesh settings card behind an availability probe — default
   builds show a permanent error card + 4s error poll
   (`mesh_llm_stubs.rs` returns Err; `MeshComputeSettingsCard` mounts
   unconditionally).
4. Make preview features part of onboarding (one-click enable of
   Workflows/Projects/Forum/Pulse), or set `defaultEnabled` for workflows
   + forum in `preview-features.json`. VISION.md claims "all seven
   surfaces today"; a fresh install shows fewer.
5. Surface authority honestly in the org UI: show
   `ORG_GRANT_ENFORCEMENT` state in OrgAuditView, label unverified
   reviewers, gate ragequit out of prod builds until the Nostr<->EVM
   holder mapping is real.

## Remove / collapse list (surface reduction)

| Candidate | Why | Action |
|---|---|---|
| Job protocol kinds 43001–43006 | Readers wired, zero emitters (`sound.ts:48` admits it); 44011 is the live task kind | Remove readers + sound slots, or emit |
| Dead workflow kinds 46002/46003/46004/46007/46011/46012 | Registered, never emitted; desktop inbox branches for 46001/46005/46006 are dead too | Remove or make buzz-workflow emit |
| NIP-PMA kind 30179 | Full spec + 500-line impl + relay/DB wiring, zero publishers and readers | Remove from shipped surface or wire |
| Write-only NIP-51 list kinds | CLI can write 10000-10003/30000/30003; no client reads (desktop uses 30078) — two parallel muting systems | Drop from CLI or wire readers |
| Dead ingest-accepted kinds 40004/40005/40006, 40901, 41001, 9009, 39003, 48001, 49001, 1063 | Accepted at ingest, never produced, never read | Remove from kind.rs + ingest allowlist |
| Dual message plane kind 9 / 40002 | Desktop+acp publish 9, web browser-agent publishes 40002; all readers parse both forever | Pick one (40002 is the live agent turn kind) |
| `buzz media get` + `buzz upload file` | One Blossom feature, three names (incl. legacy `PUT /media/upload`) | Merge into `buzz media put/get` |
| `GET /health` | Unconditional "ok", used by nothing; `/_liveness` is the probe | Alias or remove |
| `POST /_mesh/demo/echo` | Testbed-only route in the production router (its own doc says nothing calls it) | Gate harder or remove |
| `buzz launchpad mint-token` | Shells out to Foundry `forge` — dev-only dependency in a shipped CLI | Document as dev-only or implement |
| buzz-paperclip `bridge`/`apply` loop | Formally deprecated two-way bridge still shipped | Keep one-way `sync`; remove the loop on native task sync |
| buzz-community-mcp | Experimental appendage of the deprecated bridge direction; 1 test | Demote to experimental or remove after Paperclip sunset |
| ifc-core | Zero consumers outside the workspace root | Remove or wire |
| `buzz agents draft-*` in headless envs | Requires a buzz:// deep link round-trip; useless for ACP-managed agents | Add headless path or document |

## Missing CLI coverage (relay features with no CLI)

Invites + join-policy; workflow run history + approval reads; operator
provisioning (curl-only); forum post/comment creation (vote only);
huddle lifecycle (defensible). Lowest-priority gap: operator
provisioning — document or add buzz-admin subcommands.

## User journey / getting started

Exists already (better than expected): 5-page machine onboarding +
profile/avatar, invite redeem, keyring recovery, deterministic starter
channels (#general, #welcome-everyone), seeded Welcome channel + Welcome
Team of 3 agents with intro message + canvas, per-channel intro trios,
org wizard auto-opens on empty, /reminders dead-link redirect.

Missing:
- No persistent getting-started checklist; after the Welcome channel,
  guidance evaporates.
- Preview features invisible: onboarding never mentions
  Settings -> Experiments.
- Workflow approvals dead in desktop (see above) — operators hit a wall
  exactly where the story peaks.
- Terminal panel undiscoverable (Cmd/Ctrl+J absent from
  keyboard-shortcuts.ts, no affordance).
- Home's empty inbox is text-only; doesn't suggest next actions.

Recommendations (ranked):
1. Dismissible "Getting started" checklist (Home card or pinned
   Welcome-channel card): profile -> invite a teammate -> create a
   channel -> deploy an agent -> start a huddle. Deep-links to real
   flows, completion state per community.
2. Onboard preview features: final wizard step or Welcome card with
   one-click enable of Workflows/Forum/Projects/Pulse.
3. Wire the approval buttons (see fix list) — biggest story dead end.
4. Add Terminal to keyboard-shortcuts.ts + a channel-header affordance.
5. Home empty-inbox cards that suggest the high-value next actions.

## Docs debt (do before public launch, not before internal prod)

- ARCHITECTURE.md: documents 11 of 36 crates; no NIP-ORG, mesh, wiki,
  fleet, EVM, paperclip, push, deletion sections.
- AGENTS.md repo map: omits 13 crates + admin-web/, contracts/, adapters/,
  deploy/, services/ top-level dirs; "Key Patterns" silent on relay-enforced
  org authority.
- VISION.md status table: remote agents "spec in review" though the K8s
  provider + RunOn UI shipped; "all seven surfaces" vs preview gating.
- README: no crate map (VISION.md points to one), no mention of mesh,
  NIP-ORG, org graph, wiki.
- paperclip-parity-status.md: two rows stale (audit log UI + ragequit UI
  shipped in 59d7689d7).


## Progress log (same day, 2026-09-22)

Addressed by follow-up commits on feat/org-graph:

- e2e_org CI lane: added to the `relay-e2e` job (`_ci-relay.yml`) against
  the compose Postgres. (Blocker 1 — done.)
- P0 observability failure: `event.rs::huddle_started_links` now acquires
  an attributed writer connection; the P0 scan passes. (Blocker 4 — done.)
- Multi-reviewer fork: protocol codified in NIP-ORG ("Contribution record
  review & multi-reviewer resolution" — reviewer-keyed republish,
  newest-per-action-d canonical resolution, reviewer-authority SHOULD,
  clients MUST collapse); desktop `fetchContributionRecords` collapses
  forks via `canonicalContributionRecords`. (Blocker 2 — protocol done;
  relay-side reviewer-authority enforcement remains future work.)
- Workflow approval dead end: `build_approval_grant/deny` now emit the
  token-hash reference in the `d` tag (the relay resolution contract;
  the old `t` tag was rejected by the relay), and the card renders
  working Approve/Deny buttons wired to `useApprovalMutation`. (Fix
  list item 1 — done.)
- `buzz workflows runs` reads `GET /workflows/{id}/runs` via NIP-98; the
  dead-kind query is gone. (Fix list item 2 — done.)
- Preview defaults: Workflows/Projects/Forum ship `defaultEnabled: true`;
  Launchpad/Pulse/thread-scoped-ACP/agent-managed-profiles stay opt-in;
  manifest test pins the split. (Fix list item 4 — partial: the
  onboarding mention of experiments is still open.)
- Removal sweep, safe subset: kinds 40004/40005/40006 removed (constants,
  ALL_KINDS, ingest h-scope arms).

Still open (decided, need dedicated work):

- Job protocol 43001-43006 removal: wired in ~12 files (desktop inbox/
  search/sound/feed-section, web channel readers, feed SQL, e2e
  fixtures). Decided to remove (superseded by 44011); needs a dedicated
  refactor with test updates.
- Dual message plane (kind 9 vs 40002): needs a product decision + a
  coordinated producer migration across desktop, buzz-acp, and web.
- NIP-PMA (30179) and NIP-51 write-only lists: remove-or-wire decisions
  with spec implications; not urgent (inert).
- Classifier key rotation: owner action at the LLM provider; still
  pending (the audit's original blocker 3).
- Stale-chain chip, ARCHITECTURE.md/AGENTS.md/VISION.md refresh, and the
  onboarding experiments step: open.
