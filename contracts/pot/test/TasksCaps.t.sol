// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "oz5/utils/math/Math.sol";
import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";

/// @notice The three caps of the task queue, the same for everyone: 5% of the pot a task, 10% of the pot taken in any rolling
/// 28 days, eight open tasks. Includes the must-bind test 4 of the design (announce, take late, announce again at day 30, take
/// early: the 28-day sum of takes never passes the cap) with its numbers, and a brute-force fuzz of the same claim. The project
/// has no allowance (rate 0), so the pot is exactly what the test forced it to be.
contract TasksCapsTest is PotBase {
    bytes32 internal constant WHAT = keccak256("a task");
    address internal worker = makeAddr("worker");

    function setUp() public override {
        super.setUp();
        _relaunch(POOL, 0);
        _join(alice, 100_000e6);
        _force(100_000e6, 100_000e6, 0, 0, 0);
    }

    function _announce(uint16 bps, uint256 max) internal returns (uint64 serial) {
        vm.prank(founder);
        serial = t.announceTask(WHAT, worker, max, bps);
    }

    function _warpAlive(uint256 ts) internal {
        if (ts <= vm.getBlockTimestamp()) return; // time only runs forward
        _checkIn();
        uint256 at = vm.getBlockTimestamp();
        while (at + 10 days < ts) {
            at += 6 days; // an absolute time: the optimizer may cache a repeated vm.getBlockTimestamp()
            vm.warp(at);
            _checkIn();
        }
        vm.warp(ts);
    }

    function _take(uint64 serial) internal returns (uint256 amount) {
        vm.prank(worker);
        amount = t.takeTask(serial, 0);
    }

    function _window() internal view returns (uint256) {
        return _book().windowSumBps();
    }

    // ---- 5% a task

    function test_noTaskSetsAsideMoreThanFivePercentOfThePot() public {
        uint64 a = _announce(500, type(uint128).max);
        _warpAlive(_book().taskOf(a).noticeEnd);
        assertEq(_take(a), 5000e6, "a task that asks for everything it may gets 5% of 100,000");
        vm.prank(founder);
        vm.expectRevert(TaskBook.ShareTooBig.selector);
        t.announceTask(WHAT, worker, 1000e6, 501);
    }

    // ---- eight open tasks

    function test_aNinthOpenTaskWaitsForASlotAndALapsedTaskFreesItsSlot() public {
        for (uint256 i; i < 8; ++i) {
            _announce(100, 1000e6);
        }
        vm.prank(founder);
        vm.expectRevert(TaskBook.TooManyOpen.selector);
        t.announceTask(WHAT, worker, 1000e6, 100);
        // the take windows end: a settle sweeps all eight, so a new one is possible
        _warpAlive(_book().taskOf(1).expiresAt);
        _checkIn();
        assertEq(_book().openCount(), 0, "lapsed tasks leave inside every settle");
        assertEq(_announce(100, 1000e6), 9);
    }

    function test_theEightSlotsCycledManyTimesNeverReuseASerial() public {
        uint64 last;
        for (uint256 cycle; cycle < 20; ++cycle) {
            for (uint256 i; i < 8; ++i) {
                uint64 s = _announce(100, 1000e6);
                assertEq(s, last + 1, "serials rise by one");
                last = s;
            }
            vm.prank(founder);
            vm.expectRevert(TaskBook.TooManyOpen.selector);
            t.announceTask(WHAT, worker, 1000e6, 100);
            _warpAlive(_book().taskOf(last).expiresAt); // everything lapses
            _checkIn();
            assertEq(_book().openCount(), 0);
        }
        assertEq(_book().nextSerial(), 161);
    }

    // ---- 10% in any 28 days

    function test_eightTasksOfAboutOnePointTwoFivePercentPassAndTheNinthIsBlocked() public {
        uint64[8] memory ids;
        for (uint256 i; i < 8; ++i) {
            ids[i] = _announce(125, 1_000_000e6);
        }
        uint256 at = _book().taskOf(ids[0]).noticeEnd;
        _warpAlive(at);
        for (uint256 i; i < 8; ++i) {
            _take(ids[i]);
        }
        assertEq(_window(), 1000, "eight takes of 125 ten-thousandths fill the cap exactly");
        // each is paid a unit of work, so each keeps its take counted (a task that ends unpaid gives it back)
        vm.startPrank(founder);
        for (uint256 i = 1; i < 8; ++i) {
            t.acceptTask(ids[i], 1);
        }
        vm.stopPrank();
        // a slot and a ninth task: its take is refused while those eight are inside 28 days
        vm.prank(founder);
        t.acceptTask(ids[0], 1); // frees a slot; a task that was paid keeps its take counted (a rejected one would give it back)
        assertEq(_window(), 1000);
        uint64 ninth = _announce(125, 1_000_000e6);
        _warpAlive(_book().taskOf(ninth).noticeEnd);
        assertLt(vm.getBlockTimestamp(), at + 4 * uint256(UNIT));
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.CapReached.selector, 1000, 125, 1000));
        t.takeTask(ninth, 0);
    }

    function test_aTakeTheCapBlocksFailsAndTheTaskLapsesWithNothingMovedAndCanBeAnnouncedAgain() public {
        uint64[8] memory ids;
        for (uint256 i; i < 8; ++i) {
            ids[i] = _announce(125, 1_000_000e6);
        }
        _warpAlive(_book().taskOf(ids[0]).noticeEnd);
        for (uint256 i; i < 7; ++i) {
            _take(ids[i]);
        }
        // the eighth would be the last 1.25% (the sum is 8 x 125): fine; a ninth is what is blocked, so use up the room first
        _take(ids[7]);
        assertEq(_window(), 1000);
        vm.startPrank(founder);
        for (uint256 i; i < 8; ++i) {
            t.acceptTask(ids[i], 1); // paid a unit each, so every take stays counted
        }
        vm.stopPrank();
        uint64 ninth = _announce(125, 1_000_000e6);
        _warpAlive(_book().taskOf(ninth).noticeEnd);
        uint256 potBefore = t.pot();
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.CapReached.selector, 1000, 125, 1000));
        t.takeTask(ninth, 0);
        // the window passes: it lapses and nothing has moved
        _warpAlive(_book().taskOf(ninth).expiresAt);
        t.settle();
        assertEq(uint8(_book().taskOf(ninth).state), uint8(TaskBook.State.Lapsed));
        assertGe(t.pot(), potBefore, "nothing was taken");
        assertEq(_announce(125, 1_000_000e6), ninth + 1, "the runner can announce it again");
    }

    function test_flashMoneyBeforeATakeCannotRaiseWhatTheDollarMaximumAllows() public {
        uint64 a = _announce(500, 2000e6);
        _warpAlive(_book().taskOf(a).noticeEnd);
        // the pot grows tenfold just before the take (a flash join, an outside payment, a donation): the stated dollars still bind
        _force(1_000_000e6, 1_000_000e6, 0, 0, 0);
        assertEq(_take(a), 2000e6, "5% of 1,000,000 is 50,000, but the task said 2,000");
        // and when the share binds, it is the share of the pot the holders have then: nothing more
        uint64 b = _announce(500, 1_000_000e6);
        _warpAlive(_book().taskOf(b).noticeEnd);
        t.settle(); // the first task ran out and its money is back
        uint256 pot = t.pot();
        assertEq(_take(b), pot * 500 / 10_000);
    }

    /// @dev Review fix (a stranger could burn the cap for nothing): a take that ended with nothing paid to its worker moved no
    /// money out of the project, so it stops counting; a take that was paid, even by a dollar, keeps counting.
    function test_theCapIsGivenBackByRejectAndExpiryButNotByAPayment() public {
        uint64 a = _announce(300, 1_000_000e6);
        uint64 b = _announce(300, 1_000_000e6);
        uint64 c = _announce(300, 1_000_000e6);
        _warpAlive(_book().taskOf(a).noticeEnd);
        _take(a);
        _take(b);
        _take(c);
        assertEq(_window(), 900);
        vm.prank(founder);
        t.rejectTask(a);
        assertEq(_window(), 600, "rejected: its 300 is given back");
        vm.prank(founder);
        t.acceptTask(b, 1);
        assertEq(_window(), 600, "paid a dollar: still counted");
        vm.warp(_book().taskOf(c).deadline);
        t.settle();
        assertEq(uint8(_book().taskOf(c).state), uint8(TaskBook.State.Returned));
        assertEq(_window(), 300, "ran out unpaid: its 300 is given back");
        assertEq(_book().takeRoomBps(), 700);
    }

    /// @dev The attack of the two attack reviews, on the production path: a stranger takes two open 5% tasks the second the
    /// notice ends and uses the whole cap; the runner rejects both; the named worker's 1% task can then be taken.
    function test_aStrangerWhoTakesOpenTasksCannotBurnTheCapOfANamedTask() public {
        address bot = makeAddr("bot");
        vm.startPrank(founder);
        uint64 a = t.announceTask(WHAT, address(0), type(uint128).max, 500);
        uint64 b = t.announceTask(WHAT, address(0), type(uint128).max, 500);
        uint64 legit = t.announceTask(WHAT, worker, 1_000_000e6, 100);
        vm.stopPrank();
        _warpAlive(_book().taskOf(b).noticeEnd);
        vm.startPrank(bot);
        t.takeTask(a, 0);
        t.takeTask(b, 0);
        vm.stopPrank();
        assertEq(_window(), 1000, "the bot used the whole cap");
        vm.startPrank(founder);
        t.rejectTask(a);
        t.rejectTask(b);
        vm.stopPrank();
        assertEq(t.locked(), 0);
        assertEq(_window(), 0, "nothing was paid, so nothing counts");
        _warpAlive(_book().taskOf(legit).noticeEnd);
        assertGt(_take(legit), 0, "the named worker can take the task");
    }

    /// @dev Only the take's own entry is cleared, whatever the order: eight takes at once fill the ring and the cap; they are
    /// rejected one by one in a scrambled order, and after each the window falls by exactly that take's share.
    function test_eachGivenBackTakeClearsOnlyItsOwnEntry() public {
        uint64[8] memory ids;
        for (uint256 i; i < 8; ++i) {
            ids[i] = _announce(125, 1_000_000e6);
        }
        _warpAlive(_book().taskOf(ids[0]).noticeEnd);
        for (uint256 i; i < 8; ++i) {
            _take(ids[i]);
        }
        assertEq(_window(), 1000);
        uint256[8] memory order = [uint256(5), 2, 7, 0, 3, 6, 1, 4];
        for (uint256 i; i < 8; ++i) {
            vm.prank(founder);
            t.rejectTask(ids[order[i]]);
            assertEq(_window(), 1000 - 125 * (i + 1), "the window falls by that take's share only");
        }
        assertEq(t.locked(), 0);
    }

    /// @dev A model of the cap: every take is (time, bps, given back?); the window sum read from the book is the sum of the
    /// takes of the last 28 days that were not given back, over random rounds of announce, take, and one of reject / pay in
    /// part / run out.
    function testFuzz_theWindowSumIsTheTakesNotGivenBack(uint256 seed) public {
        uint256[] memory takenAt = new uint256[](24);
        uint256[] memory kept = new uint256[](24);
        uint256 n;
        for (uint256 round; round < 24; ++round) {
            seed = uint256(keccak256(abi.encode(seed, round)));
            uint16 bps = uint16(1 + (seed % 120));
            uint64 s = _announce(bps, 1_000_000e6);
            _warpAlive(_book().taskOf(s).noticeEnd);
            uint256 room = _book().takeRoomBps();
            if (room < uint256(bps)) {
                // the take counts exactly `bps` here (the pot is whole thousands of ten-thousandths), so the cap refuses it
                vm.prank(worker);
                vm.expectRevert();
                t.takeTask(s, 0);
                continue;
            }
            uint256 before_ = _window();
            _take(s);
            uint256 counted = _window() - before_;
            uint256 how = (seed >> 8) % 3;
            if (how == 0) {
                vm.prank(founder);
                t.rejectTask(s);
                counted = 0;
            } else if (how == 1) {
                vm.prank(founder);
                t.acceptTask(s, 1);
            } else {
                _warpAlive(_book().taskOf(s).deadline);
                t.settle();
                counted = 0;
            }
            takenAt[n] = _book().taskOf(s).takenAt;
            kept[n] = counted;
            ++n;
            uint256 sum;
            for (uint256 i; i < n; ++i) {
                if (takenAt[i] + 4 * uint256(UNIT) > vm.getBlockTimestamp()) sum += kept[i];
            }
            assertEq(_window(), sum, "the book's sum is the sum of the takes not given back");
            assertLe(_window(), 1000);
        }
    }

    function test_announcingAndCancellingInLoopsMovesNoCap() public {
        for (uint256 i; i < 100; ++i) {
            uint64 s = _announce(500, 1_000_000e6);
            vm.prank(founder);
            t.cancelTask(s);
        }
        assertEq(_window(), 0);
        assertEq(_book().nextSerial(), 101);
        uint64 a = _announce(500, 1_000_000e6);
        _warpAlive(_book().taskOf(a).noticeEnd);
        _take(a);
        assertEq(_window(), 500, "only what was taken counts");
    }

    function test_aTakeCountsItsShareOfThePotRoundedUp() public {
        uint64 a = _announce(100, 1e6); // one dollar of a 100,000 pot is a thousandth of a ten-thousandth
        _warpAlive(_book().taskOf(a).noticeEnd);
        assertEq(_take(a), 1e6);
        assertEq(_window(), 1);
    }

    // ---- must-bind 4: announce, take late, announce again at day 30, take early

    function test_mustBind4_theTwentyEightDaySumOfTakesNeverPassesTheCap() public {
        // N = 7 days. 5% tasks A and B announced at day 0: notice 16.5 days, takeable from day 16.5 to day 23.5 (exclusive).
        uint256 day = 1 days;
        uint64 a = _announce(500, 1_000_000e6);
        uint64 b = _announce(500, 1_000_000e6);
        assertEq(_book().taskOf(a).noticeEnd, T0 + 16 * day + 12 hours);
        assertEq(_book().taskOf(a).expiresAt, T0 + 23 * day + 12 hours);
        // both taken on the last second of the window
        uint256 lastSecond = T0 + 23 * day + 12 hours - 1;
        _warpAlive(lastSecond);
        _take(a);
        _take(b);
        assertEq(_window(), 1000, "10% taken");
        // both are paid a unit of work, so their takes stay counted (a task that ends with nothing paid gives its take back)
        vm.startPrank(founder);
        t.acceptTask(a, 1);
        t.acceptTask(b, 1);
        vm.stopPrank();
        // announce C at day 30; its notice ends at day 46.5 and its window runs to day 53.5
        _warpAlive(T0 + 30 * day);
        uint64 c = _announce(500, 1_000_000e6);
        assertEq(_book().taskOf(c).noticeEnd, T0 + 46 * day + 12 hours);
        // take as early as the notice allows: A and B were taken less than 28 days ago
        _warpAlive(T0 + 46 * day + 12 hours);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.CapReached.selector, 1000, 500, 1000));
        t.takeTask(c, 0);
        // still refused one second before they are 28 days old, accepted at the second they are
        uint256 free = lastSecond + 28 * day;
        assertEq(free, T0 + 51 * day + 12 hours - 1);
        _warpAlive(free - 1);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.CapReached.selector, 1000, 500, 1000));
        t.takeTask(c, 0);
        vm.warp(free);
        assertApproxEqAbs(_take(c), 5000e6, 2, "A and B were paid a unit each: the pot is whole to within it");
        assertEq(_window(), 500);
        // what a fixed 28-day window would have done: A and B fall in days 0-27, C in days 28-55: all three would pass (15%)
        assertLt(lastSecond, T0 + 28 * day);
        assertGe(T0 + 46 * day + 12 hours, T0 + 28 * day);
    }

    // ---- brute force: the same claim on random schedules

    /// @dev A random mix of announces, waits, takes (after waiting for the notice) and rejects. After every step the book's
    /// window sum must equal a count made here from the list of takes, and no 28-day window anywhere in the run may hold more
    /// than 10%.
    /// forge-config: default.fuzz.runs = 200
    function testFuzz_noRollingWindowOfTwentyEightDaysEverHoldsMoreThanTenPercent(uint256 seed) public {
        _walk(seed);
    }

    /// @dev The walk really takes, and really runs into the cap, on fixed seeds (so the fuzz above is not idle).
    function test_theRandomWalkTakesAndHitsTheCap() public {
        uint256 takesSum;
        uint256 blockedSum;
        for (uint256 i = 1; i <= 6; ++i) {
            uint256 id = vm.snapshotState();
            (uint256 takes, uint256 blocked) = _walk(i * 7919);
            takesSum += takes;
            blockedSum += blocked;
            vm.revertToState(id);
        }
        assertGt(takesSum, 20, "takes happened");
        assertGt(blockedSum, 0, "and the cap said no at least once");
    }

    /// @dev A take that ended with nothing paid (rejected, or run out and returned) no longer counts in the cap.
    function _givenBack(uint64 serial) internal view returns (bool) {
        TaskBook.State st = _book().taskOf(serial).state;
        return st == TaskBook.State.Rejected || st == TaskBook.State.Returned;
    }

    function _walk(uint256 seed) internal returns (uint256 takes, uint256 blocked) {
        uint256[] memory atList = new uint256[](64);
        uint256[] memory bpsList = new uint256[](64);
        uint64[] memory serialList = new uint64[](64);
        uint256 clock = vm.getBlockTimestamp();
        for (uint256 step; step < 60; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 kind = seed % 4;
            if (kind == 0) {
                if (_book().openCount() < 8) _announce(uint16(1 + (seed >> 8) % 500), 1_000_000e6);
            } else if (kind == 1) {
                clock += 1 hours + (seed >> 8) % (9 days);
                _warpAlive(clock);
            } else if (kind == 2) {
                uint64[] memory open = _book().openSerials();
                if (open.length == 0) continue;
                uint64 s = open[(seed >> 8) % open.length];
                TaskBook.Task memory k = _book().taskOf(s);
                if (k.state == TaskBook.State.Announced && clock < k.noticeEnd) {
                    clock = k.noticeEnd + (seed >> 16) % (2 days);
                    if (clock >= k.expiresAt) clock = k.expiresAt - 1;
                    _warpAlive(clock);
                }
                t.settle(); // so that the pot is the one the take sees
                uint256 potBefore = t.pot();
                vm.prank(worker);
                try t.takeTask(s, 0) returns (uint256 amount) {
                    atList[takes] = clock;
                    bpsList[takes] = Math.ceilDiv(amount * 10_000, potBefore);
                    serialList[takes] = s;
                    ++takes;
                } catch (bytes memory err) {
                    if (bytes4(err) == TaskBook.CapReached.selector) ++blocked;
                }
            } else {
                uint64 s = uint64(1 + (seed >> 8) % (_book().nextSerial()));
                vm.prank(founder);
                if ((seed >> 40) % 2 == 0) {
                    try t.rejectTask(s) {} catch {}
                } else {
                    // one unit paid: the take stays counted
                    try t.acceptTask(s, 1) {} catch {}
                }
            }
            // the book against the independent count
            uint256 counted;
            for (uint256 i; i < takes; ++i) {
                if (atList[i] + 28 days > clock && !_givenBack(serialList[i])) counted += bpsList[i];
            }
            assertEq(_book().windowSumBps(), counted, "the ring counts exactly the takes inside 28 days not given back");
            assertLe(counted, 1000, "never more than 10% in the window");
        }
        // every take's own trailing 28 days
        for (uint256 i; i < takes; ++i) {
            uint256 sum;
            for (uint256 j; j <= i; ++j) {
                if (atList[j] + 28 days > atList[i] && !_givenBack(serialList[j])) sum += bpsList[j];
            }
            assertLe(sum, 1000, "no rolling window of 28 days ever held more than 10%");
        }
        _assertConserved();
    }
}
