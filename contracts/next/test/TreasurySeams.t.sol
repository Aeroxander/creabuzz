// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RoundsBase} from "./helpers/RoundsBase.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice The Treasury's seams that only the Launcher (its `salePath`) may use, called by anyone else.
contract TreasurySeamsTest is RoundsBase {
    function test_onlyTheLauncherWindsDown() public {
        address[3] memory who = [founder, stranger, opener];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(Treasury.NotAllowed.selector);
            t.markWoundDown();
        }
        assertFalse(t.woundDown());
        vm.prank(founder);
        launcher.windDown(key); // the Launcher's own path still works
        assertTrue(t.woundDown());
    }

    /// @dev One reserve sale at a time, exits wait while it is out, and only the Launcher opens and closes it.
    function test_reserveSale_oneAtATime_andExitsWaitWhileItIsOut() public {
        _world();
        vm.prank(salePath);
        t.releaseReserve(salePath, 1000 * SHARE);
        assertTrue(t.reserveSaleOpen());
        vm.prank(salePath);
        vm.expectRevert(Treasury.ReserveSaleState.selector);
        t.releaseReserve(salePath, 1000 * SHARE);
        vm.prank(alice);
        vm.expectRevert(Treasury.SaleNotClosed.selector);
        t.handBack(1000 * SHARE);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.closeReserveSale();
        vm.prank(salePath);
        t.closeReserveSale();
        vm.prank(alice);
        t.handBack(1000 * SHARE);
        vm.prank(salePath);
        vm.expectRevert(Treasury.ReserveSaleState.selector);
        t.closeReserveSale(); // none is out
    }
}
