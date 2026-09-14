# Next-Gen DAO Launchpad — Integration Plan v3

> Research pass 2026-09-13: four sources re-read against the shipped product —
> Umia (`/tmp/nextgen/umia-full.md`), MetaDAO (`/tmp/nextgen/metadao-all.txt`),
> Trustgraphs (`/tmp/nextgen/tg/*.md`, esp. `research/BUZZ_NOSTR_PLAN.md`),
> Conviction Markets paper (`/tmp/nextgen/conviction.txt`).
> Analyst reports: `/tmp/nextgen/report-{umia,metadao,conviction}.md`
(all complete); the trustgraphs lane (`report-trustgraphs.md`) was parent-
verified directly against the docs after both assigned analysts stalled.
> Supersedes sections of `docs/dao-launchpad-plan.md` v2 where noted; the build
> log §12–§16 and the shipped web app are the ground truth this plan extends.

Status / conventions:
- **Have** = shipped in `web/src/features/launchpad/` or `contracts/src/` (cite).
- **Design** = decided in plan v2 but not built.
- **(c)** = new code/contract/kind to build.
- `UNVERIFIED` = I could not confirm a source claim against vendored code.

---

## 0. Executive summary

The launchpad is a sale today: validated CCA params, a read-only dashboard, bid
mirrors. The two competitors being studied (Umia, MetaDAO) and the two vision
documents (Trustgraphs, Conviction Markets) agree on the same gap, from four
different directions: **a raise is not a product; the post-sale relationship
is.** Everything high-value either (a) makes the raise itself executable end to
end (bid/claim/graduate), or (b) gives the money a legible fate after the sale
(doors, budgets, vesting, milestones, exit), or (c) turns the community's
activity into a verifiable reputation the sale can use.

Three headlines:

1. **The #1 gap is G1 (onchain bid/exit/claim) + G3 (graduation executes)** —
   the investor and founder half-actions are mirrors and accounting today.
2. **Trustgraphs integrates much better than "a dependency":** their
   `BUZZ_NOSTR_PLAN.md` is written against our own relay's audit hash chain.
   We can ship the *commitment + witness + client-verifiable roots* even
   without running their full prover (Option A commitment + NIP-85 score
   publishing + client-side root verification). The paper plan (§8/§P6) is
   technically valid but under-integrates: it treats trustgraphs as a
   future backend gate instead of a data plane we can consume today.
3. **The conviction paper is a direction, not a spec** — its five primitives
   and two-layer mechanism are explicitly open. We already replaced its
   undefined Participation Token with claim-bearing instruments; its honest
   residue is what **we** must design (verifier economy, passive-capital
   exclusion, non-performance handling).

Compliance caveat (every analyst flagged it): a hosted public token sale is a
legal matter no paper covers; a legal wrapper/restriction decision gates any
real launch. See §9.

---

## 1. What the four sources teach, one paragraph each

### Umia — mechanics of a well-dressed CCA
Closest competitor. Takes our exact sale primitive (Uniswap CCA) and wraps it
in: a legal entity, a smart-wallet onboarding, gated buckets (zkTLS/permits),
day-one treasury-owned LP, three-door treasury, MetaVesT vesting, decision
markets as the board, and an agent-facing MCP plugin that builds unsigned
calldata ("machines compose, humans sign"). Reject: the legal wrapper, the
platform token/protocol allocation, zkTLS, DM-for-everything.

### MetaDAO — the trust/funnel layer
Futarchy launchpad (Solana). The teachable part is **framing**: qualification
funnel (intake, 1-week public comms, monthly KPI updates), the 1/6-of-min-
raise monthly budget + 3× large-spend default-pass rule, performance packages
(2×..32× price-multiple unlocks), hash-committed terms, "anyone can propose
capital return", and their transparency dashboard. The Bid Wall is self-
deprecated. Futarchy for everything rejected by us already (plan §9).

### Trustgraphs — verifiable community reputation
Proof infrastructure: verifiable inputs → deterministic program (SP1 zkVM) →
ZK proof → onchain root. Three programs matter to us: the **nostr-workspace**
program (proves Buzz community activity → scores; `BUZZ_NOSTR_PLAN.md` is
written against our relay), **weighted prior** (founder seeds, plan §8's
decision), and **signer sync** (proves a Safe owner set from scores + activity,
for treasury council rotation). Integration surfaces: score roots → CCA
`TrustGatedHook` (already shipped), NIP-85 score publishing, and — the 
under-integrated part — *client-side root verification of score claims*.

