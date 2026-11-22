// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "oz5/proxy/Clones.sol";
import {VoteBase} from "./helpers/VoteBase.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {HolderVote} from "../src/HolderVote.sol";
import {IShares} from "../src/Interfaces.sol";

/// @notice The counting rule (COUNCIL-PLAN.md 2.2): a ballot's eligible weight is the fewest Shares an account had parked at
/// any moment from the second the ballot opened. A late park adds no weight, an unpark lowers the weight already cast and its
/// tally in the same transaction, a re-park does not restore it, an untouched account's weight is what it had parked at the
/// snapshot, the hooks write nothing while no ballot is live, a vote moves whole with the voter, the hooks stop at `voteEnd`,
/// and the snapshot is the second the ballot opens.
contract HolderVoteCountTest is VoteBase {
    // ------------------------------------------------------ a late park

    function test_aParkAfterTheSnapshotAddsNoWeight() public {
        uint32 id = _replaceVote(alice, _list());
        _warp(1);
        _park(bob, 5_000_000e18); // parked while the ballot runs, after its snapshot

        _toStandEnd(id);
        assertEq(vote.parkedOf(bob), 5_000_000e18, "the Shares are in custody");
        assertEq(vote.weightOf(bob), 0, "a park after the snapshot adds no weight");
        vm.prank(bob);
        vm.expectRevert(HolderVote.NotEligible.selector);
        vote.castVote(1);
        assertEq(vote.castOf(id), 0, "nothing was cast");
    }

    // --------------------------------------------------- an unpark falls

    function test_anUnparkLowersTheCastWeightAndTheTallyInTheSameTransaction() public {
        _park(bob, 5_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        (, uint256 tally) = vote.optionOf(id, 1);
        assertEq(vote.castOf(id), 10_000_000e18);
        assertEq(tally, 10_000_000e18);

        _unpark(alice, 4_000_000e18); // one call, one transaction
        (, uint8 option, uint256 weight, uint256 eligible) = vote.ballotOf(alice);
        assertEq(option, 1);
        assertEq(weight, 6_000_000e18, "the weight already cast falls with the custody");
        assertEq(eligible, 6_000_000e18);
        assertEq(vote.castOf(id), 6_000_000e18, "the cast total falls in the same transaction");
        (, tally) = vote.optionOf(id, 1);
        assertEq(tally, 6_000_000e18, "the option's tally falls in the same transaction");
        assertEq(vote.parkedOf(alice), 6_000_000e18);
    }

    function test_anUnparkThenParkAgainDoesNotRestoreWeight() public {
        _park(bob, 5_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);

        _unpark(alice, 4_000_000e18);
        _park(alice, 4_000_000e18); // back to the same balance, but the fewest-since-open stands
        assertEq(vote.parkedOf(alice), 10_000_000e18, "the Shares are parked again");
        assertEq(vote.weightOf(alice), 6_000_000e18, "a re-park does not restore weight");
        (, uint256 tally) = vote.optionOf(id, 1);
        assertEq(tally, 6_000_000e18);
        assertEq(vote.castOf(id), 6_000_000e18);

        _cast(alice, 0); // moving cannot carry more than the weight now
        (, uint8 option, uint256 weight,) = vote.ballotOf(alice);
        assertEq(option, 0);
        assertEq(weight, 6_000_000e18);
        (, tally) = vote.optionOf(id, 1);
        assertEq(tally, 0);
    }

    // ------------------------------------------- an account never touched

    function test_anUntouchedAccountsWeightIsItsSnapshotBalance() public {
        _park(bob, 5_000_000e18); // before the ballot opens
        uint32 id = _replaceVote(alice, _list());
        // bob never parks and never unparks while the ballot runs
        assertEq(vote.weightOf(bob), 5_000_000e18, "untouched: the weight is the balance at the snapshot");
        _toStandEnd(id);
        assertEq(vote.weightOf(bob), 5_000_000e18);
        _cast(bob, 1);
        assertEq(vote.castOf(id), 5_000_000e18, "all of the snapshot balance is cast");
    }

    // ------------------------------------- no ballot live: no vote state

    function test_parkingAndUnparkingWithNoBallotLiveWritesNoVoteState() public {
        // A plain pause, as a project without the vote switch gets one, is the baseline: a park there writes exactly the
        // pause's own slots. The vote contract with no ballot live must write the same number, and one more only while a
        // ballot runs (the snapshot of the account being touched).
        HolderPause plain = HolderPause(Clones.clone(address(new HolderPause())));
        plain.initialize(IShares(address(shares)), UNIT);

        uint32 id = _replaceVote(alice, _list());
        // one slot more than a plain park: the live hook writes the account's snapshot
        vm.record();
        _park(bob, 1_000_000e18);
        (, bytes32[] memory liveParkWrites) = vm.accesses(address(vote));
        vm.record();
        _parkIn(plain, dave, 1_000_000e18);
        (, bytes32[] memory plainParkWrites) = vm.accesses(address(plain));
        assertEq(liveParkWrites.length, plainParkWrites.length + 1, "a live ballot writes one slot more (the snapshot)");

        // no ballot live: the same park writes exactly what the plain pause writes
        _toVoteEnd(id);
        vm.record();
        _park(carol, 1_000_000e18);
        (, bytes32[] memory deadParkWrites) = vm.accesses(address(vote));
        assertEq(deadParkWrites.length, plainParkWrites.length, "no ballot live: no vote slot is written");
        vm.record();
        _unpark(carol, 400_000e18);
        (, bytes32[] memory deadUnparkWrites) = vm.accesses(address(vote));
        vm.record();
        _unparkIn(plain, dave, 400_000e18);
        (, bytes32[] memory plainUnparkWrites) = vm.accesses(address(plain));
        assertEq(deadUnparkWrites.length, plainUnparkWrites.length, "no ballot live: an unpark writes no vote slot");

        // and no vote state can be seen: the weight is the balance and no vote exists
        assertEq(vote.weightOf(carol), 600_000e18);
        (uint32 ballotId, uint8 option, uint256 weight, uint256 eligible) = vote.ballotOf(carol);
        assertEq(ballotId, 0, "no ballot live");
        assertEq(option, 0);
        assertEq(weight, 0);
        assertEq(eligible, 0);
    }

    // --------------------------------------------------- a vote moves

    function test_aVoteMovesWithTheVoter() public {
        _park(bob, 5_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        (, uint256 onList) = vote.optionOf(id, 1);
        (, uint256 onKeep) = vote.optionOf(id, 0);
        assertEq(onList, 10_000_000e18);
        assertEq(onKeep, 0);

        _cast(alice, 0); // the whole weight moves; nothing is left behind
        (, onList) = vote.optionOf(id, 1);
        (, onKeep) = vote.optionOf(id, 0);
        assertEq(onList, 0, "the old option is emptied");
        assertEq(onKeep, 10_000_000e18, "the whole weight is on the new one");
        assertEq(vote.castOf(id), 10_000_000e18, "a move does not double the cast total");
        (, uint8 option, uint256 weight,) = vote.ballotOf(alice);
        assertEq(option, 0);
        assertEq(weight, 10_000_000e18);
    }

    // --------------------------------------------- the hook stops at end

    function test_theHooksStopAtVoteEndSoTheTalliesAreFrozen() public {
        _park(bob, 5_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _replaceVote(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1);
        _cast(carol, 1); // 19,000,000e18 on the list: over the floor
        (, uint256 tally) = vote.optionOf(id, 1);
        assertEq(vote.castOf(id), 19_000_000e18);
        assertEq(tally, 19_000_000e18);

        _toVoteEnd(id); // the vote is over
        _unpark(bob, 5_000_000e18);
        _unpark(alice, 10_000_000e18); // every winner takes all of it back
        assertEq(vote.parkedOf(alice), 0);
        assertEq(vote.castOf(id), 19_000_000e18, "the cast total does not fall after voteEnd");
        (, tally) = vote.optionOf(id, 1);
        assertEq(tally, 19_000_000e18, "the tally does not fall after voteEnd");

        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_MOVED(), "the result stands");
        assertEq(winner, 1);
        _toEffective(id);
        vote.carryOut(id);
        assertEq(launcher.runnerKindOf(t.runner()), 2, "seated by Shares no longer in custody");
    }

    // -------------------------------------- the snapshot is the opening

    function test_theSnapshotIsTheSecondTheBallotOpens() public {
        _park(alice, 10_000_000e18);
        _warp(1);
        uint256 opensAt = clock + 1;
        _park(bob, 5_000_000e18); // one second before the ballot opens
        _warpTo(opensAt);
        uint32 id = _openReplace(alice, _list());
        _park(dave, 1_000_000e18); // the same second, after the opening call
        _warp(1);
        _park(carol, 5_000_000e18); // one second after it opened

        _toStandEnd(id);
        assertEq(vote.weightOf(bob), 5_000_000e18, "a park one second before counts");
        assertEq(vote.weightOf(dave), 0, "a park in the opening second, after the call, does not");
        assertEq(vote.weightOf(carol), 0, "a park one second after does not");

        _cast(bob, 1);
        assertEq(vote.castOf(id), 5_000_000e18);
        vm.prank(carol);
        vm.expectRevert(HolderVote.NotEligible.selector);
        vote.castVote(1);
    }

    // ------------------------------------------------------------ helpers

    function _parkIn(HolderPause pause, address who, uint256 n) internal {
        vm.startPrank(who);
        shares.approve(address(pause), n);
        pause.park(n);
        vm.stopPrank();
    }

    function _unparkIn(HolderPause pause, address who, uint256 n) internal {
        vm.prank(who);
        pause.unpark(n);
    }
}
