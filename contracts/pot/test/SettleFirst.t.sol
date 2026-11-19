// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {PotBase} from "./helpers/PotBase.sol";
import {PlayDollar} from "../src/PlayDollar.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {TreasuryHarness} from "./helpers/TreasuryHarness.sol";

/// @notice Design section 2.3 and section 7: `settle()` is the FIRST step of every action. Each test asserts that calling
/// the action cold (no settle since the clock moved) gives exactly what calling `settle()` and then the action gives, with
/// the allowance and the arriving money both in motion. Each fails when the `_settle()` of that entry point is removed: `leave`,
/// `leaveTeam`, `onTransferReceived` (the one-signature join) and `addRevenue`.
contract SettleFirstTest is PotBase {
    function _prepare() internal {
        _join(alice, 100_000e6);
        _join(bob, 100_000e6);
        _revenue(carol, 20_000e6);
        vm.warp(block.timestamp + 3 days + 17 minutes); // no settle since the revenue; allowance and arrival both moved
    }

    function test_leaveIsPaidOnTheSettledPot() public {
        _prepare();
        uint256 n = shares.balanceOf(bob);
        (uint256 quoted,,) = t.quoteTakeOut(bob, n);
        uint256 id = vm.snapshotState();
        t.settle();
        uint256 afterSettle = _leave(bob, n);
        vm.revertToState(id);
        uint256 cold = _leave(bob, n);
        assertEq(cold, afterSettle, "a take-out must settle first");
        assertEq(cold, quoted, "and equal the quote");
        // and the box was not paid out to the leaver
        assertGt(t.box(), 0);
    }

    function test_leaveTeamIsPaidOnTheSettledPot() public {
        _prepare();
        vm.prank(address(vester));
        team.transfer(dave(), 1_000_000e18);
        _force(t.pot() + 60_000e6, t.paidIn(), t.box(), t.arriving(), uint64(t.arrivalEnd())); // surplus above paid-in
        uint256 id = vm.snapshotState();
        t.settle();
        vm.prank(dave());
        uint256 afterSettle = t.leaveTeam(1_000_000e18, 0, dave());
        vm.revertToState(id);
        vm.prank(dave());
        uint256 cold = t.leaveTeam(1_000_000e18, 0, dave());
        assertGt(cold, 0);
        assertEq(cold, afterSettle, "a Team take-out must settle first");
    }

    /// `addRevenue` merges a new payment into the stream with `arrivalEnd - now`: without a settle first, a payment that
    /// has fully arrived but was never settled makes that subtraction underflow and the call revert (a payer is refused).
    function test_addRevenueAfterTheFirstPaymentFullyArrivedNeedsNoSettleFirst() public {
        _join(alice, 100_000e6);
        _revenue(carol, 10_000e6);
        vm.warp(block.timestamp + 10 days); // 10 days > one unit: all of it has arrived, nobody settled
        _revenue(carol, 5000e6);
        assertEq(t.arriving(), 5000e6);
        assertEq(t.pot(), 98_000e6 + 10_000e6 - t.box());
    }

    /// Mid-stream, the merge must start from the settled state.
    function test_addRevenueMergesFromTheSettledState() public {
        _join(alice, 100_000e6);
        _revenue(carol, 10_000e6);
        vm.warp(block.timestamp + 3 days + 5 minutes);
        uint256 id = vm.snapshotState();
        t.settle();
        _revenue(carol, 5000e6);
        (uint256 arr, uint64 end, uint256 pot) = (t.arriving(), t.arrivalEnd(), t.pot());
        vm.revertToState(id);
        _revenue(carol, 5000e6);
        assertEq(t.arriving(), arr);
        assertEq(uint256(t.arrivalEnd()), uint256(end));
        assertEq(t.pot(), pot);
    }

    function dave() internal returns (address) {
        return makeAddr("dave");
    }

    /// Design 2.1.1: the price is worked out inside the join transaction AFTER the allowance has moved out. The
    /// one-signature join (`onTransferReceived`) must settle first like `join` does.
    function test_payAndCallJoinIsPricedAfterTheAllowanceHasMovedOut() public {
        PlayDollar pd = new PlayDollar(address(this));
        (TreasuryHarness tr, ShareToken sh,,) = _launch(IERC20(address(pd)), POOL, 1000, 200, UNIT);
        pd.mint(alice, 100_000e6);
        vm.startPrank(alice);
        pd.approve(address(tr), 100_000e6);
        tr.join(100_000e6, 0, alice);
        vm.stopPrank();

        vm.warp(block.timestamp + 5 days); // inside the check-in window; nobody has settled since the join
        (uint256 quoted,,,) = tr.quoteBack(10_000e6); // the view settles in memory
        pd.mint(bob, 10_000e6);
        vm.prank(bob);
        pd.transferAndCall(address(tr), 10_000e6, abi.encode(uint256(0), address(0)));
        assertEq(sh.balanceOf(bob), quoted, "the one-signature join must give exactly what the quote showed");
    }
}
