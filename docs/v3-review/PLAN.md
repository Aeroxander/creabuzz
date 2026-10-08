# v3 review and implementation plan

`draft` `review` `plan` `contracts` `web` `desktop` `cli` `indexer`

**Status: for your review. Nothing in this plan has been implemented.** The only files I added are under
`docs/v3-review/` (this plan, a voting-rules study with its output, and a repro of the worst bug). The local
deployment manifests that my chain runs rewrote were restored to `HEAD`.

Branch reviewed: `v3` at `2ad77b256` **plus the uncommitted working tree** (35 modified and about 20 new files:
the Shares-allocation governor, `TreasuryMandate`, the simulations and the new voting UI). The committed HEAD
still describes the older "bounded credits" voting; the allocation design only exists in your working tree.
Commit it before anyone, including me, touches it (step 0.1).

Reading order: §0 is the whole story in one screen. §3 is the evidence. §4 to §8 are the recommendations.
§9 is the build order with gates where I stop and wait for you. §10 is what I need you to decide.

---

## 0. The short version

**v3 is good work in the middle and unfinished at the joints.** Inside the DAO box the contracts are careful:
270 Foundry tests pass, two stateful invariants ran 256,000 actions with zero reverts, and the raise to graduation
path passes in a real browser against a local chain (6 of 6). But the boxes are not connected to each other, and
several things the product copy promises do not exist.

| # | Finding | Severity | Verified |
|---|---|---|---|
| F1 | A DAO summoned from the web "Summon" dialog can **never open a proposal**, and cannot repair itself | Critical | Ran it |
| F2 | The raise proceeds (60% by default) go to a **founder-chosen address**, not the DAO | High | Read, traced |
| F3 | The reserve "floor" is not a floor: the token owner can withdraw it, and **no client ever releases it**, so after graduation there is **no market at all** | High | Read the TokenMaster source |
| F4 | People who back a raise get **no DAO rights** (no vote, no ragequit). Home copy says "Holders vote" | High | Read, traced |
| F5 | Governance liveness: the unrestricted lane needs >50% of **all** Shares (dead stake included); your own sweep: about 3% of proposals pass at 30% participation, about 23% at 50% | High | Your sim + my Study B |
| F6 | Mandates, project approvals, milestone funding, claims and contribution awards have **no screen or command in web, desktop or CLI**; web and desktop can only open the strict lane, and the CLI can reach the cheap lane only with hand-encoded calldata | High | Grepped every client tree |
| F7 | Conviction accrual adds little (your sim says the 48h review dominates every half-life) and costs the contract its simplicity | Design | Your sim |
| F8 | `TieredSellRouter` trusts the keeper's `amount`; LBAMM integration does not exist yet | Medium | Read |
| F9 | No way to earn Shares for **unpaid** work (awards need a paid claim) | Medium | Read |
| F10 | The Majeur patch is 55 regions deep and the governor has **313 bytes** of size headroom left | Medium | `forge build --sizes` |
| F11 | Social: two feeds, three trust systems, and the same like shows as **0.2 on Home and 1 on Social** | Medium | Looked at the running app |
| F12 | Local tooling: `dev-chain` reuses a stale manifest and breaks; no CCA factory locally | Low | Ran it |

**On your questions**

- *Is conviction voting the best voting mechanism we can come up with?* No, not as specified. Keep what is
  genuinely good (movable exclusive allocation, finite mandates, independent verifiers, ragequit with notice).
  Replace absolute thresholds with **tiered, participation-relative** ones, count only voting supply, and move
  conviction to where it earns its keep: competing funding requests inside a mandate pool (§4).
- *Do the Majeur customizations make sense?* The goals do; the shape does not. They rewrite the whole proposal
  state machine inside a contract with 313 bytes to spare, which voids the audit coverage that was the reason to
  use Majeur. Move new logic into satellites (§4.5).
- *Apptokens?* The Standard-pool design does not deliver its floor. I recommend an architecture spike for "the DAO's
  own token is the apptoken" (§5), with a clear fallback.
- *Two feeds and the 0.2?* Merge into one Home, one trust service, whole-number scores (§7).
- *Token charts for `$CREATE`?* Doable. LBAMM's events are public and simple; Ponder fits (§8).

**Decisions I need from you are in §10.** The three that change the build the most: D1 (do backers vote?), D2 (token
architecture), D3 (what happens to conviction).

---

## 1. What I checked, and what I did not

**Read:** `VISION.md`, `VISION_ORG.md`, `VISION_PROJECTS.md`, `docs/dao-os.md` (the product contract), the
governance, funding, token-lifecycle and launchpad plans, both simulation reports, `ConvictionVoting`,
`TreasuryMandate`, `GraduationExecutor`, `OrgBinding`, the patched Majeur diff against upstream, `ClaimStake`
changes, TokenMaster's pool and router source, the web launchpad, projects, feed and social features.

**Ran:**

