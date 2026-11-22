# Post-launch plan: a Pump-inspired curve launch option

> **Frozen (D137), 2026-10-31.** A proposal kept for after the pilots and the audited raise; nothing here is planned now. The current index is [STATUS.md](STATUS.md).

Status: **proposal for review, not an accepted tokenomics change or an implementation request**.
Prepared 2026-10-25 against `1f586dd6983e` on `v4-governance-rework`.
This document changes no contracts, application behavior, accepted decisions or deployments.

## 1. What this would look like

After the social/contributor MVP and the first validated CCA raise, an approved founder could choose **Curve launch**
for a new fundraising project. People could buy a position at the curve's current quote, or sell that position back
while the curve remains open. When its public allocation is fully bought and the settlement conditions hold, anyone
could finish the launch. Buyers would then collect the project's preallocated Shares, part of the money would enter
the DAO treasury, and a separately disclosed part would fund a trading pool.

The project page would continue to lead with the team, work, agreement and updates. Buying a token would not replace
the contributor journey. An existing contributor-only project would gain no market or sale by installing this feature.

This is a **new launch format inspired by Pump**, implemented for our contracts. It is not a literal translation of
the linked reconstruction, and not an automatic migration of existing DAOs. CCA remains the default fundraising path.

“After launch” here means after the platform's initial social/contributor release. Adding a market after a particular
project's CCA sale is a different operation, covered in section 11.

## 2. Fit with the product and existing decisions

Read first: [the product vision](../../VISION.md), [the community-owned org](../../VISION_ORG.md),
[the raise pilot](PILOT.md), [tokenomics changes](TOKENOMICS-CONTRACT-CHANGES.md),
[contributor trading](CONTRIBUTOR-TOKEN-TRADING.md), [LBAMM](LBAMM.md), and [audit scope](AUDIT-SCOPE.md).

The current pilot deliberately offers one raise format. This proposal belongs after that format has real usage;
neither its contracts nor its UI should enter the MVP release merely because the planning document exists.

The following are product decisions to approve before contract implementation. The recommendations below are
defaults for reviewing this plan, not decisions already made by the user.

| Decision | Recommended starting position | What changes |
|---|---|---|
| Which projects can use it? | New, explicitly labelled fundraising DAOs only | No conversion of existing contributor or CCA projects |
| What buyers eventually receive | The same voting and treasury rights as the CCA fundraising Shares | A curve fundraising DAO is **not contributor-only governance**; purchasing control must be stated before payment |
| What exists during the curve | A non-transferable purchase position, recorded per wallet, with no votes or claim on the DAO treasury | Buy/sell is through this launch's curve; no receipt AMM, wrapping or lending integration in v1 |
| Failure protection | Sell at the available curve quote while open; proportional recovery of remaining reserve after failure | This is **not D74's full bid refund**. Earlier trading profits and fees can reduce recovery below what someone paid |
| Trading after settlement | One verified venue, under a new explicit transfer policy for this launch format | D77's first-raise transfer lock cannot silently be bypassed. Its exception needs a new specification and audit |
| LP ownership | An immutable liquidity locker with no founder/platform withdrawal key | Locking LP does not guarantee a price or make liquidity inexhaustible |
| Supply | Fixed allocations at birth; no new mint for a purchase or a pool top-up | New Shares after setup remain reviewed awards under the applicable issuance cap |
| Chain and currency | One supported chain, one plain quote currency, initially the existing USDC path | No arbitrary quote tokens or cross-chain launch in v1 |
| Source reuse | Evaluate TokenMaster first; otherwise write a narrow Solidity implementation from a reviewed specification | Pump reconstruction is a research reference; no unlicensed code import or inherited security claim |

If the intended product is **contributors retain all governance even when others fund it**, stop the Shares-sale
branch at this decision. Design a separate non-voting funding instrument and its exact economic rights first. Do not
call an undefined “support token” equivalent to Shares, automatically issue Loot, or claim that removing votes settles
the legal questions. Existing Loot minting is closed under the accepted issuance rules.

## 3. What we reuse, and what we do not

