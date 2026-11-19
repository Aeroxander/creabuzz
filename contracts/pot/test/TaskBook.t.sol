// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {ITaskBook} from "../src/Interfaces.sol";
import {TaskBook} from "../src/TaskBook.sol";
import {TaskBookHarness} from "./helpers/TaskBookHarness.sol";

/// @notice The task queue on its own: this contract plays the Treasury, so every rule and every guard of the book is reached
/// directly, including the ones the Treasury's own settle makes unreachable through it (a take after the window, an accept
/// after the deadline, a full ring of takes). Dollar numbers are in units of 1e-6.
contract TaskBookTest is Test {
    uint256 internal constant U = 1e6;
    uint32 internal constant UNIT = 7 days;
    uint256 internal constant T0 = 1_700_000_000;
    uint256 internal constant POT = 100_000e6;

    TaskBookHarness internal book;
    address internal worker = makeAddr("worker");
    address internal other = makeAddr("other");
    address internal stranger = makeAddr("stranger");

    event TaskAnnounced(
        uint64 indexed serial,
        bytes32 what,
        address payee,
        uint256 maxDollars,
        uint16 shareBps,
        uint64 announcedAt,
        uint64 noticeEnd,
        uint64 expiresAt,
        uint8 openAfter
    );
    event TaskTaken(
        uint64 indexed serial,
        address takenBy,
        uint256 amount,
        uint256 takeBps,
        uint64 takenAt,
        uint64 deadline,
        uint256 windowSumBpsAfter,
        uint8 openAfter
    );
    event TaskResolved(
        uint64 indexed serial,
        uint8 state,
        uint256 pay,
        uint256 returned,
        uint256 notesPool,
        uint256 potPart,
        uint256 noteFaceAfter,
        uint8 openAfter
    );

    function setUp() public {
        vm.warp(T0);
        book = _fresh(UNIT);
    }

    function _fresh(uint32 unit_) internal returns (TaskBookHarness b) {
        b = TaskBookHarness(Clones.clone(address(new TaskBookHarness())));
        b.initialize(address(this), unit_);
    }

    function _announce(uint16 bps, uint256 max, address payee) internal returns (uint64 serial) {
        (serial,) = book.announce(bytes32(uint256(0xabc)), payee, max, bps);
    }

    /// @dev Announce, wait out the notice and take at once, against `POT`.
    function _taken(uint16 bps, uint256 max, address payee) internal returns (uint64 serial, uint256 amount) {
        serial = _announce(bps, max, payee);
        TaskBook.Task memory k = book.taskOf(serial);
        vm.warp(k.noticeEnd);
        (amount,) = book.take(serial, payee == address(0) ? worker : payee, POT, 0);
    }

    // ---- who may call

    function test_onlyTheTreasuryChangesTheBook() public {
        uint64 s = _announce(100, 5000e6, worker);
        bytes[] memory c = new bytes[](8);
        c[0] = abi.encodeCall(book.announce, (bytes32(uint256(1)), worker, 5000e6, 100));
        c[1] = abi.encodeCall(book.take, (s, worker, POT, 0));
        c[2] = abi.encodeCall(book.accept, (s, 1));
        c[3] = abi.encodeCall(book.reject, (s));
        c[4] = abi.encodeCall(book.cancel, (s));
        c[5] = abi.encodeCall(book.expireDue, ());
        c[6] = abi.encodeCall(book.sweepAll, ());
        c[7] = abi.encodeCall(book.initialize, (stranger, UNIT));
        for (uint256 i; i < c.length; ++i) {
            vm.prank(stranger);
            (bool ok, bytes memory ret) = address(book).call(c[i]);
            assertFalse(ok, string.concat("a stranger reached call #", vm.toString(i)));
            if (i < 7) assertEq(bytes4(ret), TaskBook.NotAllowed.selector);
            else assertEq(bytes4(ret), TaskBook.BadSetup.selector);
        }
    }

    function test_initializeOnceAndTheImplementationIsLocked() public {
        vm.expectRevert(TaskBook.BadSetup.selector);
        book.initialize(address(this), UNIT);
        TaskBook impl = new TaskBook();
        vm.expectRevert(TaskBook.BadSetup.selector);
        impl.initialize(address(this), UNIT);
        TaskBook c = TaskBook(Clones.clone(address(impl)));
        vm.expectRevert(TaskBook.BadSetup.selector);
        c.initialize(address(0), UNIT);
        vm.expectRevert(TaskBook.BadSetup.selector);
        c.initialize(address(this), 0);
        c.initialize(address(this), UNIT);
        assertEq(c.treasury(), address(this));
        assertEq(c.unit(), UNIT);
        assertEq(c.nextSerial(), 1, "serials start at 1: zero means no task");
    }

    // ---- announce

    function test_announceStoresTheTaskAndSaysWhenItCanBeTaken() public {
        bytes32 what = keccak256("task");
        (uint256 notice, uint256 window, uint256 due) = book.noticeFor(500);
        uint64 noticeEnd = uint64(T0 + notice);
        vm.expectEmit(true, false, false, true, address(book));
        emit TaskAnnounced(1, what, worker, 4000e6, 500, uint64(T0), noticeEnd, uint64(noticeEnd + window), 1);
        (uint64 serial, uint64 next) = book.announce(what, worker, 4000e6, 500);
        assertEq(serial, 1);
        assertEq(next, noticeEnd + window, "the book says when it next needs a settle");
        TaskBook.Task memory k = book.taskOf(1);
        assertEq(k.what, what);
        assertEq(k.payee, worker);
        assertEq(uint8(k.state), uint8(TaskBook.State.Announced));
        assertEq(k.shareBps, 500);
        assertEq(k.announcedAt, T0);
        assertEq(k.noticeEnd, noticeEnd);
        assertEq(k.expiresAt, noticeEnd + UNIT);
        assertEq(k.maxDollars, 4000e6);
        assertEq(k.locked, 0);
        assertEq(due, 2 * UNIT);
        assertEq(book.openCount(), 1);
        assertEq(book.nextSerial(), 2);
        assertEq(book.openSerials().length, 1);
    }

    function test_theNoticeIsTwoUnitsPlusAUnitOver1400PerTenThousandthRoundedUp() public {
        // N = 7 days: 1% is 14.5 days, 5% is 16.5 days; N / 1,400 is exactly 432 seconds, so 333 ten-thousandths are 143,856
        (uint256 n1,,) = book.noticeFor(100);
        assertEq(n1, 14 days + 12 hours);
        (uint256 n5,,) = book.noticeFor(500);
        assertEq(n5, 16 days + 12 hours);
        (uint256 n333, uint256 w, uint256 d) = book.noticeFor(333);
        assertEq(n333, 2 * uint256(UNIT) + 333 * 432);
        assertEq(w, UNIT);
        assertEq(d, 2 * uint256(UNIT));
        // the shortest test unit, N = 168 s, where N / 1,400 is 0.12 s: it rounds up
        TaskBook small = _fresh(168);
        (uint256 s1,,) = small.noticeFor(100);
        assertEq(s1, 336 + 12);
        (uint256 s333,,) = small.noticeFor(333);
        assertEq(s333, 336 + 40); // 333 x 168 / 1,400 = 39.96
        (uint256 s500,,) = small.noticeFor(500);
        assertEq(s500, 336 + 60);
    }

    function test_announceRefusesWhatIsNotATask() public {
        vm.expectRevert(TaskBook.BadInput.selector);
        book.announce(bytes32(0), worker, 1000e6, 100);
        vm.expectRevert(TaskBook.BadInput.selector);
        book.announce(bytes32(uint256(1)), worker, 1000e6, 0);
        vm.expectRevert(TaskBook.ShareTooBig.selector);
        book.announce(bytes32(uint256(1)), worker, 1000e6, 501);
        vm.expectRevert(TaskBook.BadInput.selector);
        book.announce(bytes32(uint256(1)), worker, 1e6 - 1, 100);
        vm.expectRevert(TaskBook.BadInput.selector);
        book.announce(bytes32(uint256(1)), worker, uint256(type(uint128).max) + 1, 100);
        // the edges are allowed
        book.announce(bytes32(uint256(1)), worker, 1e6, 1);
        book.announce(bytes32(uint256(1)), address(0), type(uint128).max, 500);
        assertEq(book.openCount(), 2);
    }

    function test_atMostEightTasksAreOpenAndACancelFreesASlot() public {
        for (uint256 i; i < 8; ++i) {
            assertEq(_announce(100, 1000e6, worker), i + 1);
        }
        vm.expectRevert(TaskBook.TooManyOpen.selector);
        book.announce(bytes32(uint256(1)), worker, 1000e6, 100);
        book.cancel(3);
        assertEq(book.openCount(), 7);
        assertEq(_announce(100, 1000e6, worker), 9, "a serial is never reused");
        vm.expectRevert(TaskBook.TooManyOpen.selector);
        book.announce(bytes32(uint256(1)), worker, 1000e6, 100);
        uint64[] memory open = book.openSerials();
        assertEq(open.length, 8);
        for (uint256 i; i < open.length; ++i) {
            assertTrue(open[i] != 3, "the cancelled task left the open list");
        }
    }

    // ---- take

    function test_takeSetsAsideTheSmallerOfTheDollarsAndTheShareOfThePot() public {
        // dollars bind
        uint64 a = _announce(500, 1000e6, worker);
        vm.warp(book.taskOf(a).noticeEnd);
        (uint256 amount, uint64 next) = book.take(a, worker, POT, 0);
        assertEq(amount, 1000e6, "5% of 100,000 is 5,000: the stated 1,000 binds");
        TaskBook.Task memory k = book.taskOf(a);
        assertEq(uint8(k.state), uint8(TaskBook.State.Taken));
        assertEq(k.takenBy, worker);
        assertEq(k.takenAt, vm.getBlockTimestamp());
        assertEq(k.deadline, vm.getBlockTimestamp() + 2 * UNIT);
        assertEq(k.expiresAt, k.deadline, "the end of the take window becomes the deadline");
        assertEq(k.locked, 1000e6);
        assertEq(k.stayer, 1000e6);
        assertEq(k.noteFace, 0);
        assertEq(next, k.deadline);
        // the share binds, with the floor
        uint64 b = _announce(333, 50_000e6, worker);
        vm.warp(book.taskOf(b).noticeEnd);
        (amount,) = book.take(b, worker, 99_999_999_999, 0);
        assertEq(amount, uint256(99_999_999_999) * 333 / 10_000);
    }

    function test_theShareIsOfThePotAtTheTakeNotAtTheAnnounce() public {
        // design 2.3b3: a 4,000 task stated as 4% of 100,000; if 20% of Shares left, 3,200 locks; if half, 2,000
        uint64 a = _announce(400, 4000e6, worker);
        vm.warp(book.taskOf(a).noticeEnd);
        uint256 id = vm.snapshotState();
        (uint256 amount,) = book.take(a, worker, 100_000e6, 0);
        assertEq(amount, 4000e6);
        vm.revertToState(id);
        (amount,) = book.take(a, worker, 80_000e6, 0);
        assertEq(amount, 3200e6);
        vm.revertToState(id);
        (amount,) = book.take(a, worker, 50_000e6, 0);
        assertEq(amount, 2000e6);
    }

    function test_takeNeedsTheNoticeToBeOverAndTheWindowToBeOpen() public {
        uint64 a = _announce(100, 1000e6, worker);
        TaskBook.Task memory k = book.taskOf(a);
        vm.warp(k.noticeEnd - 1);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.NoticeRunning.selector, k.noticeEnd));
        book.take(a, worker, POT, 0);
        vm.warp(k.expiresAt);
        vm.expectRevert(TaskBook.TakeWindowOver.selector);
        book.take(a, worker, POT, 0);
        vm.warp(k.expiresAt - 1); // the last second of the window
        book.take(a, worker, POT, 0);
        // the first second works too
        uint64 b = _announce(100, 1000e6, worker);
        vm.warp(book.taskOf(b).noticeEnd);
        book.take(b, worker, POT, 0);
    }

    function test_takeRefusesTheWrongTaskTheWrongTakerAndTooLittleCash() public {
        vm.expectRevert(TaskBook.NoSuchTask.selector);
        book.take(1, worker, POT, 0);
        uint64 a = _announce(100, 1000e6, worker);
        vm.warp(book.taskOf(a).noticeEnd);
        vm.expectRevert(TaskBook.NotAllowed.selector);
        book.take(a, other, POT, 0); // named payee only
        vm.expectRevert(abi.encodeWithSelector(TaskBook.TooLittleCash.selector, 1001e6, 1000e6));
        book.take(a, worker, POT, 1001e6);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.TooLittleCash.selector, 0, 0));
        book.take(a, worker, 0, 0); // an empty pot funds nothing
        book.take(a, worker, POT, 1000e6); // the amount itself is accepted
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        book.take(a, worker, POT, 0); // not twice
    }

    function test_anOpenTaskIsTakenByWhoeverComesFirstAndIsRecordedAsTakenBy() public {
        uint64 a = _announce(100, 1000e6, address(0));
        vm.warp(book.taskOf(a).noticeEnd);
        book.take(a, other, POT, 0);
        assertEq(book.taskOf(a).takenBy, other);
        assertEq(book.taskOf(a).payee, address(0));
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        book.take(a, worker, POT, 0);
    }

    function test_aTakeEmitsItsResultingState() public {
        uint64 a = _announce(100, 1000e6, worker);
        TaskBook.Task memory k = book.taskOf(a);
        vm.warp(k.noticeEnd);
        // 1,000 of 100,000 is 100 ten-thousandths
        vm.expectEmit(true, false, false, true, address(book));
        emit TaskTaken(
            a, worker, 1000e6, 100, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 2 * UNIT), 100, 1
        );
        book.take(a, worker, POT, 0);
        assertEq(book.windowSumBps(), 100);
        assertEq(book.takeRoomBps(), 900);
    }

    // ---- accept, reject, cancel

    function test_aFullPaymentVoidsTheNotes() public {
        (uint64 s,) = _taken(500, 5000e6, worker);
        book.forceNote(s, other, 2000e6);
        ITaskBook.Resolved memory r = book.accept(s, 5000e6);
        assertEq(r.to, worker);
        assertEq(r.pay, 5000e6);
        assertEq(r.c, 3000e6);
        assertEq(r.n, 2000e6);
        assertEq(r.np, 0);
        assertEq(r.pp, 0);
        TaskBook.Task memory k = book.taskOf(s);
        assertEq(uint8(k.state), uint8(TaskBook.State.Paid));
        assertEq(k.returned, 0, "nothing came back, so no note can read this serial");
        assertEq(k.notesLeft, 0);
        assertEq(k.noteFace, 0);
        assertEq(k.stayer, 0);
        assertEq(book.openCount(), 0);
        assertEq(r.next, 0);
    }

    function test_aPartPaymentSplitsWhatIsLeftAtOneRatio() public {
        // the worked case of the plan: a 5,000 task, a holder left with a note of 2,000, 3,000 is paid
        (uint64 s,) = _taken(500, 5000e6, worker);
        book.forceNote(s, other, 2000e6);
        vm.expectEmit(true, false, false, true, address(book));
        emit TaskResolved(s, uint8(TaskBook.State.Paid), 3000e6, 2000e6, 800e6, 1200e6, 2000e6, 0);
        ITaskBook.Resolved memory r = book.accept(s, 3000e6);
        assertEq(r.pay, 3000e6);
        assertEq(r.c, 3000e6);
        assertEq(r.n, 2000e6);
        assertEq(r.np, 800e6, "the notes get 2,000 x 2,000 / 5,000");
        assertEq(r.pp, 1200e6, "the stayers get the rest: 3,000 x 2,000 / 5,000");
        TaskBook.Task memory k = book.taskOf(s);
        assertEq(k.returned, 2000e6);
        assertEq(k.notesLeft, 800e6);
        assertEq(k.noteFace, 2000e6, "the face stays, for the claims");
        assertEq(k.locked, 5000e6);
    }

    function test_theNotesPoolRoundsDownSoTheStayersGetTheRounding() public {
        (uint64 s,) = _taken(500, 5000e6, worker);
        book.forceNote(s, other, 1);
        ITaskBook.Resolved memory r = book.accept(s, 1);
        // N = 1 unit, rem = L - 1: floor(1 x (L-1) / L) = 0
        assertEq(r.np, 0);
        assertEq(r.pp, 5000e6 - 1);
    }

    function test_acceptRefusesWhatIsNotATakenTaskInTime() public {
        vm.expectRevert(TaskBook.NoSuchTask.selector);
        book.accept(1, 1);
        uint64 a = _announce(500, 5000e6, worker);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        book.accept(a, 1); // not taken yet
        vm.warp(book.taskOf(a).noticeEnd);
        book.take(a, worker, POT, 0);
        TaskBook.Task memory k = book.taskOf(a);
        vm.expectRevert(TaskBook.BadInput.selector);
        book.accept(a, 0);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.TooMuch.selector, k.locked + 1, k.locked));
        book.accept(a, k.locked + 1);
        vm.warp(k.deadline);
        vm.expectRevert(TaskBook.WrongTaskState.selector); // the deadline second is already too late
        book.accept(a, 1);
        vm.warp(k.deadline - 1);
        book.accept(a, 1); // the last second works
    }

    function test_rejectReturnsAtOnceAndKeepsTheNotesWhole() public {
        (uint64 s,) = _taken(500, 5000e6, worker);
        book.forceNote(s, other, 2000e6);
        ITaskBook.Resolved memory r = book.reject(s);
        assertEq(r.pay, 0);
        assertEq(r.np, 2000e6, "every note keeps its full face");
        assertEq(r.pp, 3000e6, "and the stayers get theirs back");
        TaskBook.Task memory k = book.taskOf(s);
        assertEq(uint8(k.state), uint8(TaskBook.State.Rejected));
        assertEq(k.returned, 5000e6);
        assertEq(k.notesLeft, 2000e6);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        book.reject(s);
        vm.expectRevert(TaskBook.NoSuchTask.selector);
        book.reject(99);
        uint64 a = _announce(100, 1000e6, worker);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        book.reject(a); // only a taken task
    }

    function test_cancelWithdrawsOnlyATaskNobodyHasTaken() public {
        vm.expectRevert(TaskBook.NoSuchTask.selector);
        book.cancel(1);
        uint64 a = _announce(100, 1000e6, worker);
        vm.expectEmit(true, false, false, true, address(book));
        emit TaskResolved(a, uint8(TaskBook.State.Cancelled), 0, 0, 0, 0, 0, 0);
        uint64 next = book.cancel(a);
        assertEq(next, 0);
        assertEq(uint8(book.taskOf(a).state), uint8(TaskBook.State.Cancelled));
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        book.cancel(a);
        (uint64 s,) = _taken(100, 1000e6, worker);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        book.cancel(s); // not after the take
    }

    // ---- running out

    function test_expireDueReturnsTakenTasksAndLapsesAnnouncedOnesOnlyWhenDue() public {
        uint64 a = _announce(100, 1000e6, worker); // never taken: lapses
        uint64 b = _announce(100, 1000e6, worker);
        uint64 c = _announce(300, 2000e6, worker);
        vm.warp(book.taskOf(b).noticeEnd);
        book.take(b, worker, POT, 0);
        uint256 dl = book.taskOf(b).deadline;
        // before anything is due
        (uint256 sum, uint64 next) = book.expireDue();
        assertEq(sum, 0);
        assertEq(book.openCount(), 3);
        assertEq(
            next,
            book.taskOf(c).expiresAt < book.taskOf(a).expiresAt ? book.taskOf(c).expiresAt : book.taskOf(a).expiresAt
        );
        // a and the window of c are over, b is not due until its deadline
        vm.warp(book.taskOf(c).expiresAt);
        assertEq(book.dueC(vm.getBlockTimestamp()), 0, "no taken task is due yet");
        (sum, next) = book.expireDue();
        assertEq(sum, 0);
        assertEq(uint8(book.taskOf(a).state), uint8(TaskBook.State.Lapsed));
        assertEq(uint8(book.taskOf(c).state), uint8(TaskBook.State.Lapsed));
        assertEq(uint8(book.taskOf(b).state), uint8(TaskBook.State.Taken));
        assertEq(next, dl);
        assertEq(book.openCount(), 1);
        // b, one second before its deadline: not due; at it: due
        vm.warp(dl - 1);
        (sum,) = book.expireDue();
        assertEq(sum, 0);
        vm.warp(dl);
        assertEq(book.dueC(vm.getBlockTimestamp()), 1000e6);
        (sum, next) = book.expireDue();
        assertEq(sum, 1000e6);
        assertEq(next, 0);
        assertEq(uint8(book.taskOf(b).state), uint8(TaskBook.State.Returned));
        assertEq(book.taskOf(b).returned, 1000e6);
        assertEq(book.openCount(), 0);
        // nothing left: a second call moves nothing
        (sum, next) = book.expireDue();
        assertEq(sum + next, 0);
    }

    function test_aTaskThatRanOutKeepsItsNotesWholeAndItsStayersClaimComesBack() public {
        (uint64 s,) = _taken(500, 5000e6, worker);
        book.forceNote(s, other, 2000e6);
        vm.warp(book.taskOf(s).deadline);
        (uint256 sum,) = book.expireDue();
        assertEq(sum, 3000e6, "the stayers' claim comes back");
        TaskBook.Task memory k = book.taskOf(s);
        assertEq(k.notesLeft, 2000e6, "the notes keep their full face");
        assertEq(k.returned, 5000e6);
    }

    function test_sweepAllEndsEveryOpenTask() public {
        (uint64 s,) = _taken(100, 1000e6, worker);
        uint64 a = _announce(100, 1000e6, worker);
        uint64 b = _announce(200, 1000e6, worker);
        uint256 sum = book.sweepAll();
        assertEq(sum, 1000e6);
        assertEq(uint8(book.taskOf(s).state), uint8(TaskBook.State.Returned));
        assertEq(uint8(book.taskOf(a).state), uint8(TaskBook.State.Cancelled));
        assertEq(uint8(book.taskOf(b).state), uint8(TaskBook.State.Cancelled));
        assertEq(book.openCount(), 0);
        assertEq(book.openSerials().length, 0);
    }

    function test_requireReturnedSaysWhenAndWhy() public {
        vm.expectRevert(TaskBook.NoSuchTask.selector);
        book.requireReturned(1);
        uint64 a = _announce(100, 1000e6, worker);
        uint256 end = book.taskOf(a).expiresAt;
        vm.expectRevert(abi.encodeWithSelector(TaskBook.NotYet.selector, end));
        book.requireReturned(a); // announced
        vm.warp(book.taskOf(a).noticeEnd);
        book.take(a, worker, POT, 0);
        end = book.taskOf(a).deadline;
        vm.expectRevert(abi.encodeWithSelector(TaskBook.NotYet.selector, end));
        book.requireReturned(a); // taken
        vm.warp(end);
        book.expireDue();
        book.requireReturned(a); // returned
        uint64 b = _announce(100, 1000e6, worker);
        vm.warp(book.taskOf(b).expiresAt);
        book.expireDue();
        book.requireReturned(b); // lapsed
        uint64 c = _announce(100, 1000e6, worker);
        book.cancel(c);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        book.requireReturned(c); // cancelled: nothing was set aside
        (uint64 d,) = _taken(100, 1000e6, worker);
        book.accept(d, 1000e6);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        book.requireReturned(d); // paid in full
    }

    // ---- the cap and the ring

    function test_theCapCountsTakesInAnyRollingWindowOfFourUnits() public {
        // two 5% takes use the whole 10%; a third (announced at the same time) waits until the first is 4 units old
        uint64 a = _announce(500, 1_000_000e6, worker);
        uint64 b = _announce(500, 1_000_000e6, worker);
        uint64 c = _announce(100, 1000e6, worker);
        vm.warp(book.taskOf(a).noticeEnd);
        uint256 firstAt = vm.getBlockTimestamp();
        book.take(a, worker, POT, 0);
        book.take(b, worker, POT, 0);
        assertEq(book.windowSumBps(), 1000);
        assertLt(vm.getBlockTimestamp(), book.taskOf(c).expiresAt, "c is still inside its own take window");
        vm.expectRevert(abi.encodeWithSelector(TaskBook.CapReached.selector, 1000, 100, 1000));
        book.take(c, worker, POT, 0);
        // rejecting does not give the cap back
        book.reject(a);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.CapReached.selector, 1000, 100, 1000));
        book.take(c, worker, POT, 0);
        assertLt(vm.getBlockTimestamp(), firstAt + 4 * uint256(UNIT));
    }

    function test_anEntryStopsCountingAtExactlyFourUnitsOld() public {
        uint64 a = _announce(500, 1_000_000e6, worker);
        vm.warp(book.taskOf(a).noticeEnd);
        uint256 at = vm.getBlockTimestamp();
        book.take(a, worker, POT, 0);
        book.reject(a);
        assertEq(book.windowSumBps(), 500);
        vm.warp(at + 4 * uint256(UNIT) - 1);
        assertEq(book.windowSumBps(), 500, "still counted one second before");
        vm.warp(at + 4 * uint256(UNIT));
        assertEq(book.windowSumBps(), 0, "gone at exactly four units");
        assertEq(book.takeRoomBps(), 1000);
    }

    function test_aTakeIsCountedRoundedUpAgainstTheTaker() public {
        // 1 dollar of a 100,000 pot is 0.001%, which counts as one whole ten-thousandth
        uint64 a = _announce(100, 1e6, worker);
        vm.warp(book.taskOf(a).noticeEnd);
        book.take(a, worker, POT, 0);
        assertEq(book.windowSumBps(), 1);
    }

    function test_theRingFailsClosedWhenItWouldOverwriteATakeStillInTheWindow() public {
        // fill every slot with a take from this very second, then ask for a take
        for (uint256 i; i < 16; ++i) {
            book.forceRing(i, vm.getBlockTimestamp(), 1, 0);
        }
        uint64 a = _announce(100, 1000e6, worker);
        vm.warp(book.taskOf(a).noticeEnd);
        for (uint256 i; i < 16; ++i) {
            book.forceRing(i, vm.getBlockTimestamp(), 1, 0);
        }
        vm.expectRevert(TaskBook.TakesFull.selector);
        book.take(a, worker, POT, 0);
        // one entry older than four units is a free slot
        book.forceRing(0, vm.getBlockTimestamp() - 4 * uint256(UNIT), 1, 0);
        book.take(a, worker, POT, 0);
        assertEq(book.windowSumBps(), 15 + 100);
    }

    function test_theRingWrapsAndKeepsTheLastSixteenTakes() public {
        // 24 takes of one ten-thousandth each, spread over time; the sum must always equal a count of the takes that are
        // still inside four units, made here from the times alone
        uint256[] memory at = new uint256[](24);
        for (uint256 i; i < 24; ++i) {
            uint64 s = _announce(100, 1e6, worker);
            vm.warp(book.taskOf(s).noticeEnd);
            book.take(s, worker, POT, 0);
            book.reject(s);
            at[i] = vm.getBlockTimestamp();
            uint256 expected;
            for (uint256 j; j <= i; ++j) {
                if (at[j] + 4 * uint256(UNIT) > vm.getBlockTimestamp()) ++expected;
            }
            assertEq(book.windowSumBps(), expected, "the ring counts exactly the takes inside four units");
            if (i % 3 == 2) vm.warp(vm.getBlockTimestamp() + 6 days);
        }
    }

    // ---- the open list

    function test_theOpenListStaysConsistentThroughEveryKindOfEnd() public {
        uint64[8] memory ids;
        for (uint256 i; i < 8; ++i) {
            ids[i] = _announce(100, 1000e6, worker);
        }
        book.cancel(ids[0]); // the first
        book.cancel(ids[7]); // the last
        book.cancel(ids[3]); // a middle one
        uint64[] memory open = book.openSerials();
        assertEq(open.length, 5);
        uint256 mask;
        for (uint256 i; i < open.length; ++i) {
            mask |= 1 << open[i];
        }
        assertEq(mask, (1 << ids[1]) | (1 << ids[2]) | (1 << ids[4]) | (1 << ids[5]) | (1 << ids[6]));
        assertEq(book.openCount(), 5);
        // new tasks fill the freed slots and the list stays a set
        for (uint256 i; i < 3; ++i) {
            _announce(100, 1000e6, worker);
        }
        open = book.openSerials();
        assertEq(open.length, 8);
        for (uint256 i; i < 8; ++i) {
            for (uint256 j = i + 1; j < 8; ++j) {
                assertTrue(open[i] != open[j], "a serial is open once");
            }
        }
    }
}
