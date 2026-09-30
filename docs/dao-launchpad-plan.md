# DAO Launchpad Dashboard — Integration Plan v2 (brainstorm)

> Direction locked: **onchain-first, Moloch core, futarchy only for budget/subDAO.**
> Inspiration from Umia. Token + LP control via apptoken-skills.
> Rewrite from scratch. Dashboards for **founders** and **investors** in Buzz desktop.
> Founder links launch to their project community. Buzz = the Slack layer.

Research inputs (2026-09-09): `.tmp-umia.md`, `.tmp-majeur.md`, `.tmp-apptoken.md`.
Existing branch `dao-launchpad` reviewed (conviction-stack model, kinds 47001–47006,
Foundry workspace with vendored majeur). This v2 proposes what to keep and what to drop.

## 1. What we take from each source

### Umia — take the mechanics, not the platform
- **Tailored Auctions (CCA buckets):** windowed sale (~1wk), bids = budget + max price,
  supply releases per bucket, same clearing price per moment, early bids average lower.
  Buckets carry optional gating + per-wallet caps. **Adopt for our raise.**
- **Graduation threshold + full refunds:** min proceeds set at formation; miss = fail,
  all bids refundable, no entity formed. **Adopt as launch rule.**
- **Day-one LP seeded at discovered price, treasury-owned** (CCA → LBP → spot pool,
  Uniswap v4 + hook). **Adopt the shape;** implementation via apptoken rails below.
- **Vesting (MetaVesT pattern):** full supply minted up front, team/founder float locked
  pre-sale, post-launch grants only by governance; time-linear + TWAP price milestones.
  **Adopt the pattern** (our enforcement = locks + Transfer Validator rulesets).
- **Two tracks:** Curated (team review, fast) vs Community (permissionless, holder-ranked
  admission, protocol allocation at TGE). **Adopt as launch admission.**
- **Fluid capital:** launch lean; later needs via issuance-by-proposal, follow-on auction,
  or revenue back into same treasury. **Adopt.**
- **3-door treasury:** monthly allowance (auto-draw) / governance disbursements / wind-down
  pro-rata. **Adopt as treasury UX.**
- **No formation fee today; fee switch later** (spot + market swap fees). **Adopt.**
- Do NOT copy: Cayman SPC wrapper, zkTLS gating (defer), Umia decision markets for everything.

### Majeur (Moloch) — the governance core
- **Shares** (vote + economic, delegatable, split delegation) + **Loot** (economic only)
  + **Badges** (soulbound top-256, chat gating). Fits founder/investor/team split:
  contributors → Shares; passive capital → Shares/Loot split.
- **Proposals:** id-hashed, N-1 snapshot, quorum (bps or absolute) + FOR>AGAINST + minYes,
  TTL + timelock, execute-by-votes or permits, `bumpConfig` emergency invalidate.
- **Ragequit:** always-on pro-rata exit (sorted tokens). Timelock gives exit window.
- **Tribute (OTC escrow peripheral):** lock tokens → vote → claim shares/loot. = join-by-contribution.
- **Budget primitive = allowances:** `setAllowance` + `spendAllowance`; TapVest streaming;
  ShareSale / BondingCurveSale raises; LPSeedSwap; ShareBurner; batchCalls.
- **SubDAO pattern:** no native object — Summoner clone + parent allowance funding. **Adopt exactly this.**
- **Futarchy scoped:** per-proposal reward pools (ETH / mint-shares / mint-loot / ERC20),
  YES auto-resolves on execute, NO via resolve, auto-futarchy earmark. **Use ONLY for
  budget/subDAO allocation proposals** (your call). All other proposals = plain vote.
- **Renderer:** on-chain SVG DAO/proposal/receipt/badge cards. Cheap win for dashboard richness.

### Apptoken-skills — token + LP control
- **TokenMaster:** reserve-backed pools (Standard bonding-curve / Stable fixed-price / Promo
  free-distribution) via Router; spreads/fees/guardrails; creator/infra/partner split;
  `transferCreatorShareToMarket` = onchain buyback (Standard only); emissions controls.
