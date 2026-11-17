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

    /// @dev A reserve sale takes only reserve Shares: never more than the reserve (the rest is the work pot), never nothing, never
    /// to nobody. The Launcher passes any amount the Council names, so this is the only check.
    function test_reserveSale_neverMoreThanTheReserve_neverNothing_neverToNobody() public {
        _world();
        uint256 left = t.reserve();
        uint256 pot = t.workPot();
        vm.startPrank(salePath);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, left + 1, left));
        t.releaseReserve(salePath, left + 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.releaseReserve(salePath, 0);
        vm.expectRevert(Treasury.BadInput.selector);
        t.releaseReserve(address(0), 1);
        t.releaseReserve(salePath, left);
        vm.stopPrank();
        assertEq(shares.balanceOf(address(t)), pot, "the work pot stays");
    }

    /// @dev "No market" cannot follow a market, even if the Launcher asked.
    function test_noMarket_neverAfterAMarket_evenFromTheLauncher() public {
        _market();
        vm.prank(salePath);
        vm.expectRevert(Treasury.PoolAlreadyOpen.selector);
        t.markNoMarket();
        assertFalse(t.noMarket());
    }
}