| Check | Result |
|---|---|
| `forge test` (whole suite) | **270 passed, 0 failed, 1 skipped** (a fork test that needs an RPC). Two invariants, 256 runs × 500 actions, 0 reverts |
| Browser raise journey, `scripts/web-auction-e2e.sh` | **6 of 6**: community and curated deploy, wrong-wallet guard, decline and retry, ETH sale and USDC sale through bid, end and graduation |
| Web unit tests / typecheck / copy check | 1,281 pass / clean / pass |
| Web voting browser spec (`voting-allocation.spec.ts`) | **4 of 4** (with a mocked wallet and RPC: it proves the screens, not the network) |
| Web file-size ratchet | **Fails**: `WikiView.tsx` is 1,040 lines (limit 1,000). Pre-existing, not from governance work |
| Desktop unit tests / typecheck | 93 pass / clean |
| `just dev-chain` | **Found F12**, worked around, then loaded fine |
| Governance sims | Re-read **Study A** (`scripts/simulate-dao-governance.mjs`, the repo's own); wrote and ran **Study B** (§4.2) |
| Two adversarial probes | Confirmed F1 and the dead-stake effect (`repro-bricked-summon.t.sol.txt`) |
| The running web app | Looked at Home and Social (F11) |

**Not run (so treat these areas as unverified):** `cargo test` / clippy / `just ci`, the full Playwright suite, the
real-relay journey, the desktop app by hand, mobile, anything against live LBAMM, and TokenMaster's behaviour beyond
reading its source. No security audit; nothing here replaces one.

Regarding the older branches: every older branch (`claude/org-graph-social-token`, `-v2`, `claude/org-graph-social`,
`feat/org-graph`, `mirror/dao-os-port`) is a strict ancestor of `v3` (0 commits only they have), so nothing is
stranded. `v3` is 406 files, +12.5k/−1.6k lines past `claude/org-graph-social-token`: a checkpoint of in-flight
launchpad work, a plain-language copy sweep, journey fixes, and then the governance rewrite.

---

## 2. What v3 gets right (keep these)

- **Money safety in the settlement contracts.** `GraduationExecutor` is one-auction-per-executor, reentrancy-latched,
  amount-exact, fails closed on lying `balanceOf`, and has a lock before the reserve can return. The CCA integration
  is tested against the real factory.
- **No credit economies.** Retiring the rechargeable allowance (the depleted-majority counterexample) was right.
- **Bounded authority.** `TreasuryMandate` (finite budget, per-project cap, immutable reviewers, factory provenance
  so a UI label cannot lower thresholds) plus `ClaimStake` + `VerifierSet` (claimant recusal, quorum, challenge
  window, stake slashing) is a better answer to "how does a DAO pay people" than a vote per invoice.
- **Exit is independent of voting.** `mayExit` returns true; ragequit works whatever you allocated.
- **Honest-surface discipline** (R7), the stateful invariants, the additive-fork checker for the Majeur patch.
- **The raise UX**: quick sale, idea first, receipts, wrong-wallet guard, decline-and-retry. It works.

---

## 3. Findings in detail

### F1. A web-summoned DAO is bricked (Critical, reproduced)

`web/src/features/projects/lib/summon-composer.ts:427` sends `summon(...)` with `initCalls: org.initCalls ?? []`, and
`SummonDialog.tsx` takes a pasted summoner address and calls it directly. Majeur's defaults are
`proposalTTL = 0`, `timelockDelay = 0`. The patched policy reverts opening any proposal with `delay == 0` or
`ttl <= review + delay` (`ConvictionVoting.sol:139-142`), and the setters are `onlyDAO`, meaning they need a proposal.
**Deadlock: only ragequit still works.**

Reproduced: `docs/v3-review/repro-bricked-summon.t.sol.txt` summons exactly that calldata, then both `castVote` and
`openProposal` revert. Why nothing caught it: every Foundry fixture (`VotingFixture.sol`, `DaoGovernanceJourney`)
sets TTL and delay with `vm.prank(address(dao))`, which production cannot do. `OrgBinding.summonAndBind` does it
right (initCalls plus read-back), but the dialog bypasses it. The contract's own comment says the defaults "are
exactly the defect this wrapper must never re-create."

### F2. The raise is founder-custodied (High)

The launch wizard's `treasury` is a plain `0x` field (`wizard.ts:634-640`), and the mint flow **refuses any treasury
that is not the connected wallet**: `treasuryGate` in `mint-tx.ts:642-656` says "the deploying wallet must be the
treasury, because the transfer validator and the trading ruleset are token-owner operations." So through the UI the
treasury is always the founder's own wallet. `GraduationExecutor.executeGraduation` pays `(1 − reserveBps)` of the net
raise, plus unsold tokens, to it. Nothing ties it to the DAO or a mandate. `docs/dao-os.md` step 6 says "the raise
settles into a treasury owned by a majeur DAO." Today that holds only if the founder voluntarily moves the money,
which is exactly the trust assumption MetaDAO and Umia exist to remove.

### F3. The reserve is not a floor, and nothing releases it (High)

`GraduationExecutor.releaseReserve` raw-transfers the reserve to the TokenMaster token address. In TokenMaster
(`BondedPool.sol:318-380`) the redeemable floor is the state variable `marketPairedTokenShare`. Balance above it is
**creator share**, split into infrastructure and partner fees and the creator remainder. The token owner can
`withdrawCreatorShare` it (`TokenMasterRouter.sol:792`). It becomes floor only if the owner calls
`transferCreatorShareToMarket`, which also pays out the infrastructure and partner shares. So:

1. The "40% reserve = holder floor" is withdrawable by the founder (default owner = deployer; R4's "owned by the DAO"
   is not wired, and there is no DAO at mint time to own it).
2. Even the honest path leaks the fee shares.
3. `GRADUATION_STEPS` is `execute → mirrorSweep → mirrorLock`. No flow, CLI or script calls `releaseReserve`. After
   graduation the token has **no floor funded and no LBAMM pool**. Backers hold tokens with no market.
4. The TokenMaster curve's default price (`buyCost 1e18 / 1e18`, i.e. 1 paired unit per token) has no stated relation
   to the CCA clearing price. There are up to three prices per project (CCA, curve, LBAMM) and no coherence check.

### F4. Backers have no DAO rights (High)

The CCA sells the apptoken. DAO Shares are minted only to org-seat holders at summon. The journey test shows
investors getting **Loot** (no votes) from a DAO sale, but no UI or flow sells Loot or Shares at all. The Home hero
says "Holders vote on how the treasury is spent, and can always exit." Neither is true for someone who bid in a
raise. This is a product decision, not a bug (§10 D1), but the copy and the contract must agree.

### F5. Governance liveness (High; your own data)

`ConvictionVoting.openProposal` fixes, per proposal: unrestricted needs current FOR **>50% of the opening supply**
(`:143`), bounded needs 20%. Three consequences:

- **Participation does not matter, supply does.** Passive and dead stake count in the denominator. Your Study A
  sweep: at 30% per-wallet participation only 2.4–3.1% of 1,000 trials approve; at 50%, about 23%.
- **Dead stake is permanent.** DAO-held, lost or burned Shares are in `getPastTotalSupply` but `weightFor(dao) = 0`
  (reproduced). A treasury-held balance raises the bar forever.
- **Throughput is one.** Exclusive allocation plus >50% means at most one unrestricted proposal can be approvable at
  a time. Real DAOs run several in parallel.

Meanwhile the "bounded" 20% lane behaves like plain token voting against a concentrated holder (Study B: about
15% of harmful proposals pass when one wallet holds 8%, about 29% at 18%). It is saved only by the mandate's cap and
the verifiers, which is the right layer to rely on.

### F6. The new machinery has no front door (High)

Grepped `web/`, `desktop/`, `crates/`, `packages/`, `mobile/` and `scripts/` for `TreasuryMandateFactory`,
`approveProject`, `fundMilestone`, `awardContribution` and `consumeContribution`: **no matches outside contracts and
tests.** `openProposalWithAction` appears once, in the CLI (`buzz launchpad propose`, `launchpad_gov.rs::cmd_propose`), which
takes a target and raw calldata, so the cheap lane is reachable there only if you hand-encode `approveProject`.
The web and desktop vote encoders cover `castVote`, `queue` and `executeByVotes` only, and the first `castVote`
auto-opens a proposal with `bounded = false` (`MolochPatched.sol:177`). So in the web and desktop apps every proposal is
the strict >50% lane, and the lane the whole mandate design exists for cannot be opened. There is also no way to
create a mandate, fund a milestone, submit, attest or pay a claim, or award Shares from any screen.

### F7. Conviction accrual (Design)

Your own study: "for stable support, the minimum 48-hour review dominates every tested half-life." With a 50%
current floor and a 25% conviction floor, a steady majority has about 47% conviction after 48 hours, so the
conviction gate only binds for support that arrives in the last day. That is a late-swing guard, which a one-time
review extension does more simply (§4.3). `rpow` accrual, per-position conviction, side-change resets and fractional
wei bookkeeping are most of `ConvictionVoting`'s 435 lines and most of its audit surface. Study A's scenarios are
also arithmetic restatements (several assert numbers computed one line above), and it never compares against another
mechanism.

### F8. Sell-rate gate is advisory (Medium)

`TieredSellRouter.executeSell` is operator-only and passes the operator's `amount` to
`SellRateGate.consumeSellAllowance`; the gate cannot see what the venue actually sold, so a keeper (or a bug) can
under-report. Enforcement belongs in the token's transfer validator, where the real amount is known. LBAMM
integration itself is comments only; the LBAMM contracts exist in this repo only as hex blobs in `apptoken-dev`.

### F9. No equity-only work (Medium)

`awardContribution` consumes a claim that is `Paid`; `fundMilestone` requires `amount > 0`. A project with no money
cannot award Shares through the contribution flow, only by a >50% vote. That is the exact case you asked about:
projects that skip the raise and go straight to contributors.

### F10. The Majeur patch (Medium)

55 marked regions disable native tallies, futarchy, split delegation, delegatecall and vote receipts, replace
state/queue/execute, and add ownership hooks on every Shares and Loot transfer. `Moloch` runtime is **24,263 of
24,576 bytes**. Any further change to it will not deploy. Dead pieces remain (Loot checkpoints, `setVotingWeight`
stub, `quorumBps`/`quorumAbsolute` that the 50%/20% floors override: `quorumBps: 500` in `DeployOrgDao` and the
summon dialog is misleading config). The reason to use Majeur was its audit; the patch voids that for the exact paths
that matter.

### F11. Social (Medium; see §7)

`/` Home (`feed/`) ranks notes and launches by trust-weighted +/− (weights in `feed/lib/trust-weight.ts`: org
authority 2, contributor 1 to 2, everyone else `NEWCOMER_WEIGHT = 0.2`). `/social` (`social/`) is an X-style timeline
with likes and a different trust system (seeded PageRank over follows, `social/lib/trust.ts`, weights 0.15 to 2.5).
A third system, TrustGraph score roots (kind 37006), gates auction bids. I looked at the running app: the same test
post and the same like show **"0.2" on Home and "1" on Social**.

### F12. Tooling

- `scripts/dev-chain.sh` treats "address has code" as "already deployed". A stale `dev-currency-31337.json` named an
  address that the fresh chain gave to `OrgBinding`, so the step skipped and funding reverted. It should check the
  contract's identity (`symbol()`).
- The local chain has no CCA factory ("fork-only"), so the raise cannot run on `just dev-chain`;
  `web-auction-e2e.sh` places it with `anvil_setCode`. Do the same.
- Runs rewrite tracked manifests under `contracts/deployments/`.
- `ClaimStake` and `ConvictionVoting` diffs mix formatter churn with logic; split commits so review can see the real
  changes.
- `quorumSummary` (web and desktop) prints "quorum 5% of snapshot supply · 48-hour voting window · FOR must beat
  AGAINST", which no longer describes the rules. It is unused in the UI today; delete or fix.
- `ProposalVault` and vouchers are marked superseded in the docs but still ship in the web UI
  (`ProposalFundingPanel`, `use-proposal-vault`). Two competing "entry voice" paths is one too many.

---

## 4. Voting: what to build instead

### 4.1 Keep, change, move

| Keep | Change | Move |
|---|---|---|
| Movable exclusive allocation (priorities, no credits) | Absolute 50%/20% of supply → relative to **voting** supply, tiered by risk | Conviction → funding pools (competing requests) |
| Finite mandates, caps, verifiers, challenge window | Dead stake excluded from the denominator | New logic out of `Moloch` into satellites |
| Ragequit with notice, independent of votes | One-time review extension for late swings | |
| Snapshot at open; no new-Shares votes | Clients open the right lane | |

### 4.2 Study B (first cut; assumptions are mine)

`docs/v3-review/study-b-voting-rules.mjs`, output in `study-b-output.txt`. 1,000 supply units: team 25%, one
adversary wallet, 5% dead stake, 197 public wallets (heavy-tailed). Public turnout 5/15/30%, delegation 0 or 50%.
20% of proposals are harmful; honest voters who show up are right 80% of the time. "Small" is an approval inside a
capped mandate, "large" is outside one. Cells are *good proposals passed | harmful proposals passed*.

Public turnout 15%, delegation 0 (typical):

| Rule (cells: small good\|harmful / large good\|harmful) | No adversary | One wallet holds 8% | One wallet holds 18% |
|---|---|---|---|
| **Current v3** (large >50% of supply, small ≥20%) | 92\|6 / **21\|1** | 92\|15 / **26\|1** | 86\|29 / **34\|2** |
| Plain token vote, 10% quorum | 94\|6 / 93\|4 | 93\|11 / 93\|11 | 85\|30 / 87\|28 |
| 66% of cast, 20% quorum for everything | 80\|1 / 81\|2 | 75\|2 / 75\|2 | 60\|6 / 58\|7 |
| **Tiered-B** (small: 55% of cast, 10% quorum; large: 66% of cast, 20% quorum) | 92\|4 / **81\|1** | 89\|8 / **74\|4** | 81\|17 / **60\|5** |

(Full grid: `study-b-output.txt`; numbers are copied from it.) Across the whole grid, the current large lane passes
16–43% of good proposals with no delegation (53–73% with half the passive stake delegated) and 0–3% of harmful ones.
Reading it honestly:

- The current large lane is **safe but mostly dead**, as above.
- Plain voting is **live but exposed**: with an 18% holder, 28–30% of harmful proposals pass.
- **Tiered-B keeps most of the safety and recovers most of the liveness**: 58–86% of good large proposals pass
  (against 16–43% today) with 0–8% of harmful ones; its small lane passes 79–95% of good with 1–17% of harmful, which
  is the part the mandate cap and reviewers have to cover. It is a starting point, not a conclusion.
- A fixed-veto "optimistic" small lane did poorly (16–50% liveness) because honest voters' mistakes trip the veto.
  I would not ship optimistic approval without a better model.
- It cannot see sybils, vote buying, or turnout that moves with proposal stakes. It supports ordering, not numbers.

### 4.3 Recommended design: tiers by blast radius

| Lane | What it covers | Rule (starting values) | Why |
|---|---|---|---|
| **A. Inside a mandate** | `approveProject` on a factory-made mandate | 55% of votes cast, quorum 10% of voting supply, 24h review | The mandate cap, reviewers and challenge window bound the loss |
| **B. Funding pool** | Competing requests against a pool | Conviction accrues until a threshold that **scales with the share of the pool requested** | This is what conviction voting is for (Gardens-style) |
| **C. Treasury-scale** | Withdrawals, new mandates, issuance, rule changes | 66% of cast, quorum 20% of voting supply, 48h review, delay ≥ exit window | Large blast radius, so a high bar, plus ragequit |
| **Exit** | Ragequit | Always on; notice ≥ the review period | The real safeguard in a Moloch |

Plus: **voting supply** = total Shares minus DAO-held, burned and excluded addresses (read from the same historical
checkpoints the policy already keeps); a **one-time 24h review extension** when quorum arrives in the last quarter of
review or the margin is thin; **mandatory governed summoning** (F1). Trust scores never feed voting weight (G6 stays).

### 4.4 What to do with conviction (decision D3)

- **Option 1 (recommended):** remove accrual from lanes A and C (review extension instead), keep it in lane B.
  `ConvictionVoting` shrinks and the audit surface drops. Conviction does the job it was invented for.
- **Option 2:** keep v3's accrual everywhere, but fix F1, F5, F6 and dead stake. Least rework; you keep a mechanism
  your own simulations say is mostly decorative.
- **Option 3:** drop conviction entirely. Simplest; loses the "sustained support" story for funding requests.

### 4.5 Majeur: how to stop growing the patch

Freeze `Moloch` at today's behaviour (313 bytes left) except bug fixes. Put everything new in satellites that have
room: `ConvictionVoting` (policy), `TreasuryMandate(+Factory)` (the factory is 18 KB; check its limit before adding),
a post-init check in `Summoner` (1.7 KB runtime, 22 KB of headroom) so a DAO without production settings can never be
created, and `Shares`/`Loot` (7.5 KB and 3.1 KB today, with 17 KB and 21 KB of headroom: room for a transfer-validator
hook). Commission an audit **scoped to the fork diff**
(the checker already produces it). Delete the dead patches (Loot checkpoints unless D1 uses them, `setVotingWeight`
stub) to shorten the diff.

### 4.6 Simulation work, so the numbers stop being arithmetic

Extend Study B into a real agent-based study: stakes from the actual CCA distribution once we have testnet data,
turnout that responds to stakes, delegation concentration, vote-buying and wallet-splitting attackers, proposal
arrival rates, and **treasury loss** (not just pass rates) with ragequit modelled. Pin outputs in CI (±tolerance) so a
parameter change that kills liveness fails a test. Report assumptions beside every number.

---

## 5. Tokens: one coherent model (decision D2)

Today there are four "ownership" instruments (apptoken, TokenMaster floor, Loot, Shares) and no defined mapping from
"I bid in the raise" to any right. Options:

| | A. Keep as built | B. Loot is the sale token | **C. The DAO token is the apptoken** (spike first) |
|---|---|---|---|
| Sold in the raise | TokenMaster apptoken | Majeur Loot | Majeur Shares (and optionally Loot), made transfer-rule aware |
| Floor | TM reserve (broken, F3) | Ragequit NAV | Ragequit NAV (nothing extra to fund) |
| Market | TM curve + (future) LBAMM | LBAMM pool | LBAMM pool, with LBAMM hooks for fees |
| Transfer/fee control | Token owner + TV rulesets | Pool hooks only | Validator hook in `Shares` + LBAMM token/pool hooks |
| Backer rights | None | Exit only (Loot has no vote) | Vote + exit (decision D1) |
| Moving parts | Most | Fewest, least programmable | Few; needs the spike |

**Why I lean C.** You want programmable fees and transfers and Majeur as the base. TokenMaster's curve and floor
duplicate what ragequit already is (a reserve-backed exit at NAV), and its reserve is not enforceable as built. If
the DAO's own `Shares` carries a transfer-validator hook, the same token is raised in the CCA, traded in LBAMM,
governed through the policy, and redeemed through ragequit. One supply, one exit, one set of rules, and MetaDAO and
Umia sell (token holders own the treasury) falls out of the design rather than being bolted on.

**The spike (3–5 days, Foundry, no UI)** must answer, with tests:

1. Does `Shares` (and `Loot`) take a validator hook inside its size budget, and keep delegation, checkpoints and
   `onOwnershipChanged` correct?
2. Does the CCA accept it as the sale token, and does graduation hand it to a pool cleanly?
3. Can LBAMM create a pool with it, and can token and pool hooks set the fees you want?
4. Which transfer rulesets (pool-only, allowlist, vesting lock) work with it?
5. Gas and size.

**Fallback:** B if any of 1 to 4 fail. Keep TokenMaster only if you explicitly want its curve as a second product,
and then fix the floor (below).

**Whatever you choose, fix the raise wiring (all options):**

- Summon a **governed DAO before the raise**, so its address (CREATE2) exists. `GraduationExecutor`'s `treasury` is
  that DAO, not a free field. The UI offers no other value by default.
- Token ownership and fee levers go to the DAO in the same flow (R4 as written).
- One user action, one atomic bundle (Review-Proven Rule 5): a `LaunchKit` that deploys token, DAO, executor and
  auction in a resumable, durable sequence.
- If TokenMaster stays: a `ReserveCommitter` as pool owner whose only power is `releaseReserve → transferCreatorShareToMarket`
  in one call (fee leak shown to the user), after which ownership moves to the DAO.
- A **price-coherence check** in the wizard: CCA floor, curve start and LBAMM initial price shown side by side.

---

## 6. Projects that never raise

The honest state: a project can summon a DAO from its equity map (broken by F1), but then has an empty treasury, no
way to pay or reward people without a >50% vote, and no UI for the mandate flow.

1. **Safe summon** (F1): the Projects page goes through the governed entry from Phase 1 (`OrgBinding.summonAndBind`
   or equivalent), so seats become Shares from the equity map with production defaults and a read-back. Co-op
   preset: equal founder Shares.
2. **Equity-only claims.** `TreasuryMandate` gains a share budget: `approveProject(..., shareBudget)`, and
   `ClaimStake` accepts claims with `amount = 0`. A verified claim can be consumed by `awardContribution` whether or
   not cash was paid. Same recusal, quorum and challenge window.
3. **A way to get money in without a raise:** open pledges (donations or dues to the DAO), a revenue splitter
   (`RoyaltyDistributor` already exists), and the mandate flow from the first pledge.
4. **Front doors** (F6): CLI subcommands that build the calldata for what `buzz launchpad propose` only accepts raw
   today (create mandate, approve project, submit claim, fund milestone, attest, challenge, pay, award), then the same
   screens in web and desktop, where the first `castVote` must open the right lane. CLI first, because agents use it
   (AGENTS.md).
5. **Org graph link:** project seats, grants and budgets already live on the relay; show the mandate and claim state
   next to them.

---

## 7. Social: one Home, one trust score, cashtags

### 7.1 Today

- Home `/` (`feed/`): launches and notes, Reddit-style hot ranking, +/− votes weighted by org authority.
- Social `/social` (`social/`): X-style timeline, likes, follow-graph trust, bookmarks, DMs.
- Launchpad: TrustGraph roots for bid gating.
- The same underlying reaction shows as 0.2 on one and 1 on the other.

### 7.2 Recommendation

1. **One Home** with tabs: Following · For you · Launches · Markets. `/social/*` deep links (post, tag, profile,
   messages) stay and Home absorbs the timeline. Keep a "Launch updates" tab. This removes the duplicate surface.
2. **One trust service** (client-side first, as `seededPageRank` already is): inputs are follows, accepted
   contributions and org seats; seeds are community admins and seat holders; output is a **whole number 0–100** plus a
   tier (Newcomer, Member, Trusted, Steward). Publish a daily score root (existing kind 37006) so bid gating and the
   feeds read the same source. Hard rule: trust never feeds governance voting weight.
3. **Whole numbers, honestly shown.** Show the plain headcount ("12 people"), and rank with integer-scaled weights
   (newcomer 2, contributor 10, authority 20: the same ratios as 0.2/1/2, no decimals). Show a "trusted" badge rather
   than a weighted total. Ranking stays hot-score; weights are never displayed as fractions.
4. **Cashtags.** Parse `$TICKER` in `social/lib/content.ts`, resolve through the relay's launch records (ticker unique
   per community; `$TICKER:chain` disambiguates), render a chip (price, 24h change, sparkline), hover card with
   candles, click opens the launch page. If the indexer is down the chip shows the auction or bid price labelled as
   such, never an invented price (R7).