### Conviction Markets — the vision, honestly read
A position paper: capital on problems, not entities; conviction compounds
(time × capital × contribution); roles (curator/sponsor/contributor/verifier);
participation tokens; two-layer separation (productive vs speculative) —
mechanism explicitly open. We already mapped more of it than we admitted (plan
§10 over-claims; see §3.2). Its unsolved problems are now our design jobs.

---

## 2. Gap matrix — source features × our status

(table synthesized from the four reports; see each report for evidence.)

| # | Feature | Source | Status in creabuzz | Cost class | Rank |
|---|---------|--------|--------------------|------------|------|
| G1 | Onchain bid / exit / claim (signed) | Umia | **Design** (mirror-only today) | integration | ★★★ |
| G3 | Graduation executes (sweep + LP seed + treasury) | Umia/MetaDAO | **Partial** (accounting only) | contracts | ★★★ |
| G2 | Agent launchpad surface (ACP/MCP) | Umia | **Design** (CLI Nostr ops only) | integration | ★★☆ |
| G4 | Vesting + circulating-vs-total overhang | Umia | **Design** (allocation % only) | contracts+UI | ★★☆ |
| G5 | Three treasury doors in product | Umia/MetaDAO | **Design** | contracts+UI | ★★☆ |
| G1m | Founder funnel + readiness gate | MetaDAO | **Missing** | UI+NIP-LP | ★★☆ |
| G2m | Budget envelope (1/6 + 3×) | MetaDAO | **Missing** | UI+NIP-LP | ★★☆ |
| G3m | Performance packages (2×..32×) | MetaDAO | **Partial** (milestones %) | contracts+UI | ★★☆ |
| G4m | Trust page (commitments + proofs) | MetaDAO | **Partial** (scattered) | UI | ★★☆ |
| G5m | Propose-capital-return as UI | MetaDAO | **Missing** | UI+kind | ★★☆ |
| G6m | One-live-proposal + stake-to-live | MetaDAO | **Missing** | UI+kind | ★☆☆ |
| G7m | LP minimum policy | MetaDAO | **Missing** | UI | ★☆☆ |
| T1 | Trustgraph commitment + roots (nostr-workspace) | Trustgraphs | **Design** (plan §8) | infra | ★★★ |
| T2 | NIP-85 score publishing | Trustgraphs | **Missing** | relay+UI | ★★☆ |
| T3 | Client-side root verification | Trustgraphs | **Missing** | UI | ★★☆ |
| T4 | Signer-sync for treasury council | Trustgraphs | **Missing** | contracts | ★☆☆ |
| C1 | Verifier set + ClaimStake + attestation | Conviction | **Design** (P2) | contracts+UI | ★★★ |
| C2 | Stream cancellation as contract | Conviction | **Design** (P2) | contracts | ★★☆ |
| C3 | Stack continuity (`stack` tag + sponsor) | Conviction | **Missing** | UI+kind | ★★☆ |
| C4 | Agent seats (bid/claim as agent, NIP-OA) | Conviction | **Missing** | CLI+UI | ★★☆ |
| C5 | Fee flywheel → sponsor pool | Conviction | **Design** | contracts | ★☆☆ |
| C6 | Participation ledger (47006) vs kill PT | Conviction | **Decision** | kind | ★☆☆ |

Legend: ★★★ build next (completes the core loop); ★★☆ high value, sequenced
after; ★☆☆ optional/nice.

---

## 3. Trustgraphs — integrating better than the plan currently does
> §3 claims all verified against the trustgraphs docs (report-trustgraphs.md §1
> table); two nuances folded in here: the contributions program's EAS-parent
> constraint (T5) and the member-scoped privacy posture (T1).

### 3.1 What the plan §8/§P6 got right
- Weighted founder seeds → holder rotation at graduation; trust-graph reachability
  as Sybil boundary; root-gated CCA buckets (`TrustGatedHook`, shipped);
  contributions program for milestone payouts; signer-sync for treasury council.
- These map one-to-one onto trustgraphs programs: `weighted-prior`,
  `trust-graph`, `contributions`, `signer-sync` (`/tmp/nextgen/tg/
  docs__build__{weighted-prior,trust-graph,contributions,signer-sync}.md`),
  and `composition` for combining vouch + Nostr + DAO participation roots.

