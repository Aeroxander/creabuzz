// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFlowsFixture} from "./helpers/SecondaryMarketFlowsFixture.sol";

/// @title Secondary market clearing: whole-lot uniform-price clearing under a real Summoner-born DAO
/// @notice The frozen grid's crossing, the oversubscribed side's exact deterministic pro-rata share, the
/// leftover lot by ascending order id, and the lowest-tie rule. Every number checked here is an integer
/// the market's own orders compute, so the seller's and the buyer's arithmetic can never drift apart.
/// @dev One of the `SecondaryMarketFlows*` contracts the flow suite is split across for compiler tag space.

contract SecondaryMarketFlowsClearing is SecondaryMarketFlowsFixture {
    function test_clearing_fills_whole_crossers_and_shares_the_oversubscribed_side_exactly() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 40, 0);
        vm.prank(S2);
        l.market.sell(id, 30, 4);
        vm.prank(S3);
        l.market.sell(id, 20, 8);
        vm.prank(B1);
        l.market.bid(id, 25, 1); // never crosses: 25 lots wanted at the 2100 level or below only
        vm.prank(B2);
        l.market.bid(id, 35, 4);
        vm.prank(B3);
        l.market.bid(id, 10, 8);

        (uint256 level, uint256 matched, bool sellersShare) = l.market.clearingOf(id);
        assertEq(level, 4, "the 3600 level matches the most lots: 45");
        assertEq(matched, 45);
        assertTrue(sellersShare, "sellers at the price share: 70 offered against 45 demanded");
        _toSettle(l, id);
        l.market.settle(id);

        (,, uint128 s1Filled,, bool s1Returned, bool s1Pays) = l.market.sells(id, S1);
        (,, uint128 s2Filled,, bool s2Returned, bool s2Pays) = l.market.sells(id, S2);
        (,, uint128 s3Filled,, bool s3Returned,) = l.market.sells(id, S3);
        (,, uint128 b1Filled,, bool b1Cancelled, bool b1Paid, bool b1Refunded) = l.market.bids(id, B1);
        (,, uint128 b2Filled,,,,) = l.market.bids(id, B2);
        (,, uint128 b3Filled,,,,) = l.market.bids(id, B3);
        assertEq(s1Filled, 26, "40*45/70 = 25 integer shares + the leftover by the lower order id");
        assertEq(s2Filled, 19, "30*45/70 = 19 whole lots of the crossing sellers' pro-rata");
        assertEq(s3Filled, 0);
        assertEq(b2Filled, 35);
        assertEq(b3Filled, 10);
        assertEq(b1Filled, 0);

        // Sellers' unsold escrow already went home in the settle transaction itself.
        assertTrue(s2Returned);
        assertTrue(s3Returned);
        assertTrue(s1Returned, "S1's unsold 14 lots went home inside the settle transaction");
        assertFalse(s1Pays);
        assertFalse(s2Pays);
        assertFalse(b1Refunded, "non-crossing buyer refunds only by claim");
        assertEq(l.shares.balanceOf(S1), 14e18, "the unsold whole lots back, no rounding");
        assertEq(l.shares.balanceOf(S2), 11e18, "the unsold whole lots back, no rounding");
        assertEq(l.shares.balanceOf(S3), 20e18);
        assertEq(l.market.sharesIn(id), (35 + 10) * LOT_SIZE, "the ledger holds just what the buyers will claim");
        assertEq(l.policy.escrowedBalance(S1), 0, "the full sale consumed the seller's age credit");
        assertEq(l.policy.escrowedBalance(S2), 0, "consume + prepare both landed");
        assertEq(l.policy.escrowedBalance(S3), 0);

        // Proceeds at the one clearing price, claimable by anyone on behalf of the named owner. The
        // zero-filled seller has no proceeds at all (its Shares went home in the settle), so its claim
        // rightly refuses.
        vm.startPrank(STANDIN);
        l.market.claimQuote(id, S1);
        l.market.claimQuote(id, S2);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        l.market.claimQuote(id, S3);
        l.market.claimQuote(id, B1);
        // The fully-crossing B2 owes nothing back: zero refunds refuse. B3's escrow sat at its own
        // limit level (5600 per lot), so its refund is that limit above the 3600 clearing price.
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        l.market.claimQuote(id, B2);
        l.market.claimQuote(id, B3);
        assertEq(
            l.quote.balanceOf(B3),
            1_000_000e6 - uint256(56_000) + uint256(20_000),
            "B3's limit-level escrow refunds the 2000 gap per lot"
        );
        l.market.claimShares(id, B2);
        l.market.claimShares(id, B3);
        vm.stopPrank();

        assertEq(l.quote.balanceOf(S1), uint256(26) * 3_600);
        assertEq(l.quote.balanceOf(S2), uint256(19) * 3_600);
        assertEq(
            l.quote.balanceOf(B1),
            1_000_000e6 - uint256(25) * 2_100 + uint256(25) * 2_100,
            "the whole non-crossing escrow came back"
        );
        assertEq(l.quote.balanceOf(address(l.market)), 0, "the round paid out exactly what it took in");
        assertEq(l.shares.balanceOf(B2), 35e18);
        assertEq(l.shares.balanceOf(B3), 10e18);
        assertEq(l.shares.balanceOf(address(l.market)), 0);
        assertEq(l.market.sharesIn(id), 0, "exact share conservation");
        assertEq(l.market.quoteIn(id), 0, "exact quote conservation");
        // Repeat claims pay nothing and revert.
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        l.market.claimQuote(id, S1);
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        l.market.claimShares(id, B2);
    }

    function test_leftover_lots_go_deterministically_to_the_lowest_order_id() public {
        uint256 id = _openRoundWith(l);
        // Two sellers at the same level, 10 and 7 lots, against a 9-lot bid: the integer parts of the
        // sharing side sum to 8, so one leftover lot goes to the earlier order by stable order id.
        vm.prank(S1);
        l.market.sell(id, 10, 1);
        vm.prank(S2);
        l.market.sell(id, 7, 1);
        vm.prank(B2);
        l.market.bid(id, 9, 2);
        _toSettle(l, id);
        l.market.settle(id);
        (,, uint128 aFilled, uint64 aId, bool aReturned,) = l.market.sells(id, S1);
        (,, uint128 bFilled, uint64 bId,,) = l.market.sells(id, S2);
        assertTrue(aId < bId, "S1 placed first, so holds the lower order id");
        assertEq(aFilled, 6, "5 whole lots + the one leftover lot, by ascending order id");
        assertEq(bFilled, 3, "3 whole lots, no leftover");
        assertEq(uint256(aFilled) + uint256(bFilled), 9, "the sellers filled exactly what the buyers bought");
        (,, uint128 b2FillLeftover,,,,) = l.market.bids(id, B2);
        assertEq(b2FillLeftover, 9, "the only buyer filled its whole bid");
        vm.prank(STANDIN);
        l.market.claimQuote(id, S1);
        vm.prank(STANDIN);
        l.market.claimQuote(id, S2);
        assertEq(l.quote.balanceOf(S1), uint256(6) * 2_100);
        assertEq(l.quote.balanceOf(S2), uint256(3) * 2_100);
        vm.prank(STANDIN);
        l.market.claimShares(id, B2);
        assertEq(l.shares.balanceOf(B2), 9e18);
    }

    function test_buyers_share_the_price_when_demand_exceeds_supply() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(B1);
        l.market.bid(id, 4, 0);
        vm.prank(B2);
        l.market.bid(id, 8, 0);
        (, uint256 matched, bool sellersShare) = l.market.clearingOf(id);
        assertEq(matched, 10);
        assertFalse(sellersShare, "buyers at the price share when they are the oversubscribed side");
        _toSettle(l, id);
        l.market.settle(id);
        (,, uint128 b1Filled,,,,) = l.market.bids(id, B1);
        (,, uint128 b2Filled,,,,) = l.market.bids(id, B2);
        assertEq(b1Filled, 4, "4 whole lots of 4: 3 integer + the one leftover by the lower order id");
        assertEq(b2Filled, 6, "6 whole lots of 8");
        (,, uint128 s1WholeFill,,,) = l.market.sells(id, S1);
        assertEq(s1WholeFill, 10, "the only seller filled its whole offer under its own escrow");
        vm.prank(STANDIN);
        l.market.claimQuote(id, B2);
        assertEq(
            l.quote.balanceOf(B2),
            1_000_000e6 - uint256(8) * 1_600 + uint256(2) * 1_600,
            "escrow minus what the bought six lots cost"
        );
        assertEq(l.quote.balanceOf(address(l.market)), uint256(10) * 1_600, "the seller's proceeds wait inside");
        vm.prank(STANDIN);
        l.market.claimQuote(id, S1);
        assertEq(l.quote.balanceOf(address(l.market)), 0);
        assertEq(l.quote.balanceOf(S1), uint256(10) * 1_600);
    }

    function test_the_lowest_tie_wins_and_whatever_crosses_at_it_fills_whole() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 40, 0);
        vm.prank(B1);
        l.market.bid(id, 40, 1);
        (uint256 level, uint256 matched, bool sellersShare) = l.market.clearingOf(id);
        assertEq(level, 0, "every level up to the cap matches 40 lot pairs; the lowest wins");
        assertEq(matched, 40);
        assertFalse(sellersShare);
        (,,,, uint64 idClose,,,,,,) = l.market.rounds(id);
        vm.warp(idClose);
        l.market.settle(id);
        (,,,,,,,, uint16 roundPrice, bool settledRound, bool sharedAnyway) = l.market.rounds(id);
        assertEq(l.market.priceAt(id, roundPrice), uint256(MIN_PRICE));
        assertTrue(settledRound);
        assertFalse(sharedAnyway);
        (,, uint128 sFilled,, bool sReturned,) = l.market.sells(id, S1);
        assertEq(sFilled, 40);
        assertFalse(sReturned, "nothing was unsold");
        (,, uint128 b1FillWhole,,,,) = l.market.bids(id, B1);
        assertEq(b1FillWhole, 40, "the buyer got the whole offer at the lowest tie");
        assertEq(l.market.quoteIn(id), uint256(40) * 2_100, "the buyer escrowed at its own limit level");
    }
}
