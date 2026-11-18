// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ActivationVoting} from "../src/ActivationVoting.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFlowsFixture} from "./helpers/SecondaryMarketFlowsFixture.sol";
import {SecondaryMarketFixture} from "./SecondaryMarketMocks.t.sol";

/// @title The real market against the real policy: call order, ages, books and gas
/// @notice The market-level suites run on a stood-in policy whose hooks are trivial, so a call-order
/// regression in `settle` (return before consume, a skipped hook at a zero fill) passes them. Every case
/// here runs on a real `ContributorKitV2` launch: the real `ActivationVoting` clone, its real escrow
/// books and age histograms, and the real market made by the real factory. What they pin is what the
/// policy guarantees to a seller: sold units are taken newest-first from the escrow, so whatever the
/// round returns carries the seller's OLDEST ages, never a fresher lineage than it should.
/// @dev Holders are seeded by buying from the founder (see `SecondaryMarketFixture._seed`), so they
/// start with one fresh acquisition; `_mature` ages those out, `_awards` gives chosen holders fresh
/// units of their own through the real reviewed-award path.
contract SecondaryMarketRealPolicy is SecondaryMarketFlowsFixture {
    function _useRealKit() internal pure override returns (bool) {
        return true;
    }

    uint256 private _claims;
    uint256 private _proposals;

    // ---- helpers ------------------------------------------------------------------------------------------------

    function _policy() internal view returns (ActivationVoting) {
        return ActivationVoting(address(l.policy));
    }

    /// @dev Let every seeded acquisition age past the eight-day maturity window.
    function _mature() internal {
        vm.warp(block.timestamp + 9 days);
    }

    /// @dev Real reviewed awards, all landing on one day: every claim is filed and approved first, the week
    /// the claim must age passes, and then each pays out and mints through the policy hook. Whole lots.
    function _awards(Launch memory m, address[] memory who, uint96[] memory lots) internal {
        address budget = budgetOf[address(m.dao)];
        bytes32[] memory ids = new bytes32[](who.length);
        for (uint256 i; i < who.length; ++i) {
            ids[i] = keccak256(abi.encode("award", ++_claims));
            harness.prepareAward(budget, ids[i], who[i]);
        }
        vm.warp(block.timestamp + 7 days);
        for (uint256 i; i < who.length; ++i) {
            harness.payAward(address(m.dao), budget, ids[i], who[i], lots[i] * uint96(LOT_SIZE));
        }
    }

    function _one(address a, uint96 lots) internal returns (address[] memory who, uint96[] memory amt) {
        who = new address[](1);
        amt = new uint96[](1);
        who[0] = a;
        amt[0] = lots;
    }

    /// @dev A registered proposal snapshot (opened by the founder), the way a vote would read the electorate.
    function _snapshot() internal returns (uint48 snap, uint256 pid) {
        vm.roll(block.number + 1);
        pid = ++_proposals;
        vm.prank(KIT_FOUNDER);
        l.dao.openProposal(pid);
        snap = l.dao.snapshotBlock(pid);
        vm.roll(block.number + 1);
    }

    function _everyone() internal pure returns (address[] memory all) {
        all = new address[](7);
        all[0] = KIT_FOUNDER;
        all[1] = S1;
        all[2] = S2;
        all[3] = S3;
        all[4] = B1;
        all[5] = B2;
        all[6] = B3;
    }

    /// @dev The quorum denominator at a registered snapshot equals the sum of every holder's eligible
    /// amount, and the market's escrow never exceeds what the market physically holds.
    function _assertBooksAndDenominator(uint48 snap, uint256 pid) internal view {
        address[] memory all = _everyone();
        uint256 summed;
        uint256 escrowed;
        for (uint256 i; i < all.length; ++i) {
            summed += _policy().getPastCapacity(all[i], snap);
            escrowed += l.policy.escrowedBalance(all[i]);
        }
        assertEq(
            _policy().votingSupplyAt(l.dao.supplySnapshot(pid), snap),
            summed,
            "the quorum denominator is the sum of every holder's eligible amount"
        );
        assertLe(escrowed, l.shares.balanceOf(address(l.market)), "escrowed books never exceed the vault");
    }

    // ---- multi-seller mixed fill: the call order is observable in the ages ---------------------------------------

    /// @dev Three sellers with mixed ages, one crossing round: S1 sells part of an offer that reaches into its
    /// fresh award, S2 sells part of an all-mature offer, S3 does not cross at all. The policy takes SOLD units
    /// newest-first, so S1's fresh award is consumed by the sale and its unsold return is all mature; S3's
    /// untouched offer returns with its fresh award still fresh. Returning before consuming would hand S1 back
    /// the fresh lineage and sell its mature units instead, so this fails on that order and on nothing else.
    function test_a_multi_seller_partial_fill_returns_each_seller_its_oldest_ages() public {
        _mature();
        address[] memory who = new address[](2);
        uint96[] memory lots = new uint96[](2);
        who[0] = S1;
        who[1] = S3;
        lots[0] = 5;
        lots[1] = 3;
        _awards(l, who, lots);
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 43, 0); // 40 mature + the oldest 3 of the 5 fresh
        vm.prank(S2);
        l.market.sell(id, 30, 1);
        vm.prank(S3);
        l.market.sell(id, 23, 3); // 20 mature + 3 fresh, priced out of the round
        vm.prank(B1);
        l.market.bid(id, 30, 4);
        vm.prank(B2);
        l.market.bid(id, 15, 2);
        vm.prank(B3);
        l.market.bid(id, 5, 6);
        assertEq(l.policy.escrowedBalance(S1), 43e18);
        assertEq(l.policy.escrowedBalance(S3), 23e18);

        _toSettle(l, id);
        l.market.settle(id);
        (,, uint128 f1,,,) = l.market.sells(id, S1);
        (,, uint128 f2,,,) = l.market.sells(id, S2);
        (,, uint128 f3,,,) = l.market.sells(id, S3);
        assertEq(f1, 30, "S1 sold 30 of 43 (pro rata plus the leftover lot)");
        assertEq(f2, 20, "S2 sold 20 of 30");
        assertEq(f3, 0, "S3 did not cross");
        // Settle only consumed the sold units, newest-first: each seller's unsold remainder is still held.
        assertEq(l.policy.escrowedBalance(S1), 13e18, "consume took S1's 30 sold lots, the rest waits");
        assertEq(l.policy.escrowedBalance(S2), 10e18);
        assertEq(l.policy.escrowedBalance(S3), 23e18, "a zero fill consumed nothing");
        assertEq(l.shares.balanceOf(address(l.market)), 96e18, "the vault holds every offered lot until claimed");
        l.market.claimShares(id, S1);
        l.market.claimShares(id, S2);
        l.market.claimShares(id, S3);
        assertEq(l.policy.escrowedBalance(S1), 0, "consume + claim's prepare + return closed S1's books");
        assertEq(l.policy.escrowedBalance(S2), 0);
        assertEq(l.policy.escrowedBalance(S3), 0, "a zero fill still returns through prepare");
        assertEq(l.shares.balanceOf(address(l.market)), 50e18, "the market holds only what the buyers are owed");

        l.market.claimShares(id, B1);
        l.market.claimShares(id, B2);
        l.market.claimShares(id, B3);
        (uint48 snap, uint256 pid) = _snapshot();
        // S1: 45 held, 43 offered, 30 sold; the 3 fresh offered units were sold first. 13 mature came home,
        // 2 fresh were never offered: 15 in the wallet, 13 of them eligible.
        assertEq(l.shares.balanceOf(S1), 15e18);
        assertEq(_policy().getPastCapacity(S1, snap), 13e18, "S1's returned units are its oldest, mature ones");
        assertEq(_policy().getPastCapacity(S2, snap), 10e18, "S2 kept ten mature lots");
        assertEq(l.shares.balanceOf(S3), 23e18);
        assertEq(
            _policy().getPastCapacity(S3, snap), 20e18, "S3's untouched offer came home with its fresh award fresh"
        );
        assertEq(_policy().getPastCapacity(B1, snap), 0, "a buyer's units start fresh");
        _assertBooksAndDenominator(snap, pid);
        assertEq(l.shares.totalSupply(), 2_000e18 + 8e18, "only the two awards made new Shares");
    }

    // ---- the unsold remainder is claimed, not pushed by settle ----------------------------------------------------

    /// @dev Settle keeps only the O(n) bookkeeping (clearing, fills, the sold-escrow hook), so one transaction
    /// stays inside the 2**24 per-transaction cap. A part-filled seller's unsold Shares therefore stay in the
    /// vault with their escrow book open after settle, and `claimShares` returns them through the real
    /// prepare hook and transfer, to the original seller's oldest ages, exactly once, by anyone.
    function test_a_part_filled_seller_claims_the_unsold_remainder_after_settle_exactly_once() public {
        _mature();
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(B1);
        l.market.bid(id, 4, 6);
        _toSettle(l, id);
        l.market.settle(id);
        (,, uint128 sold,, bool returnedAtSettle,) = l.market.sells(id, S1);
        assertEq(sold, 4, "S1 sold 4 of 10 lots");
        assertFalse(returnedAtSettle, "settle did not return the unsold remainder");
        assertEq(l.shares.balanceOf(S1), 30e18, "the six unsold lots are still in the vault after settle");
        assertEq(l.policy.escrowedBalance(S1), 6e18, "only the sold lots left S1's escrow book");
        assertEq(l.market.sharesIn(id), 10e18, "the vault still holds the unsold six and the four owed to the buyer");

        vm.expectEmit(true, true, false, true, address(l.market));
        emit SecondaryMarket.SharesClaimed(id, S1, 6e18);
        vm.prank(STANDIN);
        l.market.claimShares(id, S1);
        assertEq(l.shares.balanceOf(S1), 36e18, "the unsold six came home");
        assertEq(l.policy.escrowedBalance(S1), 0, "the seller's book closed");
        assertEq(l.market.sharesIn(id), 4e18, "only the buyer's four remain");
        (,,,, bool returned,) = l.market.sells(id, S1);
        assertTrue(returned);

        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        l.market.claimShares(id, S1);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        vm.prank(S1);
        l.market.claimShares(id, S1);
        assertEq(l.shares.balanceOf(S1), 36e18, "a repeat claim pays nothing more");

        l.market.claimShares(id, B1);
        l.market.claimQuote(id, S1);
        l.market.claimQuote(id, B1);
        (uint48 snap, uint256 pid) = _snapshot();
        assertEq(_policy().getPastCapacity(S1, snap), 36e18, "the returned units kept their mature ages");
        assertEq(l.market.sharesIn(id), 0);
        assertEq(l.shares.balanceOf(address(l.market)), 0);
        _assertBooksAndDenominator(snap, pid);
    }

    /// @dev The remainder is a standing right of the order: it does not lapse with the settle window, it is
    /// not touched by the next round, and a seller who never calls anything again is still made whole by
    /// anyone's claim, even while the same wallet has an order in a later round.
    function test_an_unclaimed_remainder_survives_the_settle_window_and_the_next_round() public {
        _mature();
        uint256 first = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(first, 10, 0);
        vm.prank(B1);
        l.market.bid(first, 4, 6);
        _toSettle(l, first);
        l.market.settle(first);
        assertFalse(l.market.voided(first), "a settled round is never void");

        // Well past the settle deadline, and a whole second round later; S1 never touched anything.
        vm.warp(block.timestamp + 60 days);
        assertFalse(l.market.voided(first), "time does not void a settled round");
        uint256 second = l.market.openRound();
        vm.prank(S1);
        l.market.sell(second, 5, 0);
        vm.prank(B2);
        l.market.bid(second, 5, 6);
        _toSettle(l, second);
        l.market.settle(second);
        assertEq(l.policy.escrowedBalance(S1), 6e18, "round one's unsold six are still held, round two sold out");

        vm.prank(STANDIN);
        l.market.claimShares(first, S1);
        assertEq(l.shares.balanceOf(S1), 40e18 - 10e18 - 5e18 + 6e18, "round one's remainder came home late");
        assertEq(l.policy.escrowedBalance(S1), 0);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        l.market.claimShares(second, S1);
        l.market.claimShares(first, B1);
        l.market.claimShares(second, B2);
        l.market.claimQuote(first, S1);
        l.market.claimQuote(first, B1);
        l.market.claimQuote(second, S1);
        l.market.claimQuote(second, B2);
        assertEq(l.market.sharesIn(first), 0);
        assertEq(l.market.sharesIn(second), 0);
        assertEq(l.shares.balanceOf(address(l.market)), 0);
        assertEq(l.quote.balanceOf(address(l.market)), 0);
    }

    // ---- one wallet on both sides --------------------------------------------------------------------------------

    /// @dev S2 offers 10 lots and bids for 6 in the same round. Its sold units leave its escrow, the unsold
    /// ones come home mature, and the 6 it buys are an ordinary fresh receipt: buying never inherits the age
    /// of what the same wallet sold.
    function test_a_buyer_who_is_also_a_seller_gets_fresh_units_and_keeps_its_old_ones() public {
        _mature();
        _mintQuote(S2, 1_000_000e6);
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(S2);
        l.market.sell(id, 10, 0);
        vm.prank(S2);
        l.market.bid(id, 6, 6);
        vm.prank(B1);
        l.market.bid(id, 8, 6);
        _toSettle(l, id);
        l.market.settle(id);
        (,, uint128 s2Sold,,,) = l.market.sells(id, S2);
        (,, uint128 s2Bought,,,,) = l.market.bids(id, S2);
        assertEq(s2Sold, 7, "10 offered against 14 wanted at the floor: both sellers share 14 of 20");
        assertEq(s2Bought, 6, "the buyers fill whole");
        l.market.claimShares(id, S2); // S2's unsold three and the six it bought, in one call
        l.market.claimShares(id, S1);
        l.market.claimShares(id, B1);
        l.market.claimQuote(id, S2); // S2's proceeds and its own bid's refund in one call
        l.market.claimQuote(id, S1);
        l.market.claimQuote(id, B1);

        (uint48 snap, uint256 pid) = _snapshot();
        assertEq(l.shares.balanceOf(S2), 30e18 - 7e18 + 6e18);
        assertEq(_policy().getPastCapacity(S2, snap), 23e18, "its kept lots are mature; the six it bought are fresh");
        assertEq(l.policy.escrowedBalance(S2), 0);
        assertEq(l.shares.balanceOf(address(l.market)), 0);
        assertEq(l.quote.balanceOf(address(l.market)), 0);
        _assertBooksAndDenominator(snap, pid);
    }

    // ---- void round, donation, third-party claim ---------------------------------------------------------------

    /// @dev A round nobody settles, with an unattributed donation already sitting in the market. Anyone may
    /// claim a seller's Shares back, which runs the real prepare hook and the return; the donation stays
    /// inert in the market and in the donor's escrow credit, and the books never exceed the vault.
    function test_a_void_round_with_a_donation_returns_every_seller_through_the_real_hooks() public {
        vm.prank(S3);
        l.shares.transfer(address(l.market), 2e18); // a donation: registered as S3's escrow by the real hook
        assertEq(l.policy.escrowedBalance(S3), 2e18);
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(S3);
        l.market.sell(id, 5, 0);
        vm.prank(B2);
        l.market.bid(id, 7, 6);
        _toVoid(l, id);
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.SettleOver.selector, id));
        l.market.settle(id);

        vm.prank(STANDIN);
        l.market.claimShares(id, S1);
        vm.prank(STANDIN);
        l.market.claimShares(id, S3);
        vm.prank(STANDIN);
        l.market.claimQuote(id, B2);
        assertEq(l.shares.balanceOf(S1), 40e18, "S1 has everything back");
        assertEq(l.shares.balanceOf(S3), 18e18, "S3 has its 5 lots back, not the donated 2");
        assertEq(l.policy.escrowedBalance(S1), 0);
        assertEq(l.policy.escrowedBalance(S3), 2e18, "the donation's credit stays with the donor, unreturnable");
        assertEq(l.shares.balanceOf(address(l.market)), 2e18, "and so does its token: nobody's order");
        assertEq(l.market.sharesIn(id), 0);
        assertEq(l.quote.balanceOf(address(l.market)), 0);
        (uint48 snap, uint256 pid) = _snapshot();
        _assertBooksAndDenominator(snap, pid);
    }

    // ---- ragequit by a mixed holder -----------------------------------------------------------------------------

    /// @dev S2 holds 30 mature lots plus 4 fresh from an award, offers 20, then leaves with 6 lots while the
    /// offer is still open. The burn takes the fresh units first (newest-first), the round then sells 8 and
    /// returns 12, and S2 ends with 20 lots, every one of them mature, with its books closed.
    function test_a_mixed_holder_can_ragequit_while_its_offer_is_in_a_round() public {
        _mature();
        (address[] memory who, uint96[] memory amt) = _one(S2, 4);
        _awards(l, who, amt);
        uint256 id = _openRoundWith(l);
        vm.prank(S2);
        l.market.sell(id, 20, 0);
        vm.prank(B2);
        l.market.bid(id, 8, 6);
        uint256 supplyBefore = l.shares.totalSupply();

        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.prank(S2);
        l.dao.ragequit(tokens, 6e18, 0);
        assertEq(l.shares.totalSupply(), supplyBefore - 6e18);
        assertEq(l.policy.escrowedBalance(S2), 20e18, "the open offer's escrow is untouched by the exit");

        _toSettle(l, id);
        l.market.settle(id);
        l.market.claimShares(id, B2);
        l.market.claimShares(id, S2);
        (uint48 snap, uint256 pid) = _snapshot();
        assertEq(l.shares.balanceOf(S2), 34e18 - 6e18 - 8e18);
        assertEq(_policy().getPastCapacity(S2, snap), 20e18, "the burn took the fresh units; all 20 left are mature");
        assertEq(l.policy.escrowedBalance(S2), 0);
        _assertBooksAndDenominator(snap, pid);
    }

    // ---- the hooks themselves -------------------------------------------------------------------------------------

    /// @dev Only the market may drive the books, and the real hooks refuse anything beyond them: a sale
    /// of units never escrowed, a return of units never escrowed, and an empty return.
    function test_the_real_hooks_refuse_anyone_but_the_market_and_anything_beyond_the_books() public {
        vm.prank(S1);
        vm.expectRevert(ActivationVoting.MarketOnly.selector);
        _policy().consumeSoldEscrow(S1, 1e18);
        vm.prank(S1);
        vm.expectRevert(ActivationVoting.MarketOnly.selector);
        _policy().prepareEscrowReturn(S1, 1e18);
        vm.prank(address(l.dao));
        vm.expectRevert(ActivationVoting.MarketOnly.selector);
        _policy().consumeSoldEscrow(S1, 1e18);

        vm.startPrank(address(l.market));
        vm.expectRevert(ActivationVoting.MarketInventoryShort.selector);
        _policy().consumeSoldEscrow(S1, 1e18);
        vm.expectRevert(ActivationVoting.MarketInventoryShort.selector);
        _policy().prepareEscrowReturn(S1, 1e18);
        vm.expectRevert(ActivationVoting.PreparedReturnMismatch.selector);
        _policy().prepareEscrowReturn(S1, 0);
        vm.stopPrank();
    }
}

