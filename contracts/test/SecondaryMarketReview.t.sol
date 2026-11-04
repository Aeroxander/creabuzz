// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFlowsFixture} from "./helpers/SecondaryMarketFlowsFixture.sol";

/// @dev A transfer validator that refuses every transfer, standing in for any DAO-chosen validator.
contract RefusingValidator {
    function validateTransfer(address, address, address, uint256, uint256) external pure {
        revert("refused");
    }

    function setTokenTypeOfCollection(address, uint16) external {}
}

/// @title Regression tests from the independent review of secondary trading
/// @dev Each of the first three pins a defect the review found in
/// `docs/v3-review/SECONDARY-TRADING-REVIEW.md`'s subject matter (F1, F2, F3 in that review).
/// Each fails if its fix is reverted: that was checked by reverting all three and watching them
/// fail at the assertions below. The fourth is the review's measurement, kept because it states a
/// real bound (settle cost and the 32-order cap) rather than a behaviour to protect.
abstract contract SecondaryMarketReviewCases is SecondaryMarketFlowsFixture {
    /// F1: a seller's proceeds may not be paid — or burned — before the round settles.
    ///
    /// The defect: `claimQuote` marked a seller's order paid for any address holding one, even before
    /// settlement when `filled` is still 0. An address with both a sell order and a cancelled bid was
    /// eligible for a pre-settle call, so anyone could pay its bid refund and, in the same call, burn the
    /// proceeds settlement would later owe it — permanently, because the only other claim path then
    /// reverted `NothingToClaim` and the money stayed in the market for ever.
    function test_a_sellers_proceeds_survive_a_pre_settle_claimQuote() public {
        _mintQuote(S1, 1_000_000e6);
        _approve(l, S1);
        uint256 id = _openRoundWith(l);
        vm.startPrank(S1);
        l.market.sell(id, 5, 0);
        l.market.bid(id, 1, 0);
        l.market.cancelBid(id);
        vm.stopPrank();
        vm.prank(B2);
        l.market.bid(id, 5, 1);

        // A stranger pays the cancelled bid's refund before settlement, naming the seller.
        vm.prank(STANDIN);
        l.market.claimQuote(id, S1);
        (,,, , , bool paidEarly) = l.market.sells(id, S1);
        assertFalse(paidEarly, "a pre-settle call must not mark the seller's proceeds paid");

        _toSettle(l, id);
        l.market.settle(id);
        (,, uint128 filled, , , bool paidAfter) = l.market.sells(id, S1);
        assertEq(filled, 5, "the seller sold all five lots");
        assertFalse(paidAfter, "settlement owes the seller its proceeds");

        (uint256 level, , ) = l.market.clearingOf(id);
        uint256 owed = uint256(filled) * l.market.priceAt(id, level);
        uint256 before = l.quote.balanceOf(S1);
        vm.prank(STANDIN);
        l.market.claimQuote(id, S1);
        assertEq(l.quote.balanceOf(S1) - before, owed, "the seller is paid exactly what it sold for");
        // The buyer's own refund is still its to claim, and once both have claimed nothing is left.
        vm.prank(STANDIN);
        l.market.claimQuote(id, B2);
        assertEq(l.quote.balanceOf(address(l.market)), 0, "both sides are paid out in full");
    }

    /// F2: leftover lots go to the lowest order id, even after an earlier order was cancelled.
    ///
    /// The defect: removal swapped the last list entry into the freed slot, so list position stopped
    /// matching order id. An actor could place a decoy order early, put their real order last, cancel the
    /// decoy and take its slot — buying the leftover lot that the earlier order should have had.
    function test_leftovers_follow_order_id_after_a_cancellation() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 1, 1); // decoy, order id 1
        vm.prank(S2);
        l.market.sell(id, 10, 1); // order id 2
        vm.prank(S3);
        l.market.sell(id, 7, 1); // order id 3
        vm.prank(B2);
        l.market.bid(id, 9, 2);
        vm.prank(S1);
        l.market.cancelSell(id); // list must stay [S2, S3]

        // 17 offered against 9: 10*9/17 = 5, 7*9/17 = 3, one leftover lot.
        _toSettle(l, id);
        l.market.settle(id);
        (,, uint128 s2Filled, uint64 s2Id, , ) = l.market.sells(id, S2);
        (,, uint128 s3Filled, uint64 s3Id, , ) = l.market.sells(id, S3);
        assertTrue(s2Id < s3Id, "S2's order id is the lower one");
        assertEq(s2Filled, 6, "the earlier order takes the leftover lot");
        assertEq(s3Filled, 3, "the later order does not");
    }

    /// F3: a DAO-chosen transfer validator cannot freeze the market's escrow.
    ///
    /// The defect: the DAO could set a validator at any time, with no notice and no seal, and the
    /// validator saw every market transfer. A refusing validator froze `cancelSell`, the unsold-lot
    /// return in `settle`, and the void round's `claimShares`, while quote claims kept working — so
    /// escrowed Shares could be held hostage. The market is the Shares' named exempt address, and it is
    /// now exempt from the validator for the same reason it is exempt from the transfer lock.
    function test_a_dao_validator_cannot_freeze_the_markets_escrow() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(B2);
        l.market.bid(id, 4, 0);

        RefusingValidator v = new RefusingValidator();
        vm.prank(address(l.dao));
        l.shares.setTransferValidator(address(v));

        // The market's own movements are untouched by the validator...
        vm.prank(S1);
        l.market.cancelSell(id); // escrow returns
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        _toSettle(l, id);
        l.market.settle(id); // 6 unsold lots go back to S1
        (,, uint128 filled, , , ) = l.market.sells(id, S1);
        assertEq(filled, 4, "four lots sold, six returned");

        // ...and a void round's return is not refused either. A second round needs the weekly cadence.
        vm.warp(block.timestamp + 7 days);
        uint256 second = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(second, 3, 0);
        _toVoid(l, second);
        vm.prank(S1);
        l.market.claimShares(second, S1);

        // The validator still governs ordinary transfers: the DAO is exempt from the transfer lock, so
        // its transfer reaches the validator and is refused there.
        vm.prank(address(l.dao));
        vm.expectRevert(bytes("refused"));
        l.shares.transfer(S1, 1);
    }

    /// F4 (measurement): what a full-size round costs to settle, and the order cap it runs into.
    ///
    /// 32 sellers, 32 buyers and 64 price levels. The number logged here is warm and settles in the same
    /// block as the offers (it ran 2.6M gas with the mock policy), so it flatters the real cost: the real
    /// policy's cold, cross-block figure is measured in `SecondaryMarketRealGas` and recorded in the review
    /// packet. The 33rd buyer is refused with `TooManyBuyers`, and because cancellation is free until
    /// bidding closes, someone can fill the buyer slots with throwaway bids and keep honest bidders out for
    /// the whole window. That is a stated limit of the design, not a defect.
    function test_a_full_round_settles_and_a_33rd_buyer_is_shut_out() public {
        address[] memory holders = new address[](32);
        uint256[] memory amounts = new uint256[](32);
        for (uint256 i; i < 32; ++i) {
            holders[i] = address(uint160(0xA000 + i));
            amounts[i] = 10e18;
        }
        Launch memory m = _launch(holders, amounts);
        for (uint256 i; i < 32; ++i) {
            _approve(m, holders[i]);
            m.quote.mint(address(uint160(0xB000 + i)), 1_000_000e6);
            _approve(m, address(uint160(0xB000 + i)));
        }
        vm.prank(address(m.dao));
        m.market.configureListing(true, 1_600, 1_600 + 64 * 100, 64);
        uint256 id = m.market.openRound();
        for (uint256 i; i < 32; ++i) {
            vm.prank(holders[i]);
            m.market.sell(id, 7, uint16(i * 2));
            vm.prank(address(uint160(0xB000 + i)));
            m.market.bid(id, 5, uint16(64 - i));
        }
        m.quote.mint(address(0xC0FFEE), 1_000_000e6);
        _approve(m, address(0xC0FFEE));
        vm.prank(address(0xC0FFEE));
        vm.expectRevert(SecondaryMarket.TooManyBuyers.selector);
        m.market.bid(id, 1, 64);

        (,,,, uint64 closesAt,,,,,,) = m.market.rounds(id);
        vm.warp(closesAt);
        uint256 g = gasleft();
        m.market.settle(id);
        emit log_named_uint("settle gas, 32 sellers x 32 buyers x 64 levels", g - gasleft());
    }
}

/// @notice The review's regressions against the stood-in policy.
contract SecondaryMarketReview is SecondaryMarketReviewCases {}

/// @notice The same regressions against a real `ContributorKitV2` launch and the real policy hooks.
contract SecondaryMarketReviewReal is SecondaryMarketReviewCases {
    function _useRealKit() internal pure override returns (bool) {
        return true;
    }
}