Reuse project discovery, social discussion, account and wallet recovery, contribution history, work budgets, milestone
evidence, reviewed awards and the existing transaction UI. Reuse their interfaces and tests where behavior is identical.

Keep CCA's deployment, bidding, failure refunds and graduation intact. A curve has its own settlement and failure
accounting; it must not be squeezed into `GraduationExecutor` by treating curve positions as auction bids.

Existing Shares/DAO clones cannot be upgraded in place. The current Shares lock has one transfer-exempt address and a
30-day unlock rule. A curve, its claim escrow and its market need an explicit policy; they are not interchangeable with
the current auction exemption. Publish new versioned implementations/factories where required. Do not weaken the old
implementation or let a wrapper create a route around a founder's milestone lock.

TokenMaster is a candidate, not a drop-in choice. Its token/pool coupling, buy/sell settings, creator controls and
emissions must be tested against fixed supply, purchase positions, treasury separation, claim settlement and the rights
above. A protocol that needs incompatible rights or unrestricted new issuance fails this comparison even if its UI
looks convenient. Keep its source-reuse and production-deployment permissions separate from LBAMM's.

## 4. Money, supply and curve rules

### Fixed supply buckets

Define and display three distinct allocations: public purchase claims, milestone-locked team Shares, and market
liquidity Shares. Any DAO reserve is a fourth bucket. All must sum to the initial supply.

Public purchases must retain at least the current 60% starting allocation and the team at most 35%, unless a separately
approved tokenomics decision changes those limits. LP inventory is not “sold to backers” and is not an award reserve.
Start with no DAO reserve and propose an initial LP inventory cap of 20% for review. The dedicated LP bucket and its accounting are new scope: never fund it by routing existing
award-only DAO Shares out of the treasury.

All Shares are created during setup, assigned to verifiable escrow/lock addresses. A purchase changes a position's
entitlement to the public inventory; it does not mint more Shares. Unclaimed purchase Shares remain reserved for their
owners indefinitely after success. Fees, pool inventory and founder allocation cannot consume them.

### Pricing specification to prove before building the launch kit

Use a bounded constant-product curve as the first candidate. Specify virtual token and quote reserves, real public
inventory, real quote reserve, fees, integer rounding, maximum trade sizes and exact completion behavior. Virtual
reserves price trades; they are not spendable money or real tokens.

For v1 expose two simple transactions: buy an exact number of position units with a maximum quote spend, and sell an
exact number with a minimum quote return. Both require a transaction deadline. Round buy costs upward and sell returns
downward, and prove that rounding and repeated tiny trades cannot create free profit. Do not include Pump's synthetic
migration, multi-hop orders or an oversized trade spanning both the curve and the market.

A buy that exceeds remaining inventory is refused with the current maximum; it is not silently partially filled.
The final valid buy freezes curve pricing and enters settlement readiness in the same transaction. No later buy or
sell can race settlement against a different reserve snapshot.

Completion is based on **all public position units being outstanding plus adequate real reserves for settlement**.
Market cap, turnover, the token's latest quote and direct donations do not count toward completion. A curve with large
gross volume but almost no net capital must not appear funded.

### Capital separation

Before settlement, no purchase principal goes to the founder or DAO. Keep separate ledgers for real curve reserve,
accrued fees, amounts owed to users, and the separately prepaid settlement bounty. Direct donations never change the
pricing reserves or fulfill the launch conditions.

At successful settlement, for net quote reserve `Q` after trade fees:

`Q = quote deposited into market liquidity + quote transferred to the DAO`.

Every additional fee or transfer cost must have a named, disclosed bucket; it cannot appear as an unexplained shortfall.
The launcher freezes a minimum DAO funding amount and the LP policy before opening. Deploy only configurations whose
terminal curve state can fund both. Check the conditions again on chain at settlement.

The pool's starting price must match the curve's terminal marginal price within a stated rounding/tick tolerance.
For a full-range constant-product pool, `LP quote / LP Shares = terminal price`. A concentrated-liquidity venue needs
its own exact deposit/range equations; do not substitute that simple ratio for a real venue quote.

