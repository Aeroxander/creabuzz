// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {Moloch} from "../src/majeur/MolochPatched.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {VerifierSet} from "../src/VerifierSet.sol";

/// @notice Projects that never raise: contributors earn Shares for verified work, out of a share budget the broad
/// vote capped, with no currency anywhere in the mandate.
contract EquityMandateTest is VotingFixture {
    address internal constant DAVE = address(0xDA7E);
    bytes32 internal constant CHECK = keccak256("work accepted");
    bytes32 internal constant PROJECT = bytes32("docs");

    TreasuryMandate internal mandate;
    MandateCurrency internal currency;
    TreasuryMandateFactory internal factory;

    function setUp() public override {
        super.setUp();
        vm.prank(address(dao));
        dao.setQuorumBps(500);
        currency = new MandateCurrency();
        factory = ledger.mandateFactory();
        mandate = _create(0, 0, 60e18, 25e18);
    }

    function _reviewers() internal pure returns (address[] memory reviewers) {
        reviewers = new address[](3);
        reviewers[0] = ALICE;
        reviewers[1] = CAROL;
        reviewers[2] = BOB;
    }

    function _create(uint128 budget, uint128 cap, uint128 shareBudget, uint128 shareCap)
        internal
        returns (TreasuryMandate made)
    {
        vm.prank(address(dao));
        made = factory.create(
            address(currency),
            budget,
            cap,
            shareBudget,
            shareCap,
            uint64(vm.getBlockTimestamp() + 90 days),
            _reviewers(),
            2
        );
    }

    /// A bounded-lane vote: opened, backed by the lone holder, reviewed, queued, executed.
    function _boundedVote(address to, bytes memory data, bytes32 nonce) internal {
        vm.prank(ALICE);
        uint256 id = dao.openProposalWithAction(0, to, 0, data, nonce);
        (,,,,,,,, bool bounded,) = dao.proposalVotingRules(id);
        assertTrue(bounded, "this action is eligible for the bounded lane");
        vote(ALICE, id, 20e18);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        dao.queue(id);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        dao.executeByVotes(0, to, 0, data, nonce);
    }

    function _approveProject(bytes32 id, uint128 shareAmount) internal {
        _boundedVote(
            address(mandate),
            abi.encodeCall(
                TreasuryMandate.approveProject,
                (id, BOB, 0, shareAmount, uint64(vm.getBlockTimestamp() + 30 days), CHECK)
            ),
            id
        );
    }

    /// DAVE files a claim asking for recognition, not payment; the manager binds it; two reviewers approve it.
    function _deliver(bytes32 claim, bytes32 projectId) internal {
        ClaimStake claims = mandate.claims();
        VerifierSet panel = mandate.verifiers();
        vm.startPrank(DAVE);
        claims.submitClaim(claim, 0, 0, keccak256(abi.encode(claim)));
        claims.setCheck(claim, CHECK);
        vm.stopPrank();
        vm.prank(BOB);
        mandate.fundMilestone(projectId, claim);
        vm.prank(ALICE);
        panel.attest(claim, true);
        vm.prank(CAROL);
        panel.attest(claim, true);
        claims.settle(claim);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        vm.prank(DAVE);
        claims.payout(claim);
    }

    function _award(bytes32 claim, uint96 amount, bytes32 nonce) internal {
        _boundedVote(
            address(dao), abi.encodeCall(Moloch.awardContribution, (address(mandate), claim, amount, false)), nonce
        );
    }

    // ---- the mandate itself ------------------------------------------------------------------

    function test_a_mandate_needs_a_budget_of_something_and_each_budget_a_cap() public {
        address[] memory reviewers = _reviewers();
        uint64 expires = uint64(vm.getBlockTimestamp() + 90 days);
        // Neither budget.
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidMandate.selector);
        factory.create(address(currency), 0, 0, 0, 0, expires, reviewers, 2);
        // A cash budget with no cap, and the reverse.
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidMandate.selector);
        factory.create(address(currency), 100e18, 0, 10e18, 5e18, expires, reviewers, 2);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidMandate.selector);
        factory.create(address(currency), 0, 5e18, 10e18, 5e18, expires, reviewers, 2);
        // A share budget with no cap, a cap above its budget.
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidMandate.selector);
        factory.create(address(currency), 0, 0, 10e18, 0, expires, reviewers, 2);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidMandate.selector);
        factory.create(address(currency), 0, 0, 10e18, 11e18, expires, reviewers, 2);
    }

    function test_a_shares_only_mandate_moves_no_money_and_is_still_the_daos() public view {
        assertEq(mandate.budget(), 0);
        assertEq(mandate.shareBudget(), 60e18);
        assertEq(mandate.perProjectShareCap(), 25e18);
        assertEq(factory.daos(address(mandate)), address(dao));
        assertEq(currency.balanceOf(address(mandate)), 0);
    }

    function test_project_share_budgets_obey_the_caps_and_the_lifetime_total() public {
        vm.startPrank(address(dao));
        uint64 expires = uint64(vm.getBlockTimestamp() + 30 days);
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        mandate.approveProject(bytes32("empty"), BOB, 0, 0, expires, CHECK);
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        mandate.approveProject(bytes32("large"), BOB, 0, 26e18, expires, CHECK);
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        mandate.approveProject(bytes32("cash"), BOB, 1, 5e18, expires, CHECK); // no cash budget to draw on
        mandate.approveProject(bytes32("one"), BOB, 0, 25e18, expires, CHECK);
        mandate.approveProject(bytes32("two"), BOB, 0, 25e18, expires, CHECK);
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        mandate.approveProject(bytes32("three"), BOB, 0, 11e18, expires, CHECK);
        mandate.approveProject(bytes32("three"), BOB, 0, 10e18, expires, CHECK);
        vm.stopPrank();
        assertEq(mandate.sharesAllocated(), 60e18);
    }

    // ---- work recognised in Shares -------------------------------------------------------------

    function test_work_with_no_money_in_it_earns_shares_through_the_bounded_lane() public {
        _approveProject(PROJECT, 20e18);
        bytes32 claim = bytes32("write the docs");
        _deliver(claim, PROJECT);
        assertEq(currency.balanceOf(DAVE), 0, "a claim that asked for nothing was paid nothing");
        assertEq(currency.balanceOf(address(mandate.claims())), 0, "and nothing sits in escrow");

        uint256 supplyBefore = shares.totalSupply();
        _award(claim, 15e18, bytes32("recognise dave"));
        assertEq(shares.balanceOf(DAVE), 15e18);
        assertEq(shares.totalSupply(), supplyBefore + 15e18);
        assertTrue(mandate.contributionAwarded(claim));
        (,,,,, uint128 budget, uint128 awarded) = mandate.projects(PROJECT);
        assertEq(budget, 20e18);
        assertEq(awarded, 15e18);

        // The same delivery cannot be awarded twice, with or without a vote.
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), claim, 1, false);
    }

    function test_an_award_cannot_outrun_its_projects_share_budget() public {
        _approveProject(PROJECT, 20e18);
        bytes32 first = bytes32("first");
        bytes32 second = bytes32("second");
        _deliver(first, PROJECT);
        _deliver(second, PROJECT);
        _award(first, 15e18, bytes32("one"));
        // 5 of the project's 20 remain: 6 is refused when the DAO executes it, however the vote went.
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        dao.awardContribution(address(mandate), second, 6e18, false);
        vm.prank(address(dao));
        vm.expectRevert(Moloch.NotOk.selector); // an award of nothing is refused before the mandate is asked
        dao.awardContribution(address(mandate), second, 0, false);
        _award(second, 5e18, bytes32("two"));
        assertEq(shares.balanceOf(DAVE), 20e18);
    }

    function test_a_claim_that_is_unbound_unpaid_or_in_a_project_without_shares_earns_nothing() public {
        ClaimStake claims = mandate.claims();
        // Never bound to a project.
        vm.prank(DAVE);
        claims.submitClaim(bytes32("loose"), 0, 0, keccak256("loose"));
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), bytes32("loose"), 1e18, false);

        // Bound, but still waiting on its reviewers.
        _approveProject(PROJECT, 20e18);
        vm.startPrank(DAVE);
        claims.submitClaim(bytes32("waiting"), 0, 0, keccak256("waiting"));
        claims.setCheck(bytes32("waiting"), CHECK);
        vm.stopPrank();
        vm.prank(BOB);
        mandate.fundMilestone(PROJECT, bytes32("waiting"));
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), bytes32("waiting"), 1e18, false);

        // A project the DAO approved for cash only has no Shares to award.
        TreasuryMandate mixed = _create(0, 0, 60e18, 25e18);
        vm.prank(address(dao));
        mixed.approveProject(bytes32("cash only"), BOB, 0, 1, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mixed), bytes32("waiting"), 1e18, false);
    }

    function test_closing_the_mandate_stops_awards_from_its_allowances() public {
        _approveProject(PROJECT, 20e18);
        bytes32 claim = bytes32("late");
        _deliver(claim, PROJECT);
        vm.prank(address(dao));
        mandate.close();
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), claim, 1e18, false);
        assertEq(shares.balanceOf(DAVE), 0);
    }

    // ---- which actions get the bounded lane --------------------------------------------------

    function test_only_a_well_formed_award_inside_this_daos_mandate_gets_the_bounded_lane() public {
        bytes memory award =
            abi.encodeCall(Moloch.awardContribution, (address(mandate), bytes32("c"), uint96(1), false));
        assertTrue(ledger.boundedAction(0, address(dao), 0, award));
        assertTrue(
            ledger.boundedAction(
                0,
                address(dao),
                0,
                abi.encodeCall(Moloch.awardContribution, (address(mandate), bytes32("c"), uint96(1), true))
            ),
            "turning Loot into Shares is covered by the same budget"
        );
        // Not aimed at the DAO itself, a value transfer, or a call-type other than a plain call.
        assertFalse(ledger.boundedAction(0, address(mandate), 0, award));
        assertFalse(ledger.boundedAction(0, address(dao), 1, award));
        assertFalse(ledger.boundedAction(1, address(dao), 0, award));
        // A mandate this DAO did not create (any contract can create one for itself; here, this test).
        TreasuryMandate foreign = factory.create(
            address(currency), 0, 0, 10e18, 5e18, uint64(vm.getBlockTimestamp() + 90 days), _reviewers(), 2
        );
        assertFalse(
            ledger.boundedAction(
                0,
                address(dao),
                0,
                abi.encodeCall(Moloch.awardContribution, (address(foreign), bytes32("c"), uint96(1), false))
            )
        );
        // Padding, truncation and an address with stray high bits are all refused.
        assertFalse(ledger.boundedAction(0, address(dao), 0, bytes.concat(award, bytes1(0))));
        bytes memory short = new bytes(award.length - 1);
        for (uint256 i; i < short.length; ++i) {
            short[i] = award[i];
        }
        assertFalse(ledger.boundedAction(0, address(dao), 0, short));
        bytes memory dirty = award;
        dirty[4] = 0x01;
        assertFalse(ledger.boundedAction(0, address(dao), 0, dirty));
        // An unrelated DAO call keeps the unrestricted lane.
        assertFalse(ledger.boundedAction(0, address(dao), 0, abi.encodeCall(Moloch.setQuorumBps, (uint16(1000)))));
    }
}
