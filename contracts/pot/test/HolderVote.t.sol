// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {VoteBase} from "./helpers/VoteBase.sol";
import {Council} from "../src/Council.sol";
import {HolderVote} from "../src/HolderVote.sol";
import {ITreasuryRunner} from "../src/Interfaces.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice The vote contract end to end: binding, opening a replace vote, the stand window, voting, the result, the wait,
/// carrying it out (a Council seated), the cooldown, lapsing, one ballot at a time, and a seat election.
contract HolderVoteTest is VoteBase {
    // ------------------------------------------------------------- binding

    function test_theCloneKnowsItsProjectAndIsTheVote() public view {
        assertEq(address(vote.treasury()), address(t));
        assertEq(vote.key(), key);
        assertEq(address(vote.launcher()), address(launcher));
        assertTrue(vote.isVote());
        assertEq(vote.day(), UNIT / 7);
    }

    function test_bindProjectOnlyOnceAndOnlyByALauncherWhoseTreasuryPointsHere() public {
        vm.expectRevert(HolderVote.AlreadyBound.selector);
        vote.bindProject(ITreasuryRunner(address(t)), key); // bound by the Launcher at launch
    }

    // ------------------------------------------------------- opening one

    function test_aReplaceVoteOpensWithTheCallersListAsTheOnlyOptionAndTheChainsNumbers() public {
        _park(alice, 10_000_000e18);
        uint256 supply = shares.totalSupply();
        uint256 parked = vote.parkedTotal();
        assertGe(parked * vote.OPEN_DIVISOR(), supply, "the open floor is met");

        uint256 openedAt = clock;
        uint32 id = _openReplace(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);

        assertEq(b.kind, vote.KIND_REPLACE());
        assertEq(b.openedAt, openedAt);
        assertEq(b.standEnd, openedAt + uint256(vote.STAND_DAYS()) * DAY, "a one-day stand window");
        assertEq(b.voteEnd, b.standEnd + uint256(vote.VOTE_DAYS()) * DAY, "a three-day vote");
        (uint256 wait,,) = t.noticeFor(500);
        assertEq(b.effectiveAt, b.voteEnd + wait, "the wait is the longest task notice");
        assertEq(wait, 16.5 days, "16.5 days at a 7-day unit");
        assertEq(b.supply, supply, "the snapshot is the supply at opening");
        assertEq(b.floor, (supply + 2) / 3, "the floor is a third of the snapshot, rounded up");
        assertEq(b.optionCount, 2, "keep and the opener's list");
        (HolderVote.Option memory o1,) = vote.optionOf(id, 1);
        assertEq(o1.kind, 1, "the option is a list");
        assertEq(o1.members[0], s1);
        assertEq(vote.current(), id);
    }

    function test_aReplaceVoteNeedsTheOpenFloorAndTheOpenersOwnStake() public {
        // nothing is parked: no crowd, and no opener's weight
        vm.prank(alice);
        vm.expectRevert(HolderVote.NotEligible.selector);
        vote.openReplace(_list(), keccak256("x"));

        // a crowd parks, but the opener itself has nothing parked
        _park(bob, 6_000_000e18);
        _park(carol, 100_000e18);
        vm.prank(alice);
        vm.expectRevert(HolderVote.NotEligible.selector);
        vote.openReplace(_list(), keccak256("x"));
    }

    function test_aListIsFiveDistinctNonZeroAccountsAndNoneOfTheProjectsOwn() public {
        _park(alice, 10_000_000e18);
        address[5] memory repeated = [s1, s1, s2, s3, s4];
        vm.prank(alice);
        vm.expectRevert(HolderVote.BadMembers.selector);
        vote.openReplace(repeated, keccak256("x"));

        address[5] memory zero = [s1, s2, address(0), s3, s4];
        vm.prank(alice);
        vm.expectRevert(HolderVote.BadMembers.selector);
        vote.openReplace(zero, keccak256("x"));

        address[5] memory own = [s1, s2, address(t), s3, s4];
        vm.prank(alice);
        vm.expectRevert(HolderVote.ProjectAccount.selector);
        vote.openReplace(own, keccak256("x"));
    }

    function test_votingIsClosedUntilTheStandWindowIsOver() public {
        uint32 id = _replaceVote(alice, _list());
        vm.prank(alice);
        vm.expectRevert(HolderVote.VotingClosed.selector);
        vote.castVote(1);
        _toStandEnd(id);
        _cast(alice, 1); // now it works
        assertEq(vote.castOf(id), 10_000_000e18);
    }

    function test_aListCanBePutForwardInTheStandWindowAndNotAfter() public {
        uint32 id = _replaceVote(alice, _list());
        _park(bob, 6_000_000e18); // parked at the snapshot (before opening): wait, it is after; so this is the count test
        vm.prank(bob);
        vm.expectRevert(HolderVote.NotEligible.selector);
        vote.standList(_listB(), keccak256("b"));

        _park(carol, 4_000_000e18);
        // carol parked after the snapshot: her weight is zero, so she cannot stand either
        vm.prank(carol);
        vm.expectRevert(HolderVote.NotEligible.selector);
        vote.standList(_listB(), keccak256("b"));

        _toStandEnd(id);
        vm.prank(alice);
        vm.expectRevert(HolderVote.StandingClosed.selector);
        vote.standList(_listB(), keccak256("b"));
    }

    // ------------------------------------------------------------- voting

    function test_aVoteIsAllOfTheEligibleWeightAndMovesAsOne() public {
        _park(alice, 10_000_000e18);
        _park(bob, 6_000_000e18);
        uint32 id = _openReplace(alice, _list());
        _toStandEnd(id);

        _cast(alice, 1);
        assertEq(vote.castOf(id), 10_000_000e18, "alice's whole weight is cast");
        (, uint8 option, uint256 weight,) = vote.ballotOf(alice);
        assertEq(option, 1);
        assertEq(weight, 10_000_000e18);

        _cast(alice, 0); // move it
        (, option, weight,) = vote.ballotOf(alice);
        assertEq(option, 0);
        assertEq(weight, 10_000_000e18);
        assertEq(vote.castOf(id), 10_000_000e18, "a move does not double the cast total");
    }

    function test_aVoteUnderOneWholeShareIsRefused() public {
        _park(alice, 10_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        _park(bob, 6_000_000e18);
        _toStandEnd(id);
        vm.prank(bob); // bob parked after the snapshot: zero weight
        vm.expectRevert(HolderVote.NotEligible.selector);
        vote.castVote(1);
    }

    // ------------------------------------------------------------ results

    function test_aShortBallotChangesNothingAndCarriesNothing() public {
        uint32 id = _replaceVote(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1); // 100,000 of about 180,000 needed (a third of the supply)
        _toVoteEnd(id);
        vm.expectRevert();
        vote.carryOut(id);
        vote.finish(id);
        (uint8 outcome,,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SHORT());
        HolderVote.Ballot memory bs = _ballotAt(id);
        assertEq(bs.winner, 0, "no winner");
    }

    function test_aListWithMoreThanHalfOfTheCastSharesWinsAndIsSeatedAfterTheWait() public {
        _park(alice, 10_000_000e18);
        _park(bob, 6_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _openReplace(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1);
        _cast(carol, 1);
        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_MOVED());
        assertEq(winner, 1);
        assertEq(t.runner(), founder, "nothing moves at voteEnd");

        vm.expectRevert();
        vote.carryOut(id); // the wait is not over
        _toEffective(id);
        vote.carryOut(id);
        assertEq(vote.castOf(id), 20_000_000e18, "the tallies are frozen");
        address c = t.runner();
        assertEq(launcher.runnerKindOf(c), 2, "the runner is a Council");
        assertEq(Council(c).vote(), address(vote), "born with this vote contract");
        (address[5] memory seats,) = Council(c).seatList();
        assertEq(seats[0], s1);
        assertEq(seats[4], s5);
    }

    function test_keepWithTheFloorMetWinsAndStartsTheCooldown() public {
        _park(alice, 10_000_000e18);
        _park(bob, 6_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _openReplace(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 0);
        _cast(carol, 0); // keep: 150,000 of 250,000 cast, the floor is met, no list has half
        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome,,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_KEPT());
        assertEq(vote.nextReplaceAt(), b.voteEnd + 4 * 7 days, "four time units after the end");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderVote.Cooldown.selector, vote.nextReplaceAt()));
        vote.openReplace(_list(), keccak256("x"));
    }

    function test_afterAMovedResultTheNextVoteMayOpenTheDayItIsCarriedOut() public {
        _park(alice, 10_000_000e18);
        _park(bob, 6_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _openReplace(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1);
        _cast(carol, 1);
        _toVoteEnd(id);
        _toEffective(id);
        vote.carryOut(id);
        assertEq(vote.nextReplaceAt(), 0, "no cooldown after a result that moved the seat");
    }

    // ------------------------------------------------------- one at a time

    function test_oneBallotAtATime() public {
        _park(alice, 10_000_000e18);
        uint32 id = _openReplace(alice, _list());
        vm.prank(alice);
        vm.expectRevert(HolderVote.BallotLive.selector);
        vote.openReplace(_list(), keccak256("x"));

        _toVoteEnd(id);
        vote.finish(id); // short: nothing to carry out
        vm.prank(alice);
        vote.openReplace(_list(), keccak256("x"));
        assertTrue(vote.current() != id, "a new ballot opened");
    }

    // --------------------------------------------------------------- lapse

    function test_aWonResultNobodyCarriesOutLapsesAndTheOldRunnerStays() public {
        _park(alice, 10_000_000e18);
        _park(bob, 6_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _openReplace(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1);
        _cast(carol, 1);
        _toVoteEnd(id);
        HolderVote.Ballot memory b = _ballotAt(id);

        _warpTo(uint256(b.effectiveAt) + 2 * 7 days + 1);
        vm.expectRevert();
        vote.carryOut(id); // too late
        vote.lapse(id);
        (,, bool lapsed) = _flags(id);
        assertTrue(lapsed, "lapsed");
        assertEq(t.runner(), founder, "the old runner stays");
    }

    function test_lapseTooEarlyIsRefused() public {
        _park(alice, 10_000_000e18);
        _park(bob, 6_000_000e18);
        uint32 id = _openReplace(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1);
        _toVoteEnd(id);
        vm.expectRevert();
        vote.lapse(id);
    }

    // ------------------------------------------------------------ elections

    function test_aSeatElectionOpensWhenTheCouncilSaysTwoSeatsAreDueAndSeatsItsWinners() public {
        _makeCouncil();
        _park(alice, 10_000_000e18);
        _park(bob, 7_000_000e18);
        uint64 due = Council(t.runner()).nextElection();
        _warpTo(uint256(due));
        uint32 id = _openSeats();
        HolderVote.Ballot memory b = _ballotAt(id);
        assertEq(b.kind, vote.KIND_SEATS());
        assertTrue(b.upA != b.upB);
        vm.prank(alice);
        uint8 o1 = vote.stand(keccak256("alice"));
        vm.prank(bob);
        uint8 o2 = vote.stand(keccak256("bob"));
        _toStandEnd(id);
        _cast(alice, o1);
        _cast(bob, o2);
        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner, uint8 winnerB) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SEATED());
        assertEq(winner, o1, "alice's tally is the first");
        assertEq(winnerB, o2, "bob's is the second");
        _toEffective(id);
        vote.carryOut(id);
        (address[5] memory seats,) = Council(t.runner()).seatList();
        uint8 lo = b.upA < b.upB ? b.upA : b.upB;
        uint8 hi = b.upA < b.upB ? b.upB : b.upA;
        assertEq(seats[lo], alice, "the first winner takes the lower seat");
        assertEq(seats[hi], bob, "the second takes the other");
    }

    // ------------------------------------------------------------- helpers

    function _flags(uint32 id) internal view returns (bool finished, bool carried, bool lapsed) {
        HolderVote.Ballot memory b = _ballotAt(id);
        (finished, carried, lapsed) = (b.finished, b.carried, b.lapsed);
    }
}
