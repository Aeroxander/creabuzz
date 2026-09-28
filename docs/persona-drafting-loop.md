# The persona drafting loop (B1) — wiki → proposal drafts

*2026-09-28. Closes the agentic-governance A-series (docs/agentic-governance-design.md):
agent-proposes → delegation → votes/quorum-watch → agent-executes under the
supervision gate. This document is the loop that feeds it: an agent reading its
own wiki and drafting proposals. Status notation matches the token-lifecycle
doc: every decision carries `status:` and nobody has to ask what is done.*

## The loop

```
community activity ──distill (buzz agwiki distill)──▶ agent wiki (44002)
                                                          │
human wiki (44001) ───────────────────────────────────────┤
                                                          ▼
                                        decision blocks (explicit)
                                                          │
                            draft (buzz agwiki draft — deterministic)
                                                          ▼
                                    47004 `agent-draft` proposal records
                                                          │
                                    review (human / supervising agent)
                                    ┌──────────┴──────────┐
                                 Accept                Reject
                                    │                     │
              counter-sign: openProposal(draft.intent)   NIP-09 tombstone
                                    │
                          47004 `open` + proposalId (supersedes draft)
                                    │
              votes + quorum-watch → queue/executeByVotes (A2–A5, unchanged)
```

The distill loop already writes the wiki ("wiki-insightful, not procedural").
This milestone adds the second half of the persona's round: **the agent drafts
proposals from its wiki**, the draft lands as an `agent-draft` record, and a
human counter-signs one envelope to take it onchain. "Machines compose, humans
sign" (next-gen-launchpad-plan.md §5.2): an agent draft never broadcasts
without approval.

Two authoring paths feed decision blocks, and both end in the same
verification: humans (or agents) write blocks directly in wiki pages, and the
distill model writes blocks as part of the standup (the distill prompt now
teaches it to). The drafting step itself is **deterministic** — it never
synthesizes claims, it materializes explicit intent.

## The decision block (normative)

A fenced `decision` code block in a wiki page body (44001 or 44002):

```markdown
```decision
title: Raise proposal quorum to 600 bps
kind: plain
evidence: The round-2 postmortem asks for a 600 bps quorum.
intent: {"op":0,"to":"0x…","value":"0","data":"0x…","nonce":"0x…"}
```
```

Flat `key: value` lines, first occurrence wins, `#` starts an inline comment —
the same deliberately small parser family as the 44002 front-matter
(desktop `frontMatter.ts`); the value may itself contain `:` (split on the
first colon). Keys:

| Key | Required | Rule |
|---|---|---|
| `title` | yes | non-empty, ≤ 200 chars |
| `kind` | yes | `plain` \| `futarchy-budget` \| `signal` — the A-series routing map's own keys (never defaulted: the route is chosen, not guessed) |
| `evidence` | yes | one line, ≤ 400 chars, must appear **verbatim** in the page body **outside** decision blocks (D3) |
| `intent` | no | JSON object, strict `ProposalIntent` shape (op/to/value/data/nonce) |
| `calls` | no | JSON array, strict ERC-4824 `CallDataEVM` shape |

Unknown keys are ignored (forward-compatible); known keys are strict. Block
anchor = the 1-based index of the block in the page body (document order).

## Decisions

**D1 — Two loops, one spine.** Distill (activity → wiki) writes the worldview;
draft (wiki → proposals) materializes explicit decision intent. The drafting
composer is deterministic and claim-free: authorship of intent lives in the
wiki, under the agent-wiki security gate. `status: accepted 2026-09-28`

**D2 — Blocks are explicit, never inferred.** Only fenced `decision` blocks
produce drafts; prose never becomes a proposal. Later instruments (Phase 4's
time signals, drift probes) may propose blocks, but they land as blocks first
and pass the same verification. `status: accepted 2026-09-28`

**D3 — Verbatim evidence rule (the no-invented-facts seam).** Every block's `evidence` line must appear
verbatim in the page body outside decision blocks; otherwise the block is
skipped and reported. Scope stated honestly: the draft adds no facts beyond
the page — it does not vouch for the page's truth. The wiki is the persona's
worldview; the drafting loop's guarantee is that the proposal never
manufactures claims the wiki does not contain (in particular, no invented
numbers). `status: accepted 2026-09-28`

