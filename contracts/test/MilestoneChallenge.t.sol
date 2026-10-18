// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";
import {MilestoneChallenge} from "../src/MilestoneChallenge.sol";
import {MilestoneBadge} from "../src/MilestoneBadge.sol";
import {Shares} from "../src/majeur/MolochPatched.sol";

/// @notice The founders vote with their Shares from the start, but the part a milestone covers cannot be sold or
/// ragequit until the milestone has stood: published, waited out, and either not objected to or objected to without the
/// holders upholding it.
contract MilestoneChallengeTest is VotingFixture {
    address internal constant DAVE = address(0xDA7E); // the second team member
    address internal constant ERIN = address(0xE41);
    address internal constant FRANK = address(0xF4A);
    address internal constant TINY = address(0x7171); // a holder too small to carry an objection
    bytes32 internal constant CHECK_ONE = keccak256("beta live at a public address");
    bytes32 internal constant CHECK_TWO = keccak256("first customers are paying");
    bytes32 internal constant CHECK_THREE = keccak256("version one released");
    bytes32 internal constant EVIDENCE = keccak256("evidence packet");

    uint128 internal constant BOND = 100e18;
    uint128 internal constant DEPOSIT = 10e18;

    MilestoneChallenge internal lock;
    MilestoneBadge internal badge;
    MandateCurrency internal cash;

    // Holders after setUp: team ALICE 100 + DAVE 50 = 150, backers BOB 60 + CAROL 30 + ERIN 20 + FRANK 10 + TINY 0.5,
    // the DAO's own 200. Eligible to vote: 120.5. The minimum rejecting weight at 3% of that is 3.615.

    function _checks() internal pure returns (bytes32[] memory c) {
        c = new bytes32[](3);
        c[0] = CHECK_ONE;
        c[1] = CHECK_TWO;
        c[2] = CHECK_THREE;
    }

    function _bps() internal pure returns (uint16[] memory b) {
        b = new uint16[](3);
        b[0] = 2000; // 7 days
        b[1] = 3000; // 14 days (a tranche of 25% or more)
        b[2] = 5000; // 21 days (a tranche of half or more)
    }

    function _terms() internal view returns (MilestoneChallenge.Terms memory t) {
        t = MilestoneChallenge.Terms({
            window: 7 days,
            votePeriod: 5 days,
            clawback: 30 days,
            minRejectBps: 300,
            earliestBlock: uint64(vm.getBlockNumber()),
            bondToken: address(cash),
            bond: BOND,
            deposit: DEPOSIT
        });
    }

    function _team() internal pure returns (address[] memory who, uint256[] memory totals) {
        who = new address[](2);
        who[0] = ALICE;
        who[1] = DAVE;
        totals = new uint256[](2);
        totals[0] = 100e18;
        totals[1] = 50e18;
    }

    function _mintShares(address to, uint256 amount) internal {
        vm.prank(address(dao));
        shares.mintFromMoloch(to, amount);
    }

    function _fund(address who, uint256 amount) internal {
        cash.mint(who, amount);
        vm.prank(who);
        cash.approve(address(lock), type(uint256).max);
    }

    function setUp() public override {
        super.setUp();
        cash = new MandateCurrency();
        _mintShares(DAVE, 50e18);
        _mintShares(BOB, 60e18);
        _mintShares(CAROL, 30e18);
        _mintShares(ERIN, 20e18);
        _mintShares(FRANK, 10e18);
        _mintShares(TINY, 0.5e18);
        _mintShares(address(dao), 200e18);
        (address[] memory who, uint256[] memory totals) = _team();
        lock = new MilestoneChallenge(address(dao), who, totals, _checks(), _bps(), _terms());
        badge = lock.badge();
        vm.prank(address(dao));
        shares.setLockGuard(address(lock));
        _fund(ALICE, 1000e18);
        _fund(DAVE, 1000e18);
        _fund(BOB, 1000e18);
        _fund(CAROL, 1000e18);
        _fund(ERIN, 1000e18);
        _fund(FRANK, 1000e18);
        _fund(TINY, 1000e18);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _submit(uint256 index) internal {
        vm.prank(ALICE);
        lock.submit(index, EVIDENCE);
    }

    function _pass(uint256 seconds_) internal {
        vm.warp(vm.getBlockTimestamp() + seconds_);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _held() internal view returns (uint256) {
        return cash.balanceOf(address(lock));
    }

    // ---- the schedule and the terms ------------------------------------------------------------

    function test_a_bad_schedule_or_bad_terms_never_deploys() public {
        (address[] memory who, uint256[] memory totals) = _team();
        MilestoneChallenge.Terms memory t = _terms();
        vm.expectRevert(MilestoneChallenge.BadSchedule.selector);
        new MilestoneChallenge(address(0), who, totals, _checks(), _bps(), t);
        vm.expectRevert(MilestoneChallenge.BadSchedule.selector);
        new MilestoneChallenge(address(dao), new address[](0), new uint256[](0), _checks(), _bps(), t);
        vm.expectRevert(MilestoneChallenge.BadSchedule.selector);
        new MilestoneChallenge(address(dao), who, totals, new bytes32[](0), new uint16[](0), t);
        uint16[] memory over = _bps();
        over[2] = 5001;
        vm.expectRevert(MilestoneChallenge.BadSchedule.selector);
        new MilestoneChallenge(address(dao), who, totals, _checks(), over, t);
        bytes32[] memory twice = _checks();
        twice[1] = CHECK_ONE;
        vm.expectRevert(MilestoneChallenge.BadSchedule.selector);
        new MilestoneChallenge(address(dao), who, totals, twice, _bps(), t);
        address[] memory dup = new address[](2);
        dup[0] = ALICE;
        dup[1] = ALICE;
        vm.expectRevert(MilestoneChallenge.BadSchedule.selector);
        new MilestoneChallenge(address(dao), dup, totals, _checks(), _bps(), t);

        t.window = 12 hours;
        vm.expectRevert(MilestoneChallenge.BadTerms.selector);
        new MilestoneChallenge(address(dao), who, totals, _checks(), _bps(), t);
        t = _terms();
        t.votePeriod = 31 days;
        vm.expectRevert(MilestoneChallenge.BadTerms.selector);
        new MilestoneChallenge(address(dao), who, totals, _checks(), _bps(), t);
        t = _terms();
        t.minRejectBps = 0;
        vm.expectRevert(MilestoneChallenge.BadTerms.selector);
        new MilestoneChallenge(address(dao), who, totals, _checks(), _bps(), t);
        t = _terms();
        t.minRejectBps = 5001;
        vm.expectRevert(MilestoneChallenge.BadTerms.selector);
        new MilestoneChallenge(address(dao), who, totals, _checks(), _bps(), t);
        t = _terms();
        t.bondToken = address(0xBEEF); // a bond with no token to pay it in
        vm.expectRevert(MilestoneChallenge.BadTerms.selector);
        new MilestoneChallenge(address(dao), who, totals, _checks(), _bps(), t);
    }

    function test_the_team_is_locked_until_a_milestone_stands() public {
        assertEq(lock.lockedOf(ALICE), 100e18);
        assertEq(lock.lockedOf(DAVE), 50e18);
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        shares.transfer(BOB, 1);
        assertEq(lock.windowFor(0), 7 days);
        assertEq(lock.windowFor(1), 14 days);
        assertEq(lock.windowFor(2), 21 days);
    }

    function test_who_could_vote_leaves_out_the_dao_and_the_team() public view {
        assertEq(lock.eligibleSupply(), 120.5e18);
    }

    // ---- publishing a milestone ---------------------------------------------------------------

    function test_only_a_team_member_publishes_and_it_takes_the_bond() public {
        vm.prank(BOB);
        vm.expectRevert(MilestoneChallenge.NotTeam.selector);
        lock.submit(0, EVIDENCE);
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.UnknownMilestone.selector);
        lock.submit(3, EVIDENCE);
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.WrongPhase.selector);
        lock.submit(0, bytes32(0));

        uint256 before_ = cash.balanceOf(ALICE);
        _submit(0);
        assertEq(cash.balanceOf(ALICE), before_ - BOND);
        assertEq(_held(), BOND);
        (MilestoneChallenge.Phase phase,,, address submitter, bytes32 ev, uint64 ends,, uint128 held) =
            lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.Pending));
        assertEq(submitter, ALICE);
        assertEq(ev, EVIDENCE);
        assertEq(ends, uint64(vm.getBlockTimestamp()) + 7 days);
        assertEq(held, BOND);

        vm.prank(DAVE);
        vm.expectRevert(MilestoneChallenge.WrongPhase.selector);
        lock.submit(0, EVIDENCE);
    }

    function test_a_milestone_cannot_be_published_before_the_buyers_can_claim() public {
        (address[] memory who, uint256[] memory totals) = _team();
        MilestoneChallenge.Terms memory t = _terms();
        t.earliestBlock = uint64(vm.getBlockNumber() + 10);
        MilestoneChallenge late = new MilestoneChallenge(address(dao), who, totals, _checks(), _bps(), t);
        vm.prank(ALICE);
        cash.approve(address(late), type(uint256).max);
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.TooEarly.selector);
        late.submit(0, EVIDENCE);
        vm.roll(vm.getBlockNumber() + 10);
        vm.prank(ALICE);
        late.submit(0, EVIDENCE);
    }

    function test_a_bigger_tranche_waits_longer() public {
        _stand(0);
        _stand(1);
        _pass(30 days);
        vm.prank(ALICE);
        lock.submit(2, EVIDENCE);
        (,,,,, uint64 ends,,) = lock.milestone(2);
        assertEq(ends, uint64(vm.getBlockTimestamp()) + 21 days);
    }

    // ---- no objection ------------------------------------------------------------------------

    function test_with_no_objection_anyone_finishes_it_after_the_window_and_the_whole_team_unlocks() public {
        _submit(0);
        _pass(7 days - 1);
        vm.expectRevert(MilestoneChallenge.WindowOpen.selector);
        lock.finish(0);
        _pass(1);
        vm.prank(FRANK); // not the team: anyone may call it
        lock.finish(0);

        assertEq(lock.lockedOf(ALICE), 80e18);
        assertEq(lock.lockedOf(DAVE), 40e18);
        assertEq(badge.balanceOf(ALICE), 1);
        assertEq(badge.balanceOf(DAVE), 1);
        // The unlocked part can move now; the rest cannot.
        vm.prank(ALICE);
        shares.transfer(BOB, 20e18);
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        shares.transfer(BOB, 1);
        // It cannot be finished twice, or published again.
        vm.expectRevert(MilestoneChallenge.WrongPhase.selector);
        lock.finish(0);
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.WrongPhase.selector);
        lock.submit(0, EVIDENCE);
    }

    function test_the_bond_comes_back_only_after_the_clawback_period() public {
        _submit(0);
        _pass(7 days);
        lock.finish(0);
        uint256 before_ = cash.balanceOf(ALICE);
        vm.expectRevert(MilestoneChallenge.BondHeld.selector);
        lock.releaseBond(0);
        _pass(30 days - 1);
        vm.expectRevert(MilestoneChallenge.BondHeld.selector);
        lock.releaseBond(0);
        _pass(1);
        lock.releaseBond(0);
        assertEq(cash.balanceOf(ALICE), before_ + BOND);
        assertEq(_held(), 0);
        vm.expectRevert(MilestoneChallenge.WrongPhase.selector);
        lock.releaseBond(0);
    }

    // ---- an objection ------------------------------------------------------------------------

    function _object(address who, uint256 index) internal {
        vm.prank(who);
        lock.object(index);
    }

    function _vote(address who, uint256 index, bool reject) internal {
        vm.prank(who);
        lock.vote(index, reject);
    }

    function test_only_a_holder_who_is_not_on_the_team_can_object_and_it_takes_the_deposit() public {
        _submit(0);
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.NoWeight.selector);
        lock.object(0);
        vm.prank(DAVE);
        vm.expectRevert(MilestoneChallenge.NoWeight.selector);
        lock.object(0);
        vm.prank(address(dao));
        vm.expectRevert(MilestoneChallenge.NoWeight.selector);
        lock.object(0);
        vm.prank(address(0xDEAD)); // holds nothing
        vm.expectRevert(MilestoneChallenge.NoWeight.selector);
        lock.object(0);

        uint256 before_ = cash.balanceOf(BOB);
        _object(BOB, 0);
        assertEq(cash.balanceOf(BOB), before_ - DEPOSIT);
        assertEq(_held(), BOND + DEPOSIT);
        (
            bool open,
            bool late,
            address objector,,
            uint64 voteEnds,
            uint128 dep,
            uint256 eligible,
            uint256 rej,
            uint256 acc
        ) = lock.objection(0);
        assertTrue(open);
        assertFalse(late);
        assertEq(objector, BOB);
        assertEq(dep, DEPOSIT);
        assertEq(eligible, 120.5e18);
        assertEq(rej, 60e18); // the objector's own weight counts as a rejection
        assertEq(acc, 0);
        // The window is never shortened: the vote ends when the 7-day window would have, if later than 5 days.
        assertEq(voteEnds, uint64(vm.getBlockTimestamp()) + 7 days);
        // One objection at a time, and the milestone cannot be finished while it is open.
        vm.prank(CAROL);
        vm.expectRevert(MilestoneChallenge.VoteOpen.selector);
        lock.object(0);
        _pass(8 days);
        vm.expectRevert(MilestoneChallenge.WrongPhase.selector);
        lock.finish(0);
    }

    function test_an_objection_late_in_the_window_still_gets_a_full_vote() public {
        _submit(0);
        _pass(6 days);
        _object(BOB, 0);
        (,,,, uint64 voteEnds,,,,) = lock.objection(0);
        assertEq(voteEnds, uint64(vm.getBlockTimestamp()) + 5 days);
    }

    function test_nobody_can_object_after_the_window() public {
        _submit(0);
        _pass(7 days);
        vm.prank(BOB);
        vm.expectRevert(MilestoneChallenge.WindowClosed.selector);
        lock.object(0);
    }

    function test_an_objection_needs_a_published_milestone() public {
        vm.prank(BOB);
        vm.expectRevert(MilestoneChallenge.WrongPhase.selector);
        lock.object(0);
    }

    function test_votes_cannot_be_bought_after_the_objection_and_delegated_votes_cannot_be_used() public {
        _submit(0);
        _object(ERIN, 0); // 20 reject
        // Shares bought after the objection have no votes at the snapshot.
        _mintShares(address(0xB17E), 500e18);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(address(0xB17E));
        vm.expectRevert(MilestoneChallenge.NoWeight.selector);
        lock.vote(0, true);
        // Someone who hands their votes to another wallet cannot vote with them, and the wallet they hand them to
        // can only use Shares it holds itself.
        vm.prank(FRANK);
        shares.delegate(BOB);
        vm.roll(vm.getBlockNumber() + 1);
        // The snapshot is before the delegation, so FRANK still votes with his own 10 (past votes 10, balance 10).
        _vote(FRANK, 0, false);
        (,,,,,,, uint256 rej, uint256 acc) = lock.objection(0);
        assertEq(rej, 20e18);
        assertEq(acc, 10e18);
    }

    function test_delegation_neither_adds_to_nor_takes_from_what_a_holder_owns() public {
        vm.prank(CAROL);
        shares.delegate(ERIN); // ERIN now carries 50 votes but owns 20; CAROL still owns her 30
        vm.roll(vm.getBlockNumber() + 1);
        _submit(0);
        _object(BOB, 0);
        _vote(CAROL, 0, false);
        _vote(ERIN, 0, false);
        (,,,,,,, uint256 rej, uint256 acc) = lock.objection(0);
        assertEq(rej, 60e18);
        assertEq(acc, 50e18); // 30 owned by CAROL and 20 by ERIN, however the votes were handed around
    }

    function test_the_team_cannot_vote_and_nobody_votes_twice_or_after_the_end() public {
        _submit(0);
        _object(BOB, 0);
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.NoWeight.selector);
        lock.vote(0, false);
        vm.prank(address(dao));
        vm.expectRevert(MilestoneChallenge.NoWeight.selector);
        lock.vote(0, false);
        _vote(CAROL, 0, false);
        vm.prank(CAROL);
        vm.expectRevert(MilestoneChallenge.AlreadyVoted.selector);
        lock.vote(0, true);
        vm.prank(BOB); // the objector's weight already counted
        vm.expectRevert(MilestoneChallenge.AlreadyVoted.selector);
        lock.vote(0, true);
        _pass(7 days);
        vm.prank(ERIN);
        vm.expectRevert(MilestoneChallenge.VoteClosed.selector);
        lock.vote(0, true);
    }

    function test_the_views_say_what_a_vote_would_count_for_and_whether_it_was_cast() public {
        // With nothing open: what an objection raised now would carry.
        assertEq(lock.voteWeight(0, BOB), 60e18);
        assertEq(lock.voteWeight(0, ALICE), 0, "the team does not vote");
        assertEq(lock.voteWeight(0, address(dao)), 0);
        assertEq(lock.voteWeight(0, address(0xDEAD)), 0);
        _submit(0);
        assertFalse(lock.hasVoted(0, BOB));
        _object(BOB, 0);
        assertTrue(lock.hasVoted(0, BOB), "the objector's vote is cast");
        assertFalse(lock.hasVoted(0, CAROL));
        // Against the open objection: weights at its snapshot, so Shares bought since count for nothing.
        _mintShares(CAROL, 500e18);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(lock.voteWeight(0, CAROL), 30e18);
        _vote(CAROL, 0, false);
        assertTrue(lock.hasVoted(0, CAROL));
        // A second objection on the same milestone starts a fresh round.
        _pass(7 days);
        lock.resolve(0);
        _submit(0);
        _object(BOB, 0);
        assertFalse(lock.hasVoted(0, CAROL));
        assertTrue(lock.hasVoted(0, BOB));
    }

    // ---- how an objection ends --------------------------------------------------------------------

    function test_an_upheld_objection_sends_it_back_and_splits_the_bond() public {
        _submit(0);
        _object(BOB, 0); // 60 reject
        _vote(CAROL, 0, false); // 30 accept
        uint256 bobBefore = cash.balanceOf(BOB);
        uint256 daoBefore = cash.balanceOf(address(dao));
        vm.expectRevert(MilestoneChallenge.VoteOpen.selector);
        lock.resolve(0);
        _pass(7 days);
        lock.resolve(0);

        (MilestoneChallenge.Phase phase,, uint8 attempts, address submitter, bytes32 ev,,, uint128 held) =
            lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.None));
        assertEq(attempts, 1);
        assertEq(submitter, address(0));
        assertEq(ev, bytes32(0));
        assertEq(held, 0);
        // The objector gets the deposit back and half the bond; the DAO the other half.
        assertEq(cash.balanceOf(BOB), bobBefore + DEPOSIT + BOND / 2);
        assertEq(cash.balanceOf(address(dao)), daoBefore + BOND / 2);
        assertEq(_held(), 0);
        // Nothing unlocked; the retry waits twice as long.
        assertEq(lock.lockedOf(ALICE), 100e18);
        assertEq(lock.windowFor(0), 14 days);
        _submit(0);
        (,,,,, uint64 ends,,) = lock.milestone(0);
        assertEq(ends, uint64(vm.getBlockTimestamp()) + 14 days);
        vm.expectRevert(MilestoneChallenge.WrongPhase.selector);
        lock.resolve(0);
    }

    function test_an_objection_the_holders_do_not_back_lets_it_stand_and_the_deposit_goes_to_the_dao() public {
        _submit(0);
        _object(FRANK, 0); // 10 reject
        _vote(BOB, 0, false); // 60 accept
        uint256 daoBefore = cash.balanceOf(address(dao));
        _pass(7 days);
        lock.resolve(0);
        (MilestoneChallenge.Phase phase,,,,,, uint64 unlockedAt, uint128 held) = lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.Stood));
        assertEq(unlockedAt, uint64(vm.getBlockTimestamp()));
        assertEq(held, BOND); // still held through the clawback period
        assertEq(cash.balanceOf(address(dao)), daoBefore + DEPOSIT);
        assertEq(lock.lockedOf(ALICE), 80e18);
        assertEq(badge.balanceOf(DAVE), 1);
    }

    function test_a_tie_lets_it_stand() public {
        _submit(0);
        _object(BOB, 0); // 60 reject
        _vote(CAROL, 0, false); // 30
        _vote(ERIN, 0, false); // 20
        _vote(FRANK, 0, false); // 10: 60 each way
        _pass(7 days);
        lock.resolve(0);
        (MilestoneChallenge.Phase phase,,,,,,,) = lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.Stood));
    }

    function test_an_objection_too_small_to_count_lets_it_stand_even_if_nobody_answers_it() public {
        _submit(0);
        _object(TINY, 0); // 0.5 reject is under 3% of 120.5, and nobody else says anything
        _pass(7 days);
        lock.resolve(0);
        (MilestoneChallenge.Phase phase,,,,,,,) = lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.Stood));
    }

    function test_silence_after_an_objection_big_enough_to_count_upholds_it() public {
        _submit(0);
        _object(BOB, 0); // 60 is far over the minimum and nobody answers
        _pass(7 days);
        lock.resolve(0);
        (MilestoneChallenge.Phase phase,, uint8 attempts,,,,,) = lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.None));
        assertEq(attempts, 1);
    }

    function _holderWithADeposit(address who, uint256 shareAmount) internal {
        _mintShares(who, shareAmount);
        cash.mint(who, 100e18);
        vm.prank(who);
        cash.approve(address(lock), type(uint256).max);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function test_the_minimum_is_three_percent_of_everything_that_could_vote() public {
        // A 3.6 holder joins: 124.1 can vote, so the bar is 3.723 and 3.6 falls short.
        address small = address(0x5A11);
        _holderWithADeposit(small, 3.6e18);
        _submit(0);
        _object(small, 0);
        _pass(7 days);
        lock.resolve(0);
        (MilestoneChallenge.Phase phase,,,,,,,) = lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.Stood));
    }

    function test_an_objector_just_over_the_minimum_is_enough_on_their_own() public {
        // A 4.0 holder joins: 124.5 can vote, so the bar is 3.735 and 4.0 clears it, unopposed.
        address enough = address(0x5A12);
        _holderWithADeposit(enough, 4e18);
        _submit(0);
        _object(enough, 0);
        _pass(7 days);
        lock.resolve(0);
        (MilestoneChallenge.Phase phase,,,,,,,) = lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.None));
    }

    // ---- what a vote counts ---------------------------------------------------------------------

    function test_delegated_votes_cannot_be_filled_with_shares_bought_after_the_objection() public {
        // The team lends its votes to a small holder; an objection is raised; the small holder then buys more Shares.
        vm.prank(ALICE);
        shares.delegate(FRANK);
        vm.prank(DAVE);
        shares.delegate(FRANK);
        vm.roll(vm.getBlockNumber() + 1);
        _submit(0);
        _object(BOB, 0); // 60 against
        _mintShares(FRANK, 50e18);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(lock.voteWeight(0, FRANK), 10e18, "what he owned, not what he was lent or bought since");
        _vote(FRANK, 0, false);
        (,,,,,,, uint256 rej, uint256 acc) = lock.objection(0);
        assertEq(rej, 60e18);
        assertEq(acc, 10e18);
        _pass(14 days);
        lock.resolve(0);
        // 60 against 10: upheld. (Counting his delegated votes it was 60 against 60, a tie, and the milestone stood.)
        (MilestoneChallenge.Phase phase,,,,,,,) = lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.None));
    }

    function test_shares_passed_between_wallets_that_hold_delegations_count_for_nothing() public {
        address r1 = address(0x4E1);
        address r2 = address(0x4E2);
        vm.prank(ALICE);
        shares.delegate(r1);
        vm.prank(DAVE);
        shares.delegate(r2);
        vm.roll(vm.getBlockNumber() + 1);
        _submit(0);
        _object(BOB, 0); // 60 against
        // CAROL owned 30 when it was raised. She hands them to one wallet that holds a delegation, which hands them on.
        vm.prank(CAROL);
        shares.transfer(r1, 30e18);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(lock.voteWeight(0, r1), 0, "it owned nothing then");
        assertEq(lock.voteWeight(0, CAROL), 0, "and she no longer holds them");
        vm.prank(r1);
        vm.expectRevert(MilestoneChallenge.NoWeight.selector);
        lock.vote(0, false);
        vm.prank(r1);
        shares.transfer(r2, 30e18);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(r2);
        vm.expectRevert(MilestoneChallenge.NoWeight.selector);
        lock.vote(0, false);
        (,,,,,,, uint256 rej, uint256 acc) = lock.objection(0);
        assertEq(rej, 60e18);
        assertEq(acc, 0);
        _pass(14 days);
        lock.resolve(0);
        (MilestoneChallenge.Phase phase,,,,,,,) = lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.None));
    }

    // ---- in order ---------------------------------------------------------------------------------

    function test_milestones_are_published_in_order() public {
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.OutOfOrder.selector);
        lock.submit(1, EVIDENCE);
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.OutOfOrder.selector);
        lock.submit(2, EVIDENCE);
        _submit(0);
        // Published is not enough: the one before has to have stood.
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.OutOfOrder.selector);
        lock.submit(1, EVIDENCE);
        _object(BOB, 0);
        _pass(14 days);
        lock.resolve(0); // turned down: it is not through, so the next waits
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.OutOfOrder.selector);
        lock.submit(1, EVIDENCE);
        _stand(0);
        // Stood is not enough either: the month for a late objection to the one before has to be over first.
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.EarlierStillOpen.selector);
        lock.submit(1, EVIDENCE);
        _pass(30 days);
        vm.prank(ALICE);
        lock.submit(1, EVIDENCE); // now it can go
    }

    function test_the_tranches_ahead_are_the_collateral_for_a_late_objection_to_an_earlier_milestone() public {
        _stand(0);
        // The next one cannot even be published while the one before can still be objected to late: it is still locked.
        vm.prank(DAVE);
        vm.expectRevert(MilestoneChallenge.EarlierStillOpen.selector);
        lock.submit(1, EVIDENCE);
        uint256 supplyBefore = shares.totalSupply();
        _pass(1 days);
        _object(BOB, 0);
        _pass(5 days);
        lock.resolve(0);
        // Milestones two and three (80% of each member's Shares) were still locked, and were burned.
        assertEq(supplyBefore - shares.totalSupply(), 120e18);
        assertEq(lock.lockedOf(ALICE), 0);
        assertEq(lock.lockedOf(DAVE), 0);
        // What milestone one had already freed is theirs.
        assertEq(shares.balanceOf(ALICE), 20e18);
    }

    /// An independent review's reproduction: the last milestone was published and unlocked while a late vote on an earlier
    /// one was open, and the late objection was then upheld with nothing left to burn. Now the last milestone cannot be
    /// published while the earlier month runs, nor while a vote on it is open, so its tranche is still locked and burned.
    function test_the_last_tranche_stays_locked_while_an_earlier_milestone_can_be_objected_to_or_is_being_voted_on()
        public
    {
        _stand(0);
        _stand(1); // the first was settled before this one was even published
        _pass(10 days);
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.EarlierStillOpen.selector);
        lock.submit(2, EVIDENCE); // inside the month for a late objection to milestone two
        _object(BOB, 1); // a late objection to milestone two; its vote runs five days
        _pass(25 days); // the month is over and so is the vote, but nobody has settled it
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.EarlierStillOpen.selector);
        lock.submit(2, EVIDENCE);
        uint256 supplyBefore = shares.totalSupply();
        lock.resolve(1);
        // Upheld by silence (the objection is big enough to count): the last tranche (half of each member's Shares) was
        // still locked, and is burned.
        assertEq(supplyBefore - shares.totalSupply(), 75e18);
        assertEq(lock.lockedOf(ALICE), 0);
        assertEq(lock.lockedOf(DAVE), 0);
    }

    function test_a_vote_opened_in_the_last_second_of_the_month_still_holds_the_next_milestone() public {
        _stand(0);
        _pass(30 days - 1);
        _object(BOB, 0);
        _pass(1); // the month is over, the vote is open
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.EarlierStillOpen.selector);
        lock.submit(1, EVIDENCE);
        _vote(CAROL, 0, false);
        _vote(ERIN, 0, false);
        _vote(FRANK, 0, false);
        _pass(5 days);
        lock.resolve(0); // not upheld: it stands, and the next one can go
        vm.prank(ALICE);
        lock.submit(1, EVIDENCE);
    }

    function test_a_lock_with_no_clawback_period_only_waits_for_the_one_before_to_stand() public {
        (address[] memory who, uint256[] memory totals) = _team();
        MilestoneChallenge.Terms memory t = _terms();
        t.clawback = 0;
        MilestoneChallenge quick = new MilestoneChallenge(address(dao), who, totals, _checks(), _bps(), t);
        vm.prank(ALICE);
        cash.approve(address(quick), type(uint256).max);
        vm.prank(ALICE);
        quick.submit(0, EVIDENCE);
        _pass(quick.windowFor(0));
        quick.finish(0);
        vm.prank(ALICE);
        quick.submit(1, EVIDENCE);
    }

    // ---- the clawback ------------------------------------------------------------------------

    /// Publish and finish a milestone nobody objects to. Past the first, the month for a late objection to the one before
    /// has to be over first.
    function _stand(uint256 index) internal {
        if (index != 0) _pass(30 days);
        vm.prank(ALICE);
        lock.submit(index, EVIDENCE);
        _pass(lock.windowFor(index));
        lock.finish(index);
    }

    function test_an_upheld_late_objection_burns_what_is_still_locked_and_takes_the_bond() public {
        _stand(0);
        uint256 supplyBefore = shares.totalSupply();
        _pass(10 days);
        uint256 daoBefore = cash.balanceOf(address(dao));
        _object(BOB, 0);
        uint256 bobBefore = cash.balanceOf(BOB); // after the deposit has been paid
        (bool open, bool late,,,,,,,) = lock.objection(0);
        assertTrue(open);
        assertTrue(late);
        _pass(5 days);
        lock.resolve(0);
        // What was unlocked stays; the other 80 + 40 locked Shares are burned.
        assertEq(shares.totalSupply(), supplyBefore - 120e18);
        assertEq(lock.lockedOf(ALICE), 0);
        assertEq(lock.lockedOf(DAVE), 0);
        assertEq(shares.balanceOf(ALICE), 20e18);
        assertEq(shares.balanceOf(DAVE), 10e18);
        assertEq(cash.balanceOf(BOB), bobBefore + DEPOSIT + BOND / 2);
        assertEq(cash.balanceOf(address(dao)), daoBefore + BOND / 2);
        assertEq(_held(), 0);
        // Nothing is left to reach.
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.WrongPhase.selector);
        lock.submit(1, EVIDENCE);
    }

    function test_a_late_objection_is_allowed_once_and_only_in_the_clawback_period() public {
        _stand(0);
        _pass(30 days);
        vm.prank(BOB);
        vm.expectRevert(MilestoneChallenge.ClawbackOver.selector);
        lock.object(0);

        // Within the period, one objection that fails uses it up.
        MilestoneChallenge second = lock; // same lock, milestone 1
        _stand(1);
        _pass(1 days);
        _object(FRANK, 1);
        _vote(BOB, 1, false);
        _pass(5 days);
        second.resolve(1);
        vm.prank(CAROL);
        vm.expectRevert(MilestoneChallenge.ClawbackOver.selector);
        lock.object(1);
    }

    function test_a_late_objection_that_fails_costs_the_deposit_and_the_bond_comes_back() public {
        _stand(0);
        _pass(1 days);
        _object(FRANK, 0);
        _vote(BOB, 0, false);
        uint256 daoBefore = cash.balanceOf(address(dao));
        _pass(5 days);
        lock.resolve(0);
        assertEq(cash.balanceOf(address(dao)), daoBefore + DEPOSIT);
        assertEq(lock.lockedOf(ALICE), 80e18);
        // The vote ended inside the period, so the bond is still held until it is over.
        vm.expectRevert(MilestoneChallenge.BondHeld.selector);
        lock.releaseBond(0);
        _pass(30 days);
        lock.releaseBond(0);
        assertEq(_held(), 0);
    }

    function test_the_bond_is_held_while_a_late_vote_is_open() public {
        _stand(0);
        _pass(29 days);
        _object(BOB, 0);
        _pass(2 days); // the period is over but the vote is not
        vm.expectRevert(MilestoneChallenge.BondHeld.selector);
        lock.releaseBond(0);
    }

    // ---- scrutiny grows -------------------------------------------------------------------------

    function test_each_rejected_attempt_doubles_the_window_up_to_eight_times_and_sixty_days() public {
        assertEq(lock.windowFor(0), 7 days);
        for (uint256 i; i < 3; ++i) {
            _submit(0);
            _object(BOB, 0);
            _pass(lock.windowFor(0));
            lock.resolve(0);
        }
        assertEq(lock.windowFor(0), 56 days); // 7 days, doubled three times
        _submit(0);
        _object(BOB, 0);
        _pass(60 days);
        lock.resolve(0);
        assertEq(lock.windowFor(0), 56 days); // the doubling stops at eight times
        // The 21-day milestone caps at sixty days (milestones go in order, so the two before it stand first).
        _stand(0);
        _stand(1);
        _pass(30 days);
        for (uint256 i; i < 2; ++i) {
            vm.prank(ALICE);
            lock.submit(2, EVIDENCE);
            _object(BOB, 2);
            _pass(lock.windowFor(2));
            lock.resolve(2);
        }
        assertEq(lock.windowFor(2), 60 days);
    }

    // ---- the DAO --------------------------------------------------------------------------------

    function test_the_dao_can_give_up_a_departed_members_tranches_and_nobody_else_can() public {
        vm.prank(BOB);
        vm.expectRevert(MilestoneChallenge.OnlyDao.selector);
        lock.forfeit(DAVE);
        vm.prank(DAVE);
        vm.expectRevert(MilestoneChallenge.OnlyDao.selector);
        lock.forfeit(DAVE);
        uint256 supplyBefore = shares.totalSupply();
        vm.prank(address(dao));
        assertEq(lock.forfeit(DAVE), 50e18);
        assertEq(shares.totalSupply(), supplyBefore - 50e18);
        assertEq(lock.lockedOf(DAVE), 0);
        // The rest of the team can still reach milestones, and the forfeited member is skipped.
        _stand(0);
        assertEq(badge.balanceOf(DAVE), 0);
        assertEq(badge.balanceOf(ALICE), 1);
    }

    function test_nothing_can_be_published_once_every_tranche_is_given_up() public {
        vm.prank(address(dao));
        lock.forfeit(ALICE);
        vm.prank(address(dao));
        lock.forfeit(DAVE);
        vm.prank(ALICE);
        vm.expectRevert(MilestoneChallenge.WrongPhase.selector);
        lock.submit(0, EVIDENCE);
    }

    // ---- no bond, no deposit ---------------------------------------------------------------------

    function test_a_lock_with_no_bond_and_no_deposit_moves_no_money() public {
        (address[] memory who, uint256[] memory totals) = _team();
        MilestoneChallenge.Terms memory t = _terms();
        t.bond = 0;
        t.deposit = 0;
        t.bondToken = address(0);
        MilestoneChallenge free = new MilestoneChallenge(address(dao), who, totals, _checks(), _bps(), t);
        vm.prank(ALICE);
        free.submit(0, EVIDENCE);
        vm.prank(BOB);
        free.object(0);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        free.resolve(0);
        (MilestoneChallenge.Phase phase,, uint8 attempts,,,,,) = free.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.None));
        assertEq(attempts, 1);
    }

    // ---- the money always adds up --------------------------------------------------------------

    function test_what_the_lock_holds_is_exactly_the_bonds_and_deposits_still_owed() public {
        _submit(0); // bond 100
        assertEq(_held(), 100e18);
        _object(BOB, 0); // deposit 10
        assertEq(_held(), 110e18);
        _pass(14 days);
        lock.resolve(0); // upheld: the bond and the deposit leave
        assertEq(_held(), 0);
        vm.prank(DAVE);
        lock.submit(0, EVIDENCE); // the other team member tries again, with a bond of their own
        assertEq(_held(), 100e18);
        _pass(28 days);
        lock.finish(0); // it stands; the bond stays until the clawback period ends
        assertEq(_held(), 100e18);
        _pass(30 days); // the month for a late objection to it
        vm.prank(ALICE);
        lock.submit(1, EVIDENCE); // the next milestone, with its own bond
        assertEq(_held(), 200e18);
        lock.releaseBond(0);
        assertEq(_held(), 100e18);
        _pass(14 days);
        lock.finish(1);
        _pass(30 days);
        lock.releaseBond(1);
        assertEq(_held(), 0);
    }
}