- **LBAMM:** secondary pools (Dynamic concentrated / Fixed / Single-Provider oracle);
  integrator routers for swap/add/remove/collect.
- **Transfer Validator:** rulesets (whitelist/vanilla/soulbound/blacklist/custom) gating
  every transfer. Must whitelist TM Router + LBAMM or nothing moves.
- **Fees:** TM spreads + LBAMM exchange/fee-on-top/LP/hook fees; no-code standard-hook
  (pause, disable pools, fee BPS) or custom token/pool/position hooks (dynamic fee 55555,
  KYC/time-lock, rebates).
- **Agent path:** skills are Foundry generators (designer → validator → deployer →
  pool/hook/integrator). Run via `buzz-dev-mcp` shell/forge; expose withdraw/buyback/pause
  as narrow approved tools; log every tx to Buzz channel via `buzz-cli`.
- Deterministic CREATE2 addresses throughout (same on all chains).

## 2. Architecture: chain = ledger, Nostr = record

- **Onchain (Base first, Sepolia dev):** auction, token, LP, vesting locks, Moloch DAO,
  treasury, allowances, futarchy pools for budget/subDAO. Everything moving value.
- **Off-chain (Nostr) only where it makes sense:**
  - discussion drafts, Q&A, reviews, curate-track deliberation;
  - proposals with **no onchain action** (signal polls, roadmap sentiment, team updates);
  - receipts/mirrors of chain state (advisory — chain is authoritative, clients verify).
- Hash links bind the two (evidence hash onchain, content on Nostr/Blossom).

## 3. Product shape (desktop, rewrite from scratch)

### Founder dashboard
- Create launch → **link community** (default = current; picker for owned/admin
  communities; explicit unlink with history retained).
- Configure: sale (buckets, caps, price bounds, graduation threshold, currency USDC default),
  LP seed reserve, vesting grants (time + TWAP milestones), admission track
  (curated vs community), treasury doors (allowance lines, wind-down).
- Operate: watch auction (bids/clearing/fills lenses), execute graduation (LP seed +
  entity formation or Moloch summon), manage treasury (allowances, TapVest streams,
  follow-on auction, issuance-by-proposal), spawn subDAO (clone + allowance),
  open futarchy **only on budget/subDAO proposals**.
- Bound channels auto-created: `#announcements` (founder-signed, read-mostly),
  `#discussion` (open), proposal threads in Forum.

### Investor dashboard
- Discover (per-community featured + directory; Community Track ranked admission).
- One launch page: terms, auction state/progress, team (npubs), repos/docs, vesting table
  (circulating vs total), treasury + LP position, proposal list (plain vs futarchy-marked),
  ragequit button, claim/refund button.
- Bid flow: budget + max price + bucket eligibility; partial fills + one-call exit/claim.
- Follow → Home feed + notifications on stage, fills, proposal state, futarchy resolution.

### What changes in desktop (fresh `features/launchpad/`)
- Keep patterns from branch: `LaunchpadScreen` stats + stack list, `status.ts` pure
  projection, curate/action dialogs, Tauri `launchpad` commands, sidebar section.
- Drop/rename: conviction-stack vocabulary (curator/sponsor/claim/verdict) →
  founder/investor/launch language; conviction math + PT non-transferable model
  replaced by auction + Moloch shares/loot + apptoken rails.
- Community link is a first-class field (channel + host); new caches register in
  `resetCommunityState()`; rem tokens only; one a11y owner per label.

## 4. Data + contracts (proposal)

- **Nostr kinds:** retire 47001–47006 in current meaning; define small fresh set
  (numbers TBD): launch record (`d`-addressed, chain addrs, auction params hash),
  bid/auction mirrors (advisory), proposal records (plain vs futarchy-flagged),
  receipt mirrors. Stack-scoped via `a` tags; `kinds` always in relay filters.