An illustrative allocation, **not a proposed preset or a validated configuration**: 650,000 public Shares, 250,000
team Shares, 100,000 LP Shares. If the curve ends with $100,000 net quote and a $0.40 terminal price, a full-range pool
needs $40,000 beside the 100,000 LP Shares, leaving $60,000 for the DAO. The curve parameter solver must establish
whether those terminal numbers can actually occur, including fees and rounding, before this becomes a selectable preset.

The $0.40 quote is not a redemption floor. Under the current treasury-exit denominator, before any team unlock and
with no other balances/spending, $60,000 divided by 750,000 eligible Shares is $0.08 per Share. Display the actual exit
calculation from the new contracts, including LP and unclaimed Shares; do not present the chart price as treasury value.
That difference is a reason to evaluate demand for this format before implementing it.

### Failure recovery

Set a fixed closing time. If the public tranche has not completed, close the curve and offer each outstanding position
its proportional part of the remaining real reserve. This burns that position and cannot also deliver Shares.
Earlier sellers keep executed proceeds. Fees already charged are disclosed separately. There is no promise to return
each remaining buyer's historical payment: simultaneous profit-taking and universal full-principal refunds cannot be
funded from the same finite pot.

Specify rounding so the final position claim receives the remaining distributable dust, with no profitable splitting
strategy. Claims are pull-based, never loop over all buyers, and do not expire into an admin's wallet. Support an
owner-selected payout recipient where possible and retain an entitlement when a currency transfer fails.

If migration cannot complete by a fixed, preannounced settlement timeout, anyone can trigger the same proportional
unwind from the untouched reserve. Never pay the DAO first and hope the market can be created later.

Specify the abandoned public/LP inventory too: the starting proposal is to return it to the DAO under award-only
issuance rules, excluded from member voting/exit totals while DAO-held, with no claim conversion left open. That
inventory must not become a founder windfall or a second sale. Its cleanup cannot delay buyers' quote recovery.

## 5. State machine and who pays to advance it

| State | Allowed action and caller | Next state / reason to call |
|---|---|---|
| Draft | Founder edits offchain terms | Schedule after onchain validation and inventory funding |
| Scheduled | Any participant observes the opening time; a trade checks it on chain | Open behavior once due; no timer or operator job required |
| Open | Buyer buys or position owner sells at a bounded quote | Stays Open, or the last valid buy commits the Ready snapshot |
| Open after deadline, incomplete | Anyone calls close; buys and sells already refuse by time | Unwind; position holders can recover the remaining reserve |
| Ready | Anyone calls settle with the frozen, verified target and inventory | Settled only if pool, locker and treasury handoff all succeed atomically |
| Ready after settlement timeout | Anyone calls expireSettlement if settlement has not committed | Unwind; no permanent operator-dependent freeze |
| Settled | Anyone may submit a claim for an owner, with Shares going only to that owner; market users trade | Claims cannot consume the position twice; market is a separate system |
| Unwind | Owner claims remaining quote to an allowed recipient | Position burned/credited once; no subsequent Shares claim |

Freeze the priority of deadline/last-buy/settle/timeout transitions. At the exact settlement timeout, use disjoint
predicates (for example, settle strictly before, unwind at or after) so ordering cannot choose incompatible outcomes.
Use one chain-native clock for opening, closing, settlement expiry and governance activation. Block heights fit the
current policy's start-block interface; dates shown in the UI are estimates, not a second authority. Trade-signature
deadlines may use timestamps, but are a separate validity check, never a conversion between the launch clocks.
Specify `settleBy = readyBlock + settlementWindow`, with a bounded window fixed at launch, so an early completed
curve cannot strand holders until a distant sale deadline if migration breaks. If reusing the existing policy, set
`governanceStartBlock >= closingBlock + settlementWindow + claimWindow` at birth. Early settlement does not shorten
that published governance schedule; later claims do not expire when the minimum claim window ends.

The creator prepays a capped settlement/closure bounty, held separately from buyer principal. Pay it once for the
successful terminal transition, as a pull credit so a hostile reward recipient cannot block settlement. Gas estimates
must show it covers stressed settlement costs; if it does not, claims remain directly callable and the timeout still
permits unwind. A keeper can help, but its key is never the only allowed caller.

