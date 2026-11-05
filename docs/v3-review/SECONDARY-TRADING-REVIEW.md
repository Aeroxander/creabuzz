# Secondary trading — independent review packet

This is the packet for an outside security and legal review of Creaton's
secondary market for a project's Shares. It is written to be read by someone who
did not build it: what the code does, what it deliberately refuses to do, what
the tests actually pin, and what is still open. Every claim below names the file
it comes from, so it can be checked rather than trusted.

**Revision of 2026-11-05** (branch `v4-governance-rework`, after the second round of internal
agent review and fixes). Counts and line numbers below were re-measured on that day. The defects
found and fixed since the first revision of this packet are in section 11, "Second round". The same
day the ten low-severity batches (B15 to B24) were run; section 11, "Low-severity run", lists them, and counts and line
numbers were re-measured again after them. Nothing in this packet is an outside audit. A brief for counsel on the same feature is
[LAWYER-BRIEF-WEEKLY-SALES.md](LAWYER-BRIEF-WEEKLY-SALES.md).

**Status: trading starts disabled and nothing has been activated on any public
network.** This repository has never deployed to mainnet, and the only
deployments in evidence are local scratch chains started by the scripts named
below. The review is a gate on turning trading on, not a description of
something already live.

---

## 1. Scope

**In scope**

| Surface | File |
|---|---|
| The market itself (rounds, orders, clearing, claims) | `contracts/src/SecondaryMarket.sol` (665 lines) |
| Market creation, provenance and pinning | `contracts/src/SecondaryMarketFactory.sol` (201 lines) |
| Voting maturity, founder sale schedule, escrow accounting | `contracts/src/ActivationVoting.sol` (835 lines) |
| Shares transfer policy and the lock guard | `contracts/src/ContributorKitV2.sol` (365 lines), and the Shares token inside `contracts/src/majeur/MolochPatched.sol` (3,090 lines; only the patched regions matter here) |
| Payout accounting that must not count escrowed Shares (changed in this revision) | `contracts/src/Payouts.sol` (270 lines) |
| Web card and reader that tell people what they can do | `web/src/features/launchpad/ui/TradingCard.tsx` (656), `TradingOrderForms.tsx` (376), `TradingEarlier.tsx` (253), `TradingListingForm.tsx` (215); `lib/trading-copy.ts` (1070), `lib/secondary-read.ts` (426), `lib/trading-orders.ts` (112); `packages/creaton-core/src/launchpad/secondary.ts` (796) |
| Operator scripts | `scripts/secondary-keeper.sh` (247), `scripts/web-trading-e2e.sh` (182), `scripts/v5-local-fixture.sh` (415) |

**Out of scope for this review**

- The primary raise (`continuous-clearing-auction` fork) and the launch kit.
- Agreed rewards, work budgets, milestones and challenges — those have their own
  evidence in `docs/v3-review/V5-IMPLEMENTATION.md`.
- The desktop and mobile clients.

---

## 2. What the market is

A `SecondaryMarket` is one contract per DAO, deployed by
`SecondaryMarketFactory`. It runs **rounds**: a round opens from a listing the
DAO itself configured, sellers offer lots at a minimum price, buyers bid at a
maximum, and after the round closes anyone may settle it at a single clearing
price. Shares and money are escrowed at order time and claimed after settlement.

The DAO is the only administrator, and its power is deliberately narrow.

### Admin powers (the complete list)

| Power | Function | Guard | What it can and cannot do |
|---|---|---|---|
| Decide whether a listing exists, and its price bounds | `configureListing(bool enabled, uint128 minPrice, uint128 maxPrice, uint32 levels)` | `msg.sender != dao → NotDao` (`SecondaryMarket.sol:228`) | Cannot touch a round already open. Disabling sets `listing = Terms(false,0,0,0)` and **stops new activity only — settlement and claims still run** (`test_disabling_stops_new_activity_never_settlement`) |
| Open the next round | `openRound()` | anyone, at least `EVERY` after the last open | Uses the frozen listing terms; cannot choose terms |
| Create the market for a DAO | `create(...)` on the factory | only the kit that created the factory (`NotAuthorizedKit`), one per DAO (`AlreadyListed`), and only after proving the DAO, its Shares and its policy against pinned bytecode and predicted addresses, and checking that the quote token has code (`_prove`, `SecondaryMarketFactory.sol:152`) | Cannot create a market for a counterfeit DAO, Shares or policy (`test_a_counterfeit_dao_is_refused_at_the_bytecode_pin`, `test_a_counterfeit_token_and_policy_are_refused`, and since the second round one single-fault test per guard: `test_guard_the_dao_must_name_the_token_it_is_listed_with` and its siblings in `SecondaryMarketProvenance`, plus `SecondaryMarketDaoPin`, whose counterfeit DAO has code). **The quote token is not pinned**: `_prove` only checks that code exists at its address (`SecondaryMarketFactory.sol:158`, `UnprovenQuote` otherwise), so any contract can be named as the quote. Which quote tokens a project may use is a needs-human policy decision, still open; until it is made, treat the quote token as unvetted input. |

There is **no** admin function to move user funds, cancel someone's order, change
a round's terms after it opens, or mint Shares. Settlement (`settle`) and claims
(`claimShares`, `claimQuote`) are permissionless and ungated, which is what makes
a stalled round recoverable by anyone.

**Correction, from the review below.** An earlier version of this section said
the DAO could not pause claims. That was wrong: the DAO can set a Shares
transfer validator at any time, and the validator saw the market's own transfers,
so a refusing validator froze `cancelSell`, the unsold-lot return in `settle`,
and a void round's `claimShares`. It is fixed — the market is the Shares' named
exempt address and is now exempt from the validator as well as from the transfer
lock — and pinned by
`test_a_dao_validator_cannot_freeze_the_markets_escrow`. See §10.

### The one thing the market is trusted with

The market starts empty. The kit mints the founder's grant to the founder,
not to the market (`ContributorKitV2.sol:226`: `holders[0] = msg.sender`),
and minting Shares straight to the market reverts `MintToMarket`
(`ActivationVoting.sol:460`). There is no DAO-owned sale inventory: the DAO
cannot offer Shares (`DaoCannotSell`, `SecondaryMarket.sol:276`) and Shares
held by the DAO leave it only as reviewed awards (`awardsOnly`,
`MolochPatched.sol:~1985`), so no path moves DAO-held Shares into the market.
Holders put their own Shares in, one order at a time.