- **Contracts (fresh `contracts/`):** keep vendored majeur untouched (re-pin, no fork edits;
  wrappers in `dao-ext/`); auction module (CCA-style buckets or integrate CCA infra),
  vesting locks (MetaVesT-style or TV-gated), graduation gateway (LP seed + Moloch summon
  via Summoner/SafeSummoner presets), apptoken-generated TM/LBAMM/TV. Reuse branch's
  Foundry + CREATE2 + fork-test discipline; audit corpus for majeur reused, new code needs
  its own invariant tests (escrow-moves-only-on-verify/pass, refund-on-missed-threshold,
  conversion-fixed-at-framing).
- **CLI/agents:** `buzz launchpad` groups for list/show/bid/claim/propose/vote/ragequit;
  ACP personas (founder-ops agent, investor-read agent, treasury agent with narrow tools);
  workflow pipelines for deterministic checks (CI-style) feeding human/agent votes.

## 5. Phasing (draft for debate)

- **P0 Confirm:** auction primitive (build CCA-config vs integrate), chain targets,
  kind numbers, curated-vs-community admission for MVP, which vesting enforcer.
- **P1 Raise slice:** auction + graduation/refund + treasury-owned LP + read dashboards
  + bid/claim CLI. No governance yet except wind-down.
- **P2 Moloch:** DAO summon at graduation, shares/loot/badges, tribute join, ragequit,
  plain proposals (+ off-chain signal proposals), allowances + TapVest budgets.
- **P3 Scoped futarchy:** reward pools + auto-futarchy **only** for budget/subDAO allocation;
  Renderer cards; subDAO spawn flow.
- **P4 Token rails depth:** apptoken TM floor + LBAMM secondary + TV gating + buyback/
  emissions tooling via agent skills; fee switch design.
- **P5 Harden:** audit new contracts, E2E (relay + fork), first real launches (dogfood).

## 6. Open brainstorm questions

1. Auction: configure Uniswap CCA directly, or build our own bucketed sale reusing
   BondingCurveSale/ShareSale as stopgap?
2. Vesting enforcer: MetaVesT contracts vs Transfer Validator rulesets vs both?
3. Community Track admission: UMIA-style holder market, or simpler (curators + allowlist) for v1?
4. SubDAO depth: one level or recursive? Parent ragequit exposure acceptable?
5. Futarchy reward token default: ETH, mint-shares, or ERC20 (USDC)?
6. Off-chain proposal types: which exactly stay off-chain (list them)?
7. Branch disposal: archive `dao-launchpad` as reference, or cherry-pick (majeur pin,
   Foundry skeleton, launchpad UI shell, CLI patterns)?
8. Fee switch: design now (even if off), or defer entirely?

---
*Supersedes v1 off-chain-intent plan. Next: your answers → kind numbers + contract
skeleton + one vertical slice (auction state read + bid button) behind feature flag.*

## 7. CCA sale → apptoken LP graduation (2026-09-09 note)

Repo: `Uniswap/continuous-clearing-auction` (main, factory v2.1.0 canonical,
audits: Spearbit + OpenZeppelin + ABDK v2.0.0, bug bounty live). MIT. Designed to
pair with `liquidity-launcher`; we reuse the sale half and swap the LP half.

How CCA maps to our raise:
- Uniform-price-in-continuous-time: `(maxPrice, amount)` tick bids, lazy checkpoints
  (1/block), clearing price recomputed per checkpoint, pro-rata fills at the clearing tick,
  supply rollover. Early bids average lower — same property Umia's Tailored Auctions describe.
- Config per launch: `currency` (USDC), `totalSupply` tranche, `floorPrice`, `tickSpacing`
  (min 2; use ≥1bp of floor), `auctionStepsData` (MPS rate + block deltas via SSTORE2),
  `start/end/claimBlock`, `requiredCurrencyRaised` (our graduation threshold),
  `validationHook` (per-bucket gating), `fundsRecipient` + `tokensRecipient`.
- Lifecycle: no exits before graduation; fail → full refunds via `exitBid`, all tokens back;
  graduate → `sweepCurrency` (fee → controller recipient, net → fundsRecipient, one-shot,
  recipient-only) + `sweepUnsoldTokens`; bidders `exitBid`/`exitPartiallyFilledBid`
  (checkpoint hints) then `claimTokens`/`claimTokensBatch` after claimBlock.