## 6. Contracts and authority

Names below are proposed components, not existing contracts or final file/API decisions.

| Component | Responsibility | Authority limit |
|---|---|---|
| `CurveLaunchKit` / versioned DAO factory | Atomically create and fund the DAO, locks, position escrow and fixed market allocation; read back all bindings | Keeps no founder/platform power after creation |
| `CurveSale` | Quote, buy, sell, hold positions, freeze completion, and unwind accounting | Cannot lend reserves, transfer principal early, change fees/terms, mint Shares or call arbitrary targets |
| Settlement escrow / adapter | Claim inventory, atomic pool creation/funding and DAO funding; may be merged with sale if clearer | One target/asset pair fixed at launch; no arbitrary router calldata or delegatecall |
| Liquidity locker | Own the initial LP position and its fee entitlements | No founder withdrawal; no transferable wrapper or approval that defeats the lock |
| Versioned Shares transfer policy | Permit the disclosed settlement/venue paths while retaining team locks | No blanket exemption from milestone checks; existing projects keep old rules |

Exclude the sale/claim escrow, market custodian and liquidity locker from governance using the policy's existing
exclusion seam where it is sufficient. Do not conflate voting exclusion with economic exclusion: account for their
Shares correctly in proportional treasury exit. Claimed buyers must have the same promised economic entitlement as
unclaimed buyers, and an early treasury exit must not take late claimants' allocated share.

Keep governance closed during trading and settlement. The current policy's start block is set once, so use a fixed
claim/governance schedule consistent with the launch deadline, settlement timeout and public claim window, or specify
and audit a new gating policy. An early-completing curve is not permission to open a treasury-drain vote before other
buyers can claim and exit. Read back the gate, locks, supply and exclusion list at launch and settlement.

Use immutable versioned instances for v1. A deployment registry can stop offering new instances of a version; it
cannot replace the code/market/fee recipients of an existing launch. No platform emergency withdrawal or global pause
of sells, claims and unwind. Any proposed incident power needs a separate authority/exit review before inclusion.

Set curve fees and their recipients once at creation, bounded by the factory; start the proof with zero fees before
modelling a paid configuration. Specify how the locker collects LP fees and credits the DAO treasury without a
founder-only withdrawal path. Identify any upstream power to change market fees or implementations; a pinned proxy
address alone does not pin its behavior.

Begin with one plain quote token and exact balance-delta checks; reject fee-on-transfer and rebasing behavior.
Account for issuer freezes as an external dependency, not a condition our contract can bypass. Use bounded approvals,
checked transfers, reentrancy protection, bounded loops and integer-safe math. No spot-price oracle governs milestone
unlocks, Share awards, moderation standing or the supply cap.

## 7. What people see

| Screen | Required behavior and plain copy |
|---|---|
| Start | CCA remains the default; Curve launch appears only when separately enabled. Explain “The quote changes as people buy and sell. Some money funds trading; the rest funds the project.” |
| Before launch | Founder previews public/team/LP allocations, net DAO funding, fees, closing time, failure rules, venue, who controls funds and what buyers can vote on. Freeze a hash of these terms before accepting money. |
| Discover / project header | Label **Curve launch**, **Auction**, or **Contributor project** explicitly. Keep the project's purpose and open work visible; no volume-based “best projects” default. |
| Open curve | Show net money held for settlement, progress in public units bought, money earmarked for liquidity, and money the DAO would receive. Show that none of the reserve is spendable by the team yet. |
| Buy | Show exact position quantity, maximum total spend, fee, quote expiry, network and recipient. “This is a purchase position. You receive Shares only if the launch completes.” State that those Shares vote in this fundraising mode. |
| Sell before completion | Show expected quote return, minimum accepted return and fee. “Selling can return less than you paid.” A sell is not labelled Refund. |
| Ready | “The sale is complete. Finish setup to open claims and trading.” Show the real transaction, reward and timeout; permissionless Finish setup button. |
| Failed / timed out | “The launch did not complete. Collect your part of the money left.” Show reserve, total outstanding positions, this wallet's position and computed payout. Never say Full refund. |
| Settled | Separate **Project funds**, **Market liquidity**, **My unclaimed Shares**, **Trading**, and **Leave the DAO**. The last two have different counterparties, prices and consequences. |
| Records | Keep immutable terms, contracts, transaction links, supply, team locks, paid fees, LP custody and changes visible. No simulated return or price-floor promise. |

