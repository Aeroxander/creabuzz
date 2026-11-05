// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ActivationVoting} from "../src/ActivationVoting.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFlowsFixture} from "./helpers/SecondaryMarketFlowsFixture.sol";
import {MockSecondaryPolicy} from "./SecondaryMarketMocks.t.sol";

/// @title Secondary market resolution: void rounds, the settle window, the disposition gates, and resale
/// @notice A round nobody settled pays everything back by claim, disabling the listing only stops new
/// activity, and a buyer resells what it claimed through a later round. Every number checked here is an
/// integer the market's own orders compute, so the seller's and the buyer's arithmetic can never drift apart.
/// @dev One of the `SecondaryMarketFlows*` contracts the flow suite is split across for compiler tag space.

abstract contract SecondaryMarketFlowsResolutionCases is SecondaryMarketFlowsFixture {
    // ---- void rounds and the settle window ----------------------------------------------------------------------

    function test_void_round_claims_everything_back_without_a_settle() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(B2);
        l.market.bid(id, 5, 1);
        assertFalse(l.market.voided(id), "the round is alive until its settle window ends");
        (,,,,,,,,, bool settledAfterVoid, bool ignoredAfterVoid) = l.market.rounds(id);
        assertFalse(settledAfterVoid);
        assertFalse(ignoredAfterVoid);
        _toVoid(l, id);
        assertTrue(l.market.voided(id));
        // Nobody settled in time: settle can never run now, and claims pay everything back instead.
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.SettleOver.selector, uint256(id)));
        l.market.settle(id);
        (,,,,,,,,, bool settledVoid, bool ignoredFlag) = l.market.rounds(id);
        assertFalse(settledVoid);
        assertFalse(ignoredFlag);
        // The seller's unsold escrow: the policy call then the transfer, in the same transaction.
        vm.prank(STANDIN);
        l.market.claimShares(id, S1);
        assertEq(l.shares.balanceOf(S1), 40e18, "the whole escrow back, by anyone's claiming for the seller");
        assertEq(l.market.sharesIn(id), 0);
        assertEq(l.policy.escrowedBalance(S1), 0);
        // The buyer's escrow: recorded by claim, pushed whenever the quote token allows.
        vm.prank(STANDIN);
        l.market.claimQuote(id, B2);
        assertEq(l.quote.balanceOf(B2), 1_000_000e6);
        assertEq(l.market.quoteIn(id), 0);
        assertEq(l.shares.balanceOf(address(l.market)), 0);
        assertEq(l.quote.balanceOf(address(l.market)), 0);
        // Repeats have nothing left and revert.
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        l.market.claimShares(id, S1);
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        l.market.claimQuote(id, B2);
    }

    function test_settle_runs_only_inside_its_window() public {
        uint256 id = _openRoundWith(l);
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.BiddingOpen.selector, uint256(id)));
        l.market.settle(id);
        // Right at the settle deadline the window is gone and the round is void.
        _toVoid(l, id);
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.SettleOver.selector, uint256(id)));
        l.market.settle(id);
        // An open window with nothing in it settles empty so the cadence keeps moving.
        vm.warp(l.market.lastOpenAt() + WEEK);
        uint256 next = l.market.openRound();
        (,,,, uint64 nextClose,,,,,,) = l.market.rounds(next);
        vm.warp(nextClose);
        l.market.settle(next);
        (,,,,,,,,, bool settledNext,) = l.market.rounds(next);
        assertTrue(settledNext);
        assertFalse(l.market.voided(next));
    }

    // ---- the bidding window is closed at closesAt, for every order call ----------------------------------------

    /// @dev Each case stands in a state where the call would otherwise succeed, then warps to exactly
    /// `closesAt`, so only the bidding-window guard can be what refuses it.
    function test_sell_at_close_is_refused_as_bidding_over() public {
        uint256 id = _openRoundWith(l);
        _toSettle(l, id);
        vm.prank(S1);
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.BiddingOver.selector, uint256(id)));
        l.market.sell(id, 5, 0);
        assertEq(l.market.sharesIn(id), 0, "no late offer got in");
    }

    function test_bid_at_close_is_refused_as_bidding_over() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        _toSettle(l, id);
        (uint256 levelBefore, uint256 matchedBefore,) = l.market.clearingOf(id);
        vm.prank(B2);
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.BiddingOver.selector, uint256(id)));
        l.market.bid(id, 5, 6);
        (uint256 levelAfter, uint256 matchedAfter,) = l.market.clearingOf(id);
        assertEq(levelAfter, levelBefore, "a late bid cannot move the clearing level");
        assertEq(matchedAfter, matchedBefore, "a late bid cannot change what matches");
        assertEq(l.market.quoteIn(id), 0);
    }

    function test_cancelSell_at_close_is_refused_as_bidding_over() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        _toSettle(l, id);
        vm.prank(S1);
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.BiddingOver.selector, uint256(id)));
        l.market.cancelSell(id);
        (uint128 lots,,,,,) = l.market.sells(id, S1);
        assertEq(lots, 10, "the offer stands: a late cancel cannot pull it out");
        assertEq(l.market.sharesIn(id), 10e18);
    }

    function test_cancelBid_at_close_is_refused_as_bidding_over() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(B2);
        l.market.bid(id, 5, 3);
        _toSettle(l, id);
        // Everyone can read the clearing now; cancelling for a free refund after seeing it must not work.
        (uint256 levelBefore, uint256 matchedBefore,) = l.market.clearingOf(id);
        vm.prank(B2);
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.BiddingOver.selector, uint256(id)));
        l.market.cancelBid(id);
        (uint256 levelAfter, uint256 matchedAfter,) = l.market.clearingOf(id);
        assertEq(levelAfter, levelBefore);
        assertEq(matchedAfter, matchedBefore, "the bid still counts in the clearing");
        (,,,, bool cancelled,,) = l.market.bids(id, B2);
        assertFalse(cancelled);
    }

    function test_orders_and_cancels_still_work_in_the_last_second_of_bidding() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(B2);
        l.market.bid(id, 5, 3);
        (,,,, uint64 closesAt,,,,,,) = l.market.rounds(id);
        vm.warp(closesAt - 1);
        vm.prank(B2);
        l.market.cancelBid(id);
        vm.prank(S1);
        l.market.cancelSell(id);
        vm.prank(S2);
        l.market.sell(id, 3, 0);
        vm.prank(B3);
        l.market.bid(id, 3, 1);
        assertEq(l.market.sharesIn(id), 3e18, "the last second is still bidding time");
    }

    // ---- a round settles exactly once ------------------------------------------------------------------------------

    /// @dev The seller has donated Shares into the market, so the policy holds more escrow credit for them
    /// than the round's own offer: a repeated settle would find enough credit to consume it a second time
    /// and so could not be stopped by the policy's own hook. Only the round's settled flag refuses it.
    function test_a_second_settle_is_refused_even_when_the_policy_would_let_it_run() public {
        vm.prank(S1);
        l.shares.transfer(address(l.market), 10e18);
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(B2);
        l.market.bid(id, 10, 1);
        assertEq(l.policy.escrowedBalance(S1), 20e18, "the donation backs a second consumption");
        _toSettle(l, id);
        l.market.settle(id);
        uint256 escrowAfterFirst = l.policy.escrowedBalance(S1);
        assertEq(escrowAfterFirst, 10e18, "the first settle consumed the sold ten lots");
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.AlreadySettled.selector, uint256(id)));
        l.market.settle(id);
        assertEq(l.policy.escrowedBalance(S1), escrowAfterFirst, "no second consumption of the seller's escrow");
        (,, uint128 filled,,,) = l.market.sells(id, S1);
        assertEq(filled, 10);
    }

    // ---- the DAO's listing terms ---------------------------------------------------------------------------------

    function test_a_listing_with_zero_levels_is_refused_as_invalid_terms() public {
        _enableListing(l);
        vm.prank(address(l.dao));
        vm.expectRevert(SecondaryMarket.InvalidTerms.selector);
        l.market.configureListing(true, MIN_PRICE, MAX_PRICE, 0);
        (bool enabled,,, uint32 levels) = l.market.listing();
        assertTrue(enabled, "the earlier terms stand");
        assertEq(levels, LEVELS);
    }

    // ---- disabling only stops new activity ----------------------------------------------------------------------

    function test_disabling_stops_new_activity_never_settlement() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(B2);
        l.market.bid(id, 5, 2);
        vm.prank(address(l.dao));
        l.market.configureListing(false, 0, 0, 0);
        (bool listingOff,,,) = l.market.listing();
        assertTrue(listingOff == false, "the DAO turned the listing off");
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.ListingNotEnabled.selector);
        l.market.openRound();
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.ListingNotEnabled.selector);
        l.market.sell(id, 1, 0);
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.ListingNotEnabled.selector);
        l.market.bid(id, 1, 0);
        // Everything already in flight resolves exactly as always.
        _toSettle(l, id);
        l.market.settle(id);
        vm.prank(STANDIN);
        l.market.claimQuote(id, S1);
        assertEq(l.quote.balanceOf(S1), uint256(5) * 1_600, "5 of 40 sold at the floor");
        assertEq(l.shares.balanceOf(S1), 30e18, "settle left the unsold 5 in the vault");
        vm.prank(STANDIN);
        l.market.claimShares(id, S1);
        assertEq(l.shares.balanceOf(S1), 35e18, "the unsold 5 came back by claim, with the listing off");
        vm.prank(STANDIN);
        l.market.claimQuote(id, B2);
        assertEq(
            l.quote.balanceOf(B2),
            1_000_000e6 - uint256(5) * 2_600 + uint256(5) * 1_000,
            "the five lots cost 1600 each; the rest of the 2600 escrow refunds"
        );
        vm.prank(STANDIN);
        l.market.claimShares(id, B2);
        assertEq(l.shares.balanceOf(B2), 5e18);
        assertEq(l.shares.balanceOf(address(l.market)), 0);
        // A cancelled offer still comes home after the listing is off, too.
        vm.prank(address(l.dao));
        l.market.configureListing(true, MIN_PRICE, MAX_PRICE, LEVELS);
        vm.warp(l.market.lastOpenAt() + WEEK);
        uint256 second = l.market.openRound();
        vm.prank(S2);
        l.market.sell(second, 5, 0);
        vm.prank(address(l.dao));
        l.market.configureListing(false, 0, 0, 0);
        vm.prank(S2);
        l.market.cancelSell(second);
        assertEq(l.shares.balanceOf(S2), 30e18);
    }

    // ---- buying and reselling through later rounds ---------------------------------------------------------------

    function test_the_buyer_resells_what_they_claimed_in_a_later_round() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 15, 0);
        vm.prank(B1);
        l.market.bid(id, 15, 1);
        _toSettle(l, id);
        l.market.settle(id);
        vm.prank(STANDIN);
        l.market.claimShares(id, B1);
        assertEq(l.shares.balanceOf(B1), 15e18, "the buyer holds whole lots under the lock");
        if (_policyIsMock()) {
            assertEq(
                MockSecondaryPolicy(address(l.policy)).heldSince(B1),
                uint64(block.number),
                "the claim gave the buyer a fresh acquisition, not the seller's age"
            );
        } else {
            assertEq(l.policy.escrowedBalance(B1), 0, "the buyer inherited no seller escrow or age");
            assertEq(l.policy.saleCapacity(B1), 15e18, "what the buyer claimed is theirs to resell");
            // The raw balance says nothing about age: register a real snapshot and read the buyer's
            // voting eligibility. Units that kept the seller's age would count here; fresh ones are zero.
            vm.roll(block.number + 1);
            vm.prank(KIT_FOUNDER);
            l.dao.openProposal(1);
            uint48 snap = l.dao.snapshotBlock(1);
            vm.roll(block.number + 1);
            assertEq(
                ActivationVoting(address(l.policy)).getPastCapacity(B1, snap),
                0,
                "the claim gave the buyer fresh units, not the seller's age"
            );
        }
        vm.prank(STANDIN);
        l.market.claimQuote(id, S1);
        assertEq(l.quote.balanceOf(S1), uint256(15) * 1_600, "the seller was paid at the clearing price");
        vm.prank(STANDIN);
        l.market.claimQuote(id, B1);
        assertEq(
            l.quote.balanceOf(B1),
            1_000_000e6 - uint256(31_500) + uint256(7_500),
            "the buyer's escrow above the clearing price refunded whole lots, exact integers"
        );

        // A week later the buyer lists what they hold, through the policy's capacity for them now.
        vm.warp(l.market.lastOpenAt() + WEEK);
        uint256 second = l.market.openRound();
        vm.prank(B1);
        l.market.sell(second, 10, 1);
        assertEq(l.market.sharesIn(second), 10e18);
        vm.prank(B2);
        l.market.bid(second, 10, 1);
        (,,,, uint64 secondClose,,,,,,) = l.market.rounds(second);
        vm.warp(secondClose);
        l.market.settle(second);
        vm.prank(STANDIN);
        l.market.claimQuote(second, B1);
        assertEq(
            l.quote.balanceOf(B1),
            1_000_000e6 - uint256(31_500) + uint256(7_500) + uint256(21_000),
            "round one plus the resale proceeds, all exact integers"
        );
        vm.prank(STANDIN);
        l.market.claimShares(second, B2);
        assertEq(l.shares.balanceOf(B2), 10e18);
        assertEq(l.shares.balanceOf(B1), 5e18, "the part B1 kept stayed theirs");
        assertEq(l.shares.balanceOf(address(l.market)), 0);
        assertEq(l.market.sharesIn(id), 0, "round one stays conserving after its claims");
        assertEq(l.market.sharesIn(second), 0);
    }

    function test_the_zero_fee_leaves_every_unit_to_the_parties() public {
        assertEq(l.market.FEE_BPS(), 0, "the candidate fee: zero, fixed");
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 20, 0);
        vm.prank(B2);
        l.market.bid(id, 20, 1);
        _toSettle(l, id);
        l.market.settle(id);
        vm.prank(STANDIN);
        l.market.claimQuote(id, S1);
        assertEq(l.quote.balanceOf(S1), uint256(20) * 1_600, "the seller's whole proceeds at the matched level");
        vm.prank(STANDIN);
        l.market.claimQuote(id, B2);
        assertEq(
            l.quote.balanceOf(B2), 1_000_000e6 - uint256(20) * 1_600, "the escrow 42000, thirty-two thousand bought"
        );
        vm.prank(STANDIN);
        l.market.claimShares(id, B2);
        assertEq(l.quote.balanceOf(address(l.dao)), 0, "the DAO takes nothing from a secondary sale");
        assertEq(l.quote.balanceOf(address(l.market)), 0);
        assertEq(l.shares.balanceOf(B2), 20e18);
    }
}

/// @notice The resolution cases against the stood-in policy.
contract SecondaryMarketFlowsResolution is SecondaryMarketFlowsResolutionCases {}

/// @notice The same cases against a real `ContributorKitV2` launch and the real policy hooks: a void round
/// with the real `prepareEscrowReturn` hook, a disabled listing mid-round, and a resale of claimed Shares.
contract SecondaryMarketFlowsResolutionReal is SecondaryMarketFlowsResolutionCases {
    function _useRealKit() internal pure override returns (bool) {
        return true;
    }
}