At any moment the market therefore holds only **per-order escrow** (Shares from
open sell orders and unclaimed fills, quote from open bids and unclaimed
proceeds) plus any **unattributed donations**, which are nobody's credit and are
never paid out. Its balance is excluded from voting supply
(`ActivationVoting.configureSecondary` sets `_setExcluded(marketAddr, true)`, and
the balance is deducted from the supply exactly once). It is also the Shares'
`transferExempt` address, so escrow can move in and out without the transfer
policy refusing it. The trust placed in the market is that escrow, not
inventory, sits behind these facts:

- `test_a_rogue_market_never_receives_locked_shares_or_takes_the_exemption`
- `test_the_dao_and_the_market_cannot_sell_inventory` — the DAO cannot sell
  through the market at all
- `test_mint_straight_to_the_market_is_impossible`

---

## 3. The founder's sale schedule and transfer restrictions

The founder does not get a special market. The founder gets a **sale schedule
on their own allocation** (sale eligibility, not vesting: the Shares are the
founder's from the first block and exits are never locked), enforced where the
Shares are, and the market is one of the places it is enforced.

`ActivationVoting.configureSecondary(market, founder, initialGrant, start,
cliff, duration)` is called **once, in the creation block** (`NotInCreationBlock`
otherwise) and freezes:

- `initialGrant` — the founder's allocation, which stays with the founder (it
  is minted to the founder, not to the market) and is released for sale on the
  schedule;
- `start`, `cliff`, `duration` — the absolute schedule the grant unlocks on;
- `founder` — the only address the schedule constrains.

Reads a reviewer can use: `saleCapacity(holder)`, `lockedAt(t)`,
`escrowedBalance(holder)`, `secondaryConfiguration()`.

What the tests pin:

- `test_saleCapacity_is_balance_minus_still_locked_grant` — the founder can sell
  only what the schedule has released.
- `test_non_founders_have_no_sale_restriction` — nobody else is constrained.
- `test_the_grant_unlocks_on_the_absolute_schedule_and_caps_do_not_shift_with_sales`
  — the clock is absolute; selling does not move it.
- `test_sold_units_released_by_the_schedule_are_never_subtracted_twice`.
- `test_a_founder_burn_releases_exactly_the_locked_units_it_ate`.
- `test_future_awards_to_the_founder_are_never_re_locked` — an award earned later
  is not retro-locked.
- `test_mayExit_is_never_locked` — **exits are always allowed**, whatever the
  sale restriction says. This is a deliberate product rule: the restriction is
  on transfer and sale only.

Separately, the Shares carry a **lock guard** (`lockGuard()`, `lockGuardSet()`,
`transfersLocked()`, `salePolicy()`, `saleEligibleOf(who)`). At birth
`transfersLocked()` is true and `transferExempt()` is the market, so Shares move
only through the market and the guard until the DAO says otherwise.

---

## 4. Activation controls: trading is off by default