Keep token amounts, networks, minimum output, fees and signing consequences near the action. Technical addresses and
calldata can live under Details, with copy/explorer access. Recovery, sign-out and account import remain reachable on
phones and with keyboard navigation. A read failure says Unknown and offers retry; it never becomes a zero balance,
completed launch, disabled right or a stale quote that can be signed.

Reuse signed Nostr project/discussion events for social metadata; onchain reads establish money and launch state.
Document the record version/mechanism and any new event kinds in the central registry before writing handlers. Older
clients must not interpret a curve record as a completed CCA sale or a contributor project. Assess a new addressable
kind or explicitly versioned descriptor before merely extending `FundingPath` and publishing it to legacy readers.
Do not invent an endpoint per curve action: money actions go to contracts; community metadata uses the event pipeline.

## 8. Work packages and implementation order

| Package | Concrete deliverable | Exit criterion |
|---|---|---|
| P0 — Demand and product decision | Observe the first social/contributor pilot and CCA raise; write the reason users need a curve; resolve section 2 | User approves the new refund/trading/voting promises and the scope; otherwise CCA continues |
| P1 — Feasibility | Compare TokenMaster against a clean Solidity curve; inventory code/reuse rights and live deployments; parameter solver, cashflow model, threat model and state specification | A full worked launch and adversarial failure example balance; target venue is viable; architecture and audit delta reviewed |
| P2 — Contract proof | Local-only sale/positions, settlement, unwind and new Shares policy; regression, fuzz, invariant and mutation coverage | All money/supply/authority invariants hold through hostile ordering and failures, with meaningful failing-before evidence |
| P3 — Shared clients and operator tools | Typed encoders/readers, exact quotes, versioned records, CLI and deployment manifest | ABI goldens match compiled contracts; CLI completes a local launch, failed launch and settlement-timeout recovery |
| P4 — Web and indexing | Founder wizard, buy/sell/claim/unwind, separate funds/market/exit UI, bounded event history and candles | Real chain/server journeys plus visual review of every role/state at phone and desktop widths |
| P5 — Testnet pilot | One network/currency/venue, fixed small exposure, multiple real wallets/devices and support owner | Users complete success, failure, recovery and later return without a walkthrough; balances and receipts reconcile |
| P6 — Independent review and release | Frozen source/dependency versions, economic and contract review, instrument-specific legal read, verified deployments and runbooks | Findings resolved, human acceptance recorded, production venue permitted and available; then opt-in capped rollout |

Planning/design and an isolated feasibility branch may follow the MVP launch. A public curve sale should follow the
validated CCA raise and the independent review of this new mode. Do not add the new contracts to an audit already in
progress without an explicit scope/cost decision. There is no credible mainnet date before P1 and audit scheduling.

Likely integration points to assess, not instructions to edit all of them immediately:

- `contracts/src/`: new versioned launch/sale/settlement/policy code. Preserve the deployed CCA/contributor versions.
- `packages/creaton-core/src/launchpad/`: proposed `curvePlan`, `curveMath`, `curveRead` and `curveFlow` modules;
  reuse ABI, bounded RPC history, transaction recovery and currency helpers.
- `web/src/features/launchpad/`: mechanism-aware models, chain configuration, hooks and project details;
  `web/src/features/start/`: launch-method selection; `web/src/features/discover/`: accurate status/cards.
- `crates/buzz-cli/src/commands/`: proposed `buzz launchpad curve` quote/create/buy/sell/settle/claim/unwind commands,
  with machine-readable outcomes and no assumption that the hosted UI is available.
- `services/price-indexer/`: separate curve trades from AMM trades; index from pinned deployment blocks with bounds,
  reorg replay and duplicate handling. Quotes and exits must work from RPC without the candle service.
