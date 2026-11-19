// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {TaskLedger} from "./helpers/TaskLedger.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";

/// @notice What a server needs to rebuild the task side of a project from logs alone, run as a test: a ledger reads only the
/// events of the Treasury and of its TaskBook, in order, and after every step of a mixed run (announce, cancel, take, exit
/// notes written by take-outs, a part payment, a payment in full that voids the notes, a reject, a task that runs out, note
/// claims, a lapse, a wind-down that sweeps what is open) it must hold what the contracts hold: the pot, the money set aside,
/// the notes owed, every task's state and money, every holder's note, the open count and the 28-day sum of takes. (The longer
/// random run with every other kind of step is `EventsRebuild`.)
contract TasksRebuildTest is TaskLedger {
    bytes32 internal constant WHAT = keccak256("a task");
    address internal worker = makeAddr("worker");

    uint256 internal lPot;
    uint256 internal eventsRead;
    address[] internal holders;
    uint64[] internal serials;

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
                    lPot = _word(d, 3);
                    _applyTaskMoney(d);
                } else {
                    continue;
                }
                ++eventsRead;
            } else if (logs[i].emitter == address(_book())) {
                _applyBook(logs[i]);
            }
        }
    }

    function _same(string memory step) internal view {
        assertEq(lPot, t.pot(), string.concat(step, ": pot"));
        _sameTasks(step, holders, serials);
    }

    function _check(string memory step) internal {
        t.settle(); // anyone may; it is what a server's own poke would be
        _apply(vm.getRecordedLogs());
        _same(step);
    }

    function _announce(uint16 bps, uint256 max, address payee) internal returns (uint64 serial) {
        vm.prank(founder);
        serial = t.announceTask(WHAT, payee, max, bps);
        serials.push(serial);
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
        holders.push(alice);
        holders.push(bob);
        vm.recordLogs();
        uint256 aliceShares = _join(alice, 100_000e6);
        _join(bob, 50_000e6);
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
        assertGt(t.locked(), 0);
        // Alice takes out a third: cash on the pot and a note against each of the three taken tasks
        _leave(alice, aliceShares / 3);
        _check("alice takes out, with notes");
        assertGt(t.notesOwed(), 0, "the take-out wrote notes");
        assertGt(_book().noteOf(a, alice), 0);
        vm.prank(founder);
        t.acceptTask(a, 200e6);
        _check("pay a in part");
        t.claimNote(a, alice);
        _check("claim the note against a");
        vm.prank(founder);
        t.rejectTask(b);
        _check("reject b");
        // Bob takes out half while d is still open; then d runs out and e lapsed long ago
        _leave(bob, shares.balanceOf(bob) / 2);
        _check("bob takes out, with a note against d");
        _keepAlive(_book().taskOf(d).deadline + 1);
        _check("d ran out and e lapsed");
        assertEq(lTask[d].state, uint8(TaskBook.State.Returned));
        assertEq(lTask[e].state, uint8(TaskBook.State.Lapsed));
        t.claimNote(b, alice);
        _check("claim the note against b, which was rejected");
        t.claimNote(d, bob);
        _check("claim bob's note against d, which ran out");
        t.claimNote(d, alice);
        _check("claim alice's note against d, the last one: the rounding goes to the pot");
        // a task paid in full voids its notes
        uint64 f = _announce(100, 100e6, worker);
        _keepAlive(_book().taskOf(f).noticeEnd);
        vm.prank(worker);
        t.takeTask(f, 0);
        _check("take f");
        _leave(bob, shares.balanceOf(bob) / 2);
        _check("bob takes out, with a note against f");
        assertGt(_book().noteOf(f, bob), 0);
        uint256 all = _book().taskOf(f).locked;
        vm.prank(founder);
        t.acceptTask(f, all);
        _check("pay f in full: its notes are void");
        assertEq(lTask[f].held, 0);
        // a wind-down sweeps what is still open; a note against a swept task is claimable afterwards
        uint64 g = _announce(100, 100e6, worker);
        uint64 h = _announce(100, 100e6, worker);
        _keepAlive(_book().taskOf(g).noticeEnd);
        vm.prank(worker);
        t.takeTask(g, 0);
        _check("take g");
        _leave(alice, shares.balanceOf(alice) / 2);
        _check("alice takes out, with a note against g");
        vm.prank(founder);
        t.windDown();
        _check("wind-down");
        assertEq(lTask[g].state, uint8(TaskBook.State.Returned));
        assertEq(lTask[h].state, uint8(TaskBook.State.Cancelled));
        assertEq(lLocked, 0);
        t.claimNote(g, alice);
        _check("claim after the wind-down");
        assertGt(eventsRead + bookEvents, 40);
        assertEq(lNotesOwed, 0, "every note was claimed or void");
        // and the rolling sum decays in the ledger as it does in the book
        vm.warp(vm.getBlockTimestamp() + 30 days);
        _check("30 days on");
        assertEq(_book().windowSumBps(), 0);
    }
}
