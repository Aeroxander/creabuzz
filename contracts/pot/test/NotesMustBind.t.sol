// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {TaskBook} from "../src/TaskBook.sol";

/// @notice Must-bind test 1 of JOIN-LEAVE-DESIGN.md section 6, through the real Launcher stack and the production functions
/// only: notes never exceed the money returned for a serial, with the 8 open slots cycled 20 times.
///
/// One cycle: eight tasks of 1.25% of the pot are announced, wait out their notice and are taken; holders take out and back
/// again at random while the money is set aside (every take-out of a holder who holds Shares writes notes against the open
/// tasks); each task then ends by a random path (paid in full, paid in part, paid one unit, rejected, or left to run out); notes
/// are claimed in a random order, some of them cycles later; 28 days pass so the cap window is empty. After every step, for every
/// serial: the money set aside for the stayers and the notes adds up to what the task holds, the notes of a task are paid
/// no more than the money that came back for them, what is still claimable adds up to what is still held, serials only
/// rise, and every dollar is in exactly one bucket. A note of an old serial can never be paid out of a later task that
/// reuses its slot.
contract NotesMustBindTest is StackBase {
    bytes32 internal constant WHAT = keccak256("mb1");
    address internal worker = makeAddr("worker");
    address[5] internal hs;
    uint256 internal rnd;

    uint256 internal announced;
    uint64[] internal watch; // the serials that may still hold money: this cycle's and any with notes left
    mapping(uint64 => uint256) internal claimed;
    mapping(uint64 => uint256) internal poolAtEnd;
    mapping(uint64 => bool) internal seenEnd;
    uint256 internal cashIn;
    uint256 internal cashOut;
    uint256[5] internal paths; // how many tasks ended each way
    uint256 internal leavesWithNotes;
    uint256 internal staleTries;

    function setUp() public override {
        super.setUp();
        _use(_launch(founder, "mb1", 0, 0)); // no allowance, no Team pool: the pot moves only by tasks, joins and take-outs
        for (uint256 i; i < hs.length; ++i) {
            hs[i] = makeAddr(string.concat("mb1-holder-", vm.toString(i)));
        }
    }

    function _r(uint256 mod) internal returns (uint256) {
        rnd = uint256(keccak256(abi.encode(rnd)));
        return rnd % mod;
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

    // ---- the actions of holders

    function _someJoin() internal {
        address h = hs[_r(5)];
        uint256 amount = (1 + _r(40_000)) * 1e6 + _r(1e6);
        if (!t.doorOpenNow()) return;
        _join(h, amount);
        cashIn += amount;
    }

    function _someLeave() internal {
        address h = hs[_r(5)];
        uint256 bal = shares.balanceOf(h);
        if (bal == 0 || t.pot() < 40_000e6) return; // the project is never emptied: a take must always find money
        uint256 n = _r(3) == 0 ? bal : bal * (1 + _r(100)) / 100;
        if (n == 0) return;
        uint256 owed0 = t.notesOwed();
        vm.prank(h);
        try t.leave(n, 0, h) returns (uint256 cash) {
            cashOut += cash;
            if (t.notesOwed() > owed0) ++leavesWithNotes;
        } catch {}
    }

    function _someAction() internal {
        uint256 k = _r(10);
        if (k < 4) {
            _someJoin();
        } else if (k < 8) {
            _someLeave();
        } else {
            vm.warp(vm.getBlockTimestamp() + _r(1 days));
            _checkIn();
        }
        _check();
    }

    // ---- the rules, after every step

    function _check() internal {
        TaskBook b = _book();
        uint256 sumC;
        uint256 sumOwed;
        for (uint256 i; i < watch.length; ++i) {
            uint64 s = watch[i];
            TaskBook.Task memory k = b.taskOf(s);
            if (k.state == TaskBook.State.Taken) {
                assertEq(uint256(k.stayer) + k.noteFace, k.locked, "C + N == L while a task is taken");
                sumC += k.stayer;
                sumOwed += k.noteFace;
            } else if (
                k.state == TaskBook.State.Paid || k.state == TaskBook.State.Rejected
                    || k.state == TaskBook.State.Returned
            ) {
                sumOwed += k.notesLeft;
                if (!seenEnd[s]) {
                    seenEnd[s] = true;
                    poolAtEnd[s] = k.notesLeft; // what was set aside for the notes of this serial when it ended
                    assertLe(poolAtEnd[s], k.returned, "the notes' pool is part of what came back");
                }
                assertLe(claimed[s] + k.notesLeft, poolAtEnd[s], "notes were paid more than came back for them");
                uint256 claimable;
                for (uint256 j; j < hs.length; ++j) {
                    claimable += b.claimableNote(s, hs[j]);
                }
                assertLe(claimable, k.notesLeft, "claimable notes exceed what is held for them");
                assertLe(claimed[s], k.returned, "claimed more than came back");
            }
        }
        assertEq(t.locked(), sumC, "locked is the sum of the stayers' claims of the open taken tasks");
        assertEq(t.notesOwed(), sumOwed, "notes owed is what is held for the notes of every serial");
        assertEq(usd.balanceOf(address(t)), t.pot() + t.box() + t.arriving() + t.feesOwed() + sumC + sumOwed);
        assertEq(usd.balanceOf(address(t)), cashIn - cashOut, "dollars in less dollars out");
        assertEq(b.nextSerial(), announced + 1, "a serial is used once and never again");
    }

    // ---- one cycle of the eight slots

    function _cycle() internal {
        _checkIn();
        uint64[8] memory cur;
        uint64 prev = uint64(announced);
        for (uint256 i; i < 8; ++i) {
            vm.prank(founder);
            cur[i] = t.announceTask(WHAT, worker, 1e15, 125);
            assertEq(cur[i], prev + 1, "serials rise by one");
            prev = cur[i];
            ++announced;
            watch.push(cur[i]);
        }
        vm.prank(founder);
        vm.expectRevert(TaskBook.TooManyOpen.selector);
        t.announceTask(WHAT, worker, 1e15, 125); // the ninth waits
        _warpAlive(_book().taskOf(cur[0]).noticeEnd);
        for (uint256 i; i < 8; ++i) {
            vm.prank(worker);
            t.takeTask(cur[i], 0);
            if (i % 3 == 1) _someAction();
        }
        _check();
        for (uint256 i; i < 4; ++i) {
            _someAction();
        }
        // each ends its own way; holders move in between
        for (uint256 i; i < 8; ++i) {
            TaskBook.Task memory k = _book().taskOf(cur[i]);
            uint256 l = k.locked;
            uint256 p = k.state == TaskBook.State.Taken ? _r(5) : 4;
            if (p == 0) {
                vm.prank(founder);
                t.acceptTask(cur[i], l);
                cashOut += l;
            } else if (p == 1) {
                uint256 pay = l * (10 + _r(81)) / 100;
                vm.prank(founder);
                t.acceptTask(cur[i], pay);
                cashOut += pay;
            } else if (p == 2) {
                vm.prank(founder);
                t.rejectTask(cur[i]);
            } else if (p == 3) {
                vm.prank(founder);
                t.acceptTask(cur[i], 1);
                cashOut += 1;
            }
            ++paths[p]; // 4: left to run out
            _check();
            if (i % 2 == 0) _someAction();
        }
        // what is still open runs out
        _warpAlive(_book().taskOf(cur[7]).deadline + 1);
        t.settle();
        _check();
        assertEq(_book().openCount(), 0, "every slot is free again");
        // an old serial can never pay a note that belongs to another
        _staleClaims();
        // claims in a random order, some left for later
        _claimSome(70);
        // the cap window empties
        _warpAlive(vm.getBlockTimestamp() + 28 days);
        _someAction();
        _prune();
    }

    function _claimSome(uint256 percent) internal {
        TaskBook b = _book();
        uint256 n = watch.length;
        if (n == 0) return;
        uint256 off = _r(n * 5);
        for (uint256 q; q < n * 5; ++q) {
            uint256 idx = (q + off) % (n * 5);
            uint64 s = watch[idx / 5];
            address h = hs[idx % 5];
            if (b.noteOf(s, h) == 0 || b.taskOf(s).returned == 0) continue; // no note, or void: paid in full
            if (_r(100) >= percent) continue;
            uint256 paid = t.claimNote(s, h);
            claimed[s] += paid;
            cashOut += paid;
            _check();
        }
    }

    /// @dev The attack the serial exists for: with notes kept by slot, a note of task `s` could be paid out of the task that
    /// next used the slot. Here a holder tries every other serial of the project with a note they do not hold: nothing pays.
    function _staleClaims() internal {
        TaskBook b = _book();
        uint64 last = uint64(announced);
        for (uint256 i; i < watch.length; ++i) {
            uint64 s = watch[i];
            for (uint256 j; j < hs.length; ++j) {
                if (b.noteOf(s, hs[j]) == 0) continue; // this holder has a note against s: try the slot's later users
                for (uint64 later = s + 8; later <= last; later += 8) {
                    if (b.noteOf(later, hs[j]) != 0) continue;
                    uint256 before = usd.balanceOf(hs[j]);
                    vm.expectRevert();
                    t.claimNote(later, hs[j]);
                    assertEq(usd.balanceOf(hs[j]), before);
                    ++staleTries;
                }
            }
        }
    }

    function _prune() internal {
        TaskBook b = _book();
        uint64[] memory keep = new uint64[](watch.length);
        uint256 m;
        for (uint256 i; i < watch.length; ++i) {
            TaskBook.Task memory k = b.taskOf(watch[i]);
            bool done = (k.state != TaskBook.State.Announced && k.state != TaskBook.State.Taken) && k.noteFace == 0
                && k.notesLeft == 0;
            if (!done) keep[m++] = watch[i];
        }
        delete watch;
        for (uint256 i; i < m; ++i) {
            watch.push(keep[i]);
        }
    }

    function _run(uint256 seed, uint256 cycles) internal {
        rnd = seed;
        for (uint256 i; i < hs.length; ++i) {
            _join(hs[i], (20_000 + 5000 * i) * 1e6);
            cashIn += (20_000 + 5000 * i) * 1e6;
        }
        for (uint256 c; c < cycles; ++c) {
            _cycle();
        }
        // everything left is claimed
        _claimSome(100);
        _prune();
        _check();
        assertEq(watch.length, 0, "no serial holds money any more");
        assertEq(t.notesOwed(), 0, "every note was settled");
        assertEq(t.locked(), 0);
        assertEq(_book().nextSerial(), cycles * 8 + 1);
        assertEq(usd.balanceOf(address(t)), t.pot() + t.feesOwed(), "all the money left is the pot and the fees");
    }

    /// @dev Must-bind 1: the 8 open slots cycled 20 times (160 serials, none reused).
    function test_mb1_theEightSlotsCycledTwentyTimes() public {
        _run(0xBEEF, 20);
        assertEq(_book().nextSerial(), 161);
        for (uint256 p; p < 5; ++p) {
            assertGt(paths[p], 0, "every way a task can end was walked");
        }
        assertGt(leavesWithNotes, 20, "holders took out while money was set aside");
        assertGt(staleTries, 0, "the stale-serial attack was tried");
    }

    function test_mb1_anotherSeedTwentyCycles() public {
        _run(0xFACADE, 20);
        assertEq(_book().nextSerial(), 161);
    }

    /// forge-config: default.fuzz.runs = 200
    function testFuzz_mb1_notesNeverExceedTheMoneyReturned(uint256 seed) public {
        _run(seed, 2);
    }
}