5. **Fomo-style actions, aligned with our vision.** One-tap Bid/Buy from the chip through the existing passkey and
   sponsored-sender stack; "backed this launch" activity items (opt-in wallet link); supporter lists by **hold time and
   early backing** rather than profit-and-loss rankings. The vision documents set productive ownership against
   speculation, and a PnL leaderboard is the opposite. This is an intentional tension to flag, not a default.
6. Apply the copy and sizing rules in `CLAUDE.md` (plain words, `APP_NAME`, rem text tokens, no protocol terms) and
   Review-Proven Rules 7 and 8 (accessibility, every input modality) to every new surface.

---

## 8. Market data: Ponder service for LBAMM and the raise

### 8.1 What exists

Charts today are **bid prices only** (`launchpad/lib/candles.ts`). There is no LBAMM code. From
`limitbreakinc/lbamm-core` (`ILimitBreakAMMEvents.sol`) the events we need are:

```
PoolCreated(address indexed poolType, address indexed token0, address indexed token1, bytes32 poolId, address poolHook)
Swap(bytes32 indexed poolId, address indexed recipient, bool zeroForOne, uint256 amountIn, uint256 amountOut, uint256 lpFeeAmount)
DirectSwap(address indexed executor, address indexed recipient, address indexed tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)
LiquidityAdded / LiquidityRemoved(bytes32 indexed poolId, address indexed provider, uint256 amount0, uint256 amount1, uint256 fees0, uint256 fees1)
```