- Reads for dashboard/CLI: `CCALens` (stateless, shared) + `AuctionStateLens.state`
  (checkpoint via revert-catch `eth_call`) + `TickDataLens` (demand ladder, 1000-tick cap).

Graduation handoff (the key interface):
- `lbpInitializationParams()` → `(initialPriceX96, tokensSold, currencyRaised net of fees)`,
  reverts unless finalized + graduated. Natively consumed by an `ILBPInitializer`
  (v4 pool). **We write our own `AppTokenLBPInitializer` implementing the same interface,
  deploying apptoken rails instead:** TokenMaster reserve + LBAMM pool seeded at the
  discovered price. CCA stays untouched; only the downstream strategy changes.
- Preferred order: (1) deploy ERC-20C + Transfer Validator + TM config (buys disabled),
  TV whitelists CCA contract; (2) run CCA on the sale tranche; (3) at graduation, gateway
  consumes LBP params → enables TM buys / seeds LBAMM (price = final clearing, reserve =
  share of net raised, remainder → Moloch treasury). Alternative (vanilla token then migrate)
  rejected — worse UX + breaks TV story.

Gotchas to enforce in our launch wizard/CLI (from integration guidelines):
- Bounds: totalSupply ≤ 2^100 wei; floorPrice ≥ 2^32+1; max-bid-price derives from supply;
  keep `currency` more valuable than `token`; don't oversize supply.
- Tick spacing ≥ 2 (reject 1); recommend ≥1bp. Steps: sane MPS deltas, no dust steps.
- `prevTickPrice` hints for gas; no-exit-before-graduation is the invariant (show it in UI);
  sweeps are one-shot + access-controlled; never send extra tokens (unrecoverable);
  fee-on-transfer / low-decimal tokens need care; protocol fee controller is immutable per
  factory (deploy our factory for our fees, or pass zero).

Validation hooks = our gating layer: `IValidationHook.validate` (revert = reject) + ERC165
(CIP-1). Ship `AllowlistHook` (curated track, per-wallet caps) and `CommunityHook`
(holder/rank-gated buckets) as `dao-ext/`-style wrappers, never fork CCA.

Phasing update: P1 = CCA sale slice (factory + param builder + hooks + lens reads +
bid/claim CLI + dashboard progress); P3/P4 = `AppTokenLBPInitializer` (TM floor + LBAMM
secondary + TV rules) then Moloch summon with treasury = remaining raise. Open: TM pool
type per launch (Standard vs Stable), LBAMM pool type (Dynamic first), fee-switch wiring.

## 8. Trustgraphs (2026-09-09 note)

Repo: `AInima-Collective/trustgraphs` — proof infra for reputation computations:
verifiable inputs + deterministic program (SP1 zkVM) + ZK proof + onchain Merkle root.
Permissionless proving, epoch checkpoints, no trusted scorer. Proof shows the program ran
right, not that inputs are true or rules are fair.

Why it matters here:
- There is a **Nostr workspace program**: signed workspace events (membership, identity,
  replacement/deletion rules) verified against an anchored witness package → scores.
  That is our data plane. Buzz communities could get reputation roots without forcing
  members onto EAS first.
- Standard **vouch program** (EAS attestations, seeded PageRank, reachability = Sybil
  boundary) fits founder/investor/verifier reputation and Community Track admission.
- **Contributions program** (vouch history + claims + peer valuations → allocation) maps
  to milestone/retro payouts and budget rounds — an alternative weight next to conviction.
- **Score composition** merges proven sets without merging raw data (EAS vouches + Nostr
  activity + DAO participation → one root). **Signer sync** derives a Safe owner set from
  vouches + activity + Safe state → treasury/subDAO council rotation.
- Roots support trust-weighted voting (proposal-pinned checkpoints) and Merkle-proof reward
  claims — both directly consumable by Moloch (voting weight input, reward token claims)
  and by CCA **validation hooks** (score-gated buckets: prove membership in accepted root).

