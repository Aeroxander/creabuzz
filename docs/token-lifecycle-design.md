# Token lifecycle — earned liquidity and contributor royalties

`draft` `design` `contracts` `web` `desktop`

Design contract + build plan for the project-token lifecycle: contribution-gated
royalty income, milestone-tiered sell liquidity in the LBAMM, buyback-funded
price support, and a fair-launch journey from ideation to revenue.

Extends `docs/dao-launchpad-plan.md` §5 (P4 token rails) and
`docs/next-gen-launchpad-plan.md` (C1 VerifierSet + ClaimStake + attestation,
C2 stream cancellation). Research inputs: `.tmp-conviction-markets.pdf`,
`.tmp-umia.md`, `.tmp-majeur.md`, `.tmp-apptoken.md`.

## 0. Decisions recorded

| # | Decision | Status |
|---|---|---|
| D1 | Royalty income is personal: claimable only by a **holder who is also a contributor** (earned entitlement ∧ current holding). Selling stops future accrual; buyers acquire no yield. | **decided** |
| D2 | **Credited is owned.** Attributed revenue is the contributor's property: never expires, never swept, never redirected to buybacks or treasury, unpausable and unseizable — protected even from governance. | **decided** |
| D3 | Buyback funding is a **pre-defined share at split time**. The buyback machine only ever draws its own share; it has no claim on contributor money, including "leftovers". | **decided** |
| D4 | Unattributable revenue (holder sold / no rep) **carries into the next settlement's contributor pool** (option 1). It never flows to treasury or buybacks — this also kills the "sell before a big revenue month to redirect my share to a treasury I control" game. | **decided** |
| D5 | Sacrifice on sale is **prospective only**: `min(1, held/alloc)` scales the *accrual rate*; already-credited balances survive any sale. Rebuy restores the rate. | **decided** |
| D6 | Royalty schedules are **minted at claim attestation** (VerifierSet quorum via `ClaimStake.settle()`), bounded share and bounded term per verified work product — not a floating reputation formula. | **decided** |
| D7 | Wind-down order: credited balances first, then the final settlement, then ragequit splits what remains. | **decided** |
| D8 | LBAMM sell access is **rate-gated by milestone tier** (market-impact control). This is a separate job from D5 (which prices the personal hold-or-sell tradeoff). | **decided** |
| D9 | Unattributable-share destination: carry-forward vs treasury. | **decided = carry** (D4) |
| D10 | Receipts basis (gross vs net), settlement cadence, tier bands, split ratios. | **decided** — gross basis default, monthly close, bands/§8 numbers as written, π/β/τ = 40/40/20 (locked 2026-09-26; per-launch tunables stay launch config) |
| D11 | Raise journeys: funding CCA and float CCA are **both first-class** (patron mode + float mode, §2.1). | **decided** |
| D12 | Milestone tiers are **majeur Badges** (soulbound) — no separate tradeable milestone NFT. Tiers gate sell rates and schedule bands; keeping them non-tradeable keeps that gate from becoming a market. | **decided** |

## 1. The principle: credited is owned

A contribution royalty is **compensation for delivered work**, structured like a
royalty on one's own work product — not a dividend on a transferable security.
Three properties carry the whole design:

1. **Non-transferable income.** The revenue stream attaches to the contributor's
   identity (rep-bearing npub + bound EVM address), not to the token. Yield
   cannot be bought, so it cannot be capitalized into token price. What trades
   is ownership: governance, ragequit NAV, buyback-supported exit, and the
   *option to earn* (to contribute and claim, you must hold).
2. **Irrevocability.** Once revenue is credited, no actor — mechanics, pause,
   governance, wind-down — can reduce the balance except its owner withdrawing
   it. Earned pay is the most senior claim in the system (D7).
3. **Effort linkage.** Entitlements are minted only from **attested claims**
   (`ClaimStake` + `VerifierSet` quorum, `evidenceHash` bound to the Nostr
   contribution record, kind 37013). The unlock is attestation, never a price
   read.

## 2. Instruments

