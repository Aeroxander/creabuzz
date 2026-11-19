// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";

/// @notice What a server needs to rebuild the task side of a project from logs alone, run as a test: a ledger reads only the
/// events of the Treasury and of its TaskBook, in order, and after every step of a mixed run (announce, cancel, take, a part
/// payment, a reject, a task that runs out, a lapse, a wind-down that sweeps what is open) it must hold what the contracts
/// hold: the pot, the money set aside, the notes owed, every task's state and money, the open count and the 28-day sum of
/// takes. (The longer random run with every other kind of step is `EventsRebuild`.)
contract TasksRebuildTest is StackBase {
    bytes32 internal constant WHAT = keccak256("a task");
    address internal worker = makeAddr("worker");

    uint256 internal lPot;
    uint256 internal lLocked;
    uint256 internal lNotesOwed;
    uint256 internal lOpen;
    uint256 internal lNext = 1;
    mapping(uint256 => uint8) internal lState;
    mapping(uint256 => uint256) internal lSetAside;
    mapping(uint256 => uint256) internal lReturned;
    uint256[] internal takeAt;
    uint256[] internal takeBps;
    uint256 internal eventsRead;

    function _word(bytes memory d, uint256 i) internal pure returns (uint256 r) {
        assembly {
            r := mload(add(d, add(32, mul(32, i))))
        }
    }

    function _apply(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            bytes32 sig = logs[i].topics[0];
            bytes memory d = logs[i].data;
            if (logs[i].emitter == address(t)) {
                if (sig == Treasury.Joined.selector) {
                    lPot = _word(d, 4);
                } else if (sig == Treasury.Settled.selector) {
                    lPot = _word(d, 3);
                } else if (sig == Treasury.Left.selector) {
                    lPot = _word(d, 3);
                } else if (sig == Treasury.WoundDown.selector) {
                    lPot += _word(d, 2); // the box returns
                } else if (sig == Treasury.TaskMoney.selector) {
                    (lPot, lLocked, lNotesOwed) = (_word(d, 3), _word(d, 4), _word(d, 5));
                } else {
                    continue;
                }
                ++eventsRead;
            } else if (logs[i].emitter == address(_book())) {
                uint256 serial = uint256(logs[i].topics[1]);
                if (sig == TaskBook.TaskAnnounced.selector) {
                    lState[serial] = uint8(TaskBook.State.Announced);
                    (lOpen, lNext) = (_word(d, 7), serial + 1);
                } else if (sig == TaskBook.TaskTaken.selector) {
                    lState[serial] = uint8(TaskBook.State.Taken);
                    lSetAside[serial] = _word(d, 1);
                    takeBps.push(_word(d, 2));
                    takeAt.push(_word(d, 3));
                    lOpen = _word(d, 6);
                } else if (sig == TaskBook.TaskResolved.selector) {
                    lState[serial] = uint8(_word(d, 0));
                    lReturned[serial] = _word(d, 2);
                    lOpen = _word(d, 6);
                } else {
                    continue;
                }
                ++eventsRead;
            }
        }
    }

    function _same(string memory step) internal view {
        TaskBook b = _book();
        assertEq(lPot, t.pot(), string.concat(step, ": pot"));
        assertEq(lLocked, t.locked(), string.concat(step, ": money set aside"));
        assertEq(lNotesOwed, t.notesOwed(), string.concat(step, ": notes owed"));
        assertEq(lOpen, b.openCount(), string.concat(step, ": open tasks"));
        assertEq(lNext, b.nextSerial(), string.concat(step, ": next serial"));
        uint256 window;
        for (uint256 i; i < takeAt.length; ++i) {
            if (takeAt[i] + 4 * uint256(UNIT) > vm.getBlockTimestamp()) window += takeBps[i];
        }
        assertEq(window, b.windowSumBps(), string.concat(step, ": the 28-day sum of takes"));
        for (uint256 s = 1; s < lNext; ++s) {
            TaskBook.Task memory k = b.taskOf(uint64(s));
            assertEq(lState[s], uint8(k.state), string.concat(step, ": state of task ", vm.toString(s)));
            assertEq(lSetAside[s], k.locked, string.concat(step, ": money of task ", vm.toString(s)));
            assertEq(lReturned[s], k.returned, string.concat(step, ": returned by task ", vm.toString(s)));
        }
    }

    function _check(string memory step) internal {
        t.settle(); // anyone may; it is what a server's own poke would be
        _apply(vm.getRecordedLogs());
        _same(step);
    }

    function _announce(uint16 bps, uint256 max, address payee) internal returns (uint64 serial) {
        vm.prank(founder);
        serial = t.announceTask(WHAT, payee, max, bps);
    }

    function _keepAlive(uint256 ts) internal {
        _checkIn();
        uint256 at = vm.getBlockTimestamp();
        while (at + 10 days < ts) {
            at += 6 days; // an absolute time: the optimizer may cache a repeated block.timestamp
            vm.warp(at);
            _checkIn();
        }
        vm.warp(ts);
    }

    function test_aLedgerOfEventsAloneRebuildsTheTaskSideStepByStep() public {
        vm.recordLogs();
        _join(alice, 100_000e6);
        _check("join");
        uint64 a = _announce(100, 500e6, worker);
        uint64 b = _announce(200, 1500e6, worker);
        uint64 c = _announce(300, 2000e6, worker); // cancelled
        uint64 d = _announce(100, 400e6, address(0)); // open: a stranger takes it
        uint64 e = _announce(100, 300e6, worker); // never taken
        _check("announce five");
        vm.prank(founder);
        t.cancelTask(c);
        _check("cancel one");
        _keepAlive(_book().taskOf(b).noticeEnd);
        _check("wait for the notices");
        vm.prank(worker);
        t.takeTask(a, 0);
        _check("take a");
        vm.prank(worker);
        t.takeTask(b, 0);
        _check("take b");
        vm.prank(stranger);
        t.takeTask(d, 0);
        _check("take d, an open task");
        assertEq(_book().windowSumBps() > 0, true);
        vm.prank(founder);
        t.acceptTask(a, 200e6);
        _check("pay a in part");
        vm.prank(founder);
        t.rejectTask(b);
        _check("reject b");
        // d runs out; e lapsed long ago
        _keepAlive(_book().taskOf(d).deadline + 1);
        _check("d ran out and e lapsed");
        assertEq(lState[d], uint8(TaskBook.State.Returned));
        assertEq(lState[e], uint8(TaskBook.State.Lapsed));
        // a wind-down sweeps what is still open
        uint64 f = _announce(100, 100e6, worker);
        uint64 g = _announce(100, 100e6, worker);
        _keepAlive(_book().taskOf(f).noticeEnd);
        vm.prank(worker);
        t.takeTask(f, 0);
        _check("take f");
        vm.prank(founder);
        t.windDown();
        _check("wind-down");
        assertEq(lState[f], uint8(TaskBook.State.Returned));
        assertEq(lState[g], uint8(TaskBook.State.Cancelled));
        assertEq(lLocked, 0);
        assertGt(eventsRead, 20);
        // and the rolling sum decays in the ledger as it does in the book
        vm.warp(vm.getBlockTimestamp() + 30 days);
        _check("30 days on");
        assertEq(_book().windowSumBps(), 0);
    }
}
