// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {VoteBase} from "./helpers/VoteBase.sol";
import {Council} from "../src/Council.sol";
import {HolderVote} from "../src/HolderVote.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Treasury} from "../src/Treasury.sol";

/// @title HolderVoteAttacks
/// @notice The attack table of docs/next-version/COUNCIL-PLAN.md, section 3 (rows 1 to 23), as tests that try to break the
/// vote contract, one per row whose defence lives in `HolderVote` (rows 1, 2, 3, 4, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18,
/// 19, 21, 22 and 23). Rows 5 (a hand-over to a Council of one's own), 7 (a hostile Council), 14 (one account on two seats,
/// zero, a project contract), 15 (a seat sold) and 20 (a vote used to burn a grant) are defended in the Council and the
/// Treasury, not here: K1's suites (`Council.t.sol`, `CouncilSeats.t.sol`, `CouncilAccess.t.sol`,
/// `Treasury.t.sol`, ...) hold them, and row 13's "a replaced seat's agreement is dead" is K1's
/// `test_aReplacedSeatsAgreementIsDead`, so it is deliberately not duplicated: row 13 here covers the part that is the
/// vote contract's own — a ballot cannot be replayed after it was carried out or after it lapsed.
///
/// The base project is `VoteBase`/`CouncilBase`'s: a founder-run project with a backer pot of 500,000 dollars and a
/// backer supply of 49,000,000 Shares (one Share is one cent), and a `HolderVote` (the pause that is also the ballot box)
/// whose wait at a 7-day unit is 16.5 days. Alice holds 200,000 of the 500,000 put in (40 per cent, a third is 166,667);
/// Bob 100,000; Carol 60,000; Dave 40,000; Stranger 100,000.
///
/// The cost figures in the comments are the plan's own (section 3, cost model): for a net `m` the platform fee is
/// `0.0204 x m` (2 per cent of the gross `m / 0.98`, exactly `m / 49` rounded), "sleepers" are holders who never look and
/// never take out, and what a hostile runner can take from them is 12.4 of every 100 after 30 days.
contract HolderVoteAttacksTest is VoteBase {
    // ==================================================== helpers =====================================================

    /// @dev Alice's Shares: the default project's whale (40 per cent of the backers' Shares).
    function _whale() internal view returns (uint256) {
        return shares.balanceOf(alice);
    }

    function _flags(uint32 id) internal view returns (bool finished, bool carried, bool lapsed) {
        HolderVote.Ballot memory b = _ballotAt(id);
        (finished, carried, lapsed) = (b.finished, b.carried, b.lapsed);
    }

    // --------------------------------------------------------- the plan's row 1 arithmetic

    /// @dev The plan's cost model for row 1 (section 3): to hold a third of the backers' Shares after joining, the whale
    /// puts in a net `m = P0 / 2`; at 2 per cent its gross is `m / 0.98 = m x 50 / 49` and the fee is `m / 49`.
    /// "What it keeps after 30 days" is the sleepers' loss (12.4 per cent of the pot) less that fee.
    struct Row1 {
        uint256 net; // m = P0 / 2
        uint256 gross; // m / 0.98, rounded up
        uint256 fee; // 0.0204 x m = m / 49, the contract's own 2 per cent fee
        uint256 tied; // the gross is parked from the snapshot until voteEnd: at least 4 days
        uint256 sleepersLoss; // 12.4 of every 100 after 30 days
        uint256 kept; // sleepersLoss - fee
    }

    function _row1(uint256 potDollars) internal view returns (Row1 memory e) {
        e.net = potDollars * 1e6 / 2;
        e.gross = (e.net * 50 + 48) / 49;
        e.fee = t.feeFor(e.gross); // the contract's own fee on the gross: exactly the plan's 0.0204 x m
        e.tied = e.gross;
        e.sleepersLoss = potDollars * 1e6 * 124 / 1000;
        e.kept = e.sleepersLoss - e.fee;
    }

    /// @dev Log and pin the plan's numbers for pots of 10,000 and 1,000,000 dollars.
    function _logRow1(uint256 potDollars) internal view {
        Row1 memory e = _row1(potDollars);
        console2.log("row 1: pot (dollars)", potDollars);
        console2.log("  net m = P0 / 2 (dollar units)", e.net);
        console2.log("  gross = m / 0.98 (dollar units, capital tied up)", e.gross);
        console2.log("  platform fee = 0.0204 x m (dollar units)", e.fee);
        console2.log("  sleepers' loss after 30 days (dollar units)", e.sleepersLoss);
        console2.log("  whale keeps after the fee (dollar units)", e.kept);
        assertEq(e.tied, e.gross, "the gross is what has to be parked until voteEnd");
        assertEq(e.fee, t.feeFor(e.gross), "the plan's fee is the contract's own 2 per cent, rounded up");
        assertApproxEqAbs(e.gross - e.fee, e.net, 1, "the gross nets the whale m to within one unit");
        if (potDollars == 10_000) {
            // plan: fee 102, money tied up 5,102, loss 1,240, net +1,138
            assertApproxEqAbs(e.fee, 102e6, 1e6);
            assertApproxEqAbs(e.gross, 5102e6, 1e6);
            assertEq(e.sleepersLoss, 1240e6);
            assertApproxEqAbs(e.kept, 1138e6, 2e6);
        } else {
            // plan: fee 10,204, money tied up 510,204, loss 124,000, net +113,796
            assertApproxEqAbs(e.fee, 10_204e6, 2e6);
            assertApproxEqAbs(e.gross, 510_204e6, 2e6);
            assertEq(e.sleepersLoss, 124_000e6);
            assertApproxEqAbs(e.kept, 113_796e6, 10e6);
        }
    }

    // --------------------------------------------------------- team-vesting helper

    /// @dev Move `secs` forward in 6-day steps, checking in as the founder before each window closes.
    function _waitAlive(uint256 secs) internal {
        uint256 end = clock + secs;
        while (clock + 6 days < end) {
            _warp(6 days);
            _checkIn();
        }
        _warpTo(end);
        _checkIn();
    }

    // ============================================== row 1: the whale =================================================

    /// @notice Plan row 1. Cost, pot 10,000 / 1,000,000: fee 102 / 10,204; money tied up 5,102 / 510,204 for at least the
    /// 4 days of the vote; from sleepers after the seat 1,240 / 124,000 in 30 days; the whale's net after the fee
    /// +1,138 / +113,796. The attack: a whale with a third parks before the snapshot, opens with its own list and votes it.
    /// What the test holds: the seat only moves after the wait, and a holder who takes out on the day of the seat is paid
    /// the same quote, nothing slowed by the ballot.
    function test_row01_aWhaleWithAThirdWinsOnlyAfterTheWaitAndALeaverIsPaidTheSameDay() public {
        _logRow1(10_000);
        _logRow1(1_000_000);

        uint256 whale = _whale();
        _park(alice, whale); // parked before the ballot opens: the weight exists at the snapshot
        uint32 id = _openReplace(alice, _list()); // the whale opens with its own list in the same call
        HolderVote.Ballot memory b = _ballotAt(id);
        assertEq(b.supply, shares.totalSupply(), "the snapshot is the supply at opening");
        assertGe(whale, b.floor, "a third of the Shares meets the one-third floor");
        console2.log("row 1 on the base project: whale weight (share wei)", whale);
        console2.log("row 1 on the base project: ballot floor (share wei)", b.floor);

        _toStandEnd(id);
        _cast(alice, 1);
        assertEq(vote.castOf(id), whale, "all the whale's weight is on its own list");

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_MOVED());
        assertEq(winner, 1);
        assertEq(t.runner(), founder, "at voteEnd the old runner still runs the project");

        // the wait: a won result cannot be carried out before effectiveAt
        (bool finished, bool carried, bool lapsed) = _flags(id);
        assertTrue(finished);
        assertFalse(carried);
        assertFalse(lapsed);
        vm.expectRevert(abi.encodeWithSelector(HolderVote.TooEarly.selector, b.effectiveAt));
        vote.carryOut(id);
        assertEq(t.runner(), founder, "and it has not moved a second early");

        // Bob, awake, takes everything out on the very day of the seat: paid the quote, nothing slowed by the ballot
        uint256 n = shares.balanceOf(bob);
        (uint256 atVoteEnd,,) = t.quoteTakeOut(bob, n);
        _toEffective(id);
        (uint256 atSeat,,) = t.quoteTakeOut(bob, n);
        uint256 before_ = usd.balanceOf(bob);
        uint256 cash = _leave(bob, n);
        assertEq(cash, atSeat, "paid the quote it was shown on the day of the seat");
        assertEq(usd.balanceOf(bob) - before_, cash, "and in the same block, no wait");
        assertEq(shares.balanceOf(bob), 0);
        console2.log("row 1: Bob's take-out at voteEnd (dollar units)", atVoteEnd);
        console2.log("row 1: Bob's take-out on the day of the seat (dollar units)", atSeat);
        assertGe(
            atSeat * 1000,
            atVoteEnd * 995,
            "only the old runner's capped allowance sits between them, no new-runner effect"
        );

        // only now does the seat move: anyone may carry the frozen result out
        vote.carryOut(id);
        address seated = t.runner();
        assertTrue(seated != founder, "the seat moved");
        assertEq(launcher.runnerKindOf(seated), 2, "to a Council");
        (address[5] memory seats,) = Council(seated).seatList();
        assertEq(seats[0], s1, "the winning list, not the old runner's");
        assertEq(seats[4], s5);
    }

    // ====================================== row 2: holders wake up and leave ========================================

    /// @notice Plan row 2. Same fee as row 1 (102 / 10,204); its own money is the only money left, so what the attack can
    /// take from others is 0 / 0. The holders leave during the wait and the pot shrinks to the whale's own money.
    function test_row02_leaversDuringTheWaitLeaveTheWhaleAloneWithNothingToTake() public {
        _logRow1(10_000); // the same fee; the take from others is 0 because nobody else stays

        uint256 whale = _whale();
        _park(alice, whale);
        uint32 id = _openReplace(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome,,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_MOVED());

        // the sleepers wake: every other holder takes out during the wait, paid at face
        address[4] memory sleepers = [bob, carol, dave, stranger];
        for (uint256 i; i < 4; ++i) {
            uint256 n = shares.balanceOf(sleepers[i]);
            assertGt(n, 0);
            uint256 cash = _leave(sleepers[i], n);
            assertGt(cash, 0, "everyone who looks is paid");
            assertEq(shares.balanceOf(sleepers[i]), 0);
        }
        assertEq(shares.totalSupply(), whale, "only the whale's Shares are left");
        console2.log("row 2: pot + box left after the sleepers leave (dollar units)", t.pot() + t.box());
        console2.log("row 2: the whale's own gross (dollar units)", uint256(200_000e6));
        assertLe(t.pot() + t.box(), 200_000e6, "nothing but the whale's own money is left in the project");
        assertGt(t.pot() + t.box(), 0, "and its own money is there");

        // the result still takes the seat, but there is nobody left to take from
        _toEffective(id);
        vote.carryOut(id);
        address seated = t.runner();
        assertEq(launcher.runnerKindOf(seated), 2);
        (address[5] memory seats,) = Council(seated).seatList();
        assertEq(seats[0], s1);
    }

    // ========================================= row 3: the late large buyer ==========================================

    /// @notice Plan row 3. A buyer who joins after the ballot opened pays the fee on what it puts in (2.04 per cent: 204
    /// / 20,408 for a put-in as large as the whole pot) and can take 0 / 0: its Shares are not counted and the floor is
    /// the snapshot's third, fixed at opening.
    function test_row03_aLateBuyerCountsForNothingAndCannotRaiseTheFloor() public {
        uint256 whale = _whale();
        _park(alice, whale);
        uint32 id = _openReplace(alice, _list());
        HolderVote.Ballot memory opened = _ballotAt(id);
        uint256 supplyAtOpen = opened.supply;
        uint256 floorAtOpen = opened.floor;
        assertEq(floorAtOpen, (supplyAtOpen + 2) / 3, "the floor is a third of the snapshot, rounded up");

        // a late buyer joins AFTER the snapshot, with as much money as the whole pot
        address late = makeAddr("late buyer");
        _join(late, 500_000e6);
        uint256 lateShares = shares.balanceOf(late);
        assertGt(lateShares, 0);
        assertGt(shares.totalSupply(), supplyAtOpen, "the supply rose after the snapshot");
        assertEq(_ballotAt(id).floor, floorAtOpen, "the floor did not move");
        assertLt(floorAtOpen, (shares.totalSupply() + 2) / 3, "a late buyer cannot raise the floor");
        assertEq(_ballotAt(id).supply, supplyAtOpen, "the snapshot supply did not move");

        // parking after the opening is worth nothing (row 10's rule, seen from row 3)
        _park(late, lateShares);
        _toStandEnd(id);
        assertEq(vote.weightOf(late), 0, "a late buyer's weight is zero");
        vm.expectRevert(HolderVote.NotEligible.selector);
        vm.prank(late);
        vote.castVote(1);

        // so the money it brought cannot swing the ballot the way its size would suggest
        _cast(alice, 1);
        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_MOVED(), "the ballot is unchanged by the late money");
        assertEq(winner, 1);
        assertEq(vote.castOf(id), whale, "only the snapshot's parked Shares were counted");
        console2.log("row 3: the late buyer's fee (dollar units)", t.feeFor(500_000e6));
        console2.log("row 3: what it took from the ballot (dollar units)", uint256(0));
    }

    // ==================================== row 4: a founder with many accounts =======================================

    /// @notice Plan row 4. No cheaper than one account: Shares count, not accounts; the fee is 2.04 per cent of the money
    /// in (102 / 10,204 for a third). Twenty accounts together pay exactly what one account pays for the same money and
    /// their weight is only the Shares they hold.
    function test_row04_manyAccountsCostTheSameAsOneAndSplitSharesGiveNoExtraWeight() public {
        uint256 per = 17_500e6; // 20 x 17,500 = 350,000 put in, about a third of the supply after the join
        uint256 gross = per * 20;
        address[] memory accts = new address[](20);
        uint256 feeSum;
        uint256 weightSum;
        for (uint256 i; i < 20; ++i) {
            accts[i] = makeAddr(string.concat("founder account ", vm.toString(i)));
            feeSum += t.feeFor(per);
            _join(accts[i], per);
            uint256 n = shares.balanceOf(accts[i]);
            _park(accts[i], n);
            weightSum += n;
        }
        assertEq(feeSum, t.feeFor(gross), "twenty accounts pay exactly what one account pays: no cheaper");
        assertEq(vote.parkedTotal(), weightSum, "parking counts Shares, not accounts");

        // one of them opens with a list of five of its own accounts
        address[5] memory own;
        for (uint256 i; i < 5; ++i) {
            own[i] = accts[i];
        }
        uint32 id = _openReplace(accts[0], own);
        _toStandEnd(id);
        for (uint256 i; i < 20; ++i) {
            _cast(accts[i], 1);
        }
        assertEq(vote.castOf(id), weightSum, "the twenty accounts have no weight but the Shares they hold");
        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_MOVED(), "a third of the Shares, however split, can move the seat");
        assertEq(winner, 1);

        // the five accounts of the winning list are seated after the wait: a different shape, not a different power
        _toEffective(id);
        vote.carryOut(id);
        address seated = t.runner();
        assertEq(launcher.runnerKindOf(seated), 2);
        (address[5] memory seats,) = Council(seated).seatList();
        for (uint256 i; i < 5; ++i) {
            assertEq(seats[i], own[i]);
        }
    }

    // ==================================== row 6: the team parks its own Shares =======================================

    /// @notice Plan row 6. Team Shares are another token: `park` only takes backer Shares, so a team can never park them
    /// (0 / 0 of weight, and the fee to buy backer Shares is 2.04 per cent, 204 per 10,000 put in).
    function test_row06_teamSharesCannotBeParkedOrCounted() public {
        // a full grant, claimed: the team member really holds Team Shares in hand
        uint256 grantId = _grant(bob, POOL);
        _waitAlive(104 * UNIT);
        v.claim(grantId);
        uint256 g = team.balanceOf(bob);
        assertEq(g, POOL, "the whole team pool is in bob's hands");

        vm.startPrank(bob);
        team.approve(address(vote), g);
        vm.expectRevert(ShareToken.InsufficientBalance.selector); // park pulls backer Shares only
        vote.park(g);
        vm.stopPrank();
        assertEq(vote.parkedTotal(), 0, "no Team Share is ever parked");
        assertEq(vote.weightOf(bob), 0);

        // a team member's own backer Shares count like anyone's; Team Shares are on neither side
        uint256 backerShares = _join(bob, 5000e6);
        _park(bob, backerShares);
        assertEq(vote.parkedOf(bob), backerShares);
        _park(alice, 10_000_000e18);
        uint32 id = _openReplace(alice, _list());
        assertEq(vote.weightOf(bob), backerShares, "only his backer Shares count");
        vm.prank(bob);
        team.transfer(address(vote), g);
        assertEq(vote.parkedTotal(), backerShares + vote.parkedOf(alice), "a Team Share donation changes no count");
        _toStandEnd(id);
        _cast(bob, 1);
        assertEq(vote.castOf(id), backerShares, "his weight is his backer Shares, not the Team Shares");
    }

    // ============================================ row 8: vote spam ==================================================

    /// @notice Plan row 8. Cost: gas and 5 per cent of the Shares parked first (net 526 / 52,632, fee 10.7 / 1,074),
    /// "paid once". What the test holds: one ballot at a time and the same parked stake serves every later ballot; what
    /// the test records as a deviation: the 5 per cent is only required at the opening transaction, not held during the
    /// ballot, so a spammer can open a ballot, take the stake straight back and still block the door for 4 days.
    function test_row08_voteSpamIsOneAtATimeAndTheStakeIsNotABond() public {
        uint256 whale = _whale();
        _park(alice, whale);
        uint32 a = _openReplace(alice, _list());
        vm.expectRevert(HolderVote.BallotLive.selector);
        vm.prank(alice);
        vote.openReplace(_list(), keccak256("spam"));

        // DEVIATION: the 5 per cent is not a bond. It is required only at opening; taking it back leaves the ballot live.
        _unpark(alice, whale);
        assertEq(vote.parkedTotal(), 0, "the stake is back in the opener's wallet");
        assertEq(vote.current(), a, "and the ballot is still live");
        vm.expectRevert(HolderVote.BallotLive.selector);
        vm.prank(alice);
        vote.openReplace(_list(), keccak256("spam"));
        console2.log("row 8 deviation: the 5 per cent can be unparked the block after opening; the door is still held");

        // the ballot ends short (no one voted), and a short ballot leaves no cooldown: the next one opens at once
        _toVoteEnd(a);
        vote.finish(a);
        (uint8 outcome,,) = vote.resultOf(a);
        assertEq(outcome, vote.OUTCOME_SHORT());
        assertEq(vote.nextReplaceAt(), 0, "a short ballot leaves no cooldown");

        // the same stake, parked again, serves the next ballot: "paid once"
        _park(alice, whale);
        uint32 b = _openReplace(alice, _list());
        _toStandEnd(b);
        _cast(alice, 1);
        _toVoteEnd(b);
        vote.finish(b);
        (outcome,,) = vote.resultOf(b);
        assertEq(outcome, vote.OUTCOME_MOVED(), "the same stake can now win");

        // a won result waiting to be carried out also blocks the door (one ballot at a time)
        vm.expectRevert(HolderVote.BallotLive.selector);
        vm.prank(alice);
        vote.openReplace(_list(), keccak256("spam"));
        _toEffective(b);
        vote.carryOut(b);
        uint256 parked = vote.parkedTotal();
        uint32 c = _openReplace(alice, _list());
        assertEq(vote.current(), c);
        assertEq(vote.parkedTotal(), parked, "the same parked Shares open every later ballot: paid once");
    }

    // ========================================= row 9: ballot stuffing ===============================================

    /// @notice Plan row 9. Each list place needs 0.1 per cent parked at the snapshot (four places net 40 / 4,016, fee 0.8
    /// / 82); the four places are capped, a strictly larger stake takes the smallest junk place, an equal stake never
    /// displaces, and junk gets no votes.
    function test_row09_ballotStuffingIsCappedAndALargerStakeTakesTheSmallestPlace() public {
        address eve = makeAddr("eve with carol's stake");
        _join(eve, 70_000e6); // enough Shares to park exactly carol's stake
        _park(alice, shares.balanceOf(alice));
        _park(bob, shares.balanceOf(bob));
        _park(carol, shares.balanceOf(carol));
        _park(dave, shares.balanceOf(dave));
        _park(stranger, shares.balanceOf(stranger));
        _park(eve, vote.parkedOf(carol)); // eve parks exactly carol's weight, no more

        uint32 id = _openReplace(alice, _list()); // option 1, the opener's list
        address[5] memory lc = [carol, s1, s2, s3, s4];
        address[5] memory ld = [dave, s1, s2, s3, s4];
        address[5] memory ls = [stranger, s1, s2, s3, s4];
        _standList(bob, _listB()); // option 2
        _standList(carol, lc); // option 3
        _standList(dave, ld); // option 4: all four places are full
        assertEq(vote.optionCount(id), 5, "keep and the four list places, the cap");

        // a bigger stake takes the smallest place: stranger (9.8M) displaces dave (3.92M) at option 4
        _standList(stranger, ls);
        (HolderVote.Option memory o4,) = vote.optionOf(id, 4);
        assertEq(o4.proposer, stranger, "the larger stake took the smallest place");
        assertEq(o4.members[0], stranger);
        assertEq(vote.optionCount(id), 5, "and the cap still holds");
        // the displaced proposer may not stand again in this ballot
        vm.expectRevert(HolderVote.AlreadyStood.selector);
        vm.prank(dave);
        vote.standList(ld, keccak256("dave again"));

        // an equal stake never displaces: eve's weight is exactly carol's (the smallest place now)
        address[5] memory le = [eve, s1, s2, s3, s4];
        vm.expectRevert(HolderVote.NoRoom.selector);
        vm.prank(eve);
        vote.standList(le, keccak256("eve"));

        // a place still needs a stake: an account with nothing parked cannot stand at all
        address nobody = makeAddr("nobody");
        address[5] memory ln = [nobody, s1, s2, s3, s4];
        vm.expectRevert(HolderVote.NotEligible.selector);
        vm.prank(nobody);
        vote.standList(ln, keccak256("nobody"));

        // junk gets no votes: only the honest holder's own list is voted and it is not displaced by the junk
        _toStandEnd(id);
        _cast(alice, 1);
        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_MOVED());
        assertEq(winner, 1);
        (, uint256 tally2) = vote.optionOf(id, 2);
        assertEq(tally2, 0, "a stuffed place got no votes");
    }

    // ============================ rows 10 and 11: parking and unparking during the vote =============================

    /// @notice Plan rows 10 and 11. Row 10: parking during the vote adds nothing (the fee on the money, 0 taken). Row 11:
    /// taking Shares back during the vote lowers the count the same transaction (none), and after voteEnd it no longer
    /// matters (the tallies are frozen). Both hooks stop at exactly voteEnd.
    function test_row10_row11_parkingAfterTheOpenAddsNothingAndUnparkLowersTheCountTheSameBlock() public {
        uint256 whale = _whale();
        _park(alice, whale);
        uint32 id = _openReplace(alice, _list());

        // row 10: Bob parks after the snapshot; his weight is zero
        uint256 bobShares = shares.balanceOf(bob);
        _park(bob, bobShares);
        assertEq(vote.weightOf(bob), 0, "parking after opening adds nothing");
        _toStandEnd(id);
        vm.expectRevert(HolderVote.NotEligible.selector);
        vm.prank(bob);
        vote.castVote(1);
        assertEq(vote.castOf(id), 0, "and it cannot cast");

        // row 11: the count falls the same block as the unpark
        _cast(alice, 1);
        assertEq(vote.castOf(id), whale);
        uint256 take = whale / 4;
        _unpark(alice, take);
        assertEq(vote.weightOf(alice), whale - take, "the weight fell");
        assertEq(vote.castOf(id), whale - take, "the cast total fell in the same block");
        (, uint8 option, uint256 weight,) = vote.ballotOf(alice);
        assertEq(option, 1);
        assertEq(weight, whale - take);
        // re-parking does not restore the weight: the low since the snapshot never rises
        _park(alice, take);
        assertEq(vote.weightOf(alice), whale - take, "a re-park never restores weight");

        // the exact second: one second before voteEnd an unpark still lowers the tally; at voteEnd it is frozen.
        // (the re-park above put the balance back to `whale`, so the unpark has to take it under the low to move it)
        HolderVote.Ballot memory b = _ballotAt(id);
        _warpTo(uint256(b.voteEnd) - 1);
        _unpark(alice, take + 1);
        assertEq(vote.castOf(id), whale - take - 1, "still falls one second before the end");
        _warpTo(uint256(b.voteEnd));
        uint256 castAtEnd = vote.castOf(id);
        _unpark(alice, whale - take - 1);
        assertEq(vote.castOf(id), castAtEnd, "after voteEnd the tallies are frozen");
        vm.expectRevert(HolderVote.VotingClosed.selector);
        vm.prank(alice);
        vote.castVote(0);
    }

    // ========================================= row 12: a flash loan in one block =====================================

    /// @notice Plan row 12. A flash loan to open, stand and vote in one transaction: interest, and it cannot finish. The
    /// vote starts after the one-day stand window, and a loan repaid in the opening block has zero weight; one that stays
    /// until voting is not a flash loan and can be taken back (row 11) for nothing.
    function test_row12_aOneBlockFlashLoanCannotOpenStandAndVote() public {
        address loan = makeAddr("flash loan");
        _join(loan, 500_000e6); // the borrowed money, put in with real Shares
        uint256 n = shares.balanceOf(loan);
        _park(loan, n);
        uint32 id = _openReplace(loan, _list()); // open in the same block
        // ... and the vote is not open
        vm.expectRevert(HolderVote.VotingClosed.selector);
        vm.prank(loan);
        vote.castVote(1);
        assertEq(vote.castOf(id), 0, "nothing was cast in the opening block");

        // by the time it may vote the loan has been outstanding for the whole stand window; repaying it removes the weight
        _toStandEnd(id);
        _cast(loan, 1);
        assertEq(vote.castOf(id), n);
        _unpark(loan, n);
        assertEq(vote.castOf(id), 0, "a repaid loan counts for nothing");
        _leave(loan, n);

        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome,,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SHORT(), "the one-block loan cannot finish");
    }

    // ========================================= row 13: the ballot cannot be replayed =================================

    /// @notice Plan row 13. (The "replaced seat's agreement is dead" half is K1's and is not duplicated here.) Through the
    /// vote: a carried-out ballot cannot be carried out a second time, and a lapsed ballot cannot be carried out at all.
    function test_row13_aCarriedBallotCannotRunTwiceAndALapsedOneCannotRun() public {
        _park(alice, _whale());
        uint32 a = _openReplace(alice, _list());
        _toStandEnd(a);
        _cast(alice, 1);
        _toVoteEnd(a);
        vote.finish(a);
        _toEffective(a);
        vote.carryOut(a);
        address seated = t.runner();
        assertEq(launcher.runnerKindOf(seated), 2);

        // replay: the same ballot, carried out once already
        vm.expectRevert(HolderVote.Settled.selector);
        vote.carryOut(a);
        vm.expectRevert(HolderVote.AlreadyFinished.selector);
        vote.finish(a);

        // a second ballot; nobody carries it out inside the window, so it lapses
        uint32 b = _openReplace(alice, _list());
        _toStandEnd(b);
        _cast(alice, 1);
        _toVoteEnd(b);
        vote.finish(b);
        (uint8 outcome,,) = vote.resultOf(b);
        assertEq(outcome, vote.OUTCOME_MOVED());
        _toEffective(b);
        _warp(2 * 7 days + 1);
        vote.lapse(b);
        (,, bool lapsed) = _flags(b);
        assertTrue(lapsed);
        assertEq(t.runner(), seated, "the seated Council stays, the old runner does not come back");
        // replay: a lapsed result cannot be carried out
        vm.expectRevert(HolderVote.Settled.selector);
        vote.carryOut(b);
    }

    // ==================== row 16: the old runner's puppet offer and pending rate die at the seat =====================

    /// @notice Plan row 16. The old runner reacts during the wait: it hands the seat to a puppet and proposes a rate (and
    /// its old agents keep working). At the seat `Treasury.seatByVote` moves whoever holds it and clears the offer, the
    /// pending rate and the old agents, so none of them can reach the new Council.
    function test_row16_theOldRunnersPuppetOfferAndPendingRateDieAtTheSeat() public {
        address puppet = makeAddr("puppet");
        address agent = makeAddr("old runner agent");
        vm.prank(founder);
        t.authoriseAgent(agent);

        _park(alice, _whale());
        uint32 id = _openReplace(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome,,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_MOVED());

        // during the wait the old runner still has its own powers: hand-over and a rate proposal are not paused
        HolderVote.Ballot memory b = _ballotAt(id);
        _warpTo(uint256(b.effectiveAt) - 1);
        vm.startPrank(founder);
        t.handOver(puppet, false);
        t.proposeRate(2000);
        vm.stopPrank();
        assertEq(t.pendingRunner(), puppet, "the puppet offer is live");
        assertEq(t.pendingRatePpm(), 2000, "the rate raise is pending");
        // drawing is a different matter: a third of the Shares is parked, so the holders' pause is on
        vm.expectRevert(Treasury.Paused.selector);
        vm.prank(founder);
        t.draw(founder, 1);

        // the seat
        _warpTo(uint256(b.effectiveAt));
        vote.carryOut(id);
        address council = t.runner();
        assertEq(launcher.runnerKindOf(council), 2, "the new Council runs the project");
        assertEq(t.pendingRunner(), address(0), "the puppet offer died at the seat");
        assertEq(t.pendingSeatAt(), 0);
        assertEq(t.pendingRatePpm(), 0, "the pending rate died at the seat");
        assertEq(t.pendingAt(), 0);
        assertEq(t.ratePpm(), 1000, "and the raise never applied: the old rate stands");

        // neither can the puppet take the seat, nor can anyone apply the rate, nor can the old agent still draw
        vm.expectRevert(Treasury.NotAllowed.selector);
        vm.prank(puppet);
        t.takeSeat();
        vm.expectRevert(Treasury.BadInput.selector);
        t.applyRate();
        vm.expectRevert(Treasury.NotAllowed.selector);
        vm.prank(agent);
        t.draw(agent, 1);
    }

    // ================== row 17: the helper fails, or nobody carries a won result out ================================

    /// @notice Plan row 17. `carryOut` is open to anyone from any wallet; a failed carry-out leaves the ballot as it was
    /// and can be retried until the lapse (the lapse itself is row 13's part). No helper is needed.
    function test_row17_carryOutIsPermissionlessAndAFailedOneCanBeRetried() public {
        _park(alice, _whale());
        uint32 id = _openReplace(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        _toVoteEnd(id);
        vote.finish(id);
        HolderVote.Ballot memory b = _ballotAt(id);
        assertFalse(vote.canCarryOut(id), "not yet: the wait is not over");

        // the helper's first attempt, too early, leaves the ballot as it was
        vm.expectRevert(abi.encodeWithSelector(HolderVote.TooEarly.selector, b.effectiveAt));
        vote.carryOut(id);
        (bool finished, bool carried, bool lapsed) = _flags(id);
        assertTrue(finished);
        assertFalse(carried, "a failed carry-out changed nothing");
        assertFalse(lapsed);
        assertEq(t.runner(), founder);

        // anyone at all may carry it out once the wait is over
        _toEffective(id);
        assertTrue(vote.canCarryOut(id));
        vm.prank(stranger);
        vote.carryOut(id);
        assertEq(launcher.runnerKindOf(t.runner()), 2, "a stranger's call seated the Council");
    }

    // ============================ row 18: the hook never reverts and never traps Shares ==============================

    /// @notice Plan row 18. A hook that reverts to stop Take out or trap Shares. The hook has no external call and no loop;
    /// `unpark` is fuzzed across every ballot phase and amount and never reverts for a ballot's reason.
    function testFuzz_row18_anUnparkNeverRevertsForABallot(uint256 n, uint8 phase) public {
        uint256 whale = _whale();
        _park(alice, whale);
        uint32 id = _openReplace(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);

        uint8 p = phase % 4;
        if (p == 0) {
            // in the stand window
        } else if (p == 1) {
            _toStandEnd(id);
            _cast(alice, 1);
        } else if (p == 2) {
            _toStandEnd(id);
            _cast(alice, 1);
            _warpTo(uint256(b.voteEnd) - 1); // the last second the hook runs
        } else {
            _toStandEnd(id);
            _cast(alice, 1);
            _toVoteEnd(id); // the hook is off
        }

        uint256 amount = bound(n, 1, whale);
        vm.prank(alice);
        vote.unpark(amount); // must never revert for a ballot's reason, in any phase
        assertEq(vote.parkedOf(alice), whale - amount);
        if (p == 0) {
            assertEq(vote.castOf(id), 0, "nothing can be cast before the stand window is over");
        } else if (p < 3) {
            assertEq(vote.castOf(id), whale - amount, "the tally fell with the weight, the same block");
        } else {
            assertEq(vote.castOf(id), whale, "after voteEnd the tallies are frozen");
        }
    }

    // ============================== row 19: a candidate's text cannot be swapped ====================================

    /// @notice Plan row 19. The chain stores the text's id (its hash) at standing; nothing after that can swap it, and the
    /// hash voters saw is still on the chain after the seat.
    function test_row19_theCandidatesTextIsPinnedByItsHashOnTheChain() public {
        bytes32 h1 = keccak256("list one, signed");
        bytes32 h2 = keccak256("list one, swapped");
        _park(alice, _whale());
        _park(bob, shares.balanceOf(bob));
        vm.prank(alice);
        uint32 id = vote.openReplace(_list(), h1);
        uint8 o1 = 1;
        (HolderVote.Option memory option1,) = vote.optionOf(id, o1);
        assertEq(option1.recordHash, h1, "the opener's text hash is on the chain");
        uint8 o2 = _standList(bob, _listB());
        (HolderVote.Option memory option2,) = vote.optionOf(id, o2);
        assertEq(option2.recordHash, keccak256("list text"), "the second list's hash too");

        // the proposer cannot stand again to swap its text (the option is not rewritten)
        vm.expectRevert(HolderVote.AlreadyStood.selector);
        vm.prank(alice);
        vote.standList(_list(), h2);
        (option1,) = vote.optionOf(id, o1);
        assertEq(option1.recordHash, h1, "a second stand cannot rewrite the hash");

        // through the vote and the seat the hash is still the one voters saw
        _toStandEnd(id);
        _cast(alice, o1);
        _cast(bob, o2);
        _toVoteEnd(id);
        vote.finish(id);
        _toEffective(id);
        vote.carryOut(id);
        (option1,) = vote.optionOf(id, o1);
        (option2,) = vote.optionOf(id, o2);
        assertEq(option1.recordHash, h1);
        assertEq(option2.recordHash, keccak256("list text"));
        assertEq(option1.members[0], s1, "and the list the hash named is the list seated");
    }

    // ============================== row 21: a seat-election takeover needs a year ====================================

    /// @notice Plan row 21. Cost: the same as row 1 (fee 102 / 10,204, money tied 5,102 / 510,204 at each snapshot), and
    /// control comes about 385 days after the Council was seated (two elections 26 units apart, then 4 days and 16.5).
    /// One election takes two seats; a third seat needs a second election 26 units later.
    function test_row21_seatElectionsNeedTwoElectionsForThreeSeats() public {
        _makeCouncil();
        uint256 seatedAt = clock;
        uint64 due1 = council.nextElection();
        assertEq(due1, uint64(seatedAt + 26 * UNIT), "the first election is 26 units after the seat");

        // the whale parks before the snapshot and two of its accounts stand
        _park(alice, _whale());
        _park(bob, shares.balanceOf(bob));
        _warpTo(uint256(due1));
        uint32 first = _openSeats();
        HolderVote.Ballot memory b1 = _ballotAt(first);
        uint8 oa = _stand(alice);
        uint8 ob = _stand(bob);
        _toStandEnd(first);
        _cast(alice, oa);
        _cast(bob, ob);
        _toVoteEnd(first);
        vote.finish(first);
        (uint8 outcome, uint8 winner, uint8 winnerB) = vote.resultOf(first);
        assertEq(outcome, vote.OUTCOME_SEATED());
        assertEq(winner, oa);
        assertEq(winnerB, ob);
        _toEffective(first);
        vote.carryOut(first);

        // two of five seats, not three: this is not control yet
        (address[5] memory seats,) = council.seatList();
        assertEq(seats[0], alice);
        assertEq(seats[1], bob);
        console2.log("row 21: seats held after the first election", uint256(2));
        console2.log("row 21: the second election is due at (seconds)", uint256(council.nextElection()));

        // a second election cannot be opened before its clock
        uint64 due2 = council.nextElection();
        assertEq(due2, uint64(uint256(b1.openedAt) + 26 * UNIT), "26 units after the first was opened");
        vm.expectRevert(abi.encodeWithSelector(HolderVote.TooEarly.selector, due2));
        vote.openSeats();

        // the second election, two more of the whale's accounts; a third of the Shares votes for them
        _park(carol, shares.balanceOf(carol));
        _park(dave, shares.balanceOf(dave));
        _warpTo(uint256(due2));
        uint32 second = _openSeats();
        HolderVote.Ballot memory b2 = _ballotAt(second);
        uint8 oc = _stand(carol);
        uint8 od = _stand(dave);
        _toStandEnd(second);
        _cast(alice, oc); // the whale's third is still parked and votes for its own people
        _cast(carol, oc);
        _cast(dave, od);
        _toVoteEnd(second);
        vote.finish(second);
        (outcome, winner, winnerB) = vote.resultOf(second);
        assertEq(outcome, vote.OUTCOME_SEATED());
        assertEq(winner, oc);
        assertEq(winnerB, od);
        _toEffective(second);
        vote.carryOut(second);

        (seats,) = council.seatList();
        assertEq(seats[2], carol);
        assertEq(seats[3], dave);
        assertEq(seats[4], s5, "four of five seats are the whale's: control after two elections");
        console2.log("row 21: seats held after the second election", uint256(4));

        // arithmetic: about 385 days from the Council's seat to the second result taking effect
        uint256 elapsed = uint256(b2.effectiveAt) - seatedAt;
        console2.log("row 21: seconds from the seat to the second result", elapsed);
        assertEq(elapsed, 384 days + 12 hours, "26 + 26 units, plus 4 days of vote and the 16.5-day wait");
    }

    // ============================= row 22: the winners unpark after voteEnd =========================================

    /// @notice Plan row 22. Less than row 1 tied up (the 4 days only); the same take from sleepers. The winners unpark
    /// after voteEnd and the result still stands: the tallies are frozen and the record does not depend on their Shares
    /// staying in custody.
    function test_row22_winnersUnparkAfterVoteEndAndTheResultStands() public {
        uint256 aWeight = _whale();
        uint256 bWeight = shares.balanceOf(bob);
        _park(alice, aWeight);
        _park(bob, bWeight);
        uint32 id = _openReplace(alice, _list());
        _toStandEnd(id);
        _cast(alice, 1);
        _cast(bob, 1);
        _toVoteEnd(id);

        // the winners take every Share back right after the vote ends
        _unpark(alice, aWeight);
        _unpark(bob, bWeight);
        assertEq(vote.parkedTotal(), 0, "no winning Share is still in custody");
        assertEq(vote.castOf(id), aWeight + bWeight, "the tallies froze at voteEnd");
        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_MOVED(), "the result still stands");
        assertEq(winner, 1);

        vote.finish(id);
        _toEffective(id);
        vote.carryOut(id);
        address seated = t.runner();
        assertEq(launcher.runnerKindOf(seated), 2, "the Council is seated by Shares no longer in custody");
        (address[5] memory seats,) = Council(seated).seatList();
        assertEq(seats[0], s1);
        assertEq(seats[4], s5);
    }

    // ===================== row 23: a junk ballot holds the door, but only a "kept" one costs 28 days ================

    /// @notice Plan row 23. Cost: the row 8 stake, once. A short or moved ballot leaves no cooldown, so the next one can
    /// open the day it ends; only a "kept" result with the floor met holds the door for 4 units (28 days).
    function test_row23_onlyAKeptBallotWithTurnoutStartsTheCooldown() public {
        _park(alice, _whale()); // 19.6M Shares: a third of the supply

        // a ballot nobody votes: SHORT, no cooldown, the next one opens at once
        uint32 a = _openReplace(alice, _list());
        _toVoteEnd(a);
        vote.finish(a);
        (uint8 outcome,,) = vote.resultOf(a);
        assertEq(outcome, vote.OUTCOME_SHORT());
        assertEq(vote.nextReplaceAt(), 0, "a short ballot leaves no cooldown");

        uint32 b = _openReplace(alice, _list());
        _toStandEnd(b);
        _cast(alice, 0); // keep, with the floor met: a real "no" from the holders
        _toVoteEnd(b);
        vote.finish(b);
        (outcome,,) = vote.resultOf(b);
        assertEq(outcome, vote.OUTCOME_KEPT());
        uint64 cooldown = vote.nextReplaceAt();
        assertEq(
            cooldown,
            uint64(uint256(_ballotAt(b).voteEnd) + uint256(vote.COOLDOWN_UNITS()) * UNIT),
            "kept with turnout holds 4 units"
        );
        vm.expectRevert(abi.encodeWithSelector(HolderVote.Cooldown.selector, cooldown));
        vm.prank(alice);
        vote.openReplace(_list(), keccak256("right after the kept"));

        // after the cooldown a ballot opens; a moved one leaves no cooldown
        _warpTo(uint256(cooldown));
        uint32 c = _openReplace(alice, _list());
        _toStandEnd(c);
        _cast(alice, 1);
        _toVoteEnd(c);
        vote.finish(c);
        uint8 winner;
        (outcome, winner,) = vote.resultOf(c);
        assertEq(outcome, vote.OUTCOME_MOVED());
        assertEq(winner, 1);
        assertLe(vote.nextReplaceAt(), uint256(_ballotAt(c).voteEnd), "a moved ballot holds no cooldown past its end");
        _toEffective(c);
        vote.carryOut(c);
        assertEq(launcher.runnerKindOf(t.runner()), 2);
    }

    // ================= CONTROL: the wait and the floor are what stop the attack, not something else =================

    /// @notice The control that makes the attack tests falsifiable. Row 1's whale really can open with its own list and
    /// vote it; what stops the seat from moving at voteEnd is the wait (16.5 days) and, for anyone under a third, the
    /// floor. Here the ballot's own storage is reached with `vm.store` (`forge inspect HolderVote storage-layout`: the
    /// `ballots` mapping is slot 7, a `Ballot` is 160 bytes, `voteEnd` is the low 64 bits of base+1, `effectiveAt` the
    /// high 64 bits of base+1, `floor` is base+3; the layout is confirmed by reading the values back through
    /// `vote.ballot`). With the wait set to zero the row-1 whale is seated at voteEnd; with the floor also set to one
    /// Share, an under-a-third whale that the floor had stopped is seated at voteEnd too.
    function test_CONTROL_waitZeroAndFloorLoweredMoveTheSeatAtVoteEnd() public {
        // scenario A: the row-1 whale meets the floor on its own; only the wait stops it at voteEnd
        uint256 whale = _whale();
        _park(alice, whale);
        uint32 id = _openReplace(alice, _list());
        HolderVote.Ballot memory b = _ballotAt(id);
        _toStandEnd(id);
        _cast(alice, 1);
        _toVoteEnd(id);
        (uint8 outcome, uint8 winner,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_MOVED(), "the whale's weight already meets the third");
        assertEq(winner, 1);

        uint256 slot = _ballotSlot(id);
        console2.log("control: ballots[1] base slot", slot);
        console2.log(
            "control: base+1 before (voteEnd low 64, effectiveAt high 64)",
            uint256(vm.load(address(vote), bytes32(slot + 1)))
        );
        // the normal configuration: at voteEnd the result cannot be carried out yet
        vm.expectRevert(abi.encodeWithSelector(HolderVote.TooEarly.selector, b.effectiveAt));
        vote.carryOut(id);
        assertEq(t.runner(), founder, "the wait is the only blocker");
        // hit the layout: effectiveAt := voteEnd (the wait made zero) and floor := 1
        vm.store(address(vote), bytes32(slot + 1), bytes32(uint256(b.voteEnd) | (uint256(b.voteEnd) << 64)));
        vm.store(address(vote), bytes32(slot + 3), bytes32(uint256(1)));
        HolderVote.Ballot memory hit = _ballotAt(id);
        assertEq(hit.effectiveAt, b.voteEnd, "the wait is now zero");
        assertEq(hit.floor, 1, "the floor is now one Share");
        assertEq(uint256(vm.load(address(vote), bytes32(slot + 1))), uint256(b.voteEnd) | (uint256(b.voteEnd) << 64));
        assertEq(uint256(vm.load(address(vote), bytes32(slot + 3))), 1);
        // and now the seat moves at the exact second the vote ended
        assertTrue(vote.canCarryOut(id));
        vote.carryOut(id);
        address first = t.runner();
        assertEq(launcher.runnerKindOf(first), 2, "the seat moved at voteEnd with no wait");

        // scenario B: an under-a-third whale; the floor is what stops it, not the wait
        uint256 bobWeight = shares.balanceOf(bob);
        _park(bob, bobWeight);
        assertLt(bobWeight, b.floor, "bob is under the floor the first ballot fixed");
        uint32 id2 = _openReplace(bob, _listB());
        HolderVote.Ballot memory b2 = _ballotAt(id2);
        assertEq(b2.floor, (b2.supply + 2) / 3);
        _toStandEnd(id2);
        _cast(bob, 1);
        _toVoteEnd(id2);
        (uint8 o2,,) = vote.resultOf(id2);
        assertEq(o2, vote.OUTCOME_SHORT(), "the floor is what stops an under-a-third whale");
        assertFalse(vote.canCarryOut(id2));
        uint256 slot2 = _ballotSlot(id2);
        // lower the floor and zero the wait on this ballot too
        vm.store(address(vote), bytes32(slot2 + 1), bytes32(uint256(b2.voteEnd) | (uint256(b2.voteEnd) << 64)));
        vm.store(address(vote), bytes32(slot2 + 3), bytes32(uint256(1)));
        assertEq(_ballotAt(id2).floor, 1);
        (uint8 o3,,) = vote.resultOf(id2);
        assertEq(o3, vote.OUTCOME_MOVED(), "with the floor lowered the same turnout now wins");
        assertTrue(vote.canCarryOut(id2));
        vote.carryOut(id2);
        address second = t.runner();
        assertEq(launcher.runnerKindOf(second), 2);
        assertTrue(second != first, "a second seat moved at voteEnd");
    }

    /// @dev `ballots` is storage slot 7; a mapping value lives at `keccak256(abi.encode(key, 7))`, and a `Ballot` is
    /// 160 bytes laid out as: base+0 flags/openedAt/standEnd, base+1 voteEnd (low 64) | effectiveAt (high 64),
    /// base+2 supply, base+3 floor, base+4 council. Read back through `vote.ballot(id)` after writing.
    function _ballotSlot(uint32 id) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(uint256(id), uint256(7))));
    }

    // ============== row 11 at the packing boundary: a guard for the fixed 128-bit fields =========================

    /// @notice Row 11 at the packing boundary, now a guard. The fewest-since-open weight and the cast weight live in the
    /// low 128 bits of one slot each (`_snap = (id << 128) | low`, `_castOf = (id << 136) | (option << 128) | weight`). The
    /// first version of this contract packed them into 96 bits; an account whose parked Shares reached 2^96 wei (about
    /// 800 million dollars: backer Shares are minted at about 1e14 wei per dollar unit and `MAX_SHARES = 1e30` allows it)
    /// then overflowed into the ballot id, the stamp became `id | (weight >> 96)`, `_afterUnpark` no longer recognised the
    /// account, and the cast weight, the tally and the cast total were never lowered — the row 11 attack kept the vote with
    /// the money out of custody. With the 128-bit fields the stamp stays the id, and the same scenario must lower
    /// everything to zero. The first ballot id is burned so the weight can sit just past 2^96, the old field's boundary.
    function test_row11_aHugeAccountUnparkingLowersTheCountToo() public {
        // burn the first ballot id with a dummy ballot, so the attacker's ballot is id 2 and just over 2^96 wei is enough
        _park(alice, 10_000_000e18);
        uint32 dummy = _openReplace(alice, _list());
        _toVoteEnd(dummy);
        vote.finish(dummy);
        (uint8 dummyOutcome,,) = vote.resultOf(dummy);
        assertEq(dummyOutcome, vote.OUTCOME_SHORT());

        address attacker = makeAddr("large holder");
        // about 900,000,000 dollars: 9e14 dollar units, so about 8.8e28 wei of Shares, just past 2^96 = 7.92e28
        _join(attacker, 900_000_000e6);
        uint256 weight = shares.balanceOf(attacker);
        console2.log("row 11 guard: the attacker's weight (share wei)", weight);
        console2.log("row 11 guard: 2^96 (the old 96-bit limit, share wei)", uint256(1) << 96);
        assertGt(weight, uint256(1) << 96, "the weight is past the old 96-bit field");
        assertLt(weight, uint256(1) << 97, "and under the next bit: the exact boundary case");

        _park(attacker, weight);
        uint32 id = _openReplace(attacker, _list());
        assertEq(id, 2, "the second ballot");
        _toStandEnd(id);
        _cast(attacker, 1);
        assertEq(vote.castOf(id), weight, "all of it is counted");

        // take every Share back during the vote: row 11 says the count falls the same block, and with 128-bit fields it does
        _unpark(attacker, weight);
        assertEq(vote.parkedOf(attacker), 0, "the Shares are back in the attacker's wallet");
        assertEq(vote.weightOf(attacker), 0, "the eligible weight fell to zero");
        assertEq(vote.castOf(id), 0, "the cast total fell to zero");
        (, uint256 tally) = vote.optionOf(id, 1);
        assertEq(tally, 0, "the list's tally fell to zero");
        (, uint8 option, uint256 castWeight,) = vote.ballotOf(attacker);
        assertEq(option, 1);
        assertEq(castWeight, 0, "no weight is left on the ballot");

        // and the vote cannot take the seat: the ballot is short, not moved, and no Council is made
        _leave(attacker, weight);
        assertEq(shares.balanceOf(attacker), 0);
        _toVoteEnd(id);
        vote.finish(id);
        (uint8 outcome,,) = vote.resultOf(id);
        assertEq(outcome, vote.OUTCOME_SHORT(), "the unparked weight carries no result");
        _toEffective(id);
        vm.expectRevert(HolderVote.NothingToDo.selector);
        vote.carryOut(id);
        assertEq(t.runner(), founder, "no seat moved");
    }
}
