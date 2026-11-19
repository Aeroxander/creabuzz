// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";

/// @notice The first backer into a project that already holds money (what the Team is left with after the last backer left, or
/// outside money paid in before the first backer). Found by the invariant run: the first backer used to be credited the whole
/// payment as paid-in although the price charged them for a slice of that money, so taking out at once paid back the payment
/// and the slice. The credit is now the payment less the price of the slice.
contract EmptyJoinTest is StackBase {
    /// @dev The Team's leftover after the last backer takes out: a backer who then joins and leaves at once gets back what
    /// they paid (less the fee), within the pull of the quote offset, and the Team's leftover is not eaten.
    function test_aFirstBackerIntoTheTeamsLeftoverCannotTakeASliceOfItForNothing() public {
        uint256 n0 = _join(alice, 10_000e6);
        _revenue(carol, 5000e6);
        vm.warp(block.timestamp + UNIT);
        _checkIn();
        _leave(alice, n0); // alice takes her paid-in and her share of the surplus; the Team's share stays behind
        assertEq(shares.totalSupply(), 0, "no backers");
        assertEq(t.paidIn(), 0, "no paid-in");
        uint256 leftover = t.pot();
        assertGt(leftover, 2000e6, "the Team's slice of the outside money is still in the pot");

        uint256 paid = 10_000e6;
        (uint256 q, uint256 takeOutNow,,) = t.quoteBack(paid);
        uint256 n = _join(bob, paid);
        assertEq(n, q);
        uint256 net = paid - t.feeFor(paid);
        assertLe(takeOutNow, net + 100_000, "a first backer gets back what they paid, not a slice of the Team's money");
        assertGe(takeOutNow + 100_000, net, "and not much less either: they are not charged twice");
        // the Team keeps its leftover: what is above paid-in is shared by all Shares, the Team's part of it at least what it was
        uint256 teamGets = t.teamValue() * team.totalSupply() / 1e18;
        assertGe(teamGets + 100_000, leftover, "the Team's claim is not eaten");
    }

    /// @dev Outside money paid in before anyone has backed the project belongs to the Team Shares; the first backer pays for
    /// a slice of it in the price and does not get that slice back as paid-in.
    function test_outsideMoneyBeforeTheFirstBackerIsNotAFreeSlice() public {
        _revenue(carol, 20_000e6);
        vm.warp(block.timestamp + UNIT / 2);
        _checkIn();
        uint256 paid = 100_000e6;
        (, uint256 takeOutNow,,) = t.quoteBack(paid);
        _join(alice, paid);
        uint256 net = paid - t.feeFor(paid);
        assertLe(takeOutNow, net + 100_000, "no more than they paid in, within the offset");
        assertLe(t.paidIn(), net, "paid-in is at most the net payment");
        assertLt(t.paidIn(), net, "and the price of the slice was not paid-in");
    }

    /// @dev With nothing in the project the whole payment is paid-in, as before: 98 of 100 comes back.
    function test_aPristineFirstJoinStillGetsItsWholePaymentAsPaidIn() public {
        _join(alice, 100e6);
        assertEq(t.paidIn(), 98e6);
    }
}
