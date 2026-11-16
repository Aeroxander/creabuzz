// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "./helpers/Base.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice The Treasury's abandoned state, which only the project's Finisher can enter: the sale phase is over with no pool, the
/// Vester's clock starts, and the money that was meant for the pool goes wholly to the floor. The Finisher's use of it is tested on
/// the real route in `FinishAttacks.t.sol`; here the Treasury's own rules are.
contract TreasuryAbandonTest is Base {
    function test_markAbandoned_onlyTheOpener_onceAndNotAfterThePoolOpened() public {
        vm.prank(alice);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.markAbandoned();
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.markAbandoned();
        vm.prank(opener);
        t.markAbandoned();
        assertTrue(t.abandoned());
        assertTrue(t.poolOpen(), "the sale phase is over");
        assertGt(v.start(), 0, "the Vester's clock started");
        vm.prank(opener);
        vm.expectRevert(Treasury.PoolAlreadyOpen.selector);
        t.markAbandoned();
        vm.prank(opener);
        vm.expectRevert(Treasury.PoolAlreadyOpen.selector);
        t.markPoolOpen();
    }

    function test_markAbandoned_isRefusedOnceThePoolIsOpen() public {
        _openPool();
        vm.prank(opener);
        vm.expectRevert(Treasury.PoolAlreadyOpen.selector);
        t.markAbandoned();
        assertFalse(t.abandoned());
    }

    function test_settleToFloor_onlyTheOpener_onlyWhenAbandoned_andOnlyWhatArrived() public {
        _arrive(1000 * DOLLAR);
        vm.prank(opener);
        vm.expectRevert(Treasury.NotAbandoned.selector); // a pool that exists gets a 15 : 60 split, never a floor-only one
        t.settleToFloor(1);
        vm.prank(opener);
        t.markAbandoned();
        vm.prank(alice);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.settleToFloor(1);
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.settleToFloor(1);
        vm.startPrank(opener);
        vm.expectRevert(Treasury.BadInput.selector);
        t.settleToFloor(0);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotArrived.selector, 1001 * DOLLAR, 1000 * DOLLAR));
        t.settleToFloor(1001 * DOLLAR);
        t.settleToFloor(400 * DOLLAR);
        vm.stopPrank();
        assertEq(t.melting(), 400 * DOLLAR);
        assertEq(t.spendable(), 0, "none of it is spendable");
        assertTrue(t.settled(), "the check-in window opened with the first money");
        assertEq(t.meltRemaining(), 365 days);
        // the rest takes the normal split
        t.settle(600 * DOLLAR);
        assertEq(t.spendable(), 120 * DOLLAR);
        assertEq(t.melting(), 400 * DOLLAR + 480 * DOLLAR);
        assertEq(_buckets(), 1000 * DOLLAR);
    }

    function test_afterAnAbandon_theSaleCanCloseAndHoldersCanExit() public {
        _arrive(7500 * DOLLAR);
        vm.startPrank(opener);
        t.markAbandoned();
        t.settleToFloor(1500 * DOLLAR);
        vm.stopPrank();
        t.settle(6000 * DOLLAR);
        assertEq(t.spendable(), 1200 * DOLLAR);
        assertEq(t.melting(), 6300 * DOLLAR);
        _buy(alice, 100_000_000 * SHARE);
        _approveAll(alice);
        _closeSale();
        assertTrue(t.saleClosed());
        uint256 paid = _handBack(alice, 100_000_000 * SHARE);
        assertEq(paid, 1260 * DOLLAR * 95 / 100, "a fifth of the floor (100M of the 500M counted), less the 5% fee");
    }

    function test_afterAnAbandon_giftsAreFreeAtOnceInsideTheMonthlyCap() public {
        vm.prank(founder);
        t.giveShares(alice, 1000 * SHARE);
        assertEq(shares.balanceOf(alice), 0, "before: a gift goes to the Vester");
        vm.prank(opener);
        t.markAbandoned();
        vm.prank(founder);
        t.giveShares(bob, 1000 * SHARE);
        assertEq(
            shares.balanceOf(bob), 1000 * SHARE, "after: the sale phase is over, so a gift goes straight to the person"
        );
    }
}