These are the reads that prove it, and they are asserted on a real local
deployment by `scripts/v5-local-fixture.sh` (8/8 transactions, every value read
back from node state, not from the script's memory):

| Read | Value at birth | Meaning |
|---|---|---|
| `market.listing()` | `(false, 0, 0, 0)` | no listing exists, so `openRound` reverts `ListingNotEnabled` |
| `shares.transfersLocked()` | `true` | Shares cannot move freely |
| `shares.transferExempt()` | the market | the market is the only free path |
| `shares.saleEligibleOf(founder)` | `(0, 1)` | the founder has nothing sellable yet (true of the founder only) |
| `policy.saleCapacity(founder)` | `0` | the schedule has released nothing to the founder |
| `marketFactory.marketOf(dao)` | the market | one market per DAO |

Turning trading on is therefore **one deliberate act**, the DAO's listing vote
(`configureListing`, which nobody but the DAO can reach). It does not happen by
default. The founder's schedule is not a second act: it is the clock, and it
limits only the founder's own sales.

One qualification, because it matters once the project is no longer brand new:
the schedule constrains the founder and only the founder
(`ActivationVoting.saleCapacity` returns the plain balance for every other
holder; `test_non_founders_have_no_sale_restriction`). Any other holder — a
contributor who was awarded Shares, for example — may offer their own Shares as
soon as a listing exists, whatever the founder's schedule says. So a listing
alone sells nothing on a project whose only holder is the founder, and the
"nothing sellable yet" rows above are the birth state of the founder only; on a
project with other holders, a listing alone can produce trades.

---

## 5. What the contract tests actually pin

Counts on 2026-11-05, after the low-severity batches. The secondary, voting, kit, founder-schedule, holding-age,
exit-exchange, weekly-rounds, payouts-market and transfer-lock suites, run by the writer of this
revision with `forge test --offline` from `contracts/` and the path filter given in section 8:
**26 suites, 278 tests passed, 0 failed, 0 skipped** (the previous revision of this packet said 270; the difference is
not attributed test by test). The whole contract suite with the two fork test files
excluded, as reported by the final gate run (not re-run for this revision):
**80 suites, 882 tests passed, 0 failed.** The earlier figures of 734 tests in 69 suites and of 874 in 80 are stale.
Tests executed per suite in the writer's run (the adversary, review and resolution suites each run twice, once against
a simplified policy and once against the real policy launched through the real kit):
`SecondaryMarketAdversary` 22 + `...AdversaryReal` 22, `SecondaryMarketProvenance` 30,
`SecondaryMarketDaoPin` 4, `SecondaryMarketFlows` 8, `...FlowsClearing` 4, `...FlowsResolution` 12 +
`...ResolutionReal` 12, `SecondaryMarketReview` 4 + `...ReviewReal` 4, `SecondaryMarketGuardPins` 4,
`SecondaryMarketRealPolicy` 7, `SecondaryMarketRealGas` 2, `SecondaryMarketInvariant` 6,
`SecondaryListingVote` 3, `ActivationVoting` 42, `ActivationVotingFuzz` 1 + `ActivationVotingRealMarketFuzz` 3,
`ContributorKitV2` 17, `ContributorKitV2Guards` 23, `FounderSaleEligibility` 5, `HoldingAge` 13,
`ExitExchange` 3, `PayoutsMarket` 3, `WeeklyRounds` 16 (the frozen contract), `TransferLock` 8 (these add to 278).
Mutation checks: `scripts/contracts-mutation-check.mjs` has 261 entries (all well formed under `--check`; the entry
added for the market's lot-size bound was not run live because the script refuses a dirty working tree), and its
own node test passes 62 of 62. The ones a reviewer should read first, by theme:

**Escrow and conservation**

- `invariant_each_rounds_ledgers_equal_what_its_orders_are_owed`
- `invariant_market_balances_equal_ledgers_and_supply_is_conserved`
- `invariant_measured_flows_close_each_round`
- `invariant_settled_rounds_clear_and_fill_by_the_reference_rule`
- `invariant_canary_the_handler_really_trades`

*Strength of the invariant rows.* These run only through
`SecondaryMarketHandler`, which places, cancels, settles, voids and claims
through the market's production entrypoints under `fail-on-revert`, and they
compare the market against an independent reading of the orders and against
token balance deltas, not against the market's own counters. The canary fails
the suite if the handler never gets an order accepted. An earlier version of
this suite called the market directly as a random sender, every order reverted,
and its properties compared 0 with 0; the names above are the rewritten suite,
and `test_handler_drives_a_real_pro_rata_round_and_a_void_round` pins that the
handler really reaches a pro-rata round and a void round.
- `test_sell_escrows_exactly_lots_times_lot_size`
- `test_bid_escrows_exactly_lots_times_the_limit_price`
- `test_seller_cancel_returns_the_whole_escrow_in_the_same_transaction`
- `test_buyer_cancel_claims_the_whole_refund_whenever_the_quote_makes_it`
- `test_cancelled_orders_never_count_until_settled`
- `test_void_round_claims_everything_back_without_a_settle`

**Clearing**

- `testFuzz_settle_is_exact_at_every_grid_level`
- `test_clearing_fills_whole_crossers_and_shares_the_oversubscribed_side_exactly`
- `test_leftover_lots_go_deterministically_to_the_lowest_order_id`
- `test_buyers_share_the_price_when_demand_exceeds_supply`
- `test_the_lowest_tie_wins_and_whatever_crosses_at_it_fills_whole`
- `test_only_the_dao_decides_and_the_grid_must_divide_exactly`
- `test_rounds_freeze_terms_and_weekly_cadence`
- `test_settle_runs_only_inside_its_window`

**Hostile counterparties**

- `test_no_d179_primary_funding_open_or_claimandleave_entrypoint_exists` — calls each D179 entrypoint by its real
  selector and requires an empty revert (the selector is absent, not merely guarded); the earlier test of the same
  idea used selectors that were not `WeeklyRounds` functions and passed against a market with an added `open`.
- `test_the_market_abi_matches_the_reviewed_allowlist` — the market's whole external surface (38 entries) is compared
  with a checked-in list read from the compiled artifact, so any new function fails until a reviewer adds it.
- `test_a_full_round_mints_no_shares`
- `test_reentry_into_sell_is_refused`, `..._bid_...`, `..._cancelSell_...`,
  `..._cancelBid_...`, `..._settle_...`, `..._claimShares_...` and
  `..._claimQuote_...` — one test per guarded entrypoint. A hostile quote
  re-enters from inside a real `claimQuote` payout with well-formed calldata,
  in a state where the nested call would otherwise succeed. Deleting
  `nonReentrant` from an entrypoint fails its own case (the earlier single test
  re-entered with one malformed word and passed with the guard removed).
- `test_a_blocked_quote_strands_no_payout`
- `test_a_quote_that_delivers_less_than_asked_is_refused` and `test_shares_that_do_not_arrive_in_full_are_refused`
  (fee-on-transfer fails closed at intake)
- `test_unattributed_deposits_become_no_ones_credit_and_are_never_paid`
- `test_forced_eth_dust_stays_irrelevant`
- `test_claims_survive_a_live_exit_exchange_cleared_mid_round`,
  `test_claims_survive_an_installed_exit_exchange_that_reverts`,
  `test_claims_survive_an_exit_exchange_replaced_after_the_notice` and
  `test_void_round_claims_survive_a_replaced_exit_exchange`. The first installs a live exchange and then clears the
  exchange slot in the middle of a round. The other three
  announce a real exchange that reverts on every call, wait the 30-day notice, activate it, and in the replaced
  cases announce and activate a second one, then run cancel, settle and every claim. (The earlier single test of
  this name only cleared a slot that was already empty and never named an exchange.) They run on the simplified
  policy and, because the file is shared, on the real policy.
- `test_a_rogue_market_never_receives_locked_shares_or_takes_the_exemption`
- `test_two_markets_stay_isolated_and_never_pay_each_others_orders`
- `test_active_side_caps_bound_each_round`
- `test_the_zero_fee_leaves_every_unit_to_the_parties`

**Provenance**

- `test_create_registers_instead_of_a_second_market_for_the_same_dao`
- `test_only_the_kit_that_created_the_factory_may_create`
- `test_a_counterfeit_dao_is_refused_at_the_bytecode_pin`
- `test_a_counterfeit_token_and_policy_are_refused`
- `test_a_wrong_lot_size_is_refused`
- one test per factory guard, each of which fails when only that guard is removed:
  `test_guard_the_dao_must_name_the_token_it_is_listed_with`, `..._the_dao_must_name_the_policy_it_is_listed_with`,
  `..._the_token_must_be_the_predicted_shares_clone`, `..._the_token_must_belong_to_the_dao`,
  `..._the_policy_must_belong_to_the_dao`, `..._the_policy_must_name_the_predicted_market`,
  `..._the_policy_must_come_from_the_pinned_mandate_factory`,
  `test_a_counterfeit_dao_with_code_and_consistent_getters_is_refused`, `test_a_dao_of_another_summoner_is_refused`,
  and the constructor cases (`test_constructor_refuses_*`).
- `test_a_dao_whose_birth_exemption_points_wrong_cannot_list`

**Voting maturity and the denominator**

- `test_bootstrap_holders_are_fully_mature_from_birth`
- `test_the_delay_is_seven_to_eight_days_rounded_to_daily_epochs`
- `test_a_same_wallet_rebuy_starts_a_fresh_delay`
- `test_a_small_top_up_does_not_jump_a_holders_immature_window`
- `test_quorum_denominator_excludes_immature_supply`
- `test_the_frozen_snapshot_never_changes_when_the_clock_moves`
- `test_market_and_excluded_holdings_leave_the_denominator`
- `test_an_unregistered_snapshot_errors_instead_of_using_the_clock`
- `test_an_immature_holder_cannot_vote_at_all_yet`
- `test_a_replacement_immature_rebuy_cannot_recreate_departed_support`
- `test_leaving_removes_ownership_bound_support_before_execution`
- `test_configuration_is_one_way_and_frozen`
- `test_an_unprepared_market_transfer_refuses_to_strand_escrow`
- `test_replayed_context_is_never_reusable_and_others_cannot_touch_the_escrow`
- `test_mint_straight_to_the_market_is_impossible`

The market's own flow tests are split across `SecondaryMarketFlows.t.sol`,
`SecondaryMarketFlowsClearing.t.sol`, `SecondaryMarketFlowsResolution.t.sol`,
`SecondaryMarketAdversary.t.sol`, `SecondaryMarketProvenance.t.sol` and
`SecondaryMarketInvariant.t.sol`.

---

## 6. What the tests do **not** cover

Stated plainly, because a reviewer should not spend time discovering these:

1. **No independent audit of this code has happened.** The tests are the
   author's.
2. **No fuzzing of the voting-maturity arithmetic beyond `ActivationVotingFuzz.t.sol`'s
   scope** (which now includes `ActivationVotingRealMarketFuzz`, a strict walk through the
   real market), a fuzz over odd price floors and steps that checks the intake is paid out exactly but takes the
   clearing level and matched volume from the market's own clearing function (independent reference checks of those two
   are in the fixed-grid flow tests and the invariant suite, not in that fuzz), and no formal verification of the
   clearing algorithm.