/// @title The heaviest legal settle, against the real policy
/// @notice 32 sellers x 32 buyers x 64 levels on a real `ContributorKitV2` launch. Every seller holds fresh
/// units from reviewed awards on eight different days, so every one of the policy's eight histogram slots is
/// populated for the round: five lineages made before the offer (they sit in the seller's escrow) and three
/// made while bidding is open (they sit in the seller's wallet histogram). Five is the most a deposit can
/// escrow and still be immature at settle, because bidding is three days and the maturity window eight
/// epochs. Three fill shapes run from the same state: mixed fills (whole, pro rata, empty), every seller
/// part-filled with five lineages, and every seller part-filled with all eight slots populated, which is the
/// heaviest shape the settle loop can take. The round settles in one transaction, so the figure is what one
/// settler pays in one block.
/// @dev Settle does only the bounded bookkeeping (clearing, fills, the policy's sold-escrow hook) and returns no
/// Shares; each seller's unsold remainder is returned by that seller's own `claimShares`. That is what keeps
/// the heaviest legal settle inside one 2**24 (EIP-7825) transaction: it must fit, or the round goes void. The
/// suite asserts every shape stays under half the cap (`TX_GAS_BUDGET`) and, tighter, under a per-shape ceiling
/// with about five percent headroom over the measured figure; a single seller's claim is bounded separately.
/// The figures are recorded in `docs/v3-review/SECONDARY-TRADING-REVIEW.md`.
contract SecondaryMarketRealGas is SecondaryMarketFixture {
    function _useRealKit() internal pure override returns (bool) {
        return true;
    }

    /// @dev The per-transaction gas ceiling some chains enforce (2**24, EIP-7825).
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    /// @dev The most one seller's `claimShares` (prepare, transfer, the policy hook and the histogram restore) may cost.
    uint256 internal constant BOUND_SELLER_CLAIM = 760_000;
    /// @dev The margin every shape must keep under the cap: half of it. The heaviest measured settle is about
    /// a fifth of 2**24, so a regression that reintroduces per-seller token transfers fails here long before
    /// it reaches the cap, and a chain that enforces the cap can always mine the settle.
    uint256 internal constant TX_GAS_BUDGET = TX_GAS_CAP / 2;
    /// @dev The asserted ceilings, one per shape, each about five percent above what it measures.
    uint256 internal constant BOUND_MIXED = 3_050_000;
    uint256 internal constant BOUND_HALF_FILLED = 3_760_000;
    uint256 internal constant BOUND_EIGHT_SLOTS = 3_310_000;

    uint256 internal constant BOUND_TYPICAL_MIXED = 2_520_000;
    uint256 internal constant BOUND_TYPICAL_HALF = 3_120_000;

    /// @dev The fill shapes the same funded state is settled under.
    enum Shape {
        Mixed,
        HalfFilled,
        OneLotEightSlots
    }
    uint256 internal constant SELLERS = 32;
    uint256 internal constant TAGS_BEFORE = 5;
    uint256 internal constant TAGS_DURING = 3;

    bytes32[][] internal _awardIds;
    /// @dev How many fresh lineages each seller is expected to have escrowed at the offer.
    uint256 internal _expectedSlots = TAGS_BEFORE;

    /// @dev The populated slots of a private histogram of the policy clone: `amts` starts two storage words
    /// after the struct's base (eight 64-bit tags fill the first two) and packs two 96-bit amounts a word.
    function _populated(address policy, uint256 mapSlot, address who) internal view returns (uint256 n, uint256 sum) {
        bytes32 base = keccak256(abi.encode(who, mapSlot));
        for (uint256 j; j < 4; ++j) {
            uint256 w = uint256(vm.load(policy, bytes32(uint256(base) + 2 + j)));
            uint96 a = uint96(w);
            uint96 b = uint96(w >> 96);
            if (a != 0) ++n;
            if (b != 0) ++n;
            sum += uint256(a) + uint256(b);
        }
    }

    function _seller(uint256 i) internal pure returns (address) {
        return address(uint160(0xA000 + i));
    }

    function _buyer(uint256 i) internal pure returns (address) {
        return address(uint160(0xB000 + i));
    }

    /// @dev Pay out award batch `k` (2 whole lots to every seller) at the current clock.
    function _payBatch(Launch memory m, uint256 k) internal {
        address budget = budgetOf[address(m.dao)];
        for (uint256 i; i < SELLERS; ++i) {
            harness.payAward(address(m.dao), budget, _awardIds[k][i], _seller(i), 2e18);
        }
    }

    function test_the_worst_legal_settle_stays_inside_the_gas_bound_on_the_real_policy() public {
        address[] memory sellers = new address[](SELLERS);
        for (uint256 i; i < SELLERS; ++i) {
            sellers[i] = _seller(i);
        }
        Launch memory m = _launch(sellers, new uint256[](SELLERS));

        // Eight batches of reviewed awards, all filed together now; batches 0-4 pay on five consecutive days.
        for (uint256 k; k < TAGS_BEFORE + TAGS_DURING; ++k) {
            _awardIds.push(new bytes32[](SELLERS));
            for (uint256 i; i < SELLERS; ++i) {
                _awardIds[k][i] = keccak256(abi.encode("gas", k, i));
                harness.prepareAward(budgetOf[address(m.dao)], _awardIds[k][i], sellers[i]);
            }
        }
        vm.warp(block.timestamp + 7 days);
        for (uint256 k; k < TAGS_BEFORE; ++k) {
            _payBatch(m, k);
            if (k + 1 < TAGS_BEFORE) vm.warp(block.timestamp + 1 days);
        }

        vm.prank(address(m.dao));
        m.market.configureListing(true, 1_600, 1_600 + 64 * 100, 64);
        for (uint256 i; i < SELLERS; ++i) {
            _approve(m, sellers[i]);
            m.quote.mint(_buyer(i), 1_000_000e6);
            _approve(m, _buyer(i));
        }

        // The three shapes each run from the state above.
        uint256 snapshot = vm.snapshotState();
        uint256 mixedGas = _runRound(m, Shape.Mixed);
        assertTrue(vm.revertToState(snapshot));
        uint256 halfGas = _runRound(m, Shape.HalfFilled);
        assertTrue(vm.revertToState(snapshot));
        uint256 eightGas = _runRound(m, Shape.OneLotEightSlots);

        uint256 worst = halfGas > eightGas ? halfGas : eightGas;
        worst = worst > mixedGas ? worst : mixedGas;
        emit log_named_uint("worst measured settle gas on the real policy", worst);
        emit log_named_uint("as a share of the 2**24 per-transaction cap, in basis points", worst * 10_000 / TX_GAS_CAP);
        // The claim that matters: the heaviest legal settle fits one transaction on a chain that enforces the
        // 2**24 cap, with a wide margin. Falsifiable: moving the unsold-return transfer (and its policy hook)
        // back into settle takes the half-filled shapes to 17.5M-20.9M and fails this.
        assertLt(worst, TX_GAS_BUDGET, "the heaviest settle fits one 2**24 transaction with a wide margin");
        // Tighter per-shape ceilings: each shape's recorded figure plus about five percent, so a heavier settle
        // (an extra hook call, a wider history copy) also fails here.
        assertLt(mixedGas, BOUND_MIXED, "mixed fills stay inside their recorded bound");
        assertLt(halfGas, BOUND_HALF_FILLED, "every seller half-filled stays inside its recorded bound");
        assertLt(eightGas, BOUND_EIGHT_SLOTS, "all eight histogram slots populated stays inside its bound");
    }

    /// @dev What ordinary holders cost: 32 sellers who each acquired their units in ONE purchase (the seeding
    /// round), so each escrows a single fresh lineage. This is the shape real rounds take; the test above is the
    /// adversarial ceiling. Its half-filled figure is above the 2**24 per-transaction cap too (see the review
    /// packet): the bound pins the measurement, it does not say the shape fits.
    function test_a_typical_full_round_with_one_lineage_per_seller_settles_inside_its_recorded_bound() public {
        address[] memory sellers = new address[](SELLERS);
        uint256[] memory amounts = new uint256[](SELLERS);
        for (uint256 i; i < SELLERS; ++i) {
            sellers[i] = _seller(i);
            amounts[i] = 10e18;
        }
        Launch memory m = _launch(sellers, amounts);
        vm.prank(address(m.dao));
        m.market.configureListing(true, 1_600, 1_600 + 64 * 100, 64);
        for (uint256 i; i < SELLERS; ++i) {
            _approve(m, sellers[i]);
            m.quote.mint(_buyer(i), 1_000_000e6);
            _approve(m, _buyer(i));
        }
        _expectedSlots = 1;
        uint256 snapshot = vm.snapshotState();
        uint256 mixedGas = _runRound(m, Shape.Mixed);
        assertTrue(vm.revertToState(snapshot));
        uint256 halfGas = _runRound(m, Shape.HalfFilled);
        assertLt(halfGas, TX_GAS_BUDGET, "a typical half-filled round fits one 2**24 transaction with a wide margin");
        assertLt(mixedGas, BOUND_TYPICAL_MIXED, "mixed fills with one lineage per seller stay inside their bound");
        assertLt(halfGas, BOUND_TYPICAL_HALF, "half fills with one lineage per seller stay inside their bound");
    }

    /// @dev Claim everything `who` is owed; an empty claim is the only refusal allowed.
    function _claimAll(Launch memory m, uint256 id, address who) internal {
        try m.market.claimShares(id, who) {}
        catch (bytes memory e) {
            assertEq(bytes4(e), SecondaryMarket.NothingToClaim.selector, "only an empty claim may refuse");
        }
        try m.market.claimQuote(id, who) {}
        catch (bytes memory e) {
            assertEq(bytes4(e), SecondaryMarket.NothingToClaim.selector, "only an empty claim may refuse");
        }
    }

    /// @dev A test runs as one transaction, so every account and slot the setup touched would be WARM when
    /// `settle` runs and the measured gas would flatter it. A real settler's transaction meets all of it cold,
    /// so mark every contract the settle can reach cold first (the cheat code also cools their storage).
    function _coolEverythingSettleTouches(Launch memory m) internal {
        vm.cool(address(m.market));
        vm.cool(address(m.policy));
        vm.cool(address(m.shares));
        vm.cool(address(m.dao));
        vm.cool(address(m.quote));
        address[3] memory impls = harness.implementations();
        for (uint256 i; i < 3; ++i) {
            vm.cool(impls[i]);
        }
        for (uint256 i; i < SELLERS; ++i) {
            vm.cool(_seller(i));
            vm.cool(_buyer(i));
        }
    }

    /// @dev Open a round, fill all 32 seats on both sides, settle, assert what the shape promises, and pay
    /// everything out. `allPartial` makes every seller offer at the floor against half the demand, so both
    /// hooks run for every seller; `liveTail` pays the three later award batches while bidding is open, so each
    /// seller's wallet histogram holds three more lineages when the unsold units are restored into it.
    function _runRound(Launch memory m, Shape shape) internal returns (uint256 used) {
        bool allPartial = shape != Shape.Mixed;
        bool liveTail = shape == Shape.OneLotEightSlots;
        uint256 id = m.market.openRound();
        for (uint256 i; i < SELLERS; ++i) {
            vm.prank(_seller(i));
            m.market.sell(id, 10, allPartial ? 0 : uint16(i));
            vm.prank(_buyer(i));
            m.market.bid(id, shape == Shape.Mixed ? uint128(3 + (i % 5)) : (liveTail ? 1 : 5), uint16(63 - i));
            (uint256 slots, uint256 held) = _populated(address(m.policy), 27, _seller(i));
            assertEq(held, 10e18, "the slot read is the seller's whole escrow");
            assertEq(slots, _expectedSlots, "every seller escrows the expected fresh lineages");
        }
        if (liveTail) {
            for (uint256 k; k < TAGS_DURING; ++k) {
                vm.warp(block.timestamp + 1 days);
                _payBatch(m, TAGS_BEFORE + k);
            }
            (uint256 tail,) = _populated(address(m.policy), 18, _seller(0));
            assertEq(tail, TAGS_DURING, "each seller's wallet histogram holds the three later lineages");
        }
        _toSettle(m, id);
        // Three days of blocks have passed since the offers were placed: the policy's per-block history
        // coalescing must not see the settle in the same block as the last award, or it overwrites a row
        // where a real settle appends a new seven-word one.
        vm.roll(block.number + 21_600);
        _coolEverythingSettleTouches(m);
        uint256 g = gasleft();
        m.market.settle(id);
        used = g - gasleft();
        string memory label = liveTail
            ? "settle gas, every seller sold one lot, all 8 slots populated"
            : allPartial ? "settle gas, every seller half-filled, 5 lineages" : "settle gas, mixed fills";
        emit log_named_uint(label, used);
        _assertFillShape(m, id, allPartial);

        // Settle returned nothing: a seller's escrow book still holds exactly its unsold lots, which only the
        // claim below returns (that work is per seller and per transaction, not part of the settle).
        for (uint256 i; i < SELLERS; ++i) {
            (,, uint128 filled,,,) = m.market.sells(id, _seller(i));
            assertEq(
                m.policy.escrowedBalance(_seller(i)), (10 - uint256(filled)) * 1e18, "settle left only the unsold lots"
            );
        }

        // The round then closes cleanly: every escrow book is empty and every seller's unsold units are home.
        uint256 worstClaim;
        for (uint256 i; i < SELLERS; ++i) {
            _claimAll(m, id, _buyer(i));
            uint256 c = gasleft();
            try m.market.claimShares(id, _seller(i)) {}
            catch (bytes memory e) {
                assertEq(bytes4(e), SecondaryMarket.NothingToClaim.selector, "only an empty claim may refuse");
            }
            c -= gasleft();
            if (c > worstClaim) worstClaim = c;
            _claimAll(m, id, _seller(i));
            assertEq(m.policy.escrowedBalance(_seller(i)), 0, "the seller's books closed");
        }
        // The hook-heavy work moved here, one seller per transaction: it is nowhere near the cap.
        emit log_named_uint("worst single seller claimShares gas (unsold return)", worstClaim);
        assertLt(worstClaim, BOUND_SELLER_CLAIM, "one seller's claim is a small transaction on its own");
        if (liveTail) {
            (uint256 slots,) = _populated(address(m.policy), 18, _seller(0));
            assertEq(slots, TAGS_BEFORE + TAGS_DURING, "the restored lineages fill all eight slots");
        }
        assertEq(m.market.sharesIn(id), 0);
        assertEq(m.market.quoteIn(id), 0);
        assertEq(m.shares.balanceOf(address(m.market)), 0);
        assertEq(m.quote.balanceOf(address(m.market)), 0);
    }

    function _assertFillShape(Launch memory m, uint256 id, bool allPartial) internal view {
        uint256 whole;
        uint256 part;
        uint256 none;
        for (uint256 i; i < SELLERS; ++i) {
            (,, uint128 filled,,,) = m.market.sells(id, _seller(i));
            if (filled == 10) ++whole;
            else if (filled == 0) ++none;
            else ++part;
        }
        if (allPartial) {
            assertEq(part, SELLERS, "every seller sold some and got some back");
        } else {
            assertTrue(whole != 0 && part != 0 && none != 0, "the round mixes whole, partial and empty fills");
        }
    }
}
