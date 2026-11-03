# Secondary trading — independent review packet

This is the packet for an outside security and legal review of Creaton's
secondary market for a project's Shares. It is written to be read by someone who
did not build it: what the code does, what it deliberately refuses to do, what
the tests actually pin, and what is still open. Every claim below names the file
it comes from, so it can be checked rather than trusted.

**Status: trading is off by default and nothing has been activated on any public
network.** This repository has never deployed to mainnet, and the only
deployments in evidence are local scratch chains started by the scripts named
below. The review is a gate on turning trading on, not a description of
something already live.

---

## 1. Scope

**In scope**

| Surface | File |
|---|---|
| The market itself (rounds, orders, clearing, claims) | `contracts/src/SecondaryMarket.sol` (648 lines) |
| Market creation, provenance and pinning | `contracts/src/SecondaryMarketFactory.sol` (201 lines) |
| Voting maturity, founder sale schedule, escrow accounting | `contracts/src/ActivationVoting.sol` (831 lines) |
| Shares transfer policy and the lock guard | `contracts/src/ContributorKitV2.sol`, `contracts/src/Shares.sol` |

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
| Decide whether a listing exists, and its price bounds | `configureListing(bool enabled, uint128 minPrice, uint128 maxPrice, uint32 levels)` | `msg.sender != dao → NotDao` (`SecondaryMarket.sol:222`) | Cannot touch a round already open. Disabling sets `listing = Terms(false,0,0,0)` and **stops new activity only — settlement and claims still run** (`test_disabling_stops_new_activity_never_settlement`) |
| Open the next round | `openRound()` | anyone, at least `EVERY` after the last open | Uses the frozen listing terms; cannot choose terms |
| Create the market for a DAO | `create(...)` on the factory | only the kit that created the factory (`NotAuthorizedKit`), one per DAO (`AlreadyListed`), and only after proving the DAO, its Shares, its policy and its quote token against pinned bytecode (`_prove`) | Cannot create a market for a counterfeit DAO or token (`test_a_counterfeit_dao_is_refused_at_the_bytecode_pin`, `test_a_counterfeit_token_and_policy_are_refused`) |

There is **no** admin function to move user funds, cancel someone's order, change
a round's terms after it opens, mint Shares, or pause claims. Settlement
(`settle`) and claims (`claimShares`, `claimQuote`) are permissionless and
ungated, which is what makes a stalled round recoverable by anyone.

### The one thing the market is trusted with

The market holds the DAO's entire sale inventory at birth
(`ActivationVoting.configureSecondary` sets `_setExcluded(marketAddr, true)` and
the market's balance is deducted from voting supply exactly once). It is also the
Shares' `transferExempt` address, so inventory can move in and out without the
transfer policy refusing it. Both facts are load-bearing:

- `test_a_rogue_market_never_receives_locked_shares_or_takes_the_exemption`
- `test_the_dao_and_the_market_cannot_sell_inventory` — the DAO cannot sell the
  inventory it is holding for the sale through the market
- `test_mint_straight_to_the_market_is_impossible`

---

## 3. The founder's sale schedule and transfer restrictions

The founder does not get a special market. The founder gets a **vesting
schedule on their own allocation**, enforced where the Shares are, and the
market is one of the places it is enforced.

`ActivationVoting.configureSecondary(market, founder, initialGrant, start,
cliff, duration)` is called **once, in the creation block** (`NotInCreationBlock`
otherwise) and freezes:

- `initialGrant` — the founder's allocation, minted to the market as sale
  inventory;
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
| `shares.saleEligibleOf(founder)` | `(0, 1)` | nothing sellable yet |
| `policy.saleCapacity(founder)` | `0` | the schedule has released nothing |
| `marketFactory.marketOf(dao)` | the market | one market per DAO |

Turning trading on is therefore **two independent acts**: the DAO configures a
listing, and the schedule releases units. Neither happens by default, and
`configureListing` cannot be reached by anyone but the DAO.

---

## 5. What the 734 contract tests actually pin

`forge test --root contracts` runs 69 suites, 734 passing, 2 skipped. The ones a
reviewer should read first, by theme:

**Escrow and conservation**

- `invariant_each_rounds_ledger_is_held_by_the_market`
- `invariant_settled_rounds_fill_both_sides_exactly`
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

- `test_no_primary_mint_funding_or_claimandleave_entrypoint_exists`
- `test_a_reentering_quote_cannot_rerun_any_order_state_change`
- `test_a_blocked_quote_strands_no_payout`
- `test_unattributed_deposits_become_no_ones_credit_and_are_never_paid`
- `test_forced_eth_dust_stays_irrelevant`
- `test_claims_survive_a_cleared_or_replaced_exit_exchange`
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
   scope**, and no formal verification of the clearing algorithm.
3. **The market has never run against a real quote token with fee-on-transfer,
   rebasing or blacklist behaviour.** `test_a_blocked_quote_strands_no_payout`
   covers a blocking token; fee-on-transfer is not covered.
4. **No gas-limit analysis for a round with the maximum number of orders.**
5. **No real-chain reorg testing.** Reorg behaviour is covered only by fake-node
   tests in the agreement finalizer, not for the market.
6. **Upgradeability is absent by design** — the market is immutable and
   `SecondaryMarketFactory` pins bytecode. That removes upgrade risk but also
   removes the ability to fix a defect; a replacement market is a new deployment
   and a DAO decision.

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
4. The market holds the entire sale inventory and is `transferExempt`. What
   happens if the DAO votes to change `transferExempt` later — can inventory
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
# The contracts, with the pinned invariants
forge test --offline --root contracts        # 734 passed, 2 skipped

# A real deployment, every value read back from node state
./scripts/v5-local-fixture.sh                # 8/8 receipts, listing disabled at birth

# The market end to end, on a real chain
bash scripts/mvp-gate.sh web-challenge-e2e
bash scripts/mvp-gate.sh web-rounds-e2e

# The founder schedule and transfer restrictions
bash scripts/mvp-gate.sh web-dao-journey-e2e
bash scripts/mvp-gate.sh web-dao-launch-e2e
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
stated a view on the seven open questions in §7. Trading activation stays off
until that sign-off exists, and turning it on remains two deliberate DAO acts
per project (§4), not a platform switch.