3. **The market has never run against a real quote token with fee-on-transfer,
   rebasing or blacklist behaviour.** `test_a_blocked_quote_strands_no_payout`
   covers a blocking token. Fee-on-transfer is covered as a *refusal at intake*
   (`test_a_quote_that_delivers_less_than_asked_is_refused`); a token that skims a
   fee only on payout, a rebasing token, or a token that lies in `balanceOf` is not
   covered.
4. **Gas for a round with the maximum number of orders is measured on the real policy, and the heaviest settle is about 21% of the 2^24 per-transaction cap** (see F4). It was over the cap before settle stopped returning unsold Shares; `MAX_ACTIVE_SELLERS` stays 32. The per-seller collect that now carries the heavy part was measured at up to about 0.72M gas. The figures depend on a Foundry cheat code that cools storage and on two storage slot numbers the test reads, so they are test-VM measurements, not chain measurements, and whether a target chain enforces the cap is a property of that chain.
5. **No real-chain reorg testing.** Reorg behaviour is covered only by fake-node
   tests in the agreement finalizer, not for the market.
6. **Open gaps recorded here so nobody discovers them.** (a) Which quote tokens
   a market may use is undecided: the factory checks only that the quote has
   code (§2). (b) The exit-exchange independence tests now install and replace a real
   exchange that refuses transfers, on both the simplified and the real policy (§5).
   The kit-level tests in `ContributorKitV2.t.sol` and the adversary suite
   now also clear a live exchange mid-round and replace it after the notice, against the real kit. The frozen `WeeklyRounds` contract can still be named in that slot; see
   (e).
   (c) The Trading card reads the latest round and
   the last 8 earlier rounds, and "Check older rounds" reads the next block of 8
   ids on each click down to round 1 (each read is bounded); the `cast` commands
   in the runbook also work for any round, because claims never expire. (d) The clearing rule fills the short side's crossing orders whole
   and pro-rates **all** crossing orders on the long side, including orders
   strictly better than the price; whether to keep that or add price priority
   is a product decision, and no money is mis-paid either way (`LedgerShort`
   holds). (e) The old `WeeklyRounds` contract is frozen and unrepaired, but the V2
   contracts do not stop a DAO naming it as its exit exchange after the 30-day notice;
   today only the deploy scripts and build settings keep it away from a value-bearing
   network. Whether to seal that slot is an open owner decision, and no test yet pins
   either outcome. (f) The low-severity batches (B15 to B24) were run after the first
   version of this revision; see section 11. What they left: the V2 kit still accepts the
   older launch call (a sealed project with no market), a wording sentence about a fee
   was not added, and the follow-up fixes were not re-reviewed. (g) The Trading card
   no longer renders in the contributor-only hosted build or in a build that names no market factory
   (`d5a67fa`, with a pilot browser test); it still renders, saying trading is not set up, in a build that
   names a factory only for another network.
7. **Upgradeability is absent by design** — the market is immutable and
   `SecondaryMarketFactory` pins bytecode. That removes upgrade risk but also
   removes the ability to fix a defect; a replacement market is a new deployment
   and a DAO decision.


8. **Design limits and open product decisions the tests record but cannot settle.**
   None of these loses money; each is a choice about who the round serves, and
   each is a decision for the product owner, not a defect found by a test.
   (a) *Buyer-slot griefing.* The 33rd buyer is refused `TooManyBuyers`, and
   cancellation is free until bidding closes, so someone can fill all 32 buyer
   slots with throwaway bids and keep honest bidders out for the whole window.
   (b) *A bid can move the price and then be pulled.* Orders are visible and
   cancellable until the last second; the clearing is honest about the orders
   that exist when it runs, and cannot make a late withdrawal honest.
   (c) *Free size inflation under pro-rata allocation.* The oversubscribed side
   is shared pro rata by stated lots, and whatever is not filled comes back in
   full, so overstating an order's size costs only the time the money or Shares
   sit in the market, and takes lots from honest orders on that side. Stating a
   true size is not rewarded. (d) *Slot squatting on the seller side.* The same
   free cancellation lets holders fill the 32 seller seats with offers at a price
   nobody will pay (`TooManySellers`) and withdraw them before the close,
   keeping honest sellers out of the week's round. Whether to add a cost,
   a deposit, price priority, or a smaller allocation share for late or very
   large orders is an open product decision for each of (a) to (d); nothing in
   the code changes until it is made.

