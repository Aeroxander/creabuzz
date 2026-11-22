// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {VoteBase} from "./helpers/VoteBase.sol";
import {HolderVote} from "../src/HolderVote.sol";

/// @notice The exact-second boundaries (COUNCIL-PLAN.md 2.2, 2.3, 2.6, 2.11): voting opens at `standEnd` and closes at
/// `voteEnd`; the hooks count up to the second before `voteEnd` and write nothing from it on; standing closes at `standEnd`;
/// a result may be carried out from `effectiveAt`; and it lapses only after, not at, two time units past `effectiveAt`.
contract HolderVoteBoundaryTest is VoteBase {
    // ----------------------------------------------------------- voting

    function test_castVoteAtStandEndMinusOneRevertsAndAtStandEndWorks() public {
        uint32 id = _replaceVote(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);

        _warpTo(uint256(b.standEnd) - 1);
        vm.prank(alice);
        vm.expectRevert(HolderVote.VotingClosed.selector);
        vote.castVote(1);

        _warpTo(uint256(b.standEnd));
        _cast(alice, 1);
        assertEq(vote.castOf(id), 10_000_000e18, "the first second of voting counts");
    }

    function test_castVoteAtVoteEndMinusOneWorksAndAtVoteEndReverts() public {
        uint32 id = _replaceVote(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);

        _warpTo(uint256(b.voteEnd) - 1);
        _cast(alice, 1);
        assertEq(vote.castOf(id), 10_000_000e18, "the last second of voting counts");

        _warpTo(uint256(b.voteEnd));
        vm.prank(alice);
        vm.expectRevert(HolderVote.VotingClosed.selector);
        vote.castVote(0);
        assertEq(vote.castOf(id), 10_000_000e18, "nothing moved");
    }

    // ------------------------------------------------------------ hooks

    function test_parkAndUnparkAtVoteEndMinusOneLowerWeightAndAtVoteEndDoNot() public {
        _park(bob, 5_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1);
        _cast(carol, 0);
        assertEq(vote.castOf(id), 19_000_000e18);

        _warpTo(uint256(b.voteEnd) - 1);
        _unpark(bob, 2_000_000e18); // the hook is still live
        assertEq(vote.weightOf(bob), 3_000_000e18, "one second before the end, the weight falls");
        assertEq(vote.castOf(id), 17_000_000e18, "and the cast total falls with it");
        (, uint256 tally) = vote.optionOf(id, 1);
        assertEq(tally, 13_000_000e18);
        _park(dave, 1_000_000e18); // a park in the last second still adds no weight
        assertEq(vote.weightOf(dave), 0);

        _warpTo(uint256(b.voteEnd));
        _unpark(bob, 1_000_000e18); // the hook has stopped
        assertEq(vote.weightOf(bob), 2_000_000e18, "at voteEnd the weight is the balance, not the fewest");
        assertEq(vote.castOf(id), 17_000_000e18, "at voteEnd an unpark changes no tally");
        (, tally) = vote.optionOf(id, 1);
        assertEq(tally, 13_000_000e18);
    }

    // --------------------------------------------------------- standing

    function test_standListAtStandEndMinusOneWorksAndAtStandEndReverts() public {
        _park(bob, 5_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);

        _warpTo(uint256(b.standEnd) - 1);
        uint8 option = _standList(bob, _listB());
        assertEq(option, 2, "the second place is the second option");
        assertEq(vote.optionCount(id), 3);

        _warpTo(uint256(b.standEnd));
        vm.prank(carol);
        vm.expectRevert(HolderVote.StandingClosed.selector);
        vote.standList(_listB(), keccak256("late list"));
    }

    // ------------------------------------------------------- the result

    function test_carryOutAtEffectiveAtMinusOneRevertsAndAtEffectiveAtWorks() public {
        _park(bob, 5_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1);
        _cast(carol, 1); // 19,000,000e18: a moved result after the wait

        _warpTo(uint256(b.effectiveAt) - 1);
        vm.expectRevert(abi.encodeWithSelector(HolderVote.TooEarly.selector, b.effectiveAt));
        vote.carryOut(id);
        assertEq(t.runner(), founder, "nothing happens one second early");

        _warpTo(uint256(b.effectiveAt));
        vote.carryOut(id);
        assertEq(launcher.runnerKindOf(t.runner()), 2, "the Council takes the seat at effectiveAt");
    }

    function test_lapseAtEffectiveAtPlusTwoUnitsRevertsAndOneSecondLaterWorks() public {
        _park(bob, 5_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1);
        _cast(carol, 1);

        uint256 lapseAt = uint256(b.effectiveAt) + 2 * 7 days;
        _warpTo(lapseAt);
        vm.expectRevert(HolderVote.NotLapsable.selector);
        vote.lapse(id); // exactly two units after it was due is not yet late
        assertEq(t.runner(), founder);

        _warpTo(lapseAt + 1);
        vote.lapse(id);
        HolderVote.Ballot memory afterLapse = _ballotAt(id);
        assertTrue(afterLapse.lapsed, "lapsed one second later");
        assertEq(t.runner(), founder, "the old runner stays");
    }
}
