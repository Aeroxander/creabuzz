// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {MilestoneLock} from "../src/MilestoneLock.sol";
import {MilestoneBadge} from "../src/MilestoneBadge.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {Shares} from "../src/majeur/MolochPatched.sol";

/// @notice The founders hold their Shares and vote with them from the start, but the part a milestone covers cannot
/// be sold or ragequit until reviewers have judged that milestone and it has been unlocked.
contract MilestoneLockTest is VotingFixture {
    address internal constant DAVE = address(0xDA7E);
    address internal constant ERIN = address(0xE41);
    bytes32 internal constant CHECK_ONE = keccak256("alpha shipped");
    bytes32 internal constant CHECK_TWO = keccak256("first customers");
    bytes32 internal constant PROJECT = bytes32("founders");

    MilestoneLock internal lock;
    MilestoneBadge internal badge;
    TreasuryMandate internal mandate;
    MandateCurrency internal currency;

    function _checks() internal pure returns (bytes32[] memory checks) {
        checks = new bytes32[](2);
        checks[0] = CHECK_ONE;
        checks[1] = CHECK_TWO;
    }

    function _bps() internal pure returns (uint16[] memory bps) {
        bps = new uint16[](2);
        bps[0] = 3000; // 30% unlocked by the first milestone
        bps[1] = 5000; // 50% by the second; the last 20% was never locked
    }

    function setUp() public override {
        super.setUp();
        address[] memory who = new address[](1);
        who[0] = ALICE;
        uint256[] memory totals = new uint256[](1);
        totals[0] = 100e18;
        lock = new MilestoneLock(address(dao), who, totals, _checks(), _bps());
        badge = lock.badge();
        vm.prank(address(dao));
        shares.setLockGuard(address(lock));
        vm.prank(address(dao));
        dao.setQuorumBps(500);

        // A mandate for the founders' milestones: no money, a token share allowance, three reviewers, two must agree.
        currency = new MandateCurrency();
        address[] memory reviewers = new address[](3);
        reviewers[0] = CAROL;
        reviewers[1] = DAVE;
        reviewers[2] = ERIN;
        TreasuryMandateFactory factory = ledger.mandateFactory();
        vm.startPrank(address(dao));
        mandate =
            factory.create(address(currency), 0, 0, 10, 10, uint64(vm.getBlockTimestamp() + 365 days), reviewers, 2, 0, address(0));
        mandate.approveProject(PROJECT, BOB, 0, 2, uint64(vm.getBlockTimestamp() + 300 days), CHECK_ONE);
        mandate.approveProject(bytes32("founders-2"), BOB, 0, 2, uint64(vm.getBlockTimestamp() + 300 days), CHECK_TWO);
        vm.stopPrank();
    }

    /// Alice files the claim, the manager binds it, two reviewers approve it, the window passes, she takes it.
    function _earn(bytes32 claim, bytes32 project, bytes32 check) internal {
        _earnIn(mandate, claim, project, check);
    }

    function _earnIn(TreasuryMandate where, bytes32 claim, bytes32 project, bytes32 check) internal {
        ClaimStake claims = where.claims();
        VerifierSet panel = where.verifiers();
        vm.startPrank(ALICE);
        claims.submitClaim(claim, 0, 0, keccak256(abi.encode(claim)));
        claims.setCheck(claim, check);
        vm.stopPrank();
        vm.prank(BOB);
        where.fundMilestone(project, claim, ALICE);
        vm.prank(CAROL);
        panel.attest(claim, true);
        vm.prank(DAVE);
        panel.attest(claim, true);
        claims.settle(claim);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        vm.prank(ALICE);
        claims.payout(claim);
    }

    // ---- the schedule --------------------------------------------------------------------------

    function test_a_bad_schedule_never_deploys() public {
        address[] memory who = new address[](1);
        who[0] = DAVE;
        uint256[] memory totals = new uint256[](1);
        totals[0] = 100e18;
        bytes32[] memory checks = _checks();
        uint16[] memory bps = _bps();
        vm.expectRevert(MilestoneLock.BadSchedule.selector);
        new MilestoneLock(address(0), who, totals, checks, bps);
        vm.expectRevert(MilestoneLock.BadSchedule.selector);
        new MilestoneLock(address(dao), who, totals, new bytes32[](0), new uint16[](0));
        uint16[] memory over = new uint16[](2);
        over[0] = 6000;
        over[1] = 4001;
        vm.expectRevert(MilestoneLock.BadSchedule.selector);
        new MilestoneLock(address(dao), who, totals, checks, over);
        uint16[] memory zero = new uint16[](2);
        zero[1] = 1000;
        vm.expectRevert(MilestoneLock.BadSchedule.selector);
        new MilestoneLock(address(dao), who, totals, checks, zero);
        bytes32[] memory twice = new bytes32[](2);
        twice[0] = CHECK_ONE;
        twice[1] = CHECK_ONE;
        vm.expectRevert(MilestoneLock.BadSchedule.selector);
        new MilestoneLock(address(dao), who, totals, twice, bps);
        bytes32[] memory blank = new bytes32[](2);
        blank[0] = CHECK_ONE;
        vm.expectRevert(MilestoneLock.BadSchedule.selector);
        new MilestoneLock(address(dao), who, totals, blank, bps);
        // The same wallet twice, a zero wallet, a share too small to cover a tranche, too many milestones.
        address[] memory dup = new address[](2);
        dup[0] = DAVE;
        dup[1] = DAVE;
        uint256[] memory two = new uint256[](2);
        two[0] = 100e18;
        two[1] = 100e18;
        vm.expectRevert(MilestoneLock.BadSchedule.selector);
        new MilestoneLock(address(dao), dup, two, checks, bps);
        who[0] = address(0);
        vm.expectRevert(MilestoneLock.BadSchedule.selector);
        new MilestoneLock(address(dao), who, totals, checks, bps);
        who[0] = DAVE;
        totals[0] = 1; // 30% of one wei is nothing
        vm.expectRevert(MilestoneLock.BadSchedule.selector);
        new MilestoneLock(address(dao), who, totals, checks, bps);
        totals[0] = 100e18;
        bytes32[] memory nine = new bytes32[](9);
        uint16[] memory ninth = new uint16[](9);
        for (uint256 i; i < 9; ++i) {
            nine[i] = bytes32(uint256(i + 1));
            ninth[i] = 100;
        }
        vm.expectRevert(MilestoneLock.BadSchedule.selector);
        new MilestoneLock(address(dao), who, totals, nine, ninth);
    }

    function test_80_of_the_allocation_is_locked_and_the_rest_was_never_locked() public view {
        assertEq(lock.lockedOf(ALICE), 80e18);
        assertEq(lock.lockedOf(CAROL), 0, "nobody else is held");
        assertEq(lock.trancheCount(ALICE), 2);
        assertEq(lock.trancheOf(ALICE, 0).amount, 30e18);
        assertEq(lock.trancheOf(ALICE, 1).amount, 50e18);
    }

    function test_locked_founders_vote_with_everything_but_sell_and_ragequit_only_the_free_part() public {
        // 20 are free.
        vm.prank(ALICE);
        shares.transfer(ERIN, 20e18);
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        shares.transfer(ERIN, 1);
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        dao.ragequit(tokens, 1, 0);
        // The 80 that are left still vote.
        assertEq(shares.getVotes(ALICE), 80e18);
        assertEq(ledger.capacity(ALICE), 80e18);
    }

    // ---- reaching a milestone ---------------------------------------------------------------------

    function test_a_reviewed_milestone_unlocks_its_tranche_and_mints_a_badge() public {
        _earn(bytes32("alpha"), PROJECT, CHECK_ONE);
        vm.prank(ERIN); // anyone may finish it
        lock.unlock(ALICE, 0, address(mandate), bytes32("alpha"));
        assertEq(lock.lockedOf(ALICE), 50e18, "30 are free now");
        assertTrue(lock.trancheOf(ALICE, 0).unlocked);
        assertEq(badge.balanceOf(ALICE), 1);
        assertEq(badge.ownerOf(1), ALICE);
        vm.prank(ALICE);
        shares.transfer(ERIN, 50e18); // 20 never locked + 30 earned
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        shares.transfer(ERIN, 1);

        _earn(bytes32("customers"), bytes32("founders-2"), CHECK_TWO);
        lock.unlock(ALICE, 1, address(mandate), bytes32("customers"));
        assertEq(lock.lockedOf(ALICE), 0);
        assertEq(badge.balanceOf(ALICE), 2);
        // Everything is free, ragequit included.
        vm.deal(address(dao), 10 ether);
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.prank(ALICE);
        dao.ragequit(tokens, 50e18, 0);
        assertEq(shares.balanceOf(ALICE), 0);
    }

    function test_a_tranche_unlocks_once_and_only_for_a_claim_that_earned_it() public {
        _earn(bytes32("alpha"), PROJECT, CHECK_ONE);
        // A claim for the other milestone's check cannot open this one: wrong check.
        vm.expectRevert(MilestoneLock.ClaimNotEligible.selector);
        lock.unlock(ALICE, 1, address(mandate), bytes32("alpha"));
        lock.unlock(ALICE, 0, address(mandate), bytes32("alpha"));
        vm.expectRevert(MilestoneLock.AlreadyResolved.selector);
        lock.unlock(ALICE, 0, address(mandate), bytes32("alpha"));
        vm.expectRevert(MilestoneLock.UnknownTranche.selector);
        lock.unlock(ALICE, 2, address(mandate), bytes32("alpha"));
    }

    function test_someone_elses_claim_an_unpaid_claim_or_an_unbound_claim_unlocks_nothing() public {
        ClaimStake claims = mandate.claims();
        VerifierSet panel = mandate.verifiers();
        // Alice's claim, bound and approved but not yet past the challenge window.
        vm.startPrank(ALICE);
        claims.submitClaim(bytes32("early"), 0, 0, keccak256("early"));
        claims.setCheck(bytes32("early"), CHECK_ONE);
        vm.stopPrank();
        vm.prank(BOB);
        mandate.fundMilestone(PROJECT, bytes32("early"), ALICE);
        vm.prank(CAROL);
        panel.attest(bytes32("early"), true);
        vm.prank(DAVE);
        panel.attest(bytes32("early"), true);
        claims.settle(bytes32("early"));
        vm.expectRevert(MilestoneLock.ClaimNotEligible.selector);
        lock.unlock(ALICE, 0, address(mandate), bytes32("early")); // approved, not paid

        // A claim nobody filed.
        vm.expectRevert(MilestoneLock.ClaimNotEligible.selector);
        lock.unlock(ALICE, 0, address(mandate), bytes32("ghost"));

        // A claim that is filed with the right check but never bound to a project.
        vm.startPrank(ALICE);
        claims.submitClaim(bytes32("loose"), 0, 0, keccak256("loose"));
        claims.setCheck(bytes32("loose"), CHECK_TWO);
        vm.stopPrank();
        vm.expectRevert(MilestoneLock.ClaimNotEligible.selector);
        lock.unlock(ALICE, 1, address(mandate), bytes32("loose"));
    }

    function test_a_mandate_the_dao_did_not_create_cannot_unlock_anything() public {
        // Anyone can create a mandate for themselves with reviewers who say yes. It is not this DAO's.
        address[] memory reviewers = new address[](1);
        reviewers[0] = address(this);
        TreasuryMandate foreign = ledger.mandateFactory()
            .create(address(currency), 0, 0, 10, 10, uint64(vm.getBlockTimestamp() + 90 days), reviewers, 1, 0, address(0));
        foreign.approveProject(PROJECT, address(this), 0, 2, uint64(vm.getBlockTimestamp() + 30 days), CHECK_ONE);
        // (This test contract is the foreign mandate's DAO, so it can approve its own project and claims.)
        ClaimStake claims = foreign.claims();
        vm.prank(ALICE);
        claims.submitClaim(bytes32("fake"), 0, 0, keccak256("fake"));
        vm.prank(ALICE);
        claims.setCheck(bytes32("fake"), CHECK_ONE);
        foreign.fundMilestone(PROJECT, bytes32("fake"), ALICE);
        foreign.verifiers().attest(bytes32("fake"), true);
        claims.settle(bytes32("fake"));
        vm.warp(vm.getBlockTimestamp() + 3 days);
        vm.prank(ALICE);
        claims.payout(bytes32("fake"));
        vm.expectRevert(MilestoneLock.NotThisDaosMandate.selector);
        lock.unlock(ALICE, 0, address(foreign), bytes32("fake"));
        assertEq(lock.lockedOf(ALICE), 80e18, "nothing moved");
    }

    // ---- the DAO's escape -----------------------------------------------------------------------

    function test_the_dao_can_forfeit_what_a_founder_never_earned_and_it_is_burned_not_freed() public {
        _earn(bytes32("alpha"), PROJECT, CHECK_ONE);
        lock.unlock(ALICE, 0, address(mandate), bytes32("alpha"));
        vm.prank(ALICE);
        vm.expectRevert(MilestoneLock.OnlyDao.selector);
        lock.forfeit(ALICE);

        // Before the forfeit, even a governance burn of the locked part is refused.
        vm.prank(address(dao));
        vm.expectRevert(Shares.LockedShares.selector);
        shares.burnFromMoloch(ALICE, 51e18);
        // And nobody but the lock can burn through the forfeit path.
        vm.prank(address(dao));
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        shares.burnForfeited(ALICE, 50e18);

        uint256 supply = shares.totalSupply();
        vm.prank(address(dao));
        assertEq(lock.forfeit(ALICE), 50e18, "the unearned second tranche");
        // Burned on the spot: the supply fell by exactly that, and she never held it free.
        assertEq(shares.totalSupply(), supply - 50e18);
        assertEq(shares.balanceOf(ALICE), 50e18);
        assertEq(lock.lockedOf(ALICE), 0);
        // What was earned stays earned, and a forfeited tranche cannot be unlocked afterwards.
        assertEq(badge.balanceOf(ALICE), 1);
        vm.expectRevert(MilestoneLock.AlreadyResolved.selector);
        lock.unlock(ALICE, 1, address(mandate), bytes32("alpha"));
        // A second forfeit has nothing left to take.
        vm.prank(address(dao));
        assertEq(lock.forfeit(ALICE), 0);
        assertEq(shares.totalSupply(), supply - 50e18);
    }

    // ---- the panel named at launch ----------------------------------------------------------------

    function test_a_dao_that_named_its_milestone_panel_unlocks_through_that_panel_only() public {
        TreasuryMandateFactory factory = ledger.mandateFactory();
        address[] memory panelists = new address[](3);
        panelists[0] = CAROL;
        panelists[1] = DAVE;
        panelists[2] = ERIN;
        uint64 ends = uint64(vm.getBlockTimestamp() + 730 days);
        vm.prank(address(dao));
        TreasuryMandate named = factory.createMilestonePanel(address(currency), ends, panelists, 2, 0, address(0));
        assertEq(factory.milestoneMandate(address(dao)), address(named));
        assertEq(factory.daos(address(named)), address(dao), "it is the DAO's, like any mandate it made");
        assertEq(named.budget(), 0, "it moves no money");
        // Named once: a later vote cannot name another.
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandateFactory.PanelAlreadyNamed.selector);
        factory.createMilestonePanel(address(currency), ends, panelists, 1, 0, address(0));

        // The friendly mandate the DAO made in setUp (any reviewers it likes) earned a paid claim, and it no longer counts.
        _earn(bytes32("alpha"), PROJECT, CHECK_ONE);
        vm.expectRevert(MilestoneLock.NotThisDaosMandate.selector);
        lock.unlock(ALICE, 0, address(mandate), bytes32("alpha"));
        assertEq(lock.lockedOf(ALICE), 80e18, "nothing moved");

        // The named panel's mandate does, once the DAO approves a project in it (a milestone project holds nothing).
        vm.prank(address(dao));
        named.approveProject(bytes32("milestone-1"), BOB, 0, 0, uint64(vm.getBlockTimestamp() + 300 days), CHECK_ONE);
        _earnIn(named, bytes32("beta"), bytes32("milestone-1"), CHECK_ONE);
        lock.unlock(ALICE, 0, address(named), bytes32("beta"));
        assertEq(lock.lockedOf(ALICE), 50e18);
    }

    function test_the_milestone_panel_holds_nothing_and_its_projects_can_neither_hold_nor_award() public {
        TreasuryMandateFactory factory = ledger.mandateFactory();
        address[] memory panelists = new address[](3);
        panelists[0] = CAROL;
        panelists[1] = DAVE;
        panelists[2] = ERIN;
        uint64 ends = uint64(vm.getBlockTimestamp() + 730 days);
        vm.prank(address(dao));
        TreasuryMandate named = factory.createMilestonePanel(address(currency), ends, panelists, 2, 0, address(0));
        assertTrue(named.milestonePanel());
        assertFalse(mandate.milestonePanel(), "an ordinary mandate is not the panel");
        assertEq(named.budget(), 0);
        assertEq(named.shareBudget(), 0);

        // A project in it holds nothing, and cannot be given anything.
        uint64 until = uint64(vm.getBlockTimestamp() + 300 days);
        vm.startPrank(address(dao));
        named.approveProject(bytes32("empty"), BOB, 0, 0, until, CHECK_ONE);
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        named.approveProject(bytes32("money"), BOB, 1, 0, until, CHECK_ONE);
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        named.approveProject(bytes32("shares"), BOB, 0, 1, until, CHECK_TWO);
        vm.stopPrank();

        // A claim for the milestone is bound without reserving anything; one that asks for money cannot be.
        ClaimStake claims = named.claims();
        vm.startPrank(ALICE);
        claims.submitClaim(bytes32("asks"), 5, 0, keccak256("e"));
        claims.setCheck(bytes32("asks"), CHECK_ONE);
        vm.stopPrank();
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        named.fundMilestone(bytes32("empty"), bytes32("asks"), ALICE);

        // Nothing can be awarded out of it, whatever the claim.
        _earnIn(named, bytes32("beta"), bytes32("empty"), CHECK_ONE);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        named.consumeContribution(bytes32("beta"), 1);
    }

    // The ordinary mandate still needs something to spend: the tests in TreasuryMandate.t.sol and EquityMandate.t.sol refuse
    // one with neither budget.

    function test_a_dao_that_named_no_panel_keeps_the_older_rule() public {
        // The factory records no panel for this DAO, so any mandate the DAO made still unlocks (the tests above).
        assertEq(ledger.mandateFactory().milestoneMandate(address(dao)), address(0));
        _earn(bytes32("alpha"), PROJECT, CHECK_ONE);
        lock.unlock(ALICE, 0, address(mandate), bytes32("alpha"));
        assertEq(lock.lockedOf(ALICE), 50e18);
    }

    // ---- the badge -----------------------------------------------------------------------------

    function test_the_badge_is_a_soulbound_receipt() public {
        _earn(bytes32("alpha"), PROJECT, CHECK_ONE);
        lock.unlock(ALICE, 0, address(mandate), bytes32("alpha"));
        assertEq(badge.minter(), address(lock));
        assertTrue(badge.locked(1));
        assertTrue(badge.supportsInterface(0x80ac58cd), "ERC-721");
        assertTrue(badge.supportsInterface(0x5b5e139f), "metadata");
        assertTrue(badge.supportsInterface(0xb45a3c0e), "ERC-5192");
        assertFalse(badge.supportsInterface(0xdeadbeef));
        vm.startPrank(ALICE);
        vm.expectRevert(MilestoneBadge.Soulbound.selector);
        badge.transferFrom(ALICE, ERIN, 1);
        vm.expectRevert(MilestoneBadge.Soulbound.selector);
        badge.safeTransferFrom(ALICE, ERIN, 1);
        vm.expectRevert(MilestoneBadge.Soulbound.selector);
        badge.approve(ERIN, 1);
        vm.expectRevert(MilestoneBadge.Soulbound.selector);
        badge.setApprovalForAll(ERIN, true);
        vm.stopPrank();
        vm.expectRevert(MilestoneBadge.NotMinter.selector);
        badge.mint(ERIN, CHECK_ONE, 0, 1);
        vm.expectRevert(MilestoneBadge.NoSuchBadge.selector);
        badge.ownerOf(2);
        string memory uri = badge.tokenURI(1);
        assertEq(bytes(uri).length > 40, true);
        assertEq(_prefix(uri, 29), "data:application/json;base64,");
    }

    function _prefix(string memory s, uint256 n) internal pure returns (string memory out) {
        bytes memory b = bytes(s);
        bytes memory o = new bytes(n);
        for (uint256 i; i < n; ++i) {
            o[i] = b[i];
        }
        out = string(o);
    }

    function test_the_lock_fits_beside_the_badge_in_one_deployment() public view {
        assertLe(address(lock).code.length, 24_576);
        assertLe(type(MilestoneLock).creationCode.length, 49_152);
    }
}