(`multiSwap` emits one `Swap` per hop.) I could not confirm production deployment addresses or whether `amountIn`
is gross or net of `lpFeeAmount`; the spike checks both against the local environment.

### 8.2 Design

`services/market-indexer/` (a Ponder app, TypeScript, Postgres):

- **Sources:** LBAMM `PoolCreated`, `Swap`, `DirectSwap`, `LiquidityAdded/Removed`; CCA `CheckpointUpdated` and
  `BidSubmitted` (pre-graduation clearing-price chart); `GraduationExecutor` events; token `Transfer` (holder count,
  optional); the DAO's `Opened/Voted/Queued/Executed`, so proposal lists come from one place. Pools found via `PoolCreated`
  filtered to tokens in our launch registry (an allowlist passed in config, regenerated from relay launch records).
- **Tables (`onchainTable`):** `token`, `pool`, `trade` (poolId, block, tx, side, amounts, price), `candle` with
  intervals 1m/5m/1h/1d (upsert per trade, using the floor-to-interval pattern in Ponder's time-series guide),
  `token_stats` (last price, 24h change, 24h volume, liquidity), `auction_point` (clearing price by checkpoint).
- **Price:** from `Swap`, `price = zeroForOne ? amountIn/amountOut : amountOut/amountIn` in token1/token0, normalized
  by decimals; direction fixed by `token0 < token1`. Tests: golden swaps with hand-computed prices.
- **API (read-only, advisory):** `GET /quote?chain=&token=`, `/candles?chain=&token=&interval=&from=&to=`,
  `/trending`, plus Ponder's GraphQL. Responses carry `indexedAtBlock` and `chainHead` so the UI can show staleness.
- **Reorgs:** Ponder's built-in reorg handling; the UI only labels data "final" after N confirmations
  (Review-Proven Rule 2: results must be fenced by generation).
- **Resource bounds (Rule 4):** capped candle history per request, per-IP rate limit, bounded backfill range and
  retries with backoff and a terminal failure state.
- **Local and CI:** anvil with the apptoken-dev contracts, `ponder dev` against it; a golden-trade test that swaps on
  LBAMM locally and asserts the candle. Production: managed Postgres, one service per chain.
- **Why an HTTP service:** AGENTS.md prefers Nostr events over new HTTP endpoints for app state. Chain data is not on
  the relay, and the client already reads chain state over RPC; this is the same trust class (advisory, R7), so I
  recommend HTTP here. If you would rather mirror daily candles into events for offline reads, it is a small add-on.

### 8.3 Ticker rules (needs your input, D5)

Ticker uniqueness per community enforced at relay ingest of the launch record, case-insensitive, reserved list, 2–8
letters. Cross-community clashes show a chooser. Spam and impersonation (`$CREATE` registered by someone else) are
handled by the first-claim rule plus admin moderation; no onchain registry in v1.

---

## 9. Build order, with gates

Each phase ends with: tests that bind the **production** path (Rule 3, falsifiable), `just ci` or the scoped
equivalent, an agent review and an agent exercise of the changed flow, and then **your** hands-on test. Per AGENTS.md
the `buzz-review-completed` marker is yours to add, not mine. I stop at each gate.

| Phase | Work | Size | Exit gate |
|---|---|---|---|
| **0. Safety net** | 0.1 Commit the working tree in logical commits on `v3` or a new branch (contracts, web, desktop, docs/sims). 0.2 Failing regression tests for F1, F3, F6. 0.3 Fix `dev-chain` (identity check, place CCA factory and Permit2, stop rewriting tracked manifests). 0.4 One `just verify` for forge, unit, auction e2e, sims | 1–2 d | Baseline recorded; red tests exist |
| **1. Stop-the-bleeding** | Route the Summon dialog through `OrgBinding.summonAndBind` (it already enforces production settings and reads them back) or an equivalent governed entry; add a post-init check in `Summoner` so a bricked DAO cannot be created through any front door; tests that do **not** prank the DAO (F1). Remove or correct stale copy: "Holders vote", `quorumSummary`, 48-hour window, `quorumBps` config. Integer trust display (7.2.3) and make Home/Social agree. Mark `TieredSellRouter` advisory in UI. Hide ProposalVault UI until D8 | 2–3 d | **Gate 1**: you click Summon in the web app and open a proposal |
| **2. Spike: token architecture** (§5) | Foundry prototypes for options B and C, decision record | 3–5 d | **Gate 2: decide D2** |
| **3. Raise → DAO wiring** | `LaunchKit` (token, DAO, executor, auction, atomic and resumable), treasury = DAO, owner = DAO, reserve handling per D2, price-coherence check, backer rights per D1, tests on the real CCA factory | 1–2 wk | **Gate 3**: full raise on a local chain ends with funds in the DAO and a tradable token |
| **4. Voting v2** (after D3) | Voting supply, tiered lanes, review extension, lane B pool conviction, dead-stake exclusion, `openProposalWithAction` default for mandate actions, stateful invariants updated, Study B extended and pinned in CI | 1–2 wk | **Gate 4**: study table + invariants green; you review parameters |
| **5. Front doors** | CLI first (`buzz mandate …`, `buzz claim …`), then web, then desktop: mandate, project approval, claims, attest, award, equity-only claims, pledges | 1–2 wk | **Gate 5**: no-raise project journey end to end |
| **6. Social + markets** | Unified Home, trust service, cashtag parser/chip/hover, Ponder indexer + LBAMM integration + chart, one-tap trade sheet | 2 wk | **Gate 6**: post `$TICKER`, see a live chip and chart |
| **7. Hardening** | Audit scoped to the Majeur fork diff + new satellites; fork test on a public testnet; threat-model pass; real-relay journeys in CI; docs aligned with `dao-os.md` | 2+ wk | Ready for a limited-value pilot |

Phases 1 and 2 can run in parallel with the study work. Phase 5's CLI can start as soon as Phase 4's interfaces are
frozen. Sizes are calendar estimates for one engineer-agent pair with your reviews between gates.

### 9.1 Test and evidence plan

- **Contract:** the no-prank summon test, a full launch lifecycle on the real CCA factory with funds ending in the DAO,
  reserve and floor accounting against the real TokenMaster (if kept), mandate and claim lifecycle including
  equity-only, lane thresholds at boundary values, and the invariants (allocation conservation, voting supply
  conservation, no execution without notice).
- **Browser (real relay + chain):** two journeys in one runner: *raise* (idea → quick sale → mint → auction → bids →
  graduation → funds in DAO → claim tokens → trade → post `$TICKER` → proposal → mandate → project → claim → pay →
  award) and *no-raise* (project → governed summon → equity claims → award → proposal). Extend
  `web-auction-e2e.sh` and `e2e-real/journey.spec.ts` rather than adding infrastructure.
- **Indexer:** golden-swap price tests, reorg replay test, staleness label test.
- **Human test steps** will be written per gate; I will never mark that step done myself.

---

## 10. Decisions I need from you

| # | Decision | My recommendation |
|---|---|---|
| **D1** | Do backers (people who fund a raise) get a vote? (a) Exit only, as designed ("contributors govern, investors exit"); (b) vote + exit; (c) vote on treasury-scale actions only | **(b), or (c) if you want contributors to keep day-to-day control.** MetaDAO and Umia both give holders a voice; "exit only" contradicts the current copy and is hard to market |
| **D2** | Token architecture: A as built / B Loot is the sale token / **C the DAO token is the apptoken** | C, gated by the spike; fall back to B |
| **D3** | Conviction: 1 move it to funding pools only / 2 keep everywhere / 3 drop | 1 |
| **D4** | Thresholds (starting values in §4.3). Willing to accept ~80% liveness with ≤8% harmful-pass in Study B conditions, with exit as backstop? | Yes, then tune on testnet data |
| **D5** | Tickers: first-claim per community, no onchain registry in v1? | Yes |
| **D6** | Fomo-style social trading: supporter lists by hold time / early backing, **not** PnL leaderboards? | Yes |
| **D7** | Majeur: freeze `Moloch`, satellites only, audit scoped to the fork diff? | Yes |
| **D8** | Superseded pieces: delete `ProposalVault`/vouchers UI and the futarchy-budget proposal kind, or revive? | Delete (keep contracts until after D1) |
| **D9** | Scope: desktop and mobile parity inside this plan, or web + CLI first with parity after? | Web + CLI first |
| **D10** | Working tree: commit to `v3` as-is, or a new branch? | New branch off `v3`, logical commits |

---

## 11. Risks and unknowns

- **LBAMM:** no local source here; production addresses, fee semantics and hook permissions unverified. The spike must
  run against the local environment before anything depends on it.
- **TokenMaster and ERC-20C transfer validators:** I read the source; I have not run the combination with Majeur
  hooks. That is the spike (§5).
- **Security:** no part of this has been audited. Mainnet stays off (`VITE_ENABLE_MAINNET`), and every flow keeps the
  "unaudited" notice.
- **Legal:** raising money with transfer-restricted ownership tokens, investor voting rights and exit rights is a
  securities question in many places. `token-lifecycle-design.md` already defers it; this plan does not resolve it.
- **Sybil and collusion:** reviewer panels can collude and a governing majority can self-deal; the design bounds
  and exposes this, it does not prevent it. Study B cannot model sybils or vote buying.
- **Ponder specifics** (version, config shape) must be pinned against the docs at implementation time; I used its
  documented concepts, not an installed version.
- **Plan drift:** the older plans (`dao-launchpad-plan.md`, `funding-and-governance-plan.md`) disagree with each other
  and with `dao-os.md` in places. After the decisions I will update `dao-os.md` and mark the rest superseded.

---

## Appendix: reproduce

```bash
# contracts
cd contracts && forge test                                       # 270 passed
# raise → graduation in a browser (boots its own anvil)
. ./bin/activate-hermit && scripts/web-auction-e2e.sh            # 6 passed
# F1 repro: copy docs/v3-review/repro-bricked-summon.t.sol.txt to contracts/test/ReviewScratch.t.sol, then
cd contracts && forge test --match-path test/ReviewScratch.t.sol -vv
# Study B
node docs/v3-review/study-b-voting-rules.mjs > docs/v3-review/study-b-output.txt
# web
cd web && pnpm test && pnpm typecheck && pnpm check:copy
```

Sources used for the competitor and tooling notes: MetaDAO raise and futarchy summaries
([Alea Research](https://alearesearch.io/newsletters/metadao), [Hackernoon](https://hackernoon.com/ownership-coins-cryptos-answer-to-broken-token-holder-rights)),
Umia ([overview](https://ourcryptotalk.com/blog/crypto-launches-need-structure-can-umia-deliver)), Fomo
([QuickNode listing](https://www.quicknode.com/builders-guide/tools/fomo-by-fomo-labs)), Ponder
([time-series guide](https://ponder.sh/docs/guides/time-series)), LBAMM events
([`ILimitBreakAMMEvents.sol`](https://github.com/limitbreakinc/lbamm-core/blob/main/src/interfaces/core/ILimitBreakAMMEvents.sol)).
Competitor details are secondhand summaries; verify against their docs before we claim parity.