Cautions: seed selection + params remain trust assumptions; witness availability is
operational; ZK adds complexity (epochs, verifier rotation, prover ops). Start with
off-chain score display → EAS/Nostr network per community → root-gated hooks later.
Decision (2026-09-09): seeds start as the **founders** (equal split, or explicit
weights via weighted-prior network), migrating to **token holders** post-graduation
(e.g. top holders / delegates by snapshot, or a composed holder+vouch root).
Reachability from founders is the Sybil boundary pre-graduation; revocation + epochs
contain a bad vouch. Seed rotation itself is a governed action (founder multisig
pre-graduation → DAO vote after), recorded with provenance. Epoch cadence decoupled
from auction windows; proposal votes pin a checkpoint.

## 9. Decisions round (2026-09-09)

- **Auction: CCA directly.** No curve-sale stopgap. Factory + param builder + two
  validation hooks + lens reads = P1 sale slice.
- **SubDAOs = independent projects.** They receive funds (no recursive governance).
  Performance scored via trustgraph; funding vested/streamed and cancellable on
  non-performance (TapVest-style streams + allowance revoke; conviction-markets paper
  as the mental model: capital flows against attested delivery, not upfront bets).
  Continuation/cancel decisions can be futarchy votes (budget scope) with USDC rewards.
- **Futarchy rewards: USDC default.** Funder-picks-token escape hatch stays.
- **Off-chain proposals = git issues.** No special surface: NIP-34 issues (kind 1621)
  through the forum. Signal polls / sentiment / updates / pre-sponsor grant threads all
  live there. Onchain the moment value, membership, or parameters move.
- **Fee switch explained:** three places fees can arise — (a) CCA protocol fee
  (immutable controller per factory; fee taken at sweep/handoff from gross raised);
  (b) TokenMaster spreads/fees + 4-way creator/infra/partner split; (c) LBAMM
  exchange/hook/LP fees + decision-market conditional swap fees. The "switch" is the
  governed knob setting rates + recipients. Decision: platform multi-sig/DAO takes a
  share — plumb recipient fields now (CCA factory controller, TM partner recipient,
  LBAMM hook fees), ship rates at zero or minimal, governance owns the knob later.
- **Founders weighted**, not equal-split (weighted-prior network; weights visible).

## 10. Conviction Markets paper (2026-09-09 note)

Source: Outlier Ventures, `Conviction-Markets-OV-Final.pdf` (11pp, Mar 2026).
Thesis: Zero to One → Zero to Many; bottleneck is coordination, not building.
VC bundles problem+solution+team into one decade bet; 9/10 fail and knowledge
evaporates. Fix: start from the problem, place capital on solving it, coordinate
whoever is best placed — no startup, entity, or decade bet required.

Concepts we adopt:
- **Conviction ≠ prediction.** Duration, compounds, productive (attracts others,
  generates who-funded/worked/stayed signal). Time × capital × contribution.
  Our streams/allocations weight all three; early+consistent beats early+gone.
- **Two layers, speculation as derivative.** Productive (conviction, ownership,
  milestone rewards) vs speculative (price discovery, liquidity) — either cleanly
  separated or rising-floor + floating premium. Our mapping: CCA raise + streamed
  allowances + milestone unlocks = productive; TM floor + LBAMM premium = speculative.
- **Roles:** Curators (judgment, decoupled from capital — our weighted founders),
  Sponsors (tranches unlocking per milestone — our treasury streams), Contributors
  (stake-to-claim skin in game, PTs at milestones — our builders/agents),
  Verifiers (expert panels → automated agents — our verifier set + agents).
- **Participation Token:** record of participation, not speculative asset; minted at
  milestones weighted by timing/risk/consistency. Pre-graduation lock (our plan §2.4
  in branch docs) is exactly this.
- **Six principles** (commitment>prediction, co-owner>contractor, stacks>products,
  evidence>claims, performance>time-vesting, contributors>passive capital) — keep as
  the design gate for every launchpad decision.
- **Five primitives → our modules:** capital (CCA + streams), reputation (trustgraph
  scores + completion history + slashing), verification/governance (milestone approval,
  futarchy only for budget/subDAO), market creation (launch lifecycle), interface
  (Buzz desktop + CLI + ACP agents).