- `scripts/`: isolated local world and browser journey, followed by testnet deployment tooling only after its gates.
- `docs/v3-review/`: accepted decisions, revised tokenomics, new audit scope and exact manual acceptance runbook once
  the proposal is approved. Do not pre-mark these gates done.

## 9. Validation that decides whether it can ship

Use [TESTING.md](../../TESTING.md): tests bind production seams and must fail when the guard is removed. Unit math,
economic simulations, screenshots and human comprehension answer different questions; retain all four.

Required invariants and hostile cases:

1. Reserve assets cover accounted reserve, fees and outstanding credits. Quote donations cannot improve progress,
   alter price, steal a claimant's share or justify a treasury payout.
2. Positions cannot exceed public inventory. Claiming Shares and recovering quote are mutually exclusive and
   idempotent. LP inventory and founder allocation cannot be claimed by purchasers.
3. A buy/sell round trip with no outside trade cannot profit from integer rounding; splitting orders cannot create
   money. Compare an independently written high-precision model against contract execution, including 6/18 decimals.
4. The last buy, last sell, deadline close, settle and timeout races select one valid state. Test the exact boundary,
   different ordering in one block, reentrancy and a stale browser quote. Bound slippage; do not claim MEV is eliminated.
5. Failed/absent venue, pre-created hostile pool, wrong price, short LP deposit or treasury-transfer failure commits
   no partial handoff. A missing keeper can never strand the launch beyond its unwind timeout.
6. Fee/reward recipients cannot block settlement; blocked user payouts retain an entitlement. Duplicate requests,
   reload, replaced/reverted transactions, RPC outages and reorgs cannot report success before it exists.
7. No operator can drain or repoint a live reserve. Founder/team Shares remain milestone locked through every
   settlement/market path. Pool and escrow cannot vote; eligibility changes do not erase an economic claim.
8. Governance cannot act before the promised claim/review/exit window. Test late claims, early exits, purchases around
   the snapshot, LP custody and founder unlocks against the exact exit denominator.
9. Run economic cases: no demand; one buyer; many buyers; concentrated buyers; repeated wash trades; high early
   profit-taking then failure; late buyers; every remaining position exiting; success followed by DAO exits; and a
   sharply falling post-settlement market. Include dollar cashflows per participant, not just total volume.
10. Preserve ordinary CCA refunds, contributor awards, existing transfer notice, milestone objections, evidence reads
    and treasury exit. A social ban or unavailable relay must not remove contract claim/unwind/exit access.

Run real local chain/server journeys as founder, early buyer, late buyer, seller, non-technical contributor, keeper
and a holder with lost community access. Include a real hardware passkey/device recovery check and next-day return.
Photograph Scheduled/Open/Ready/Settled/Unwind/loading/error on desktop and phone, light and dark; manually read the
copy, inspect keyboard/focus/screen-reader behavior and compare the displayed calculations to actual transactions.

The mainnet release requires a fresh review of our **composition**, not just a citation to a CCA, TokenMaster or DEX
audit. Verify code/implementation identities and authority on the chosen chain, source/ABIs and build reproducibility,
contract sizes, deployment transaction gas and the final web configuration.

## 10. Trust, reuse rights and operation (CROPS)

| Area | Chosen default and accepted limitation | Required escape/recovery |
|---|---|---|
| Censorship resistance | Trade/close/settle/claim/unwind use direct contract calls; hosted discovery can still refuse a listing. A quote issuer or chain can still censor/freeze assets. | Document CLI/direct RPC calls and alternate RPC/frontend; no relay approval needed to exercise an existing financial right. |
| Open source | Publish first-party contracts, UI, ABI, event schema, build instructions, deployment blocks and bytecode identities. | A usable alternative reader/client can be built without our indexer. |
| Reuse freedom | Record SPDX and provenance per dependency. Pump reconstruction is not permission to copy Pump materials; LBAMM's public review source is not a production deployment permission. | Use a permitted live deployment or an independently licensed implementation. If unavailable, keep Curve launch disabled. |
| Privacy | Wallet positions, trades, voting rights and settlement are public. Linking a payment wallet can link social activity; RPC/host metadata remain visible to providers. | No forced profile-wallet linking to trade or claim; disclose visibility before signing and keep provider choices replaceable. |
| Security | Immutable terms and instances; fixed venue/fees, no principal lending, no drain key, independent review. LP locking and issuer risk are deliberate limitations. | Unwind on missed completion/migration timeout; claim/exit independent of social membership; no forced upgrade. |