| Instrument | Role | Yield right |
|---|---|---|
| Project token (apptoken TM; TV-gated transfers) | Ownership: governance (majeur Shares side), ragequit NAV, LBAMM exit | none by itself |
| Earned allocation (`alloc_i`) | Tokens granted to contributor *i* at claim acceptance (post-launch grants only by governance — the anti-paywall valve) | scales *i*'s accrual while held |
| Royalty schedule | Per approved claim: weight + term over the contributor pool | the income stream (personal) |
| Milestone badge (majeur Badge tier I/II/III, soulbound — D12) | Sets the schedule band and the LBAMM sell-rate cap | indirect (bands) |
| Loot (majeur) | Economic-only ownership for passive capital | none of the contributor stream |

Double-pay rule: one verified contribution earns **income** (a schedule) *and*
**ownership** (an allocation). Income is senior in wind-down; ownership is the
exit/NAV/governance side. The token itself never carries transferable yield.

### 2.1 Raise modes: patron and float (D11)

Both raise journeys are first-class and share the entire §3 lifecycle — the
mode changes only the raise stage and the initial distribution:

| | Patron mode (funding CCA) | Float mode (float CCA) |
|---|---|---|
| What sells | supply minted at formation | pre-existing supply (contributors, treasury) |
| Proceeds | treasury — funding the work | sellers + treasury per the launch split |
| Early buyers | patrons backing a problem (Umia-style raise) | price discovery for already-earned tokens |
| Graduation | LP seed + majeur summon | LP seed around the discovered price |
| After graduation | identical: royalties, LBAMM rate caps, buybacks, ragequit | identical |

A project may run patron mode first and float later (or the reverse); the
token, schedules, and distributor are the same objects across both.

## 3. Mechanism

### 3.1 Royalty schedules (minted at attestation)

A schedule is minted when `ClaimStake.settle()` reaches approval quorum:

```
Schedule = {
  contributor,        // npub + bound EVM address (buzz-evm-auth binding)
  claimId, evidenceHash,   // provenance → kind 37013 record
  weight,             // share points over the contributor pool (tier band)
  term,               // bounded: mintedAt .. mintedAt + Δ (tier band)
  band,               // badge tier I/II/III
  allocation          // earned token allocation alloc_i registered at mint
}
```

Bounded term is what keeps "always claimable" compatible with "ongoing work
gets paid": credited balances are perpetual (D2), the *stream* has a royalty
term. An early contributor's stream ends; the money they already earned never
does.

**Freeze carve-out.** `ClaimStake.freeze` may suspend a schedule (stop *future*
accrual, fraud escalation) but the royalty distributor must not inherit freeze
power over credited balances — a freeze that can block a worker's pay violates
D2 and would be a governance rug vector.

### 3.2 Revenue settlement (split-first, D3)

At each settlement (default: monthly close on Base; attribution happens per
revenue event, the close only totals and carries):

```
R  = revenue in the window
P  = R·π  + carry_in          // contributor pool, π = 0.40 default
B  = R·β                      // buyback share,  β = 0.40 default
T  = R·τ                      // treasury,       τ = 0.20 default
β + τ + π = 1
```

`B` funds the TokenMaster `transferCreatorShareToMarket` buyback whose refill
target is the LBAMM reserve. Buyback, treasury, and contributor flows are
structurally independent: the buyback draws only `B`, at any point, forever.

### 3.3 Entitlement and accrual (D5)

Active schedules at the window: `w_i = Σ weights of i's in-term schedules`.

```
entitlement_i = P · w_i / Σ w
h_i(t)        = min(1, held_i(t) / alloc_i)        // held at the rep-bound address
credit_i      = entitlement_i · TW(h_i)            // time-weighted over the window
carry_in_next = Σ entitlement_i · (1 − TW(h_i))    // unattributable → next P (D4)
```

- `TW(h_i)` over the window. **v1 implementation (decided):** trapezoidal
  sampling — the project-token balance is sampled at each window's close
  (and the previous close is the open), `h = min(1, (open+close)/2 / alloc)`.
  Zero extra user actions, deterministic, testable. Upgrade path: poke-style
  checkpoint accumulator for true time-weighting.
- Sell some allocation → rate drops proportionally from that moment. Sell it
  all → rate zero (D1: "sell the token, forego revenue"). Rebuy → rate
  restores. Nothing already credited is touched (D5).