---

## 7. Open questions for the reviewer

These are the ones the implementation ledger already names, plus the legal ones
this packet cannot answer:

**Security**

1. Is the clearing algorithm's tie-breaking (`lowest order id` wins leftovers)
   exploitable by an actor who can choose their order id, i.e. by ordering
   transactions?
2. Can the escrow accounting be driven to `LedgerShort` by a sequence of partial
   returns and re-sales? `test_partial_return_preserves_partial_ages` covers one
   path; the adversarial paths around `_migrateEscrow` deserve a read.
3. `exclusionsFrozen` is set once at creation. Is there any post-creation path
   that changes the set of excluded holders (a burn to the market, a transfer
   to a locked address) in a way that shifts the quorum denominator?
4. The market is `transferExempt` and holds every open order's escrow. What
   happens if the DAO votes to change `transferExempt` later — can that escrow
   become stranded?

**Legal / product**

5. Selling a share of a project's treasury and payouts — is that a security in
   the jurisdictions the product will launch in, and does the "ownership only, no
   dividends" framing hold?
6. The founder sale schedule is a transfer restriction on a token the founder
   holds. Does that create disclosure obligations, and is it enforceable?
7. Exit is always allowed, even while the sale restriction is active. Does that
   undercut the restriction in a way a regulator would care about?

---

## 8. How to reproduce the evidence locally

Everything below runs on a scratch chain with public dev keys; nothing touches a
public network.

```bash
# The contracts. From contracts/ (foundry-bin on PATH; never run forge install or update):
forge test --offline --no-match-path 'test/{LaunchpadFork,SepoliaLaunchFork}.t.sol'   # whole suite; the final gate run reported 80 suites, 882 passed, 0 failed
forge test --offline --match-path "test/{Secondary*,ActivationVoting*,ContributorKitV2*,FounderSaleEligibility*,HoldingAge*,ExitExchange*,WeeklyRounds*,PayoutsMarket*,TransferLock*}.t.sol"
                                             # the secondary set: 26 suites, 278 passed, 0 failed (2026-11-05, after the low-severity batches)

# The guard-removal check and its tests (no chain needed for the two node commands)
node scripts/contracts-mutation-check.mjs --check                       # 261 entries well formed
node --test scripts/contracts-mutation-check.test.mjs scripts/check-secondary-review-wording.test.mjs   # 72 passed (62 + 10)
# A single entry removes one guard and requires a named test to fail; see the script header.

# The keeper's retry and give-up logic against a stubbed node and clock
bash scripts/secondary-keeper-test.sh        # "all passed"

# A real deployment, every value read back from node state
./scripts/v5-local-fixture.sh                # 8/8 receipts, listing disabled at birth

# The market end to end, on a real local chain (needs anvil, node and a browser)
bash scripts/web-trading-e2e.sh              # five browser journeys: a full round, a void round, a part-filled seller, a round where nothing crosses, keyboard and screen reader
bash scripts/secondary-keeper-e2e.sh         # scripts/secondary-keeper.sh through a round's whole life

# The founder sale schedule and transfer restrictions are pinned by the Foundry
# suites above (FounderSaleEligibility, ActivationVoting*, ContributorKitV2),
# and the fixture reads saleCapacity(founder) back from node state.
```

Addresses from the local fixture (regenerate; they are deterministic per
deployment, not fixed):

| Contract | Address |
|---|---|
| DAO | `0x0f8D13153cD974B0134e6734DE36AbcD5ba40Ea6` |
| Shares | `0xD07c6FAa2eFf9e1A9dc706470999011Fa64dD3eB` |
| Voting policy | `0xf4077771FB45A67a76B78632B92783C181CCdEA2` |
| Market | `0xB0bcEc182f347c12a43CAB32De5527BD496aDBe6` |
| Mandate factory | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |

The implementation ledger (`docs/v3-review/V5-IMPLEMENTATION.md`) records the
gate results behind every claim in this packet, with the command that produced
each one.

---

## 9. What a sign-off should say

The review is complete when an outside reviewer has either (a) found no
high-severity defect, or (b) found defects that are fixed and re-tested, and has
stated a view on the seven open questions in §7. That sign-off, and the legal
view, are release gates owned by people: nothing in the software checks for a
sign-off. Trading is off by default only because a listing starts disabled and
no hosted build names a market factory; turning it on remains one deliberate DAO
act (the listing vote) per project (§4), not a platform switch.

---

## 10. First review (internal agent pass, not an outside audit): findings and what changed

This was an agent review pass, not an independent human audit (§6 item 1 is the
single statement of audit status). An agent review pass read `SecondaryMarket.sol` and `SecondaryMarketFactory.sol`
in full, the Shares transfer path in `MolochPatched.sol`, and the market's hooks
in `ActivationVoting.sol`, and reproduced three defects with forge tests. All
three were real and are now fixed, each with a regression test that fails when
its fix is reverted (verified by reverting each fix in turn). Their tests live in
`contracts/test/SecondaryMarketReview.t.sol`.

### F1 — anyone could burn a seller's proceeds (medium) — fixed

`claimQuote` marked a seller's order paid for **any** address holding a sell
order, even before settlement when `filled` is still 0. An address with both a
sell order and a cancelled bid was eligible for a pre-settle call, so anyone
could pay its bid refund and, in the same call, mark its proceeds paid at zero.
After settlement the seller had sold its Shares and `claimQuote` reverted
`NothingToClaim`; the money stayed in the market for ever.

Fixed by paying a seller's proceeds only when the round is settled or void.
Pinned by `test_a_sellers_proceeds_survive_a_pre_settle_claimQuote`, which also
proves both sides end up paid in full.

### F2 — leftovers did not follow order id (low) — fixed

`_removeFromList` swapped the last entry into the freed slot, so list position
stopped matching order id, while the code and this packet both claimed leftovers
go to the lowest order id. An actor could place a decoy order early, put their
real order last, cancel the decoy and take its slot — worth at most one lot per
leftover, but it makes the documented tie-break false and is exploitable by
transaction ordering.

