// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

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
        assertEq(l.shares.balanceOf(S1), 35e18, "the unsold 5 came back in the settle transaction");
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