### 3.2 Where the plan under-integrates (this pass's finding)
1. **BUZZ_NOSTR_PLAN.md already exists and is written against our relay.**
   It specifies the nostr-workspace program end to end: commitment via the
   relay's per-community audit hash chain (Option A, verified from source:
   `AuditAction::EventCreated` fires for every stored event on the awaited
   path — `handlers/event.rs::enqueue_event_created_audit`), agent
   self-committed logs (Option C), envelope kind 2, edge rules V1/G1/J1/F1,
   mint kind 36382 for vouches, NIP-85 (30382) for publishing scores,
   decision record §12 (2026-08-18): "Option A + C at v1, no upstream
   dependency". Our plan §8 predates this and treats trustgraphs as a remote
   system; their plan treats *our* relay as the substrate.
2. **The cheap consumable slice is client-side root verification, not the
   prover.** We don't need to run SP1 to *use* trustgraphs: consume the
   published Merkle root + Merkle proof over HTTP (indexer), verify the proof
   against the root on-chain or locally, and render "score X proven under
   root R/epoch E" on the profile/launch card. `docs__build__integrate-scores
   .md` §Choose an integration path explicitly offers this path. Plan §8
   jumped straight to "root-gated buckets" (the expensive, deploy-bound leg)
   and skipped the display leg that costs almost nothing.
3. **The relay is where the data plane lives, and we already own it.** Our
   relay stores the events, maintains the audit chain, and serves clients.
   A score-consumer UI + NIP-85 publishing of a score root (or a Buzz-side
   "score root" record under a reserved kind) makes scores a first-class
   surface inside the community — before any onchain hook exists.
4. **Signer-sync gives us treasury council rotation without new governance.**
   The module proves a Safe owner set from checkpointed vouches + direct
   governance activity + Safe state. That is a concrete post-graduation
   feature (plan §11 P4 "treasury council rotation") that is *pre-built* by
   the trustgraphs team rather than something we design from scratch.

### 3.3 What "integrate better" concretely means (v3 additions to plan §8/§P6)
- **T1 (★★★): Nostr-score data plane.** New reserved kind (suggest 37006)
  `[d = epoch or nodeId] score-root record`: `{program, outputDomain, root,
  blockNumber, epoch, paramsHash, scoreFileCid, indexerUrl}`. Published by an
  operator (CLI one-shot or a small poller) that watches trustgraphs checkpoints
  (or computes a local scoring program) and republishes. Clients verify:
  root ↔ record(chain) via RPC (AnchorRegistry already supports
  `envelopeKind=2`, node kind 3 = BUZZ_COMMUNITY — verified in
  BUZZ_NOSTR_PLAN §4), proof validity via a tiny TS merkle verifier (shipped in
  `web/src/features/launchpad/lib/` — reuse the `TrustGatedHook` Merkle layout,
  assert compatibility in a unit test, no onchain step). The workspace itself
  stays private (member-scoped pilot per BUZZ_NOSTR_PLAN §12.6): the root
  proves the computation, never exposes the raw workspace.
- **T2 (★★☆): NIP-85 score publishing.** Scores (not roots) published as
  kind-30382 assertions ("npub X has score Y under root R") by the same
  operator; client renders on profiles + launch team rows; searchable inside
  the community. Optional extra: relay ingest allows 30382 (kinds list §12).
- **T3 (★★☆): root-gated buckets.** Existing `TrustGatedHook` (plan §12,
  `contracts/src/hooks/TrustGatedHook.sol`) + T1 roots = bucket gating with a
  real data plane. This stays the deploy-bound leg (needs CCA + hook on a
  fork), sequenced after T1 so it is testable.
- **T4 (★☆☆): signer-sync council rotation** — post-graduation, P4 scope.
- **T5 (★☆☆): contributions program** for milestone/retro payouts — **only
  after a standard EAS `trust-graph` parent exists** (verified: contributions
  requires onchain-only EAS inputs, `docs__build__contributions.md`); do NOT
  route the v1 Nostr-lane milestone payouts through it — those use C1's
  verifier set instead.

Falsifiability:
- Unit: TS Merkle verifier matches `TrustGatedHook` layout (assert a known
  vector).
- Model test: score-root record parses + stale-epoch warning renders.
- E2E (mock): profile shows "score proven under root R"; a tampered proof
  shows "unverified".
- Fork (T3): bucket gated by score proof end to end — valid proof passes,
  minScore revert (pattern exists in `Launchpad.t.sol`).

---

## 4. The conviction paper's open problems — what still needs solving

Source: report-conviction.md §3 (11 problems, each with citation). The honest
headline: the paper is a vision; the mechanism for almost every sentence is
"open". Our claim is not "we solved the paper" — it is "we replaced the vague
parts with instruments that have defined claims, and the residue is our design
work". Table: paper's open problem → our verdict → concrete action.

| Open problem (paper cite) | Verdict | Action in this plan |
|---|---|---|
| Speculative-layer mechanism ("the mechanism design is open", p.7; two options in consideration) | **Partially solve** — we built approach (b): TM floor + LBAMM (plan §7/§16); the "rising participation floor rises with PMF" property is unmodeled | Record the choice explicitly (§7.2); revisit only with real volume |
| Verification automation (expert panels → "increasingly automated", p.7) | **Partially solve** — verifier panels concrete (C1); the automated tier has no existing mechanism anywhere | Ship verifier panels; treat automation as research; never promise agent-judged milestones in v1 |
| Reputation module (scoring, onchain completion history, slashing, p.10) | **Partially solve** — T1 gives a data plane; **cannot** make pseudonymous "reputation" slashable — slash only stake inside the system | Verifier bonds (idea §6.1) = slashing with real economics; state "we slash stake, not reputation" |
| Participation-token economics (undefined claim, p.5) | **Solved by replacement** — sale tokens + Moloch shares/loot + apptoken rails all have claims | Resolve PT language contradiction (§7.3): kill PT term, keep 47006 participation ledger optional |
| Passive-capital exclusion ("arrives after risk has passed", p.4) | **Mostly solved by CCA construction** (no exit pre-end, no claim pre-claimBlock, no trade pre-graduation); last-block entry still at clearing terms | Off-auction earned-holding bonus (idea §6.2) as the "earlier = more earned" mechanism |
| Multi-dimensional conviction math (time×capital×contribution, p.5) | **Partially solve** — P6 weight candidate (epoch-attendance × stake × delivered); score-farming residue | T1 data plane + vouch channel; publish the weight formula as a deterministic, test-vector'd module |
| "How the system decides what to build next" (p.10, decision markets) | **Consciously deviate** — verifier attestation + plain vote; futarchy only for budget/subDAO | Record the deviation as deliberate (§7.1), stop implying the paper endorses it |
| Agents as principals (p.7–8) | **We are positioned to lead** — NIP-OA provenance, ACP, relay kinds all exist | C4: agent seats (bid/claim as agent key); owner/agent accountability rule (§7.5) |
| Market-creation lifecycle / revenue flywheel (p.10) | **Partially solve** — fee switch plumbed (plan §9); no destination | C5: route fees to a sponsor pool that auto-streams to top-scored launches |
| Non-performance / failure / fraud (only slashing mentioned, p.10) | **Solved where it matters** — CCA refunds, wind-down door, ragequit, cancellable streams | The "problem outlives teams" claim is unaddressed → C3 stack tag + sponsor pattern |
| No implementation anywhere (p.11) | **Headline** — we are not adopting a spec; we are adopting a direction and building the spec | Everything above is (c); nothing ships "as-is" |

### 4.1 Fidelity fixes to plan §10 (over-claims the analysts caught)
1. **Conviction weighting "exists"** — no: `lib/allocation.ts` is a static
   supply split; the P6 weight is planned, unbuilt. Plan §10's "streams/
   allocations weight all three" is aspirational.
2. **"Pre-graduation lock is exactly the PT"** — dangling pointer (§2.4 no
   longer exists) and wrong: PT is a milestone-minted participation record
   with undefined transferability; our lock is CCA custody + a planned transfer
   lock. Two different instruments.
3. **Two-layer mapping silently picked approach (b)** — the paper leaves both
   options open; we never recorded the choice.
4. **SubDAO rule "derived from the paper"** — the paper supports tranches
   against milestones but says nothing about cancellation; that is our
   extension. Keep, but label as extension.

These are doc fixes (edit `docs/dao-launchpad-plan.md` §10), testable by
git-diff review; no code.

---

## 5. Winner's-edge ideas (mechanism-level, dogfoodable)

Synthesised from the four reports' "next-gen" sections; each has a falsifiable
test. These are the *fun* part — what makes creabuzz's launchpad categorically
different, not just feature-complete.

1. **The refund is the feature.** Pre-graduation: CCA full refund on miss
   (existing contract). Post-graduation: ragequit (vendored Moloch). Between:
   one-click "propose capital return". Demonstrated in a fork test on every
   PR. MetaDAO sells the *threat*; we can sell the *button*.
2. **Machines compose, humans sign (agent bid draft).** An ACP persona reads
   `TickDataLens`, drafts a compliant bid (tick-aligned, max-price math from
   `launch-params.ts`), publishes a 47004 `agent-draft`, and the human
   counter-signs one envelope. Same rule as Umia's MCP but with a Nostr audit
   trail. Test: agent draft never broadcasts without approval; approved draft
   produces a valid bid tx on fork.
3. **Community Track without a platform token.** Score-gated buckets
   (T1 + `TrustGatedHook`) instead of Umia's curation market + protocol
   allocation. Admission reflects expected contribution, auditable on Nostr,
   no token needed. Test: bucket gating by score proof (T3).
4. **Failure keeps the community.** On `failed`: record transitions, 47005
   refund receipts per mirror bid, founder relaunches same `d` with a new
   auction address. Refund → re-raise → same community. Retention no pure-chain
   launchpad has. Test: e2e relaunch flow in the mock relay.
5. **Attestation bonds.** Verifiers bond per milestone verdict; an appeal
   that overturns a verdict slashes the bond into the pot. Reputation =
   expected non-slash value across epochs. Test: forge — wrong verdict slashes,
   correct verdict returns.
6. **Problem-stack continuity.** `stack` tag on 37001 + a convention that
   47003 updates + 47005 receipts are the immutable problem log; graduated
   DAOs act as Sponsors (stream a tranche to a follow-on). The paper's "knowledge
   doesn't evaporate" made real. Test: model test for tag parsing + directory UI.
7. **The conviction ledger as a public good.** 47006 participation records +
   a published, test-vector'd weight formula → every participant sees a
   verifiable conviction trajectory. Cheapest way to make "conviction" an
   observable property, not a slogan.

---

## 6. The plan — phases

Sequencing logic: complete the core loop first (raise executes → graduation
executes), then make money legible post-sale, then the reputation/agent layer,
then optional depth. Each item names its falsifiable test. Live-chain items
are flagged; everything else is fixture/anvil-fork testable.

### Phase A — Complete the half-actions (G1, G3)  [core loop]
- **A1. Signed bid/exit/claim in product (G1).** Web wallet-tx composer for
  `submitBid(maxPrice, amount, owner, hookData)` (vendored CCA, `submitBid`),
  tick-alignment + max-price helper (reuse `launch-params.ts` math), exit +
  claim composers (`exitBid` / `exitPartiallyFilledBid` / `claimTokens`
  semantics from `ContinuousClearingAuction.sol`), `buzz launchpad
  bid/claim/exit`. 47002 mirrors automatically on tx success (hash binding).
  Test: `LaunchpadForkTest` — bid → graduate → `claimTokens`, balances; unit —
  off-tick max price rejected; e2e — mirror written only after tx.
- **A2. Graduation executes (G3).** Executor flow: `sweepCurrency` +
  `sweepUnsoldTokens` (recipient-only, verified) → consume
  `lbpInitializationParams()` → reserve share → TM pool + remainder →
  treasury; 47005 `sweep`/`lock` receipts. Destination decision needed
  (§7.2). Test: fork lifecycle — graduate → initializer consumed, reserve in
  TM, remainder in treasury; pre-graduation transfer reverts (TV ruleset).
- **A3. Relaunch-on-fail (idea 4).** Record transitions on `failed`, refund
  receipts, relaunch same `d` with new auction addr. Test: e2e mock-relay.

### Phase B — Money with a legible fate (G5%+, MetaDAO G2m/G3m/G4m/G5m)
- **B1. Budget envelope (G2m).** `budget` field + 1/6-of-min-raise validation
  in `launch-params.ts` + wizard + treasury tab. Stage 2 (P4): map to Moloch
  `setAllowance`/`spendAllowance`. Test: unit — `budget > requiredRaised/6`
  is a blocking issue.
- **B2. Founder funnel + readiness gate (G1m).** Record content fields
  (`longPitch`, `image`, `ipList`, `budget`, `vesting`, `comms`), a signed
  checklist gate before `stage: funding`, "delinquent" label when updates
  lapse (founder-ops ACP persona drafts weekly 47003 from channel activity).
  Test: publish disabled until checklist complete; unit — record cannot
  transition to funding without checklist.
- **B3. Trust page (G4m).** One deterministic page: every commitment × its
  current proof (paramsHash commit, chain addresses, team npubs, docs,
  receipts), "not deployed" for missing, no fabricated numbers (reuse
  `unavailableProgress`). Auditor-bot 47005 receipts on state changes.
  Test: fixture e2e — launch without `auction` tag shows "not deployed".
- **B4. Propose-capital-return (G5m).** 47004 `return-capital` kind +
  one-click button on treasury; pre-graduation it links to the CCA refund
  path. Test: e2e — button state per stage.
- **B5. Performance packages (G3m).** `vesting` config (cliff, tranches
  multiples, twapWindow) on the record + validator; TWAP source decision
  (§7.4). Onchain (P3): transfer-lock + unlock conditions. MetaDAO 2×..32×
  ladder as default template option. Test: unit tranche math.
- **B6. LP minimum policy (G7m).** Wizard default reserve ≥ 20% of net raise
  (percent-of-supply conversion, not a blind copy). Test: unit block.

### Phase C — Reputation + agents (T1–T3, C1, C4)
- **C1. Nostr-score data plane (T1).** Kind 37006 score-root record;
  operator CLI/poller publishes roots; TS Merkle verifier matching
  `TrustGatedHook` layout; profile/launch-card score rendering with stale-
  epoch badge. Test: unit merkle vector + model test + e2e mock.
- **C2. NIP-85 score publishing (T2).** Operator publishes 30382 assertions;
  relay ingest allows the kind (test in relay); client renders on profile.
- **C3. Root-gated buckets (T3).** `TrustGatedHook` + 37006 roots, fork test.
- **C4. Agent seats (C4/G7).** `buzz launchpad bid/claim/verify --as-agent`
  with NIP-OA provenance, agent-run badge in UI, escrow address-agnostic.
  Test: e2e agent-key bid mirror + fork agent-key bid tx.
- **C5. Verifier set + ClaimStake + attestation (C1).** Contracts
  (`VerifierSet`, `ClaimStakeEscrow`), 47005 vocabulary
  (`milestone-claimed/milestone-attested/milestone-slashed/stream-cancelled`,
  reserved 47006–47009), evidence composer + verdict UI, `buzz launchpad
  claim/verify`. Test: forge — escrow moves only on quorum attestation; spam
  claim slashed; stream frozen on failed attestation.
- **C6. Stream cancellation contract (C2).** Streams module or `StreamRegistry`
  wrapper; invariant tests (stream-only-on-attestation, revoke-on-non).
- **C7. Participation ledger (C6/idea 7) or kill PT.** Decision §7.3 first.

### Phase D — Optional depth (gated on decisions + live chain)
- D1. Signer-sync treasury council (T4).
- D2. Fee flywheel → sponsor pool (C5); legal decision gates this (§7.6).
- D3. Stack continuity (C3) + programmatic sponsor.
- D4. Earned-holding bonus (idea 2), attestation bonds (idea 5).
- D5. Futarchy decision markets for budget/subDAO (plan P5) — already designed.

---

## 7. Decisions needed (human)

1. **Milestone approval** — verifier panel + plain vote (recommended, ship now)
   vs optional per-launch conditional pools (paper's G8) vs both. Record as a
   deliberate choice either way.
2. **Graduation destination** — treasury-owned Uniswap v4 pool (Umia's exact
   shape) vs apptoken rails (plan §7/§16: TM reserve + LBAMM; current leaning).
   Resolves G3/A2. Highest-risk contract surface.
3. **PT language contradiction** — kill the "PT" term (edit plan §10) and skip
   47006, or ship 47006 participation records? (Recommend: kill the term,
   keep the ledger optional.)
4. **Vesting enforcer + TWAP source** — TV rulesets vs MetaVesT-style controller
   vs both; and what a TWAP milestone reads (LBAMM self-reference risk —
   MetaDAO's lagged TWAP was disabled-in-practice; verifier milestones
   recommended as primary, TWAP backstop).
5. **Agent authority/cap** — read-only vs read+draft-for-human-sign vs sign
   small value under cap; owner-vs-agent slash accountability (NIP-OA).
6. **Compliance (highest risk, gates everything live)** — jurisdictions,
   restricted admission, entity decision; no analyst can answer this.
7. **Community Track v1** — curated-only (recommend) vs trustgraph-root vs
   (never) a curation token market.
8. **Budget rules** — 1/6 + 3× as blocking rules (MetaDAO's trust lever) vs
   founder freedom + warnings. Recommend: rules for v1.
9. **Strategic backer tier** — separate tranche with own hook vs allowlist-
   with-cap only vs none.

---


---

## 7.5 Resolutions (2026-09-13, principal)

- **§7.2 Graduation destination: APPToken rails (locked).** `GraduationExecutor`
  (commit 99d7d0fe7) ships the handoff; no v4 pool.
- **§7.6 Compliance/jurisdiction: OUT OF SCOPE — project-owned.** Each project
  that raises is responsible for its own legal posture; creabuzz is a
  coordination + infrastructure layer. No host-level admission restriction,
  no entity-as-a-service. (The plan's trust-page copy keeps being honest: a
  binding decision is onchain, the team can walk away.)
- **§7.9 Strategic backer tier: NONE for v1.** AllowlistHook gives priority
  within a bucket; a separate guaranteed tranche is a disclosure burden and a
  trust smell in a permissionless system.
- **§7.5 Agent onchain authority: PUBLISH-ONLY for now (C4).** Agents author
  records/mirrors with NIP-OA attestation and compose unsigned txs (A1), but
  never sign money. Future: account-abstraction / session-key limits on an
  ERC-4337-style wallet would give capped agent signing — guardrails' shape
  (per-key spend limits, expiry, single-purpose sessions) is a later design,
  and session keys are exactly the right primitive to revisit it with.
- **§7.4 Vesting unlock source: VERIFIER-ATTESTED MILESTONES PRIMARY, TWAP
  BACKSTOP — and the backstop is deferred.** The TWAP concern is real on both
  rails: Uniswap v4's truncated-oracle attack
  (Hacken, "Uniswap v4 Truncated Oracle") shows a price-milestone oracle can
  be manipulated around truncation; our apptoken LBAMM floor is the same
  self-referential surface (the price a milestone reads is gated by the same
  vesting). So B5's record + wizard validation ship now; the onchain enforcer
  rides C5's verifier set; a TWAP backstop is not built until the pool has
  volume that makes it safe.
- **§7.3 PT language: KILL THE TERM (doc fix).** Edit the contradiction (see
  §4.1): we replaced an instrument with an undefined claim by instruments
  with defined claims. No 47006 ledger for now; revisit only if conviction
  weights (P6) become a real mechanism.

## 8. Where the reports disagree (read before deciding)

- **Futarchy**: Umia = board of directors (everything); MetaDAO = the only
  governance; our plan §9 = budget/subDAO only. All three analysts endorse the
  scoped version but for different reasons (Umia report: thin markets low-
  signal; MetaDAO report: liquidity drag from moving half the spot pool;
  conviction report: the paper's trajectory is decision markets and we deviate
  unrecorded).
- **Curation**: Umia report recommends curated-only forever-ish; MetaDAO
  report suggests the STAMP-style private-capital path is securities law;
  conviction report recommends score-gated. Common ground: never a curation
  token market on our stack.
- **Vesting TWAP**: Umia uses its own spot pool TWAP (self-referential);
  MetaDAO uses lagged TWAP from conditional markets but it's risky on thin
  pools; trustgraphs/conviction lean verifier-attested milestones. Common
  ground: verifier milestones primary, TWAP backstop, oracle decision §7.4.

---

## 9. Compliance note (all four analyses converged)

A hosted public token sale is a securities-shaped activity; the papers'
"no legal entity" claims cover the *protocol*, not our *hosted product*. The
trust, ownership-coin, and fee-flywheel features (§5 ideas 1,3; §6 D2) all
presume a legal posture. This gates: any real deployment, live-chain tests,
follow-on funding, and the fee switch. Recommend a one-page posture decision
(jurisdiction, admission restriction, wrapper) recorded in the repo before
Phase A's fork suite is treated as *the* gate rather than a dev tool.

---
*Next: answers to §7 → update plan v2's §10 fidelity fixes → Phase A vertical
slice (A1+A2, fork-tested) → B1+B2 (UI, no chain) → C1 (score data plane).*