**D4 — Strictly parse or drop (inherited).** Malformed block structure
(missing/oversized title, missing or unknown `kind`, missing or non-verbatim
evidence)
drops the block with a printed reason — never guessed at. A malformed
`intent`/`calls` **value** drops only that value (the draft stays
record-only), matching NIP-LP §47004 ("readers MUST ignore… such a record
carries no executable intent") and A-series D8. A `signal` block carrying an
intent is contradictory and drops the block. `status: accepted 2026-09-28`

**D5 — `agent-draft` is a first-class 47004 state.** Drafts are47004 records
with `state: "agent-draft"` and `proposalId: null`. Accept is one human (or
supervising) counter-sign: `openProposal(block.intent)` through the A-series
composer, then an accepted record (`state: "open"`, `proposalId` set, same
`wiki` tag) supersedes the draft and the draft is NIP-09 tombstoned. Reject
tombstones only. Tombstones hide; the hash chain keeps the audit.
`status: accepted 2026-09-28`

**D6 — Routing inherits the A-series map verbatim.** The block's `kind` is
the routing map's key: `governanceRoute(kind)` decides mechanism and ballot
exactly as the proposal cards render it — `signal` gets deliberation (no
ballot, no executable intent, ever), `futarchy-budget` gets decision markets,
`plain` gets the recorded token vote. The drafting loop adds no routing
vocabulary of its own. `status: accepted 2026-09-28`

**D7 — Dedupe by wiki anchor.** One live (non-tombstoned) draft or open
proposal per `["wiki", <page-coordinate>, <block-anchor>]`; the loop is
idempotent — re-running on unchanged pages drafts nothing new. The accepted
record keeps the `wiki` tag so the counter-sign is always traceable to its
source block. `status: accepted 2026-09-28`

**D8 — Provenance is the source pointer, not a summary.** Drafts carry the
`wiki` tag and the block's verbatim `evidence` — no re-summarized text, no
model tag (the page keeps its own agwiki provenance: model, cost_tokens,
sources). The composer runs locally and deterministically, so there is no
model to record. `status: accepted 2026-09-28`

**D9 — Drafts are supervised actions.** Publishing a draft is
`governance.proposal` at the S3 ingest budget gate (already enforced): an
agent over its governance budget gets a kind:46010 approval request instead of
a landing draft. Agents draft under their own keys (C4 agent-seat
provenance); humans under theirs; budgets bind by `content.subject == author`
so human drafts are free by design (NIP-ORG rule 5).
`status: accepted 2026-09-28`

**D10 — `dao.json` presents drafts as drafts.** The ERC-4824 projection maps
`agent-draft` to DAOIP-5 `status: "draft"`; it never presents a draft as
open/active. A tombstoned draft leaves the projection like every other
tombstoned launchpad event. `status: accepted 2026-09-28`

## Wire vocabulary (additions to NIP-LP §47004)

- `state`: `open | passed | executed | defeated | agent-draft` — `agent-draft`
  is pre-chain: `proposalId` is null and nothing onchain refers to it until
  the counter-sign.
- `evidence` (optional string): the block's verbatim quote; renderers show it
  as the draft's justification with the wiki source.
- `["wiki", <page-coordinate>, <block-anchor>]` — the draft's source block;
  `page-coordinate` is `44001:<hex>:<slug>` or `44002:<hex>:<space>/<slug>`.
  The tag is the dedupe key (D7) and the provenance pointer (D8).

## Honesty rules carried from the A-series

Numbers appear only when the block states them (they were authored in the
wiki, quoted verbatim into evidence). Empty means omitted, never nulled.
Unreadable ≠ verified: a record-only draft (intent value dropped) renders as
"a decision, not an executable action" — it never pretends to be executable.
Malformed is dropped and reported, never guessed.

## Test discipline

Golden vectors bind the production seams: one fixture corpus (a page with
three valid blocks, one non-verbatim evidence, one malformed intent, one
contradictory signal) pins the exact composed content JSON in **both** the
Rust (`buzz-agwiki` draft tests) and the TS (`draft-proposal` /
`draftProposal` tests) implementations, so the CLI loop and the UI journey can
never diverge silently. Determinism/order-independence tests run the composer
over shuffled page order. Selector discipline from the A-series continues to
apply to the accept flow (the `openProposal` composers are already pinned).

## What this milestone does not do (still open)

- LLM-authored blocks land through the distill prompt only; a dedicated
  "propose blocks from prose" instrument is Phase 4 (time-signal detection,
  drift probes) and passes D2/D3 unchanged.
- ANS-2's version-binding question: still just taken as a question
  (docs/aos/ans-interop.md); the `wiki` tag binds a draft to a page revision's
  block anchor, which is the local answer to "which version did this come
  from" — deliberately not ANS PKI.
- The relay-side scheduled sink (`distill_agent_wiki` workflow action) adopts
  the same pure core for drafting later; today's hosts are the CLI and the
  web/desktop one-tap journey.
- Legal wrapper work: deferred with the entity decision (AO survey §entity).
