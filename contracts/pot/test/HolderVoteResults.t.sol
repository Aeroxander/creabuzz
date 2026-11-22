// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {VoteBase} from "./helpers/VoteBase.sol";
import {Council} from "../src/Council.sol";
import {HolderVote} from "../src/HolderVote.sol";

/// @notice Every result path (COUNCIL-PLAN.md 2.6). A replace ballot is short under the floor, kept when the floor is met and
/// no list has more than half of the cast Shares, and moved when one list has strictly more than half (exactly half is kept).
/// A seat ballot seats a person who is strictly above "keep", with at least one whole Share and among the top two; a tie for
/// the last seat leaves that seat as it is; nobody qualifying is unchanged. Only a kept replace result with the floor met
/// starts the cooldown. The last test says which seat a winner takes when they already hold one of the two up seats.
contract HolderVoteResultsTest is VoteBase {
    // ---------------------------------------------------------- replace

    function test_aReplaceBallotUnderTheFloorIsShortSetsNoCooldownAndOpensTheDoorAgain() public {
        _park(bob, 5_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1); // 15,000,000e18 cast, under the 16,333,333e18 floor

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SHORT(), "under the floor is short");
        assertEq(winner, 0);
        assertEq(vote.nextReplaceAt(), 0, "a short ballot starts no cooldown");

        _toEffective(id);
        vm.expectRevert(HolderVote.NothingToDo.selector);
        vote.carryOut(id);
        assertTrue(vote.canOpenReplace(), "the door is open at once");
        uint32 next = _replaceVote(alice, _list());
        assertTrue(next != id, "a new ballot opened");
    }

    function test_aKeptReplaceBallotStartsTheCooldownAndCarriesNothing() public {
        _park(bob, 5_000_000e18);
        _park(carol, 4_000_000e18);
        _park(dave, 3_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 0);
        _cast(carol, 0);
        _cast(dave, 0); // 22,000,000e18 cast; the list's 10,000,000e18 is under half

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_KEPT(), "the floor is met and no list has more than half");
        assertEq(winner, 0);
        assertEq(vote.nextReplaceAt(), uint256(b.voteEnd) + 4 * 7 days, "a real keep holds the door 28 days");
        assertEq(t.runner(), founder);

        _toEffective(id);
        vm.expectRevert(HolderVote.NothingToDo.selector);
        vote.carryOut(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderVote.Cooldown.selector, vote.nextReplaceAt()));
        vote.openReplace(_list(), keccak256("too soon"));
    }

    function test_aListWithExactlyHalfOfTheCastSharesIsKeptNotMoved() public {
        _park(bob, 5_000_000e18);
        _park(carol, 5_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 0);
        _cast(carol, 0); // 20,000,000e18 cast; the list's 10,000,000e18 is exactly half

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_KEPT(), "exactly half does not move the seat");
        assertEq(winner, 0);
        assertEq(vote.nextReplaceAt(), uint256(b.voteEnd) + 4 * 7 days, "the floor was met, so the cooldown runs");
    }

    function test_aListWithMoreThanHalfOfTheCastSharesMovesTheSeat() public {
        _park(bob, 5_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1);
        _cast(carol, 0); // 19,000,000e18 cast; the list has 15,000,000e18, more than half

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_MOVED(), "more than half moves the seat");
        assertEq(winner, 1);
        assertEq(vote.nextReplaceAt(), 0, "no cooldown after a result that moved the seat");

        _toEffective(id);
        vote.carryOut(id);
        address c = t.runner();
        assertEq(launcher.runnerKindOf(c), 2, "the runner is a Council");
        assertEq(Council(c).vote(), address(vote));
        (address[5] memory seats,) = Council(c).seatList();
        assertEq(seats[0], s1);
        assertEq(seats[4], s5);
    }

    function test_aMovedResultThatLapsesSetsNoCooldown() public {
        _park(bob, 5_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1);
        _cast(carol, 1);

        _toVoteEnd(id);
        _warpTo(uint256(b.effectiveAt) + 2 * 7 days + 1);
        vote.lapse(id);
        HolderVote.Ballot memory afterLapse = _ballotAt(id);
        assertTrue(afterLapse.lapsed);
        assertEq(vote.nextReplaceAt(), 0, "no cooldown after a result that lapsed");
        assertEq(t.runner(), founder, "the old runner stays");
    }

    // ------------------------------------------------------------ seats

    function test_aSeatBallotUnderTheFloorIsShort() public {
        _makeCouncil();
        _park(alice, 10_000_000e18);
        _park(bob, 5_000_000e18);
        uint32 id = _dueSeatElection();
        _toStandEnd(id);
        _cast(alice, 0);
        _cast(bob, 0); // 15,000,000e18 cast on "keep", under the floor

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome,,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SHORT(), "under the floor is short");
        _toEffective(id);
        vm.expectRevert(HolderVote.NothingToDo.selector);
        vote.carryOut(id);
    }

    function test_aPersonLevelWithKeepIsNotSeated() public {
        _makeCouncil();
        _park(alice, 9_000_000e18);
        _park(bob, 9_000_000e18);
        uint32 id = _dueSeatElection();
        uint8 bobOption = _stand(bob);
        _toStandEnd(id);
        _cast(alice, 0);
        _cast(bob, bobOption); // bob's tally equals "keep" exactly, so it is not strictly above it

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner, uint8 winnerB) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_UNCHANGED(), "level with keep is not a win");
        assertEq(winner, 0);
        assertEq(winnerB, 0);
        _toEffective(id);
        vm.expectRevert(HolderVote.NothingToDo.selector);
        vote.carryOut(id);
    }

    function test_aPersonUnderOneWholeShareIsNotSeated() public {
        _makeCouncil();
        _park(alice, 17_000_000e18);
        _park(bob, 49_050e18); // enough to stand
        uint32 id = _dueSeatElection();
        uint8 aliceOption = _stand(alice);
        uint8 bobOption = _stand(bob);
        _toStandEnd(id);
        _cast(alice, aliceOption);
        _cast(bob, bobOption);
        _unpark(bob, 49_050e18 - 5e17); // bob's weight falls under one whole Share but stays above keep

        (, uint256 bobTally) = vote.optionOf(id, bobOption);
        assertEq(bobTally, 5e17);
        assertLt(bobTally, vote.MIN_VOTE(), "under one whole Share");

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner, uint8 winnerB) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SEATED(), "alice's 17,000,000e18 meets the floor");
        assertEq(winner, aliceOption);
        assertEq(winnerB, 0, "a person under one whole Share cannot take the second seat");
    }

    function test_theTopTwoTakeTheTwoSeats() public {
        _makeCouncil();
        _park(alice, 10_000_000e18);
        _park(bob, 7_000_000e18);
        _park(carol, 3_000_000e18);
        uint32 id = _dueSeatElection();
        HolderVote.Ballot memory b = _ballotAt(id);
        uint8 aliceOption = _stand(alice);
        uint8 bobOption = _stand(bob);
        uint8 carolOption = _stand(carol);
        _toStandEnd(id);
        _cast(alice, aliceOption);
        _cast(bob, bobOption);
        _cast(carol, carolOption); // 10,000,000e18, 7,000,000e18, 3,000,000e18: carol is third

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner, uint8 winnerB) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SEATED());
        assertEq(winner, aliceOption, "the highest tally is first");
        assertEq(winnerB, bobOption, "the second highest takes the other seat");

        _toEffective(id);
        vote.carryOut(id);
        (address[5] memory seats,) = Council(t.runner()).seatList();
        uint8 lo = b.upA < b.upB ? b.upA : b.upB;
        uint8 hi = b.upA < b.upB ? b.upB : b.upA;
        assertEq(seats[lo], alice);
        assertEq(seats[hi], bob);
    }

    /// @dev A tie between the first and second places is not a tie for the last seat: those two are the top two, so both
    /// are seated (COUNCIL-PLAN.md 2.6).
    function test_twoCandidatesTiedAtTheTopTakeBothSeats() public {
        _makeCouncil();
        _park(alice, 9_000_000e18);
        _park(bob, 9_000_000e18);
        uint32 id = _dueSeatElection();
        uint8 aliceOption = _stand(alice);
        uint8 bobOption = _stand(bob);
        _toStandEnd(id);
        _cast(alice, aliceOption);
        _cast(bob, bobOption); // tied at the top, both strictly above keep

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner, uint8 winnerB) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SEATED());
        assertEq(winner, aliceOption);
        assertEq(winnerB, bobOption, "the top two take the two seats");
    }

    /// @dev A tie between the second and third tallies is a tie for the last seat: it leaves that seat as it is, and the
    /// tie is never broken by the order the candidates stood (COUNCIL-PLAN.md 2.6, V39).
    function test_aTieForTheLastSeatLeavesThatSeatAsItIs() public {
        _makeCouncil();
        _park(alice, 10_000_000e18);
        _park(bob, 8_000_000e18);
        _park(stranger, 8_000_000e18);
        uint32 id = _dueSeatElection();
        HolderVote.Ballot memory b = _ballotAt(id);
        uint8 aliceOption = _stand(alice);
        uint8 bobOption = _stand(bob);
        uint8 strangerOption = _stand(stranger);
        _toStandEnd(id);
        _cast(alice, aliceOption);
        _cast(bob, bobOption);
        _cast(stranger, strangerOption); // 10,000,000e18, then two 8,000,000e18 tied for the last seat

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner, uint8 winnerB) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SEATED(), "alice takes one seat");
        assertEq(winner, aliceOption);
        assertEq(winnerB, 0, "a tie for the last seat leaves that seat as it is");

        _toEffective(id);
        vote.carryOut(id);
        (address[5] memory seats,) = Council(t.runner()).seatList();
        uint8 lo = b.upA < b.upB ? b.upA : b.upB;
        uint8 hi = b.upA < b.upB ? b.upB : b.upA;
        assertEq(seats[lo], alice, "the seat alice took");
        assertEq(seats[hi], s2, "the tied seat keeps its holder");
        assertEq(bobOption, 2);
        assertEq(strangerOption, 3);
    }

    function test_nobodyQualifyingIsUnchanged() public {
        _makeCouncil();
        _park(alice, 10_000_000e18);
        _park(bob, 7_000_000e18);
        uint32 id = _dueSeatElection();
        _toStandEnd(id);
        _cast(alice, 0);
        _cast(bob, 0); // nobody stood; 17,000,000e18 on "keep" meets the floor

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner, uint8 winnerB) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_UNCHANGED(), "nobody qualifies");
        assertEq(winner, 0);
        assertEq(winnerB, 0);
        _toEffective(id);
        vm.expectRevert(HolderVote.NothingToDo.selector);
        vote.carryOut(id);
    }

    function test_oneWinnerFillsOnlyOneSeat() public {
        _makeCouncil();
        _park(alice, 10_000_000e18);
        _park(bob, 7_000_000e18);
        uint32 id = _dueSeatElection();
        HolderVote.Ballot memory b = _ballotAt(id);
        uint8 aliceOption = _stand(alice);
        _toStandEnd(id);
        _cast(alice, aliceOption);
        _cast(bob, 0); // 10,000,000e18 against 7,000,000e18: alice is the only person above keep

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner, uint8 winnerB) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SEATED());
        assertEq(winner, aliceOption);
        assertEq(winnerB, 0, "only one person qualified");

        _toEffective(id);
        vote.carryOut(id);
        (address[5] memory seats,) = Council(t.runner()).seatList();
        uint8 lo = b.upA < b.upB ? b.upA : b.upB;
        uint8 hi = b.upA < b.upB ? b.upB : b.upA;
        assertEq(seats[lo], alice, "one winner fills one seat");
        assertEq(seats[hi], s2, "and the other seat keeps its holder");
    }

    // ------------------------------------------- which seat a winner takes

    function test_aWinnerWhoAlreadyHoldsAnUpSeatStaysInIt() public {
        // a Council of holders, so the two seats that come up are held by accounts that can also vote and stand
        address[5] memory members = [alice, bob, carol, dave, s6];
        Council c = _handOverTo(members, keccak256("a council of holders"));
        _park(alice, 7_000_000e18); // holds seat 0, which comes up
        _park(stranger, 9_000_000e18);
        _park(carol, 1_000_000e18); // holds seat 2, which is not up: she may vote but not stand
        uint32 id = _dueSeatElection();
        HolderVote.Ballot memory b = _ballotAt(id);
        assertEq(b.council, address(c));
        uint8 aliceOption = _stand(alice); // a holder of an up seat may stand again
        uint8 strangerOption = _stand(stranger);
        _toStandEnd(id);
        _cast(alice, aliceOption);
        _cast(stranger, strangerOption);
        _cast(carol, 0); // 7,000,000e18, 9,000,000e18 and 1,000,000e18 on keep

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner, uint8 winnerB) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SEATED());
        assertEq(winner, strangerOption);
        assertEq(winnerB, aliceOption);

        uint8 lo = b.upA < b.upB ? b.upA : b.upB;
        uint8 hi = b.upA < b.upB ? b.upB : b.upA;
        (, uint64[5] memory seatedAtBefore) = c.seatList();
        _toEffective(id);
        vote.carryOut(id);
        (address[5] memory seats, uint64[5] memory seatedAt) = Council(t.runner()).seatList();
        assertEq(seats[lo], alice, "the winner who already held an up seat stays in it");
        assertEq(seats[hi], stranger, "the other winner takes the other up seat");
        assertEq(seatedAt[lo], seatedAtBefore[lo], "alice's own seat was not reset by her re-election");
        assertEq(seatedAt[hi], uint64(clock), "the other seat was taken now");
    }

    // ------------------------------------------------------------ helpers

    /// @dev The election the Council says is due, after the callers have parked (the snapshot is at opening).
    function _dueSeatElection() internal returns (uint32 id) {
        _warpTo(uint256(Council(t.runner()).nextElection()));
        id = _openSeats();
    }
}
