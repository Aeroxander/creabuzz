// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {PotHandler} from "./helpers/PotHandler.sol";
import {Vester} from "../src/Vester.sol";
import {TaskBook} from "../src/TaskBook.sol";

/// @notice Stateful invariants of one project run through the real stack by `PotHandler`: many actors, joins, leaves,
/// Team leaves, outside payments arriving, forfeits, vesting, draws, rate changes, check-ins, lapses and a wind-down, and the
/// task queue: announce, take, accept in full and in part, reject, cancel, a task running out, exit notes and their claims.
/// The handler also records, step by step, the rules that need a before and an after (price never falls on a join, no step
/// but a spend or a fee lowers a Share's worth, the Team never reaches paid-in money, a full exit pays everyone the same per
/// Share and never more than the pot); the last invariant here reads that record.
contract PotInvariantsTest is StackBase {
    PotHandler internal h;
    address[] internal who;

    function setUp() public override {
        super.setUp();
        h = new PotHandler(usd, t, shares, team, v, founder, POOL);
        who = h.actorsList();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](31);
        sel[0] = h.join.selector;
        sel[1] = h.leave.selector;
        sel[2] = h.leaveTeam.selector;
        sel[3] = h.revenue.selector;
        sel[4] = h.warp.selector;
        sel[5] = h.checkIn.selector;
        sel[6] = h.draw.selector;
        sel[7] = h.lowerRate.selector;
        sel[8] = h.proposeRate.selector;
        sel[9] = h.applyRate.selector;
        sel[10] = h.grant.selector;
        sel[11] = h.claim.selector;
        sel[12] = h.ownExit.selector;
        sel[13] = h.executeForfeit.selector;
        sel[14] = h.collectFees.selector;
        sel[15] = h.toggleDoor.selector;
        sel[16] = h.windDown.selector;
        sel[17] = h.probeFullExit.selector;
        sel[18] = h.join.selector; // joins twice as likely as most steps: nothing else happens without money
        sel[19] = h.teamPath.selector;
        sel[20] = h.leaveTeam.selector;
        sel[21] = h.announceTask.selector;
        sel[22] = h.advanceToTask.selector;
        sel[23] = h.takeTask.selector;
        sel[24] = h.acceptTask.selector;
        sel[25] = h.rejectTask.selector;
        sel[26] = h.cancelTask.selector;
        sel[27] = h.claimNote.selector;
        sel[28] = h.advanceToTask.selector; // time has to move for a task to be taken, paid or run out
        sel[29] = h.leave.selector; // take-outs while money is set aside are what writes notes
        sel[30] = h.claimNote.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// @dev The dollars the Treasury holds always cover every bucket it owes.
    function invariant_theTreasuryHoldsAtLeastWhatItOwes() public view {
        uint256 owed = t.pot() + t.box() + t.arriving() + t.feesOwed() + t.locked() + t.notesOwed();
        assertGe(usd.balanceOf(address(t)), owed, "the contract owes more dollars than it holds");
    }

    /// @dev With no donations, every dollar that went in and has not come out sits in exactly one bucket: the pot, the box, outside
    /// money arriving, fees owed, the money set aside for tasks, or the money held for exit notes. What went out includes
    /// payments to workers and note claims.
    function invariant_everyDollarIsInOneBucket() public view {
        uint256 owed = t.pot() + t.box() + t.arriving() + t.feesOwed() + t.locked() + t.notesOwed();
        assertEq(usd.balanceOf(address(t)), h.cashIn() - h.cashOut(), "balance is dollars in less dollars out");
        assertEq(owed, h.cashIn() - h.cashOut(), "the buckets add up to dollars in less dollars out");
    }

    /// @dev Shares and Team Shares in anyone's hands add up to the token supplies the Treasury reads as B and G.
    function invariant_suppliesAreTheSumOfBalances() public view {
        uint256 b;
        uint256 g = team.balanceOf(address(v));
        for (uint256 i; i < who.length; ++i) {
            b += shares.balanceOf(who[i]);
            g += team.balanceOf(who[i]);
        }
        assertEq(b, shares.totalSupply(), "backer Shares in hands equal the supply");
        assertEq(g, team.totalSupply(), "Team Shares in hands and in the Vester equal the supply");
    }

    /// @dev Paid-in is zero with no backers, and never more than what joins put in net of fees.
    function invariant_paidInStaysInStep() public view {
        if (shares.totalSupply() == 0) assertEq(t.paidIn(), 0, "paid-in with no backers");
        assertLe(t.paidIn(), h.creditedMax(), "paid-in is more than was ever paid in");
    }

    /// @dev After a step the box is within seven days of accrual.
    function invariant_theBoxIsWithinItsCap() public view {
        assertLe(t.box(), t.boxCap(), "the box is over its cap");
    }

    /// @dev The burn queue is exactly the announced, unburned Team Shares, and is never more than all Team Shares.
    function invariant_theBurnQueueIsTheAnnouncedPart() public view {
        uint256 queued;
        uint256 owed;
        for (uint256 id; id < v.grantCount(); ++id) {
            Vester.Grant memory g = v.grantOf(id);
            owed += g.total - g.claimed + g.burn;
            if (g.state == Vester.State.Announced) queued += g.burn;
        }
        assertEq(t.Z(), queued, "Z is the announced part");
        assertLe(t.Z(), team.totalSupply(), "Z is within G");
        assertEq(v.committed(), owed, "committed is exactly what the grants are owed");
        assertGe(team.balanceOf(address(v)), v.committed(), "the Vester holds what it owes");
    }

    /// @dev Team Shares are made once, at birth.
    function invariant_teamSharesAreNeverCreatedAfterBirth() public view {
        assertLe(team.totalSupply(), POOL, "Team supply above the pool");
    }

    /// @dev The step rules the handler checks with a before and an after.
    function invariant_noStepBrokeARule() public view {
        assertEq(h.violation(), "", "a step broke a rule");
    }

    // ================================================= the task queue ================================================

    /// @dev I2, I3: `locked` is the sum of the stayers' claims of the open taken tasks; `notesOwed` is the face of their notes
    /// plus what is still held for the notes of tasks that ended; C + N == L while a task is taken.
    function invariant_theMoneySetAsideIsWhatTheOpenTasksHold() public view {
        TaskBook b = TaskBook(address(t.tasks()));
        uint64[] memory live = h.liveSerials();
        uint256 sumC;
        uint256 sumOwed;
        for (uint256 i; i < live.length; ++i) {
            TaskBook.Task memory k = b.taskOf(live[i]);
            if (k.state == TaskBook.State.Taken) {
                assertEq(uint256(k.stayer) + k.noteFace, k.locked, "C + N == L while a task is taken");
                sumC += k.stayer;
                sumOwed += k.noteFace;
            } else if (k.state != TaskBook.State.Announced) {
                sumOwed += k.notesLeft;
            }
        }
        assertEq(t.locked(), sumC, "locked is the sum of the stayers' claims");
        assertEq(t.notesOwed(), sumOwed, "notes owed is what is held for notes");
    }

    /// @dev I4, I9: the notes of a serial are paid no more than was held for them when it ended, the money held and the money
    /// paid never pass it, claimable notes add up to no more than what is held, and a task paid in full has no claimable note.
    function invariant_notesNeverExceedTheMoneyReturnedForTheirSerial() public view {
        TaskBook b = TaskBook(address(t.tasks()));
        uint64[] memory all = h.allSerials();
        address[] memory holders = h.actorsList();
        for (uint256 i; i < all.length; ++i) {
            uint64 sr = all[i];
            TaskBook.Task memory k = b.taskOf(sr);
            if (k.state == TaskBook.State.Announced || k.state == TaskBook.State.Taken) continue;
            assertLe(h.claimedOf(sr) + k.notesLeft, h.poolAtEnd(sr), "notes were paid more than was held for them");
            assertLe(h.poolAtEnd(sr), k.returned, "the notes' pool is part of what came back");
            assertLe(h.claimedOf(sr), k.returned, "claimed more than came back");
            uint256 claimable;
            for (uint256 j; j < holders.length; ++j) {
                claimable += b.claimableNote(sr, holders[j]);
            }
            assertLe(claimable, k.notesLeft, "claimable notes exceed what is held for them");
            if (k.returned == 0) {
                assertEq(claimable, 0, "a task paid in full (or never taken) has no claimable note");
                assertEq(k.notesLeft, 0);
            }
            if (k.noteFace == 0) assertEq(k.notesLeft, 0, "no note left, nothing held for notes");
        }
    }

    /// @dev I5, I6, I10: at most 8 open tasks and as many as are announced or taken; a serial is used once; the 28-day sum of
    /// takes never passes 10%; the next expiry is the earliest end of any open task.
    function invariant_theQueueKeepsItsLimits() public view {
        TaskBook b = TaskBook(address(t.tasks()));
        assertLe(b.openCount(), 8, "at most eight open tasks");
        uint64[] memory all = h.allSerials();
        assertEq(b.nextSerial(), all.length + 1, "serials are used once, in order");
        uint256 open;
        uint256 first;
        for (uint256 i; i < all.length; ++i) {
            TaskBook.Task memory k = b.taskOf(all[i]);
            assertEq(all[i], i + 1, "serials are consecutive");
            if (k.state == TaskBook.State.Announced || k.state == TaskBook.State.Taken) {
                ++open;
                if (first == 0 || k.expiresAt < first) first = k.expiresAt;
            }
        }
        assertEq(b.openCount(), open, "the open count is the tasks announced or taken");
        assertLe(b.windowSumBps(), 1000, "the 28-day sum of takes is within 10% of the pot");
        assertEq(t.nextExpiry(), first, "the next expiry is the earliest end of any open task");
    }

    /// @dev Print how many steps of each kind a run made, so a green run can be seen to have done something.
    function afterInvariant() public {
        bytes32[] memory names = h.stepNames();
        for (uint256 i; i < names.length; ++i) {
            emit log_named_uint(string(abi.encodePacked(names[i])), h.count(names[i]));
        }
    }
}