SubDAO funding rule derived from the paper: subDAOs receive **streamed, cancellable**
funding against milestones with verifier attestation; trustgraph performance scores
weight continuation/top-up/cancel; cancel = freeze stream + revoke allowance, never
governance surgery. Paper's open mechanism-design stance matches ours: ship the right
primitive (stream + score + cancel), not the complete system.

## 11. Build plan + open questions (2026-09-09)

### P0 — Foundations (confirm + skeleton)
- Decisions: chain targets (Sepolia dev → Base), CCA factory deployment, kind numbers,
  branch disposal (archive dao-launchpad, cherry-pick majeur pin + Foundry skeleton +
  UI shell + CLI patterns + invariant-test style).
- Skeleton: fresh `contracts/` (forge, solc 0.8.30, CREATE2), `dao-ext/` wrappers dir,
  desktop `features/launchpad/` shell behind flag, `buzz launchpad` CLI group stub.
- Exit: `forge build` green, desktop flag renders empty list, CLI `--help` lists group.

### P1 — CCA sale slice (mechanic 02 start, raise works)
- Contracts: CCA factory deploy (or pin canonical), `AuctionLauncher` param builder
  (currency USDC, floor, tickSpacing ≥1bp, MPS steps, threshold, blocks), two validation
  hooks: `AllowlistHook` (curated + per-wallet caps), `CommunityHook` (rank/score-gated).
- Reads: CCALens/AuctionStateLens/TickDataLens wired to desktop progress + CLI
  (`list/show/status/bid/claim`). Dashboard: auction state, demand ladder, fills.
- Nostr: launch record kind (d-addressed, chain addrs + params hash) + bid mirrors.
- Exit: Sepolia auction runs full cycle — bid → graduate → sweep/claim, or miss → refund.

### P2 — Stake + streams (mechanics 04 + 02)
- `ClaimStake` (fixed USDC/native per claim, escrowed, refund at graduation, slash on
  spam/failed verdicts) + tribute-style join flow; TapVest-style streams + allowance
  revoke for milestone payouts; verifier set with stake/quorum/slash params; evidence
  hash Nostr → chain binding; cancel = freeze + revoke.
- Desktop: claim/stake flow, milestone evidence composer, verifier verdict UI, stream
  status. CLI: claim/evidence/verify/receipts.
- Exit: contributor stakes → delivers → verifiers attest → tranche unlocks; spam claim
  slashed; stream cancelled on non-performance.

### P3 — Locks + graduation rails (mechanic 03)
- Transfer lock pre-graduation (reverting) + TV rulesets (whitelist CCA/TM/LBAMM);
  `AppTokenLBPInitializer` (consume lbpInitializationParams → TM reserve + LBAMM seed
  at clearing price, remainder → treasury); TWAP price-milestone unlocks next.
- Desktop: vesting table (circulating vs total), LP position view, graduation execute UI.
- Exit: graduated token tradeable only via backed rails; pre-graduation transfer reverts
  onchain (test proves it).

### P4 — Moloch DAO at graduation (operate phase)
- Summoner/SafeSummoner presets via GraduationGateway; shares/loot/badges split
  (contributors 1:1 shares, sponsors shares/loot split fixed at framing); treasury =
  remaining raise; ragequit on; tribute join; plain proposals + git-issue signal flow.
- Desktop: DAO tab (proposals, votes, treasury doors, ragequit button), issue ↔ proposal
  linking. Renderer cards for proposals/badges.
- Exit: stack graduates into functioning DAO on Sepolia with ragequit proven by test.

### P5 — Scoped futarchy (budget/subDAO only)
- Reward pools (USDC default) + auto-futarchy earmark on budget/subDAO proposals;
  YES-auto-resolve on execute, NO path manual; subDAO = clone + allowance, streamed +
  cancellable, trustgraph-scored continuation.
- Desktop: futarchy-marked proposal cards, pool/reward display, subDAO spawn flow.
- Exit: one budget proposal resolved via market; one subDAO funded → scored → topped-up
  or cancelled in test.