Fixed by shifting on removal, so the list stays in order. Pinned by
`test_leftovers_follow_order_id_after_a_cancellation`.

### F3 — the DAO could freeze escrowed Shares (medium–high) — fixed

`Shares.setTransferValidator` can be called by the DAO at any time, with no
notice and no seal, and the validator saw every market transfer. With a refusing
validator, `cancelSell`, the unsold-lot return inside `settle`, and a void
round's `claimShares` all reverted, while quote claims kept working — so a DAO
could hold every seller's escrowed Shares hostage.

Fixed by exempting the market — the Shares' named `transferExempt` address — from
the validator, for the same reason it is already exempt from the transfer lock:
the market's accounting assumes it can always return what it holds. Ordinary
holder-to-holder transfers still reach the validator (asserted in the same test).
Pinned by `test_a_dao_validator_cannot_freeze_the_markets_escrow`.

### F4 — a measurement, fixed in the code it found (informational)

A full round of 32 sellers, 32 buyers and 64 price levels settled for about
**2.63M gas** with the mock policy, but that figure was misleading twice over:
the mock's hooks are trivial, and a test runs as one transaction, so every slot
was warm and the policy's per-block history rows were overwritten instead of
appended. Measured against the **real policy** (a real `ContributorKitV2`
launch), with every touched contract cooled and the settle three days of blocks
after the offers, as a real settler's transaction would meet it
(`SecondaryMarketRealGas`), the first real-policy measurement of settle was
11.29M to 20.87M gas (up to 124% of 2^24, the per-transaction cap some chains
enforce under EIP-7825). The cost was per part-filled seller (about 350k to 650k
gas each: the history row, vote checkpoints and escrow-book writes for every
seller whose Shares the loop returned), so a part-filled round near 32 sellers
could not be mined under that cap. It would go void after the two-day window:
nobody lost funds, because every seller's Shares and every buyer's quote come
back by claim, but that round did not trade, and a griefer who filled the
seller seats against less than the supply could make it happen on purpose.

It is fixed in the contract. `settle` no longer returns anything: it books the
clearing, the fills and the policy's sold-escrow hook, and a part-filled
seller's unsold remainder is returned by `claimShares`, exactly as a void
round's whole offer already is (one seller per transaction, callable by anyone,
no deadline). Re-measured after that change, same method:

| Shape (32 sellers x 32 buyers x 64 levels) | Settle gas | Share of 2^24 (16,777,216) | Worst single seller claim |
|---|---|---|---|
| Typical: one fresh lineage per seller, mixed fills | 2.40M | 14% | 0.48M |
| Typical: one fresh lineage per seller, every seller part-filled | 2.97M | 18% | 0.48M |
| Five fresh lineages per seller, mixed fills | 2.88M | 17% | 0.72M |
| Five fresh lineages per seller, every seller part-filled | **3.58M** | 21% | 0.61M |
| Eight histogram slots populated (5 escrowed + 3 in the wallet), each seller sold one lot | 3.15M | 19% | 0.59M |

The heaviest settle is about a fifth of the cap, so it fits one transaction on a
chain that enforces it, and `MAX_ACTIVE_SELLERS` stays 32. The suite requires
every shape to stay under half the cap and pins each figure with an upper bound,
so the number cannot grow unnoticed; it also asserts that settle moves no
Shares. No economic parameter changed.

The 33rd buyer is refused `TooManyBuyers`, and because cancellation is free until
bidding closes, someone can fill the buyer slots with throwaway bids and keep
honest bidders out for the whole window. Orders are also visible and cancellable
until the last second, so a bid can move the price and then be pulled. Both are
**design choices to state**, not defects; they are recorded in §6, item 8,
together with two consequences of the same free cancellation and pro-rata
allocation that this review found: free size inflation and seller-side slot
squatting. All four are open product decisions.

### The seven questions, answered

| Question | Answer |
|---|---|
| 1. Is the leftover tie-break exploitable by ordering transactions? | **Yes, it was** — that is F2, now fixed. Plain arrival order remains first-come-first-served. |
| 2. Can the escrow accounting be driven to `LedgerShort`? | **No path found** in the market's own accounting: `sharesIn` and `quoteIn` stay conserved. In the first round the policy's `_migrateEscrow` side was not read closely. In the second round it was read and exercised (§11), including through `ActivationVotingRealMarketFuzz`; no path to `LedgerShort` or `LedgerCorrupt` was found. Still agent review, not audit. |
| 3. Can the exclusion set change after creation? | **No.** `_setExcluded` reverts once frozen and no other path was found. |
| 4. Can `transferExempt` change and strand escrow? | **No** — it can only be set once. The real stranding route was the validator (F3), now fixed. |
| 5. Is a Share a security? | For counsel. Unanswered here. |
| 6. Does the founder schedule create disclosure obligations? | For counsel. |
| 7. Does "exit is always allowed" undercut the schedule? | **Yes, in fact**: a founder can exit with Shares not yet released for sale, for a pro-rata share of the treasury once one exists. The schedule restricts transfer and sale, not exit. Whether that matters legally is for counsel; the product fact is now stated plainly. |

### Test-coverage gaps the review named

- The flow tests used to run only against a **mock policy**, and the policy tests
  against a **shim market**. The adversarial, review and resolution suites now run
  twice, against the mock and against a real `ContributorKitV2` launch
  (`SecondaryMarketAdversaryReal`, `SecondaryMarketReviewReal`,
  `SecondaryMarketFlowsResolutionReal`); `SecondaryMarketRealPolicy` adds the
  settle call order (observable in the ages a seller gets back), a multi-seller
  partial-fill round, a buyer who is also a seller, a void round with a donation
  and a third-party claim, a ragequit by a mixed holder, and the real hooks'
  refusals; `ActivationVotingRealMarketFuzz` walks the real market and asserts, at
  every step, that escrow books never exceed the vault and that no hook reverts
  inside a market action, and at snapshots that the quorum denominator equals the
  sum of eligible amounts. The shims stay for the policy's unit cases and say so.
  Not reachable and so not tested: a real-hook revert that wedges a round (the
  market is the only caller of the hooks, the DAO cannot burn market escrow
  because burns are a holder's own exit, and the books are only moved by the
  market).
