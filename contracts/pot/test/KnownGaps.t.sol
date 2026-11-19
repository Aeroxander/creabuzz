// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";

/// @notice A KNOWN GAP, written down with its size so it cannot grow unseen (POT-STEP1A-REPORT.md, "Review fixes", declined).
/// A bot that sees a member's own-exit announcement before it lands joins one transaction earlier, stays until the burn runs
/// (one time unit), and takes out. The join price counts a burn only from its announcement on, so the bot buys at the full
/// Team Share count and shares in the burn afterwards. It is the same open gap the design admits for outside payments
/// (2.5), larger here because the burned part is the whole unvested pool. A join after the announce gains nothing.
contract KnownGapsTest is StackBase {
    address internal bot = makeAddr("bot");

    function _setup() internal returns (uint256 id) {
        _use(_launch(founder, "p2", 0, POOL));
        _join(bob, 100_000e6);
        id = _grant(alice, 9_000_000e18);
        _revenue(carol, 200_000e6);
        vm.warp(block.timestamp + 8 days);
        _checkIn();
    }

    function _botRun(bool beforeAnnounce, uint256 m, uint256 id) internal returns (int256 net, uint256 potBefore) {
        usd.mint(bot, m);
        vm.startPrank(bot);
        usd.approve(address(t), m);
        uint256 n;
        if (!beforeAnnounce) {
            vm.stopPrank();
            vm.prank(alice);
            v.announceForfeit(id);
            vm.startPrank(bot);
        }
        n = t.join(m, 0, bot);
        vm.stopPrank();
        if (beforeAnnounce) {
            vm.prank(alice);
            v.announceForfeit(id);
        }
        vm.warp(block.timestamp + 7 days + 1);
        _checkIn();
        v.execute(id);
        potBefore = t.pot();
        vm.prank(bot);
        uint256 cash = t.leave(n, 0, bot);
        net = int256(cash) - int256(m);
    }

    function test_joiningOneTransactionBeforeAForfeitAnnounceCapturesPartOfTheBurn_knownGap() public {
        uint256 snap = vm.snapshotState();
        uint256 id = _setup();
        (int256 netBefore,) = _botRun(true, 1_000_000e6, id);
        vm.revertToState(snap);
        id = _setup();
        (int256 netAfter,) = _botRun(false, 1_000_000e6, id);
        // the gap: a gain of about 53,483 on a 1,000,000 join (5.3%), only with 9M of the 10M pool unvested and burning
        assertGt(netBefore, 0, "the gap exists");
        assertLt(netBefore, 60_000e6, "and does not grow beyond what the report says");
        assertLt(netAfter, 0, "a join after the announce loses the fee");
    }
}
