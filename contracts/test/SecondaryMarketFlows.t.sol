// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFlowsFixture} from "./helpers/SecondaryMarketFlowsFixture.sol";

/// @title Secondary market behaviour under a real Summoner-born DAO: the listing decision, order intake,
/// and cancels
/// @notice Escrow exactness, the frozen grid, and cancels. Every number checked here is an integer the
/// market's own orders compute, so the seller's and the buyer's arithmetic can never drift apart.
/// @dev Clearing lives in `SecondaryMarketFlowsClearing`, void rounds, disposition gates and resale in
/// `SecondaryMarketFlowsResolution`. The three contracts are one test suite split for compiler tag space.

contract SecondaryMarketFlows is SecondaryMarketFlowsFixture {
    // ---- the listing decision -----------------------------------------------------------------------------------

    function test_only_the_dao_decides_and_the_grid_must_divide_exactly() public {
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.NotDao.selector);
        l.market.configureListing(true, MIN_PRICE, MAX_PRICE, LEVELS);
        // Without a listing decision, rounds can start nowhere.
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.ListingNotEnabled.selector);
        l.market.openRound();
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.ListingNotEnabled.selector);
        l.market.sell(1, 1, 0);
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.ListingNotEnabled.selector);
        l.market.bid(1, 1, 0);
        _enableListing(l);
        uint256 id = l.market.openRound();
        // A grid whose levels are not exact integers would drift sellers against buyers.
        vm.startPrank(address(l.dao));
        vm.expectRevert(SecondaryMarket.InvalidTerms.selector);
        l.market.configureListing(true, 1_600, 5_601, 8);
        vm.expectRevert(SecondaryMarket.InvalidTerms.selector);
        l.market.configureListing(true, 0, 5_600, 8);
        vm.expectRevert(SecondaryMarket.InvalidTerms.selector);
        l.market.configureListing(true, MIN_PRICE, MIN_PRICE, 8);
        // A level count above the frozen cap cannot list either.
        uint32 unboundedLevels = uint32(l.market.MAX_LEVELS() + 1);
        vm.expectRevert(SecondaryMarket.InvalidTerms.selector);
        l.market.configureListing(true, MIN_PRICE, 100_000, unboundedLevels);
        vm.stopPrank();
    }

    function test_rounds_freeze_terms_and_weekly_cadence() public {
        _enableListing(l);
        uint256 first = l.market.openRound();
        (
            uint128 minPrice,
            uint128 step,
            uint32 levels,
            uint64 opensAt,
            uint64 closesAt,
            uint64 settleDeadline,
            uint256 asked,
            uint256 wanted,
            uint16 price,
            bool settled,
            bool sellersShare
        ) = l.market.rounds(first);
        assertEq(minPrice, MIN_PRICE);
        assertEq(step, 500, "grid step = (max-min)/levels");
        assertEq(levels, LEVELS);
        assertEq(closesAt - opensAt, BIDDING);
        assertEq(settleDeadline - opensAt, BIDDING + SETTLE_WINDOW);
        assertEq(asked, 0);
        assertEq(wanted, 0);
        assertEq(price, 0);
        assertFalse(settled);
        assertFalse(sellersShare);
        // Round terms freeze at open: a later DAO decision never reaches a live round.
        vm.prank(address(l.dao));
        l.market.configureListing(true, 2_000, 6_000, 2);
        // A live round keeps its frozen terms; five lots at the 2100 level can only clear 5 of them.
        vm.prank(B2);
        l.market.bid(first, 5, 1);
        (,,,, uint64 firstClose,,,,,,) = l.market.rounds(first);
        vm.warp(firstClose);
        l.market.settle(first);
        assertEq(l.market.priceAt(first, 0), uint256(MIN_PRICE), "the opened round kept its own floor");
        assertEq(l.market.priceAt(first, 8), uint256(MAX_PRICE), "and its own cap");
        // The next round waits a week from the last open and uses the new terms.
        uint256 at = l.market.lastOpenAt();
        vm.warp(at + WEEK - 1);
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.TooSoon.selector, at + WEEK));
        l.market.openRound();
        vm.warp(at + WEEK);
        uint256 second = l.market.openRound();
        (uint128 minPrice2, uint128 step2,,,,,,, uint16 price2, bool settled2, bool sellersShare2) =
            l.market.rounds(second);
        assertEq(minPrice2, 2_000, "the frozen round-2 terms came out of the DAO decision");
        assertEq(step2, 2_000, "grid step = (6_000-2_000)/2");
        assertEq(price2, 0);
        assertFalse(settled2);
        assertFalse(sellersShare2);
    }

    // ---- order intake -------------------------------------------------------------------------------------------

    function test_sell_escrows_exactly_lots_times_lot_size() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        assertEq(l.market.sharesIn(id), 10e18, "the market actually took ten whole lots");
        // The deposit went through the DAO's ownership hook, so the policy holds the seller escrow
        // and its original acquisition, exactly what a later return must keep and a sale consumes.
        assertEq(l.policy.escrowedBalance(S1), 10e18);
        assertTrue(l.policy.heldSince(S1) != 0, "the deposit registered the seller's acquisition age");
        assertEq(l.shares.balanceOf(S1), 30e18);
        assertEq(l.shares.balanceOf(address(l.market)), 10e18);
        (,,,,,, uint256 askedAfterSell,,,,) = l.market.rounds(id);
        assertEq(askedAfterSell, 10);
        (uint128 lots, uint16 minStep, uint128 filled, uint64 orderId, bool escrowReturned, bool proceedsPaid) =
            l.market.sells(id, S1);
        assertEq(lots, 10);
        assertEq(minStep, 0);
        assertEq(filled, 0);
        assertEq(orderId, 1);
        assertFalse(escrowReturned);
        assertFalse(proceedsPaid);
        // Errors on anything the round does not accept.
        vm.prank(S1);
        vm.expectRevert(SecondaryMarket.OneOrderPerSide.selector);
        l.market.sell(id, 1, 0);
        vm.prank(address(l.dao));
        vm.expectRevert(SecondaryMarket.DaoCannotSell.selector);
        l.market.sell(id, 1, 0);
        vm.prank(S2);
        vm.expectRevert(SecondaryMarket.BadLots.selector);
        l.market.sell(id, 0, 0);
        vm.prank(S2);
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.BadStep.selector, uint256(LEVELS + 1)));
        l.market.sell(id, 1, uint16(LEVELS + 1));
        vm.prank(S2);
        vm.expectRevert(SecondaryMarket.NoCapacity.selector);
        l.market.sell(id, 31, 0);
    }

    function test_bid_escrows_exactly_lots_times_the_limit_price() public {
        uint256 id = _openRoundWith(l);
        vm.prank(B2);
        l.market.bid(id, 10, 3);
        uint256 escrow = uint256(10) * 3_100;
        assertEq(l.market.quoteIn(id), escrow, "exactly lots times the grid level 3 price");
        assertEq(l.quote.balanceOf(address(l.market)), escrow);
        (,,,,,,, uint256 wantedAfterBid,,,) = l.market.rounds(id);
        assertEq(wantedAfterBid, 10);
        (
            uint128 lots,
            uint16 maxStep,
            uint128 filled,
            uint64 orderId,
            bool cancelled,
            bool sharesPaid,
            bool refundDone
        ) = l.market.bids(id, B2);
        assertEq(lots, 10);
        assertEq(maxStep, 3);
        assertEq(filled, 0);
        assertEq(orderId, 1);
        assertFalse(cancelled);
        assertFalse(sharesPaid);
        assertFalse(refundDone);
        vm.prank(B2);
        vm.expectRevert(SecondaryMarket.OneOrderPerSide.selector);
        l.market.bid(id, 1, 3);
        vm.prank(B2);
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarket.BadStep.selector, uint256(LEVELS + 1)));
        l.market.bid(id, 1, uint16(LEVELS + 1));
        vm.prank(B2);
        vm.expectRevert(SecondaryMarket.BadLots.selector);
        l.market.bid(id, 0, 3);
    }

    // ---- cancels ------------------------------------------------------------------------------------------------

    function test_seller_cancel_returns_the_whole_escrow_in_the_same_transaction() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        uint256 before = l.shares.balanceOf(S1);
        vm.prank(S1);
        l.market.cancelSell(id);
        assertEq(l.shares.balanceOf(S1) - before, 10e18, "the escrow went home inside the cancel");
        assertEq(l.market.sharesIn(id), 0);
        (,,,,,, uint256 askedAfterCancel,,,,) = l.market.rounds(id);
        assertEq(askedAfterCancel, 0);
        (,,,, bool returned,) = l.market.sells(id, S1);
        (uint128 lots,,,,,) = l.market.sells(id, S1);
        assertEq(lots, 0, "the offer is gone from the round");
        assertFalse(returned);
        // The seller can come straight back with a fresh offer.
        vm.prank(S1);
        l.market.sell(id, 6, 1);
        assertEq(l.market.sharesIn(id), 6e18);
    }

    function test_buyer_cancel_claims_the_whole_refund_whenever_the_quote_makes_it() public {
        uint256 id = _openRoundWith(l);
        vm.prank(B2);
        l.market.bid(id, 5, 3);
        vm.prank(B2);
        l.market.cancelBid(id);
        (,,,,,,, uint256 wantedAfterCancel,,,) = l.market.rounds(id);
        assertEq(wantedAfterCancel, 0, "the cancelled order no longer counts in the round");
        assertFalse(l.market.voided(id), "still just a round underway");
        // The refund stands even while bidding is open, whoever triggers the buyer's claim.
        vm.prank(S1);
        l.market.claimQuote(id, B2);
        assertEq(l.quote.balanceOf(B2), 1_000_000e6, "the whole escrow came back, nothing kept");
        assertEq(l.market.quoteIn(id), 0);
        // A repeat claim has nothing left to pay.
        vm.prank(S1);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        l.market.claimQuote(id, B2);
    }

    function test_cancelled_orders_never_count_until_settled() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 20, 0);
        vm.prank(S1);
        l.market.cancelSell(id);
        vm.prank(S1);
        l.market.sell(id, 5, 0);
        vm.prank(S3);
        l.market.sell(id, 10, 0);
        // 15 lots bid: if the cancelled 20-lot offer still counted in supply, the settle below would
        // fail loudly instead of paying out, so this test also fails when the count leaks.
        vm.prank(B2);
        l.market.bid(id, 15, 0);
        (, uint256 matched, bool sellersShare) = l.market.clearingOf(id);
        assertEq(matched, 15, "only the live orders count in the clearing");
        assertFalse(sellersShare, "sellers are the shorter side: buyers fill all 15");
        _toSettle(l, id);
        l.market.settle(id);
        (,, uint128 s1LiveFill,,,) = l.market.sells(id, S1);
        (,, uint128 s3LiveFill,,,) = l.market.sells(id, S3);
        (,, uint128 b2AllFill,,,,) = l.market.bids(id, B2);
        assertEq(s1LiveFill, 5, "the cancelled portion returned above; only the live 5 sold");
        assertEq(s3LiveFill, 10);
        assertEq(b2AllFill, 15, "demand 15 against supply 15: everyone who crossed, filled");
        vm.prank(STANDIN);
        l.market.claimQuote(id, S1);
        assertEq(l.quote.balanceOf(S1), uint256(5) * 1_600);
    }
}