### P6 — Trustgraph wiring (mechanic 01)
- Lightweight conviction weight (epoch-attendance × stake × delivered) for splits;
  network per community (weighted founders → holder rotation at graduation, governed);
  root-gated CCA buckets via hook; trust-weighted signal votes; signer-sync for
  treasury council rotation.
- Exit: bucket gated by score proof end-to-end (no allowlist server).

### P7 — Harden + dogfood
- Invariant tests (refund-on-miss, lock, fixed conversion, stream-only-on-verify);
  fork tests; audit new contracts (majeur corpus reused); E2E relay+chain; fee-switch
  rates set (platform multi-sig/DAO recipients); first real launches (dogfood creabuzz).

### Still to think about (grouped)
- Sale: TM pool type per launch (Standard first?), LBAMM type (Dynamic first?),
  CCA default steps/ticks/floor guidance, fee-controller + factory ownership.
- Money: stake amounts, verifier quorum/stake/slash numbers, stream schedules,
  sponsor shares/loot split, curator weight cap, PT→share conversion edge cases.
- Admission: Community Track v1 scope (curated-only?), holder definition at seed
  rotation (delegates-by-snapshot?), epoch cadence (weekly pre / daily post?).
- Enforcement: TV ruleset list, TWAP milestone params, lock exceptions (market-maker? none?).
- Data: final kind numbers + schemas, receipt-mirror trust wording, issue↔proposal
  linking convention, search indexing for new kinds.
- Ops: audit scope/cost, Base deployment + CREATE2 addrs, Anvil/fork CI, dogfood launch pick.

## 12. Build log — branch `dao-launchpad-rewrite` (2026-09-10)

