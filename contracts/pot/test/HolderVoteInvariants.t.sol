// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {VoteBase} from "./helpers/VoteBase.sol";
import {VoteHandler} from "./helpers/VoteHandler.sol";
import {HolderVote} from "../src/HolderVote.sol";

/// @notice Stateful invariants of the holders' vote (COUNCIL-PLAN.md 2.2 and 7 K2), run through the real stack by
/// `VoteHandler` (seven holders with fixed Shares: park, un-park, cast and move, stand a list or a person, open, finish,
/// carry out, lapse, a hand-over and a taken offer, and time). After every step:
///  - the sum of a ballot's tallies is the cast total, and while the vote runs the cast total is the sum of the weights cast
///    and is no more than what is parked, and no weight is more than its owner has parked;
///  - after `voteEnd` the tallies are frozen, they still add up, and they are no more than the Shares at the snapshot;
///  - an un-park never reverts for a ballot's reason, a park or un-park writes no vote slot with no ballot live, and no ballot
///    ever opens while another is live;
///  - no vote call moves a dollar of the Treasury's buckets, and the runner seat changes only by a hand-over, a taken offer or
///    a carried-out vote, and then only to a Council the Launcher made.
///  - the handler's own before-and-after rules held (the aggregate `violation` is empty).
/// The runs and depth are the plan's (1,000 at 200). A `forge-config` line outranks the environment, so
/// `FOUNDRY_INVARIANT_RUNS`/`FOUNDRY_INVARIANT_DEPTH` do not lower them; to run smaller, lower the two numbers below.
/// forge-config: default.invariant.runs = 1000
/// forge-config: default.invariant.depth = 200
contract HolderVoteInvariantsTest is VoteBase {
    VoteHandler internal h;
    address[] internal who;
    address internal eve = makeAddr("eve");
    address internal frank = makeAddr("frank");

    function setUp() public override {
        super.setUp();
        _join(eve, 300_000e6);
        _join(frank, 200_000e6);
        who = new address[](7);
        who[0] = alice;
        who[1] = bob;
        who[2] = carol;
        who[3] = dave;
        who[4] = stranger;
        who[5] = eve;
        who[6] = frank;
        address[5] memory st = [s1, s2, s3, s4, s5];
        h = new VoteHandler(usd, t, shares, vote, launcher, key, founder, who, st);
        who = h.actorsList();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](30);
        sel[0] = h.park.selector;
        sel[1] = h.park.selector;
        sel[2] = h.parkAll.selector;
        sel[3] = h.parkAll.selector; // enough parked for the open floor and the turnout floor
        sel[4] = h.unpark.selector;
        sel[5] = h.unparkAll.selector; // the fall, when a voter takes every Share back
        sel[6] = h.cast.selector;
        sel[7] = h.cast.selector;
        sel[8] = h.castMany.selector;
        sel[9] = h.castMany.selector; // several holders in one step: turnout enough for a carried-out result
        sel[10] = h.standList.selector;
        sel[11] = h.stand.selector;
        sel[12] = h.open.selector;
        sel[13] = h.open.selector;
        sel[14] = h.finishBallot.selector;
        sel[15] = h.carryOut.selector;
        sel[16] = h.lapseBallot.selector;
        sel[17] = h.advance.selector;
        sel[18] = h.advance.selector;
        sel[19] = h.advance.selector;
        sel[20] = h.advance.selector; // time has to reach the ends and the wait
        sel[21] = h.warp.selector;
        sel[22] = h.probe.selector;
        sel[23] = h.probe.selector;
        sel[24] = h.handOver.selector;
        sel[25] = h.takeOffer.selector;
        sel[26] = h.park.selector;
        sel[27] = h.unpark.selector;
        sel[28] = h.cast.selector;
        sel[29] = h.unparkAll.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    // ------------------------------------------------------------------ helpers

    /// @dev The ballot whose vote is running at this second (zero when none).
    function _live() internal view returns (uint32 id) {
        id = vote.current();
        if (id != 0 && block.timestamp >= vote.ballot(id).voteEnd) id = 0;
    }

    function _sumTallies(uint32 id) internal view returns (uint256 sum) {
        uint8 count = vote.optionCount(id);
        for (uint8 i; i < count; ++i) {
            (, uint256 tally) = vote.optionOf(id, i);
            sum += tally;
        }
    }

    // ------------------------------------------------------------------ drive

    /// @dev The handler's own mixed sequence, driven deterministically for 400 steps, must reach every phase the invariants
    /// speak of: a ballot opened with a snapshot, names stood, votes cast and moved, an un-park that lowers a cast weight, the
    /// end of a vote, a result recorded and carried out, and the rules held at each step. This is the evidence that the action
    /// space the fuzzer picks from is not empty of the states the invariants are about.
    function test_theActionSpaceReachesEveryPhase() public {
        uint256 x = uint256(keccak256("council-plan-2.2"));
        for (uint256 step; step < 400; ++step) {
            x = uint256(keccak256(abi.encode(x, step)));
            h.step(x);
            if (step % 8 == 0) h.probe(x); // the hooks' writes, measured with no ballot live
        }
        assertGt(h.opens(), 0, "no ballot was opened");
        assertGt(h.stands(), 0, "nobody stood");
        assertGt(h.casts(), 0, "no vote was cast");
        assertGt(h.moves(), 0, "no vote was moved");
        assertGt(h.falls(), 0, "no weight fell");
        assertGt(h.finishes(), 0, "no result was recorded");
        assertGt(h.carryOuts(), 0, "no result was carried out");
        assertGt(h.probes(), 0, "the hooks were never measured");
        assertGt(h.ballotCount(), 1, "only one ballot ran");
        assertEq(bytes(h.violation()).length, 0, h.violation());
        emit log_named_uint("ballots", h.ballotCount());
        emit log_named_uint("casts", h.casts());
        emit log_named_uint("moves", h.moves());
        emit log_named_uint("falls", h.falls());
        emit log_named_uint("finishes", h.finishes());
        emit log_named_uint("carryOuts", h.carryOuts());
        emit log_named_uint("lapses", h.lapses());
    }

    // --------------------------------------------------------------- invariants

    /// @dev 2.2: one Share counted is on exactly one option, so a ballot's tallies are its cast total; and while the vote
    /// runs, that total is the sum of the weights cast.
    function invariant_theSumOfTalliesIsTheSumOfCastWeights() public view {
        uint256 n = h.ballotCount();
        for (uint256 k; k < n; ++k) {
            (uint32 id,) = h.ballotAt(k);
            assertEq(_sumTallies(id), vote.castOf(id), "a ballot's tallies do not add up to its cast total");
        }
        uint32 live = _live();
        if (live == 0) return;
        uint256 weights;
        for (uint256 i; i < who.length; ++i) {
            (,, uint256 weight,) = vote.ballotOf(who[i]);
            weights += weight;
        }
        assertEq(weights, vote.castOf(live), "the cast total is not the sum of the weights cast");
    }

    /// @dev 2.2: the cast total can never be more than what is in custody, and a weight is never more than what its owner has
    /// parked (an un-park lowers the weight; a park after the snapshot adds none).
    function invariant_whileTheVoteRunsTheCastIsAtMostTheParkedAndNoWeightIsMoreThanItsOwnersParked() public view {
        uint32 live = _live();
        if (live == 0) return;
        assertLe(vote.castOf(live), vote.parkedTotal(), "more Shares cast than are parked");
        for (uint256 i; i < who.length; ++i) {
            (,, uint256 weight,) = vote.ballotOf(who[i]);
            assertLe(weight, vote.parkedOf(who[i]), "a weight is more than its owner has parked");
        }
    }

    /// @dev 2.2: from `voteEnd` the tallies are final: they do not move (against what the handler saw the first time the
    /// ballot was ended), they still add up, and they are no more than the Shares at the snapshot.
    function invariant_afterVoteEndTheTalliesAreFrozenAndAtMostTheSharesAtTheSnapshot() public view {
        uint256 n = h.ballotCount();
        for (uint256 k; k < n; ++k) {
            (uint32 id, uint64 end) = h.ballotAt(k);
            if (block.timestamp < end) continue;
            HolderVote.Ballot memory b = vote.ballot(id);
            assertEq(_sumTallies(id), vote.castOf(id), "an ended ballot's tallies do not add up");
            assertLe(vote.castOf(id), b.supply, "an ended ballot cast more than the supply at the snapshot");
            if (h.frozenAt(id) != 0) {
                assertLe(h.frozenAt(id), block.timestamp, "a freeze is dated in the future");
                assertEq(h.frozen(id), h.stateHash(id), "the tallies moved after voteEnd");
            }
        }
    }

    /// @dev 2.2: the hook has no external call and no loop, so taking out can never fail for a ballot's reason.
    function invariant_unparkNeverRevertsForABallotsReason() public view {
        assertFalse(h.unparkReverted(), h.violation());
    }

    /// @dev 2.2: outside a live ballot the hooks write nothing (a park writes only the pause's own slots, measured).
    function invariant_noLiveBallotMeansTheVoteHooksWriteNothing() public view {
        assertFalse(h.hookWrote(), h.violation());
    }

    /// @dev 2.10: one ballot at a time; a live ballot is the current one.
    function invariant_atMostOneBallotIsLive() public view {
        uint256 n = h.ballotCount();
        uint256 live;
        uint32 liveId;
        for (uint256 k; k < n; ++k) {
            (uint32 id, uint64 end) = h.ballotAt(k);
            if (block.timestamp < end) {
                ++live;
                liveId = id;
            }
        }
        assertLe(live, 1, "two ballots are live at once");
        if (live == 1) assertEq(liveId, vote.current(), "the live ballot is not the current one");
        assertFalse(h.openedOverLive(), h.violation());
    }

    /// @dev 2.2: no vote call moves a dollar of the Treasury's buckets.
    function invariant_noVoteCallMovesADollarOfTheTreasurysBuckets() public view {
        assertFalse(h.moneyMoved(), h.violation());
    }

    /// @dev 2.2: the runner seat changes only by a hand-over, a taken offer or a carried-out vote (`seatByVote`), and only to
    /// a Council the Launcher made. A project always has a runner.
    function invariant_theRunnerChangesOnlyByHandOverTakeSeatOrSeatByVote() public view {
        assertFalse(h.runnerJumped(), h.violation());
        assertFalse(h.offerSurvived(), h.violation());
        address r = t.runner();
        assertTrue(r != address(0), "no runner");
        if (r != founder) assertEq(launcher.runnerKindOf(r), 2, "the runner is neither the founder nor a Council");
    }

    /// @dev 2.2: the tallies of a ballot do not move after its end.
    function invariant_theTalliesDoNotMoveAfterVoteEnd() public view {
        assertFalse(h.talliesNotFrozen(), h.violation());
    }

    /// @dev Everything the handler checks inside its steps, in one place: empty while every rule held.
    function invariant_theHandlersOwnRulesHeld() public view {
        assertEq(bytes(h.violation()).length, 0, h.violation());
    }
}