- Fee-on-transfer quote tokens **fail closed** at bid (the exact-balance check
  reverts) — safer than §6 previously implied. Pinned in the second round by
  `test_a_quote_that_delivers_less_than_asked_is_refused`.
- A blacklist or negative rebase **on the market address itself** is not covered.
- The `_migrateEscrow` path in the policy was not read closely in the first round;
  read and exercised in the second (§11).

The first and fourth gaps are closed; the second is closed for intake and open for
payout; the third is open. The packet is a description of what exists, not a claim
that the review is finished.

---

## 11. Second round (2026-11-05): defects found and fixed since the first revision

A second internal agent pass looked at the market and factory, the voting policy and
founder schedule, the accounting, the web card and keeper, and what the documents
claimed. Findings were each checked by a second agent trying to refute them; those that
held were fixed with a regression test and a one-at-a-time reversion of the fix. It is
the same kind of review as §10: agents, not an outside audit. Commits are on branch
`v4-governance-rework`. "Fails when reverted" means the batch removed only the fix and
saw the named test fail.

### Contract and policy changes

| Finding | Severity | Fix | Regression tests (fail when the fix is reverted) |
|---|---|---|---|
| **Settle did not fit in one transaction at full size.** Against the real policy a 32 x 32 x 64 settle cost 11.29M to 20.87M gas, above the 16.78M (2^24) per-transaction cap some chains enforce. The round would go void; a griefer could cause it. | high | `9ce0656`: `settle` no longer returns unsold Shares; `claimShares` does, one seller per transaction. Now 2.40M to 3.58M. | `test_a_part_filled_seller_claims_the_unsold_remainder_after_settle_exactly_once`, `test_an_unclaimed_remainder_survives_the_settle_window_and_the_next_round`; ceilings in `SecondaryMarketRealGas` (measured in `532a793`) |
| **An unconfigured `ActivationVoting` kept a half-built pending ledger.** A legacy launch through the V2 kit address left a fresh award holder unable to exit (arithmetic underflow) and inflated the pending supply. | medium | `9b5ab7d`: unconfigured behaves exactly like the legacy policy | `test_unconfigured_policy_ragequit_of_a_fresh_award_never_reverts`, `test_unconfigured_policy_award_then_ragequit_and_transfer_do_not_revert_or_track_pending`, `test_legacy_launch_over_the_variant_summoner_lets_an_award_holder_exit` |
| **Payouts counted market-held Shares as units.** Payout shares owed to escrowed units were credited to the market address with no way out. | medium | `256ade0` (`Payouts.sol`) | `test_shares_in_round_escrow_neither_count_nor_strand_payouts`, `test_a_void_round_returns_escrow_to_counting_without_a_stranded_slice` (`PayoutsMarket.t.sol`) |
| **A second `cancelBid` of the same order panicked (0x11) instead of refusing with `NoOrder`.** Found by the strict fuzz walk. No loss of funds was shown. | low | `a455a1c`: `cancelBid` rejects an already cancelled order | `test_a_second_cancelBid_is_refused_as_no_order_not_a_panic` |
| **`agreementState` reported READY_TO_SETTLE for every open claim on a realistic clock.** Agreed-rewards code in the same branch, not the market. | medium | `d108614` (`TreasuryMandate.sol`) | `test_agreement_state_reads_the_review_chain_at_a_realistic_timestamp`, `test_agreement_state_reads_corrections_at_a_realistic_timestamp` |

### Tests that did not test what they claimed

| Finding | Fix | New or rewritten tests |
|---|---|---|
| Both market invariants were vacuous: the handlers were never targeted and every call reverted (0 compared with 0). | `4ff3f56` | `invariant_canary_the_handler_really_trades` and the four rewritten invariants; `test_handler_drives_a_real_pro_rata_round_and_a_void_round` |
| The reentrancy test passed with every `nonReentrant` removed. | `cae1342` | `test_reentry_into_sell_is_refused`, `..._bid_...`, `..._cancelSell_...`, `..._cancelBid_...`, `..._settle_...`, `..._claimShares_...`, `..._claimQuote_...` |
| The counterfeit-DAO regression used a code-less address; most factory guards shadowed each other. | `b6ab248` | `SecondaryMarketDaoPin` (3 tests) and the single-fault `test_guard_*` and `test_constructor_*` tests |
| The exit-exchange tests never named an exchange. | `680eaec` | `test_claims_survive_an_installed_exit_exchange_that_reverts`, `..._replaced_after_the_notice`, `test_void_round_claims_survive_a_replaced_exit_exchange` |
| The "no funding/claimAndLeave" probe pinned selectors that were not `WeeklyRounds` functions. | `680eaec` | `test_no_d179_primary_funding_open_or_claimandleave_entrypoint_exists`, `test_the_market_abi_matches_the_reviewed_allowlist` |
| Every adversarial test ran only against the simplified policy. | `532a793` | `SecondaryMarketRealPolicy`, `...AdversaryReal`, `...ReviewReal`, `...FlowsResolutionReal`, `ActivationVotingRealMarketFuzz` |
| The real-market fuzz swallowed panics and failed ragequits. | `a455a1c` | strict `_act` allowlist and ghost counters in `ActivationVotingRealMarketFuzz` |
| Guards with no test or no mutation entry: bidding window, settle-once, zero levels, intake deltas, `LedgerShort`, kit read-backs, the factory's post-create exemption read. | `9c2031d`, `8b2c09e`, `4d63a2a`, `071dcf9` | `test_sell_at_close_is_refused_as_bidding_over` and its three siblings, `test_a_second_settle_is_refused_even_when_the_policy_would_let_it_run`, `test_a_listing_with_zero_levels_is_refused_as_invalid_terms`, `SecondaryMarketGuardPins` (4), `ContributorKitV2Guards` (21), `test_guard_the_shares_must_still_name_the_new_market_after_creation`, `test_configuring_after_the_creation_block_is_refused` |

### App, keeper and document fixes

