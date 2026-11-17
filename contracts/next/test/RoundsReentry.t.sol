// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RoundsBase} from "./helpers/RoundsBase.sol";
import {Rounds} from "../src/Rounds.sol";
import {IQuoteHook} from "./mocks/QuoteToken.sol";

/// @dev A backer that calls back into the Rounds when dollars reach it (a dollar token with call-backs makes this possible).
contract ReentrantBacker is IQuoteHook {
    Rounds internal immutable R;
    bytes public reentry;
    bool public tried;
    bytes public reason;

    constructor(Rounds r) {
        R = r;
    }

    function arm(bytes calldata data) external {
        reentry = data;
    }

    function act(bytes calldata data) external {
        (bool ok, bytes memory ret) = address(R).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function onQuoteTransfer(address, address to, uint256, bool after_) external {
        if (!after_ || to != address(this) || tried || reentry.length == 0) return;
        tried = true;
        (bool ok, bytes memory ret) = address(R).call(reentry);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

/// @notice The Rounds' re-entry lock. Every function also writes its state before it sends dollars, so a call-back finds the
/// position already updated; the lock is the second line, and this test shows it is the one that answers.
contract RoundsReentryTest is RoundsBase {
    function test_aCallBackIntoTheRoundsWhileDollarsAreSentIsRefused() public {
        _checkIn();
        uint256 id = _openRound();
        ReentrantBacker b = new ReentrantBacker(rd);
        usd.mint(address(b), 300 * DOLLAR);
        vm.prank(address(b));
        usd.approve(address(rd), type(uint256).max);
        b.act(abi.encodeCall(Rounds.ask, (id, 200 * DOLLAR)));
        usd.setHooked(address(b), true);
        // while the lowered dollars come back, the backer asks again from inside the transfer
        b.arm(abi.encodeCall(Rounds.ask, (id, 100 * DOLLAR)));
        vm.expectRevert(Rounds.Reentrancy.selector);
        b.act(abi.encodeCall(Rounds.lower, (id, 100 * DOLLAR)));
        assertEq(rd.positionOf(id, address(b)).ask, 200 * DOLLAR, "nothing changed");
    }
}

/// @notice The shared release clock across the Treasury's own changes of the window: the auction's first money opens a new
/// check-in window, and the Rounds must have counted the lapse before it did.
contract RoundsClockTest is RoundsBase {
    function test_theAuctionsFirstMoneyDoesNotPayTheRoundsForALapse() public {
        uint256 id = _round(alice, 1820 * DOLLAR); // 8.2 a day while checked in
        uint256 closedAt = rd.roundOf(id).activeAtClose;
        vm.warp(_now() + 60 days); // nobody checks in: 13 more active days count (the window was opened a day before the close)
        _sale(7500 * DOLLAR); // the auction's money arrives and its first split renews the window
        assertEq(rd.activeNow() - closedAt, 13 days, "the 47 lapsed days stay lost");
        vm.warp(_now() + 1 days);
        assertEq(rd.activeNow() - closedAt, 14 days, "and the clock runs again from the new window");
    }
}