Opinionated calls: record at 37001 (NIP-33 replaceable; 47001 can't replace),
mirrors at 47002–47005; scope MessagesWrite; global-only (stack-scoped via
`a`); any member may curate; chain reads behind a `LaunchChainAdapter` with a
clearly-badged preview fixture until RPC wiring; off-chain = git issues.

Shipped:
- NIP: `docs/nips/NIP-LP.md` (record, bid/update/proposal/receipt, tags,
  deletion, relay query rules).
- Relay: kind.rs consts + ALL_KINDS + assert; ingest scope/globality arms;
  `validate_launch_record_envelope` + `validate_launch_mirror_envelope` +
  call sites; bounded metric labels; 13 unit tests green.
- Desktop (`features/launchpad`, behind `launchpad` preview flag): models +
  fetch (boundary-bucket drain + tombstones) + hooks + mutations, preview
  chain adapter, discovery screen (All/Mine/Following + follow set), detail
  (Overview/Updates/Discussion/Proposals/Treasury/Manage-founder-only),
  create wizard, bid-mirror composer, update composer w/ channel cross-post,
  sidebar entry, `/launchpad` + `/launchpad/$launchId` routes. 13 model tests.
- CLI: `buzz launchpad list/show/curate/delete/record-bid/post-update/
  record-proposal/record-receipt` + inventory tests.
- Contracts: `AuctionLauncher`, `AllowlistHook`, `TrustGatedHook`,
  `AppTokenLBPInitializer`, CCA interfaces; 11 forge tests green.

Deferred (no deploy yet): RPC chain adapter, CCA/majeur pins + fork tests,
verifier set, trustgraph roots, fee-switch rates, audit, testnet.

## 13. Build log round 2 — live chain reads + screenshot pass (2026-09-10)

- `lib/chainRpc.ts`: `RpcChainAdapter` reads `isGraduated()` (0x9e5f2602),
  `currencyRaised()` (0x998ba4fc), `eth_blockNumber`, and `BidSubmitted` log
  counts directly from chain — read-only `eth_call`, no wallet. Any failure
  falls back to the preview fixture (still badged). 9 unit tests.
- `useAuctionProgress` tries RPC when an auction contract is linked; cards
  show Live vs Preview data. `RpcEndpointControl` in the directory header
  (default local Anvil, per-community override in localStorage).
- Screenshot pass (`just desktop-screenshot`, mock bridge): empty directory
  renders clean behind the preview-flag gate; create wizard renders
  correctly (test-profile autofill only). Seeded-card shots deferred — the
  mock bridge does not serve `fetchEvents` for launchpad kinds.
- Guards: biome/tsc/px-text/pubkey/file-size clean; 22 launchpad tests green.
  (Node strip-types rejects TS parameter properties — plain assignment used.)

Still deferred: CCA/majeur pins + fork tests (needs a Sepolia RPC URL),
verifier set + trustgraph roots, fee-switch rates, audit, testnet.

## 14. Build log round 3 — smoke spec (2026-09-10)

- `desktop/tests/e2e/launchpad.spec.ts` (smoke): directory renders, sidebar
  entry navigates, create wizard validates slugs before enabling publish.
  Registered in `playwright.config.ts` smoke `testMatch`. 2 passed; neighboring
  `navigation.spec.ts` still green (19 passed, 1 skipped).
- Note: the E2E static server has no SPA fallback — specs enter at `/` and
  navigate client-side.

## 15. Build log round 4 — pins + fork + web app (2026-09-10)

- URL handling: Sepolia RPC lives only in gitignored `.env` as
  `SEPOLIA_RPC_URL` (never in code, scripts read env). `scripts/
  launchpad-anvil-fork.sh` boots a pinned-block Anvil fork and runs unit +
  pin + fork suites.
- Pins: `continuous-clearing-auction` + `majeur` vendored via forge
  (submodules). The pin caught a real bug: `BidSubmitted` carries
  `(uint256,address,uint256,uint128)` — topic corrected onchain-adjacent
  code and desktop (`0x650baa…`). `PinnedInterfaces.t.sol` asserts our
  selectors/topic against upstream sources; `via_ir` on (upstream needs it).
- Fork: `LaunchpadForkTest` reads the canonical v2.1.0 factory on live
  Sepolia state + registers through our launcher. 2 passed. Unit suite 14
  passed (11 launchpad + 3 pin proofs).
- Web app at parity with desktop reads: `features/launchpad` (models,
  chain incl. RPC adapter + endpoint control, queries/mutations via
  NIP-07/ephemeral/passkey signers), directory + detail (Overview/Updates/
  Proposals/Treasury/Manage-founder-only), create/bid/update dialogs,
  `/launchpad` routes, directory header link. No channel cross-post in web
  v1 (update-only + channel link-out). Screenshot-validated; mocked-relay
  smoke spec green (routeWebSocket REQ→EVENT→EOSE).

Still deferred: verifier set + trustgraph roots (design settled), fee-switch
rates (plumbing in place), audit, any deploy.

## 16. Build log round 5 — apptoken mint + non-crypto UX (2026-09-10)

- Dropped the OZ ERC-20 path per review: minting is apptoken-only
  (TokenMaster Standard pool, ERC-20C, native pairing, Vanilla ruleset).
- `contracts/script/DeployAppToken.s.sol`: deterministic Standard deploy +
  initial supply to treasury + canonical TV + Vanilla ruleset, driven by
  `buzz launchpad mint-token` (whole-token supply, auto salt, paired
  deposit default 0.1 ETH, public-network guard). Proven on a live local
  apptoken-dev env: token deployed, supply minted, reserve funded, TV wired.
- Env findings (local only, documented in contracts/README): packaged env
  allowlists phantom factories (not the deployed ones) — patched
  `allowedTokenFactory` for the real three via Anvil storage surgery
  (router slot 1); forge needs `--no-storage-caching` against live Anvil
  (stale fork cache reads pre-patch state); native pairing requires nonzero
  initial deposit; Standard guardrails require spreads < BPS (9999, not
  10000). Curve buy-price tuning still open (first buys revert
  InsufficientBuyInput at 0.1 ETH reserve — needs bigger deposit or gentler
  curve; reversible econ).
- UX: both wizards default to Mint-new (no hex to start), import mode with
  on-chain Verify, Quick-start preset for all technical fields, human supply
  units, copy-paste mint command + paste-and-verify linking in Manage
  (desktop) / ManagePanel (web). NIP-LP records `tokenPlan`; `token` tag
  links after mint.
