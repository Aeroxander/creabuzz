// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";
import {PotMath} from "../src/PotMath.sol";

/// @notice Exit notes through the real paths: a holder who takes out while money is set aside for a taken task is paid cash on
/// the pot without it and is given a note for the rest, keyed by the task's serial; when the task ends the worker is paid first
/// and what is left comes back at ONE ratio to the stayers and to every note; a task paid in full has no claimable note. The
/// project has no allowance and no Team pool (unless a test says so), the pot is 100,000 dollars and Alice holds 40% of the
/// Shares, so the numbers are exact. Dollar numbers are in units of 1e-6.
contract NotesTest is PotBase {
    bytes32 internal constant WHAT = keccak256("a task");
    address internal worker = makeAddr("worker");

    function setUp() public override {
        super.setUp();
        _relaunch(0, 0); // no Team pool, no allowance: the pot moves only by tasks and take-outs
        t.forceShares(alice, 40_000e18);
        t.forceShares(bob, 60_000e18);
        _force(100_000e6, 100_000e6, 0, 0, 0);
    }

    // ---- helpers

    function _announce(uint16 bps, uint256 max) internal returns (uint64 serial) {
        vm.prank(founder);
        serial = t.announceTask(WHAT, worker, max, bps);
    }

    function _warpAlive(uint256 ts) internal {
        if (ts <= vm.getBlockTimestamp()) return;
        _checkIn();
        uint256 at = vm.getBlockTimestamp();
        while (at + 10 days < ts) {
            at += 6 days; // an absolute time: the optimizer may cache a repeated vm.getBlockTimestamp()
            vm.warp(at);
            _checkIn();
        }
        vm.warp(ts);
    }

    /// @dev Announce a task of `bps` ten-thousandths, wait out its notice and take it as the worker.
    function _locked(uint16 bps, uint256 max) internal returns (uint64 serial) {
        serial = _announce(bps, max);
        _warpAlive(_book().taskOf(serial).noticeEnd);
        vm.prank(worker);
        t.takeTask(serial, 0);
    }

    function _accept(uint64 serial, uint256 pay) internal {
        vm.prank(founder);
        t.acceptTask(serial, pay);
    }

    function _claim(uint64 serial, address holder) internal returns (uint256) {
        return t.claimNote(serial, holder);
    }

    // ---- the worked case: a part-paid accept splits pro rata (must-bind 8)

    /// @dev Pot 100,000 paid in 100,000, a 5% task set aside (pot 95,000, 5,000 set aside), a holder of 40% takes out: cash
    /// 38,000, note 2,000 (stayers' claim 3,000, notes 2,000). The task is paid 3,000 of 5,000: 2,000 comes back, 800 to the
    /// note and 1,200 to the stayers, so the stayers stand at 58,200 for 60,000 Shares and the leaver at 38,000 + 800 for 40,000,
    /// 0.97 a Share each. A rule that repaid notes first would pay the note 2,000 and leave the stayers 0.95.
    function test_mb8_aPartPaidAcceptSplitsWhatIsLeftProRataThroughARealLeave() public {
        uint64 a = _locked(500, 10_000e6);
        assertEq(t.locked(), 5000e6);
        assertEq(t.pot(), 95_000e6);
        (uint256 cashQ, uint256 noteQ,) = t.quoteTakeOut(alice, 40_000e18);
        assertEq(cashQ, 38_000e6);
        assertEq(noteQ, 2000e6, "the quote shows the note");
        vm.recordLogs();
        uint256 cash = _leave(alice, 40_000e18);
        assertEq(cash, 38_000e6);
        assertEq(usd.balanceOf(alice), 38_000e6);
        assertEq(t.locked(), 3000e6, "the stayers' claim fell by the note");
        assertEq(t.notesOwed(), 2000e6, "and the money for the note is held apart");
        assertEq(_book().noteOf(a, alice), 2000e6);
        TaskBook.Task memory k = _book().taskOf(a);
        assertEq(k.stayer + k.noteFace, k.locked, "C + N == L");
        // the event carries the note and the three buckets after it
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawLeft;
        bool sawMoney;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(t)) continue;
            if (logs[i].topics[0] == Treasury.Left.selector) {
                (,, uint256 note,,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256));
                assertEq(note, 2000e6, "Left carries the note");
                sawLeft = true;
            }
            if (logs[i].topics[0] == Treasury.TaskMoney.selector) {
                (uint8 kind,,,, uint256 lockedAfter, uint256 owedAfter) =
                    abi.decode(logs[i].data, (uint8, address, uint256, uint256, uint256, uint256));
                assertEq(kind, 5);
                assertEq(lockedAfter, 3000e6);
                assertEq(owedAfter, 2000e6);
                sawMoney = true;
            }
        }
        assertTrue(sawLeft && sawMoney);
        _accept(a, 3000e6);
        assertEq(usd.balanceOf(worker), 3000e6);
        assertEq(t.pot(), 57_000e6 + 1200e6, "the stayers' part of the 2,000 that came back: 3,000 / 5,000");
        assertEq(t.notesOwed(), 800e6, "the note's part: 2,000 / 5,000 of it");
        assertEq(t.leaveValue(), 970_000, "stayers: 0.97 a Share (58,200 for 60,000)");
        assertEq(t.pot() * 1e18 / 60_000e18, 970_000);
        assertEq(_book().claimableNote(a, alice), 800e6);
        // anyone settles it; the money goes to Alice and nobody else
        vm.prank(stranger);
        uint256 paid = t.claimNote(a, alice);
        assertEq(paid, 800e6);
        assertEq(usd.balanceOf(alice), 38_800e6, "the leaver ends at 38,800 for 40,000 Shares: 0.97 a Share");
        assertEq(usd.balanceOf(stranger), 0);
        assertEq(t.notesOwed(), 0);
        assertEq(t.pot(), 58_200e6);
        _assertConserved();
        assertEq(usd.balanceOf(address(t)), t.pot(), "every dollar is in the pot");
    }

    /// @dev Every state change says what it left: the note's part and the task's two claims, the buckets after a claim and the
    /// task's held money after it, and the buckets after notes are written (so a server can rebuild them from logs alone).
    function test_theEventsCarryTheStateTheyLeave() public {
        uint64 a = _locked(500, 10_000e6);
        vm.expectEmit(true, true, false, true, address(_book()));
        emit TaskBook.NoteMinted(a, alice, 2000e6, 3000e6, 2000e6);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.TaskMoney(5, 0, alice, 2000e6, 57_000e6, 3000e6, 2000e6);
        vm.expectEmit(true, true, false, true, address(t));
        emit Treasury.Left(alice, alice, 40_000e18, 38_000e6, 2000e6, 57_000e6, 60_000e6, 60_000e18);
        _leave(alice, 40_000e18);
        vm.expectEmit(true, false, false, true, address(_book()));
        emit TaskBook.TaskResolved(a, uint8(TaskBook.State.Paid), 3000e6, 2000e6, 800e6, 1200e6, 2000e6, 0);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.TaskMoney(2, a, worker, 3000e6, 58_200e6, 0, 800e6);
        _accept(a, 3000e6);
        vm.expectEmit(true, true, false, true, address(_book()));
        emit TaskBook.NoteClaimed(a, alice, 800e6, 0, 0, 0);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.TaskMoney(6, a, alice, 800e6, 58_200e6, 0, 0);
        _claim(a, alice);
    }

    function test_aFullPaymentVoidsTheNote() public {
        uint64 a = _locked(500, 10_000e6);
        _leave(alice, 40_000e18);
        _accept(a, 5000e6);
        assertEq(usd.balanceOf(worker), 5000e6, "the worker is paid the stayers' claim and the note's money");
        assertEq(t.notesOwed(), 0);
        assertEq(t.locked(), 0);
        assertEq(_book().claimableNote(a, alice), 0);
        vm.expectRevert(TaskBook.NothingToPay.selector);
        t.claimNote(a, alice);
        assertEq(t.pot(), 57_000e6, "stayers bear the whole payment: 57,000 for 60,000 Shares");
        _assertConserved();
    }

    function test_aRejectedTaskPaysTheNoteInFull() public {
        uint64 a = _locked(500, 10_000e6);
        _leave(alice, 40_000e18);
        vm.prank(founder);
        t.rejectTask(a);
        assertEq(t.notesOwed(), 2000e6, "the note keeps its whole face");
        assertEq(t.pot(), 57_000e6 + 3000e6);
        assertEq(_claim(a, alice), 2000e6);
        assertEq(
            usd.balanceOf(alice), 40_000e6, "the leaver ends where they would have if the task had never been set aside"
        );
        assertEq(t.pot(), 60_000e6);
        _assertConserved();
    }

    // ---- what a leave mints

    function test_noteIsWhatQuoteTakeOutShowedToTheUnit() public {
        _locked(500, 10_000e6);
        uint256[4] memory pieces = [uint256(1e18), 1234e18, 7777e18 + 13, 20_000e18];
        for (uint256 i; i < pieces.length; ++i) {
            (uint256 cashQ, uint256 noteQ,) = t.quoteTakeOut(alice, pieces[i]);
            uint256 lockedBefore = t.locked();
            uint256 owedBefore = t.notesOwed();
            uint256 cash = _leave(alice, pieces[i]);
            assertEq(cash, cashQ, "cash");
            assertEq(lockedBefore - t.locked(), noteQ, "the stayers' claim fell by exactly the quoted note");
            assertEq(t.notesOwed() - owedBefore, noteQ, "and the notes owed rose by it");
        }
    }

    function test_theNoteIsTheCostOfBeingPaidOnThePotWithoutTheSetAsideMoney() public {
        _locked(500, 10_000e6);
        uint256 b = shares.totalSupply();
        uint256 n = 5000e18;
        uint256 withLocked = PotMath.cash(n, t.pot() + t.locked(), t.paidIn(), b, team.totalSupply());
        uint256 cash = PotMath.cash(n, t.pot(), t.paidIn(), b, team.totalSupply());
        uint256 lk = t.locked();
        _leave(alice, n);
        assertEq(lk - t.locked(), withLocked - cash);
    }

    function test_aLeaveWithNothingSetAsideMintsNothingAndSaysNothingMore() public {
        vm.recordLogs();
        _leave(alice, 10_000e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != Treasury.TaskMoney.selector, "no money moved between the buckets");
        }
        (uint256 c, uint256 note,) = t.quoteTakeOut(alice, 1e18);
        assertGt(c, 0);
        assertEq(note, 0);
    }

    function test_theNoteIsSpreadOverTheTakenTasksInProportionToTheirClaims() public {
        uint64 a = _announce(500, 10_000e6);
        uint64 b = _announce(100, 10_000e6);
        _warpAlive(_book().taskOf(a).noticeEnd);
        vm.startPrank(worker);
        t.takeTask(a, 0); // 5,000 set aside
        t.takeTask(b, 0); // 1% of the 95,000 pot: 950
        vm.stopPrank();
        assertEq(t.locked(), 5950e6);
        _leave(alice, 40_000e18);
        // pot 94,050, so cash 37,620 and a note of 2,380 spread 5,000 : 950
        assertEq(_book().noteOf(a, alice), 2000e6);
        assertEq(_book().noteOf(b, alice), 380e6);
        assertEq(t.notesOwed(), 2380e6);
        assertEq(t.locked(), 5950e6 - 2380e6);
        TaskBook.Task memory ka = _book().taskOf(a);
        TaskBook.Task memory kb = _book().taskOf(b);
        assertEq(ka.stayer + ka.noteFace, ka.locked);
        assertEq(kb.stayer + kb.noteFace, kb.locked);
        assertEq(ka.noteFace, 2000e6);
        assertEq(kb.noteFace, 380e6);
    }

    function test_theLastHoldersToLeaveTurnAllTheSetAsideMoneyIntoNotes() public {
        uint64 a = _locked(500, 10_000e6);
        _leave(alice, 40_000e18);
        _leave(bob, 60_000e18);
        assertEq(t.locked(), 0, "nothing is left for stayers: there are none");
        assertEq(t.notesOwed(), 5000e6, "never more than was set aside");
        TaskBook.Task memory k = _book().taskOf(a);
        assertEq(k.stayer, 0);
        assertEq(k.noteFace, 5000e6);
        assertEq(t.pot(), 0);
        _accept(a, 3000e6);
        assertEq(t.pot(), 0, "all that came back belongs to the notes");
        assertEq(_claim(a, alice), 800e6);
        assertEq(_claim(a, bob), 1200e6);
        assertEq(t.notesOwed(), 0);
        assertEq(t.pot(), 0);
        _assertConserved();
        assertEq(usd.balanceOf(address(t)), 0, "every dollar went out");
    }

    function test_aTakeOutThatPaysNoCashMintsNoNoteEvenIfOneWouldBeDue() public {
        // Team Shares are paid only from the pot above paid-in. Pot 101,000 over paid-in 100,000: a 5% task is set aside
        // (5,050) and the pot falls to 95,950, under paid-in, so a Team take-out pays nothing now; with the money back it
        // would be owed 1,000 of surplus. The take-out still reverts (the quote and the action agree: no cash, no note).
        _relaunch(10_000_000e18, 0);
        t.forceShares(alice, 100_000e18);
        _force(101_000e6, 100_000e6, 0, 0, 0);
        vm.prank(address(vester));
        team.transfer(carol, 1_000_000e18);
        uint64 a = _locked(500, 10_000e6);
        assertEq(t.locked(), 5050e6);
        vm.prank(carol);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.leaveTeam(1_000_000e18, 0, carol);
        assertEq(_book().noteOf(a, carol), 0);
        assertEq(t.locked(), 5050e6, "nothing was written down");
    }

    function test_aTeamTakeOutIsGivenANoteByTheTeamFormula() public {
        _relaunch(10_000_000e18, 0);
        t.forceShares(alice, 100_000e18);
        _force(130_000e6, 100_000e6, 0, 0, 0);
        vm.prank(address(vester));
        team.transfer(carol, 1_000_000e18);
        uint64 a = _locked(500, 10_000e6); // 6,500 set aside, pot 123,500, surplus over paid-in 23,500
        uint256 lk = t.locked();
        assertEq(lk, 6500e6);
        uint256 n = 400_000e18;
        uint256 b = shares.totalSupply();
        uint256 g = team.totalSupply();
        uint256 cashX = PotMath.teamCash(n, t.pot(), t.paidIn(), b, g);
        uint256 noteX = PotMath.teamCash(n, t.pot() + lk, t.paidIn(), b, g) - cashX;
        assertGt(cashX, 0);
        assertGt(noteX, 0);
        vm.prank(carol);
        uint256 cash = t.leaveTeam(n, 0, carol);
        assertEq(cash, cashX);
        assertEq(_book().noteOf(a, carol), noteX);
        assertEq(lk - t.locked(), noteX);
        assertEq(t.notesOwed(), noteX);
        // it comes back whole when the task is rejected
        vm.prank(founder);
        t.rejectTask(a);
        assertEq(_claim(a, carol), noteX);
        _assertConserved();
    }

    function test_aTinyTakeOutThatPaysNothingStillReverts() public {
        _locked(500, 10_000e6);
        vm.prank(alice);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.leave(1e6, 0, alice); // a millionth of a millionth of a Share: no cash
        assertEq(t.notesOwed(), 0);
    }

    function test_theSpreadRoundsEachPartDownAndTheRemainderStaysWithTheStayers() public {
        _force(100_001_777_000 / 1000 * 1000 + 333, 100_000e6, 0, 0, 0); // a pot that makes every share an odd number
        uint64 a = _announce(137, 1e15);
        uint64 b = _announce(211, 1e15);
        uint64 c = _announce(333, 1e15);
        _warpAlive(_book().taskOf(c).noticeEnd);
        vm.startPrank(worker);
        t.takeTask(a, 0);
        t.takeTask(b, 0);
        t.takeTask(c, 0);
        vm.stopPrank();
        uint256 lk = t.locked();
        uint256 n = 13_579e18 + 7;
        uint256 expected = PotMath.cash(n, t.pot() + lk, t.paidIn(), shares.totalSupply(), team.totalSupply())
            - PotMath.cash(n, t.pot(), t.paidIn(), shares.totalSupply(), team.totalSupply());
        (, uint256 quoted,) = t.quoteTakeOut(alice, n);
        _leave(alice, n);
        uint256 minted = _book().noteOf(a, alice) + _book().noteOf(b, alice) + _book().noteOf(c, alice);
        assertEq(minted, quoted, "the quote shows what was written");
        assertLe(minted, expected, "parts are rounded down: never more than the note");
        assertGe(minted + 2, expected, "and at most one unit a task less");
        assertEq(lk - t.locked(), minted);
        assertEq(t.notesOwed(), minted);
        uint64[3] memory ids = [a, b, c];
        for (uint256 i; i < 3; ++i) {
            TaskBook.Task memory k = _book().taskOf(ids[i]);
            assertEq(uint256(k.stayer) + k.noteFace, k.locked, "C + N == L");
            assertEq(k.noteFace, _book().noteOf(ids[i], alice));
        }
    }

    function test_theQuoteSkipsOneTaskThatHasRunOutWhileAnotherIsStillTaken() public {
        // two tasks announced together; `a` is taken at the end of the notice, `b` three days later, so `a` runs out first
        uint64 a = _announce(500, 10_000e6);
        uint64 b = _announce(200, 10_000e6);
        _warpAlive(_book().taskOf(a).noticeEnd);
        vm.prank(worker);
        t.takeTask(a, 0);
        _warpAlive(vm.getBlockTimestamp() + 3 days);
        vm.prank(worker);
        t.takeTask(b, 0);
        _warpAlive(_book().taskOf(a).deadline); // the second `a` runs out; `b` has three days left
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Taken), "nobody has settled yet");
        (uint256 cashQ, uint256 noteQ,) = t.quoteTakeOut(alice, 40_000e18);
        assertGt(noteQ, 0, "`b` is still set aside");
        uint256 cash = _leave(alice, 40_000e18);
        assertEq(cash, cashQ, "the cash is the quote");
        assertEq(_book().noteOf(a, alice), 0, "no note against the task that had run out");
        assertEq(_book().noteOf(b, alice), noteQ, "the whole note is against the task still taken: the quote said so");
        assertEq(t.notesOwed(), noteQ);
    }

    function test_theQuoteSkipsATaskThatHasRunOutAndStillMatchesTheLeave() public {
        uint64 a = _locked(500, 10_000e6);
        _leave(bob, 1000e18); // a note against `a`, so the pot and the claims are not round
        _warpAlive(_book().taskOf(a).deadline);
        // `a` ran out this second but nobody has settled: the quote must already count it as back, the leave does
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Taken));
        (uint256 cashQ, uint256 noteQ,) = t.quoteTakeOut(alice, 40_000e18);
        assertEq(noteQ, 0, "nothing is set aside any more");
        uint256 cash = _leave(alice, 40_000e18);
        assertEq(cash, cashQ);
        assertEq(_book().noteOf(a, alice), 0);
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Returned));
    }

    function test_theBookRefusesANumberTheTreasuryGotWrongInsteadOfWritingNotes() public {
        uint64 a = _locked(500, 10_000e6);
        t.forceNote(1); // the Treasury believes 1 unit less is the stayers' claim than the book holds
        vm.prank(alice);
        vm.expectRevert(TaskBook.Inconsistent.selector);
        t.leave(1000e18, 0, alice);
        assertEq(_book().noteOf(a, alice), 0, "nothing was written");
    }

    // ---- claims

    function test_aNoteIsClaimedOnceAndAnyoneMayCallItForTheHolder() public {
        uint64 a = _locked(500, 10_000e6);
        _leave(alice, 40_000e18);
        vm.prank(founder);
        t.rejectTask(a);
        vm.prank(stranger);
        assertEq(t.claimNote(a, alice), 2000e6);
        assertEq(usd.balanceOf(alice), 38_000e6 + 2000e6);
        vm.expectRevert(TaskBook.NothingToPay.selector);
        t.claimNote(a, alice); // a second claim finds nothing
        vm.expectRevert(TaskBook.NothingToPay.selector);
        t.claimNote(a, bob); // a holder with no note finds nothing
        assertEq(_book().noteOf(a, alice), 0);
    }

    function test_aNoteCannotBeClaimedWhileTheTaskIsOpen() public {
        uint64 a = _locked(500, 10_000e6);
        _leave(alice, 40_000e18);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.NotYet.selector, _book().taskOf(a).deadline));
        t.claimNote(a, alice);
        vm.expectRevert(TaskBook.NoSuchTask.selector);
        t.claimNote(99, alice);
        uint64 b = _announce(100, 1000e6);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.NotYet.selector, _book().taskOf(b).expiresAt));
        t.claimNote(b, alice);
    }

    function test_aTaskThatRanOutIsReturnedAndClaimedInOneCall() public {
        uint64 a = _locked(500, 10_000e6);
        _leave(alice, 40_000e18);
        _warpAlive(_book().taskOf(a).deadline + 1);
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Taken), "nobody has settled yet");
        vm.prank(stranger);
        assertEq(t.claimNote(a, alice), 2000e6);
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Returned));
        assertEq(t.pot(), 60_000e6);
        assertEq(t.locked(), 0);
        assertEq(t.notesOwed(), 0);
        _assertConserved();
    }

    function test_aNoteIsStillClaimableAfterAWindDownReturnedTheTask() public {
        uint64 a = _locked(500, 10_000e6);
        _leave(alice, 40_000e18);
        vm.prank(founder);
        t.windDown();
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Returned));
        assertEq(_claim(a, alice), 2000e6);
        _assertConserved();
    }

    function test_theLastClaimSendsTheRoundingLeftOverToThePot() public {
        // Three notes of 333,333 units against a task of 1,000,000 (a dollar): the stayers' claim is the last unit. Paying 1
        // unit leaves 999,999; the notes get floor(999,999 x 999,999 / 1,000,000) = 999,998 to share, each claim is
        // floor(333,333 x 999,999 / 1,000,000) = 333,332, so two units are left over for the pot after the last claim.
        _force(100_000e6, 100_000e6, 0, 0, 0);
        uint64 a = _announce(100, 1e6);
        _warpAlive(_book().taskOf(a).noticeEnd);
        vm.prank(worker);
        t.takeTask(a, 0);
        assertEq(t.locked(), 1e6);
        address[3] memory h = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            _book().forceNote(a, h[i], 333_333);
            t.forceNote(333_333);
        }
        _accept(a, 1);
        uint256 pot0 = t.pot();
        assertEq(t.notesOwed(), 999_998);
        uint256 total;
        for (uint256 i; i < 3; ++i) {
            if (i == 2) {
                // the last note: the two units of rounding go to the pot, and the event says so
                vm.expectEmit(true, true, false, true, address(_book()));
                emit TaskBook.NoteClaimed(a, h[i], 333_332, 2, 0, 0);
            }
            uint256 got = _claim(a, h[i]);
            assertEq(got, 333_332);
            total += got;
        }
        assertEq(t.notesOwed(), 0, "nothing stays owed");
        assertEq(t.pot(), pot0 + 2, "the two left-over units went to the pot, not to the last claimer");
        assertEq(total, 999_996);
        assertLe(total, _book().taskOf(a).returned, "notes were paid no more than came back");
        _assertConserved();
    }

    function test_aNoteTooSmallToPayAnythingIsStillClearedAndItsDustSwept() public {
        _force(100_000e6, 100_000e6, 0, 0, 0);
        uint64 a = _announce(100, 1e6);
        _warpAlive(_book().taskOf(a).noticeEnd);
        vm.prank(worker);
        t.takeTask(a, 0);
        _book().forceNote(a, carol, 1);
        t.forceNote(1);
        _accept(a, 999_999); // 1 unit comes back; the note's pool is floor(1 x 1 / 1,000,000) = 0
        assertEq(t.notesOwed(), 0);
        assertEq(_book().taskOf(a).returned, 1);
        uint256 pot0 = t.pot();
        assertEq(_claim(a, carol), 0, "nothing to pay");
        assertEq(_book().noteOf(a, carol), 0, "but the note is cleared");
        assertEq(t.pot(), pot0);
        _assertConserved();
    }

    function test_aClaimReentersNothing() public {
        uint64 a = _locked(500, 10_000e6);
        _leave(alice, 40_000e18);
        vm.prank(founder);
        t.rejectTask(a);
        // while the holder is paid, the dollar calls back: another claim, a settle, a take-out and a return all find the lock
        bytes[4] memory calls = [
            abi.encodeCall(Treasury.claimNote, (a, alice)),
            abi.encodeCall(Treasury.settle, ()),
            abi.encodeCall(Treasury.leave, (1e18, 0, alice)),
            abi.encodeCall(Treasury.returnTask, (a))
        ];
        for (uint256 i; i < calls.length; ++i) {
            uint256 id = vm.snapshotState();
            usd.armCallback(alice, address(t), calls[i]);
            assertEq(_claim(a, alice), 2000e6);
            assertTrue(usd.callbackFired(), "the dollar called back during the payment");
            assertFalse(usd.callbackOk(), string.concat("the Treasury refused re-entry #", vm.toString(i)));
            assertEq(bytes4(usd.callbackRet()), Treasury.Reentrancy.selector, "for that reason");
            assertEq(t.notesOwed(), 0);
            _assertConserved();
            vm.revertToState(id);
        }
    }

    function test_theHolderIsPaidAfterEveryBucketIsFinal() public {
        NoteRecorder rec = new NoteRecorder(t);
        t.forceShares(address(rec), 10_000e18);
        uint64 a = _locked(500, 10_000e6);
        vm.prank(address(rec));
        t.leave(10_000e18, 0, address(rec));
        assertGt(_book().noteOf(a, address(rec)), 0);
        vm.prank(founder);
        t.rejectTask(a);
        usd.setHooked(address(rec), true);
        uint256 owed = t.notesOwed();
        uint256 mine = _book().noteOf(a, address(rec));
        assertGt(mine, 0);
        _claim(a, address(rec));
        assertTrue(rec.fired(), "the dollar called the holder back");
        assertEq(rec.noteSeen(), 0, "the note was already cleared when the holder was paid");
        assertEq(rec.owedSeen(), owed - mine, "and the money was already booked out");
    }
}

/// @notice A note holder that looks at the Treasury while it is being paid.
contract NoteRecorder {
    Treasury internal t;
    bool public fired;
    uint256 public owedSeen;
    uint256 public noteSeen;

    constructor(Treasury t_) {
        t = t_;
    }

    function onQuoteTransfer(address, address, uint256, bool after_) external {
        if (!after_ || fired || address(t.tasks()) == address(0)) return;
        fired = true;
        owedSeen = t.notesOwed();
        noteSeen = TaskBook(address(t.tasks())).noteOf(1, address(this));
    }
}