- A contributor holding their granted allocation and doing no buying earns
  their full stream — work is never paywalled.

### 3.4 Credited balances (D2)

- **Push at settlement:** on Base, transfer `credit_i` to the bound address at
  close — delivery is automatic, no claim step ("revenue automatically goes to
  the holder who is also a contributor").
- **Eternal pull fallback:** a failed push leaves the amount in the balance,
  claimable at any time in the future. No deadline exists anywhere.
- **No control surface over balances:** no expiry, no sweep, no clawback, no
  pause, no governance call. Withdrawal of credited balances is the one
  unmoderated function in the system.

### 3.5 LBAMM sell access (D8)

Separate from accrual scaling. Entitlement sells into the LBAMM are rate-capped
per contributor: `rate ≤ max(tier_cap · alloc, royalty_linked · trailing_revenue)`
per epoch, tier caps from milestone badges (e.g. I: 3%, II: 5%, III: 8% of
allocation per epoch — §8). Continuous rates, no unlock cliffs: a revenue
milestone changes the *tier* going forward, never unleashes a lump sell wall.

### 3.6 Wind-down (D7)

Revenue stops → `h_i` scaling decays accrual to zero with actual receipts (no
kill switch, no liabilities from promised-but-unearned shares) → order of
claims on what remains:

1. Credited balances (pulled or pushed).
2. The final window's settlement (carry-in included).
3. Ragequit pro-rata on the remainder.

## 4. Invariants (falsifiable — each is a test)

- **I1 Credited-is-owned:** no call sequence reduces a credited balance other
  than its owner's withdrawal. Fuzz every admin/governance/settle/freeze path.
- **I2 Split-first:** `B` and `T` are fixed at settlement; carry ever only grows
  `P`. Buyback solvency never depends on contributor balances and vice versa.
- **I3 Prospective-only:** sale, rebuy, band changes, schedule freeze, and
  governance schedule edits affect accrual after *t* only; credited balances
  are byte-identical across any of them.
- **I4 Attribution final:** once the close credits `credit_i`, it cannot be
  re-targeted; `carry_in` sources only from `1 − h_i`, never from credited
  amounts.
- **I5 Worker-first wind-down:** no ragequit distribution executes while any
  credited balance is unpaid.
- **I6 Anti-dust:** `held < alloc` scales accrual proportionally; keeping dust
  yields dust.
- **I7 Anti-wash:** transfers to addresses not bound to the contributor's npub
  reduce `h_i`; selling to one's own alt forfeits accrual (self-defeating).
- **I8 No yield on the token:** no contract path pays revenue to a bare token
  holder without an attested schedule.

## 5. Attack surfaces and mitigations

| Attack | Mitigation |
|---|---|
| Dust-holding keeps full stream | I6: `min(1, held/alloc)` |
| Wash sale to self/alt | I7: rep-bound-address accounting; npub↔address binding |
| Insider sells before a revenue month to redirect "their" share | D4 carry: the share goes to other workers, never to an attacker-influenced treasury |
| Agent farms minting claims for royalties | trustgraph-gated earning (`TrustGatedHook` pattern pointed at claims, not just CCA buckets); agent-seat claims route to the owner seat in the org graph; verifier objection quorum slashes claim stakes |
| Fake/overstated claims | VerifierSet quorum + stake slashing (`ClaimStake`), `evidenceHash` → 37013 provenance, governance `freeze` on suspicion (accrual only) |
| Revenue under-attestation / late attestation | Attested revenue feed (hash-linked audit chain, 47005-style mirrors); windowed close is public and reconcilable; **honest limit:** attestation is the trust root — v1 is founder/ops attestation with open books, later attested feeds |
| Front-run a settlement by buying tokens | `h_i` is per-contributor and schedule-gated; buying tokens without a schedule earns nothing (I8) |
| Double-pay for one contribution | §2: income = schedule (term-bounded), ownership = allocation; token carries no yield |

## 6. Contract surface

- **New: `RoyaltyDistributor`** (currency splitter + balance ledger):
  `settle(window)` splits `B/T/P`, credits balances (push + pull fallback),
  carries `carry_in`; `claim()`; admin surface cannot touch balances (I1).
  Schedule registry: `mint(claimId, …)` restricted to `ClaimStake` at approval.
- **`ClaimStake.settle()` extension:** on `Approved`, also calls
  `RoyaltyDistributor.mint(claimId, weight, term, band)` — the payout stays
  one-shot; the schedule is the new minted artifact. Rejected claims mint
  nothing. `freeze` → schedule suspension only (§3.1 carve-out).
- **`VerifierSet`:** unchanged contract; verifier compensation rides C5
  (next-gen plan) later — out of scope here.
- **Existing wiring:** TokenMaster `transferCreatorShareToMarket` = the `B`
  burn/refill path; LBAMM Fixed/Single-Provider pools with per-wallet caps =
  sell venues; `TransferValidator` whitelist = TM router + LBAMM + treasury +
  distributor (nothing moves outside); majeur = governance, badges (tiers),
  ragequit (D7 step 3). CREATE2 + the vendored-majeur-no-edits rule from
  `docs/dao-launchpad-plan.md` §4 stand.

## 7. Off-chain surface

- **Kinds (locked at S0):** `KIND_ROYALTY_SCHEDULE = 47006` (regular, immutable
  mirror of a minted schedule; suspension state read from chain) and
  `KIND_ROYALTY_CLOSE = 47007` (regular, settlement-close mirror, 47005-style).
  Reclaims the participation-ledger slot (next-gen plan C6: kill the PT
  concept, spend the number on the royalty ledger). Registered in
  `crates/buzz-core/src/kind.rs` and `web/src/shared/constants/kinds.ts`.
- **Revenue attestation feed:** hash-linked evidence per window (audit chain
  spine; provenance-tagged like agent-wiki 44002 `sources`).
- **UI (web + desktop):** royalty statement card (entitlement, `h`, credited,
  pending push, term/band provenance → 37013 → wiki standup); schedule mint
  surfaces into the existing claim/review flow; LBAMM sell panel shows the
  live rate cap and the hold-or-earn tradeoff in plain words ("selling stops
  future royalties; what you earned is never touched").
- **Launch page copy (both journeys):** buyers acquire ownership only — no
  dividends, ever, unless they contribute. Say it before the bid button.

## 8. Parameters (v1 defaults — open, D10)

| Parameter | Symbol | Default | Notes |
|---|---|---|---|
| Contributor pool | π | 40% | split-first |
| Buyback share | β | 40% | LBAMM refill target |
| Treasury | τ | 20% | doors + grants valve |
| Tier band I | badge I | weight 1×, term 12 mo | majeur Badge tiers (D12); numbers provisional |
| Tier band II | badge II | weight 2×, term 24 mo | |
| Tier band III | badge III | weight 3×, term 36 mo | |
| LBAMM sell cap | — | I: 3% / II: 5% / III: 8% of alloc per epoch | continuous rate |
| Settlement cadence | — | monthly close on Base | push transfers |
| Receipts basis | — | gross (tunable per launch) | provisional (D10); net invites cost games; gross is auditable |
| Unattributable | — | carry → next pool | D4, not tunable without a new decision |

## 9. Plan

| Slice | Deliverable | Acceptance |
|---|---|---|
| **S0 Spec lock** | This doc finalized: D10 resolved (D11/D12 closed), kind numbers chosen, `RoyaltyDistributor` interface + schedule schema PR'd | kind PR merged; interface reviewed against I1–I8 |
| **S1 Distributor MVP** | `RoyaltyDistributor` + `ClaimStake.settle()` schedule mint; invariant/fuzz suite (I1–I8); Base Sepolia deploy + `buzz` CLI read/claim commands | fuzz: no path reduces a credited balance; end-to-end claim → schedule → settle → push on anvil |
| **S2 Token rails** | TV whitelist incl. distributor; LBAMM rate caps (D8); `B` → `transferCreatorShareToMarket` → LBAMM refill; carry accounting | fork tests: sell cap enforced; buyback draw ≤ `B`; carry grows `P` only |
| **S3 Product** | Royalty statement card (web + desktop); settlement-close mirror events; revenue attestation feed; launch-page copy; wiki provenance links | one dogfood project earns revenue → monthly close visible in its channel, statement matches onchain balances |

### Implementation status (2026-09-26)

- **S0 done.** D10/D11/D12 locked; kinds 47006/47007 registered in
  `crates/buzz-core/src/kind.rs` and `web/src/shared/constants/kinds.ts`.
- **S1 done minus live deploy.** `contracts/src/RoyaltyDistributor.sol`
  (split-first settle, credited-is-owned, trapezoid `h`, carry),
  `contracts/src/ClaimStake.sol` (`submitClaimWithSchedule`, mint-on-approval,
  suspend-on-freeze, one-shot `setRoyalties`), `contracts/test/RoyaltyDistributor.t.sol`
  (18 tests incl. fuzz I1/I2/solvency), `contracts/script/DeployRoyalty.s.sol`
  (one-command deploy + wiring; broadcaster must be the treasury). The Base
  Sepolia broadcast awaits operator keys — that is an operator action, not a
  code gap. `buzz royalty show|claim|settle` + `mirror-schedule|mirror-close`
  in `crates/buzz-cli/src/commands/royalty.rs` (bounded-resources tx seam,
  selectors pinned to `cast sig`).
- **S2 done at the gate layer.** `contracts/src/SellRateGate.sol` + tests
  (tier caps, window drip reset, venue-only, fail-closed, non-contributors
  ungated). Wiring the gate as the TV custom ruleset / LBAMM router caller
  and the `B` → `transferCreatorShareToMarket` → LBAMM refill loop needs the
  apptoken local-environment fork runs — the integration point is documented
  on the contract; fork tests remain.
- **S3 done minus the watcher.** Web + desktop `RoyaltyStatementCard`
  (`web|desktop/src/features/launchpad/lib/royalty.ts`, `ui/RoyaltyStatementCard.tsx`,
  unit tests 15/15 + 16/16, tsc + biome clean) with provenance → 37013 notes;
  the ownership-only disclaimer (`OwnershipOnlyNote` in `widgets.tsx`) renders
  before both web bid surfaces; mirror event composers (kinds 47006/47007)
  ship in the CLI with tests binding them to the kind registry. The feed
  publisher is live as `buzz royalty publish-schedule|publish-close` (signed,
  `a`/`h`-bound, duplicate-aware — `commands/royalty.rs`) and the watcher as
  `buzz royalty watch` (polls `WindowClosed` logs, publishes unattended,
  feed-dedupe across restarts, `--once` for cron-style runs). Remaining: the
  dogfood run on a live stack.

## 10. Open questions

D10 (locked 2026-09-26: gross basis, monthly close, §8 band numbers),
D11 (both raise modes — §2.1), and D12 (tiers stay majeur Badges) are
decided. Remaining:

1. Verifier compensation (next-gen C5 fee flywheel) — who pays attestation.
2. Sequencing of the two raise modes in build order (both are in scope;
   patron mode's CCA slice is already the P1 shape — see
   `docs/dao-launchpad-plan.md` §5).
3. Legal review per jurisdiction before any public sale (deferred by
   decision 2026-09-26 — the structure is deliberately effort-linked and
   non-transferable-income, but this is a design contract, not legal advice).

## 11. Sources

- `.tmp-conviction-markets.pdf` (Conviction Markets OV, Mar 2026) — conviction
  vs prediction, productive/speculative split, verifier tier; mechanism left
  open by the paper, supplied here.
- `docs/dao-launchpad-plan.md` (v2 mechanics: CCA, majeur, apptoken rails),
  `docs/next-gen-launchpad-plan.md` (C1/C2/C5/C6), `docs/agent-wiki.md`
  (provenance-tag pattern), `docs/agent-activity-sharing.md` (relay-enforced
  visibility discipline).
- `contracts/src/ClaimStake.sol`, `contracts/src/VerifierSet.sol` (attestation
  tier extended here), `contracts/src/hooks/TrustGatedHook.sol` (earning gate
  pattern), vendored `contracts/lib/majeur`, `contracts/lib/apptoken` rails.