Listed with commits in [LAWYER-BRIEF-WEEKLY-SALES.md](LAWYER-BRIEF-WEEKLY-SALES.md) section 5.4. Those that change a
statement in this packet: the card now reads the last 8 earlier rounds and pages back through older ones
(`2b98a5e`, `3369b99`); a part-filled seller's unsold remainder is a collect (`5d14d62`); a round that matched
nothing prints no price (`1c50b49`); the quote token's address is shown and a mismatch with the sale currency
warned (`cb64d74`); and this packet's account of DAO-held "sale inventory", of the review as "independent", and of
the clearing rule was corrected (`3c5895e`, `8c394b8`, `fffd75d`).

### Examined and judged sound (agent reading, not audit)

The six D179 routes do not recur: a counterfeit DAO cannot obtain a market (the factory accepts only the kit and
pins the DAO's runtime code); no terms contract or token argument exists; there is no balance-difference payout,
and the only measured-before-after step is intake, with exact equality; locked Shares reach a buyer only through an
enabled listing, weekly, within the window and within sale capacity; disabling the listing cannot reach settlement
or claims; one price function is used for escrow, settle and payout; one wei of ETH is irrelevant. Quote and
Shares conservation per round, claim idempotence, and the time boundaries (settle and void do not overlap or leave
a gap) were reasoned through and are pinned by the invariants and flow tests above.

### Findings refuted or not accepted

Nine finding entries (eight topics; one was filed twice) did not survive a second agent's attempt to refute them, or were judged documented design: that the
real-policy settle exceeds a gas cap (superseded by the measurement and fix above); that a permissionless
`openRound` can be used to burn a week with stale terms (the terms are the DAO's own earlier ones, and the DAO can
switch the listing off); that quorum has no floor (a documented trade-off, left as an owner decision); that
trading is "off" only through an absent build variable (the hosted image cannot receive it; a code-level guard is
optional); that connecting a wallet discards form values (no form exists before connection); a wording nit about
the settle notice; that the web decoders are bound to the contract by an opt-in test (a nightly workflow runs it,
though that workflow has never run on GitHub); and that the invariant suite may not reach pro-rata states (a
directed test does).

### Low-severity run (B15 to B24), the same day

The ten batches the owner left for a second run were run on branch `v4-governance-rework` (17 commits, none pushed).
Fixed, each with a test that fails when the fix is reverted; "reported" means the batch said so and it was not re-run
for this revision. Details are in [LAWYER-BRIEF-WEEKLY-SALES.md](LAWYER-BRIEF-WEEKLY-SALES.md) section 5.6.

| Batch | Fix | Commits | Regression tests |
|---|---|---|---|
| B15 | One lot-size bound (the largest value that fits in 128 bits) in `SecondaryMarket` (constant `MAX_LOT_SIZE`), `ContributorKitV2` and the factory; kit comments corrected; the web start flow adopts a project at its predicted address only when the DAO factory's log names the kit, and asks a lagging node again before refusing | `bb5dbad`, `212afc2`, `6fbd706` | `test_a_lot_size_of_two_to_the_128_is_refused_by_the_kit_itself`, `test_the_largest_lot_size_launches`, `test_constructor_refuses_a_lot_size_of_two_to_the_128`, `test_constructor_accepts_the_largest_lot_size`, `test_a_lot_size_of_two_to_the_128_is_refused_by_the_factory`, `test_legacy_launch_over_the_variant_summoner_makes_a_sealed_marketless_dao`; web `contributor-flow.test.mjs`, `contributor-project.test.mjs` (the five `daoMadeByKit` tests) |
| B16 | A live round shows its own terms; no card where trading is not offered | `d5a67fa` | `trading-copy.test.mjs`, `trading-offered.test.mjs`, `tradingCardContract.test.mjs`, `contributorOnlyGatesContract.test.mjs`, `pilot-build.spec.ts` |
| B17 | Plain-words disclosures, time zones, Share counts and plurals | `a710d42` | six tests in `trading-copy.test.mjs`; listing-vote tests in `daoActions.test.mjs` |
| B18 | Status text and announcements on the order forms | `e4a5a42`, `8e959f9` | `tradingCardContract.test.mjs` (status-element and always-present-region pins) |
| B19 | Exit exchange cleared mid-round and replaced after the notice, with exchanges that pull Shares, on the real kit | `1556ef6` | `test_claims_survive_a_live_exit_exchange_cleared_mid_round` (both policies), `test_claims_survive_an_exit_exchange_replaced_after_the_notice`, `test_clearing_a_live_exit_exchange_still_returns_a_sellers_own_escrow` |
| B20 | Fuzz over odd price floors and steps | `75ca683` | `testFuzz_settle_pays_out_the_intake_exactly_on_any_grid` (both policies) |
| B21 | Keeper exit status and key handling | `dab2c8a`, `1862cf7` | `scripts/secondary-keeper-test.sh`, `scripts/secondary-keeper-e2e.sh` |
| B22 | Own chain and checked port in the e2e scripts; port probe checks a real listener | `63d7967`, `77150fa` | `scripts/test-e2e-script-hygiene.sh`, `scripts/test-mvp-gate.sh` |
| B23 | `agreement-finalizer.mjs` exit codes | `bd1fdfd` | six new tests in `scripts/agreement-finalizer.test.mjs` (40 of 40) |
| B24 | Status documents and size figures | `5e22ddc` | counts re-measured |
| Follow-ups | `tradingStateLine` "differs" clauses bound; a gate-run test fixed | `105dbb9`, `787f315` | `trading-copy.test.mjs`; `accept-policy.test.mjs` |

A review of the first ten commits confirmed 11 points (2 medium test gaps: the production check that a DAO was made by
the kit had no test, and the "differs from the live round" test moved the minimum and maximum price together; and 9
low) and refuted one (that the new grid fuzz does not check matched volume or the seller's lowest price: the gap
exists in that test and its sibling, but fixed-grid and invariant tests pin them independently, so it is optional
hardening and was not applied). The confirmed points were fixed in `212afc2`, `1862cf7`, `8e959f9`, `105dbb9`, `6fbd706` and
`77150fa`. **A delta review of those fixes was not run.**

### Still open after this round

See §6 items 6 and 8. The owner decisions are in the brief, section 8. After the low-severity run the open
engineering items are listed in the brief, section 6.2: the V2 kit still accepts the older launch call, the exit-exchange
slot is not sealed, no sentence about a fee, the keeper test is not run by CI, and the follow-up fixes were not re-reviewed.