Founder project approval remains server-enforced for Creaton's own discovery and hosted launch flow. If contract-level
creation authorization is desired, specify it separately; hiding a UI does not make a public factory permissioned.
No creation gate may become authority to veto a buyer's sell, claim or unwind after funds are accepted.

Publish a runbook for settlement failures, indexer lag, currency freezes, compromised discovery metadata and newly
discovered contract defects. Stopping creation of new launches is a different action from freezing holders' exits.

## 11. Projects that already completed CCA

Do not rerun initial distribution, mint extra public Shares, move a milestone lock, or replace a holder's rights.
Adding a secondary market starts with the existing governance notice and transfer rules. Liquidity needs existing
holders' voluntary Shares and an explicitly approved quote allocation, or a separately designed donation mechanism.
The old DAO reserve is award-only and is not a free pool-seeding balance.

That market is secondary trading. Sale proceeds belong to whoever sells; the DAO receives only the fees or donations
actually specified. It is not automatically another project raise. A curve funded from existing holder inventory
would be another secondary venue and still needs a reserve-owner/withdrawal design, rather than the new-launch path
above.

Keep the initial implementation to one route: new curve launches after approval. Existing-project markets stay a
separate later work package under [CONTRIBUTOR-TOKEN-TRADING.md](CONTRIBUTOR-TOKEN-TRADING.md). Existing immutable
projects with incompatible rules continue on their existing contracts; never advertise an in-place upgrade.

## 12. Handoff and first task

The next agent should start with **P1 feasibility only**, after the product choices in section 2 are reviewed. Produce:

1. A comparison of TokenMaster reuse versus a narrow independent implementation, with exact commit/license/deployment
   references and an explanation of each mismatch with current Shares/DAO rights.
2. A terminal-price/reserve/supply solver and an independent cashflow model, including the illustrative example,
   failed-raise recovery and early/late buyers. Reject impossible funding/liquidity combinations explicitly.
3. A state and authority specification, including all callers, timeout boundaries, keeper compensation, governance
   activation, LP custody and the revised transfer policy.
4. The proposed implementation boundary and audit delta, a versioned record compatibility design, and concrete screen
   sketches/copy for buy, sell, failure recovery and the separate DAO exit.

Do not start by translating the research repository, exposing an extra launch button, adding mainnet addresses,
changing accepted decisions to “built,” or deploying anything. The output is a reviewable feasibility package; user
approval of its new promises and a separate implementation request precede production-code work.

### Primary references checked on 2026-10-25

These main-branch pages can change. Pin exact versions and verify deployed implementations during P1/P6.

- [Pump reconstruction status](https://github.com/lalalune/pumpfun-source#readme): explicitly partial reconstruction
  and unfinished security assessment; research input only.
- [Pump's official program documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md):
  virtual/real reserves, curve completion and migration mechanics.
- [Pump's synthetic migration extension](https://github.com/pump-fun/pump-public-docs/blob/main/docs/SYNTHETIC_MIGRATION.md):
  an example of extra crossing-trade complexity deliberately omitted from this first version.
- [Uniswap CCA](https://github.com/Uniswap/continuous-clearing-auction#readme): standalone auctions remain an available
  existing path; the curve does not inherit their settlement or audit scope.
- [TokenMaster](https://github.com/limitbreakinc/tm-tokenmaster#standard-pool): buy/sell/spend and emissions/settings
  differ from a fixed-inventory Shares sale; integration feasibility must be established.
- [LBAMM public review release](https://github.com/limitbreakinc/lbamm-core#readme): the inspected release states
  evaluation-only restrictions. Do not infer production permission or deployment availability from a local example.
