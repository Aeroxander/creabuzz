// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AllocationVoting} from "../src/AllocationVoting.sol";
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {Moloch} from "../src/majeur/MolochPatched.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MandateCurrency is ERC20 {
    constructor() ERC20("DAO currency", "CASH") {}

    function mint(address owner, uint256 amount) external {
        _mint(owner, amount);
    }
}

contract TreasuryMandateTest is VotingFixture {
    function test_current_opposition_blocks_and_resets_a_bounded_queue_immediately() public {
        vm.prank(address(dao));dao.setQuorumBps(500);
        vm.prank(ALICE);shares.transfer(BOB,40e18);vm.roll(block.number+1);
        bytes memory data=projectData(bytes32("contested"),100e18);
        vm.prank(ALICE);uint256 id=dao.openProposalWithAction(0,address(mandate),0,data,bytes32(0));
        vote(ALICE,id,20e18);vm.warp(vm.getBlockTimestamp()+24 hours);dao.queue(id);
        vm.prank(BOB);dao.castVote(id,0,21e18);
        assertEq(dao.queuedAt(id),0);assertFalse(ledger.qualifies(id));
    }

    TreasuryMandate internal mandate;
    MandateCurrency internal currency;
    bytes32 internal constant CHECK = keccak256("delivery acceptance");

    function setUp() public override {
        super.setUp();
        currency = new MandateCurrency();
        address[] memory reviewers = new address[](3);
        reviewers[0] = ALICE;
        reviewers[1] = CAROL;
        reviewers[2] = BOB;
        TreasuryMandateFactory factory = ledger.mandateFactory();
        currency.mint(address(dao), 1000e18);
        vm.prank(address(dao));
        currency.approve(address(factory), 1000e18);
        vm.prank(address(dao));
        mandate = factory.create(
            address(currency), 1000e18, 300e18, uint64(vm.getBlockTimestamp() + 90 days), reviewers, 2
        );
    }

    function projectData(bytes32 id, uint128 amount) internal view returns (bytes memory) {
        return
            abi.encodeCall(
                TreasuryMandate.approveProject, (id, BOB, amount, uint64(vm.getBlockTimestamp() + 30 days), CHECK)
            );
    }

    function approve(bytes32 project, uint128 amount) internal {
        bytes memory data = projectData(project, amount);
        uint256 id;
        vm.prank(ALICE);
        id = dao.openProposalWithAction(0, address(mandate), 0, data, project);
        vote(ALICE, id, 20e18);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        dao.queue(id);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        dao.executeByVotes(0, address(mandate), 0, data, project);
    }

    function test_only_authentic_approve_project_gets_bounded_rules() public {
        bytes memory data = projectData(bytes32("project"), 300e18);
        assertTrue(ledger.boundedAction(0, address(mandate), 0, data));
        assertFalse(ledger.boundedAction(0, CAROL, 0, data));
        assertFalse(ledger.boundedAction(1, address(mandate), 0, data));
        assertFalse(ledger.boundedAction(0, address(mandate), 1, data));
        assertFalse(ledger.boundedAction(0, address(mandate), 0, abi.encodeCall(TreasuryMandate.returnUnused, ())));
        vm.prank(ALICE);
        uint256 id = dao.openProposalWithAction(0, address(mandate), 0, data, bytes32(0));
        (uint96 votingSupply, uint96 quorum,, uint16 approvalBps, uint64 notice,,, uint64 hold, bool bounded, bool exclusive) =
            dao.proposalVotingRules(id);
        assertEq(votingSupply, 100e18);
        assertEq(quorum, 50e18, "native 50% quorum can raise the bounded lane's 10% quorum");
        assertEq(approvalBps, 5500);
        assertEq(hold, 6 hours);
        assertEq(notice, vm.getBlockTimestamp() + 24 hours);
        assertTrue(bounded);
        assertFalse(exclusive, "approvals inside a funded budget do not compete for the same Shares");
    }

    function test_arbitrary_id_and_foreign_mandate_cannot_claim_bounded_rules() public {
        bytes memory data = projectData(bytes32("arbitrary"), 1e18);
        uint256 id = dao.proposalId(0, address(mandate), 0, data, bytes32(0));
        vote(ALICE, id, 20e18);
        (,,,,,,,, bool bounded,) = dao.proposalVotingRules(id);
        assertFalse(bounded);
        address[] memory reviewers = new address[](1);
        reviewers[0] = ALICE;
        currency.mint(address(this), 1000e18);
        currency.approve(address(ledger.mandateFactory()), 1000e18);
        TreasuryMandate foreign = ledger.mandateFactory()
            .create(address(currency), 1000e18, 300e18, uint64(vm.getBlockTimestamp() + 90 days), reviewers, 1);
        assertFalse(ledger.boundedAction(0, address(foreign), 0, data));
    }

    function test_lifetime_and_project_caps_survive_refunds_and_new_identities() public {
        vm.prank(address(dao));
        mandate.approveProject(bytes32("one"), BOB, 300e18, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
        vm.prank(address(dao));
        mandate.approveProject(bytes32("two"), BOB, 300e18, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
        vm.prank(address(dao));
        mandate.approveProject(bytes32("three"), BOB, 300e18, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        mandate.approveProject(bytes32("four"), BOB, 101e18, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        mandate.approveProject(bytes32("large"), BOB, 301e18, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
        assertEq(mandate.allocated(), 900e18);
        vm.warp(vm.getBlockTimestamp() + 90 days);
        mandate.returnUnused();
        assertEq(currency.balanceOf(address(dao)), 1000e18);
        assertEq(mandate.allocated(), 900e18);
    }

    function test_claim_checks_reservations_recusal_challenge_and_award() public {
        vm.prank(address(dao));
        dao.setQuorumBps(500);
        approve(bytes32("project"), 300e18);
        ClaimStake claims = mandate.claims();
        VerifierSet panel = mandate.verifiers();
        bytes32 claim = bytes32("milestone");
        currency.mint(BOB, 10e18);
        vm.startPrank(BOB);
        currency.approve(address(claims), 10e18);
        claims.submitClaim(claim, 200e18, 10e18, keccak256("delivered"));
        claims.setCheck(claim, CHECK);
        mandate.fundMilestone(bytes32("project"), claim);
        vm.expectPartialRevert(ClaimStake.CheckLocked.selector);
        claims.setCheck(claim, keccak256("easier"));
        vm.expectPartialRevert(VerifierSet.ClaimantCannotAttest.selector);
        panel.attest(claim, true);
        vm.stopPrank();
        vm.prank(ALICE);
        panel.attest(claim, true);
        vm.prank(CAROL);
        panel.attest(claim, true);
        claims.settle(claim);
        vm.prank(BOB);
        vm.expectPartialRevert(ClaimStake.InChallengeWindow.selector);
        claims.payout(claim);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        vm.prank(BOB);
        claims.payout(claim);
        assertEq(currency.balanceOf(BOB), 210e18);
        assertEq(claims.funded(claim), 0);
        bytes memory data = abi.encodeCall(Moloch.awardContribution, (address(mandate), claim, uint96(10e18), true));
        bytes32 nonce = bytes32("award");
        uint256 id = dao.proposalId(0, address(dao), 0, data, nonce);
        vote(ALICE, id, 100e18);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        dao.queue(id);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        dao.executeByVotes(0, address(dao), 0, data, nonce);
        assertEq(shares.balanceOf(BOB), 10e18);
        assertEq(loot.balanceOf(BOB), 90e18);
        assertTrue(mandate.contributionAwarded(claim));
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), claim, 1, true);
    }

    function test_failed_funding_rolls_back_reservation_and_check_lock() public {
        vm.prank(address(dao));
        mandate.approveProject(bytes32("project"), BOB, 300e18, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
        ClaimStake claims = mandate.claims();
        bytes32 claim = bytes32("too-big");
        vm.startPrank(BOB);
        claims.submitClaim(claim, 301e18, 0, keccak256("evidence"));
        claims.setCheck(claim, CHECK);
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        mandate.fundMilestone(bytes32("project"), claim);
        vm.stopPrank();
        assertEq(mandate.claimProject(claim), bytes32(0));
        assertFalse(claims.acceptanceLocked(claim));
        (,, uint128 reserved,,) = mandate.projects(bytes32("project"));
        assertEq(reserved, 0);
    }

    function test_closing_recovers_unreserved_funds_without_new_project_authority() public {
        vm.prank(address(dao));
        mandate.approveProject(bytes32("project"), BOB, 300e18, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
        vm.prank(address(dao));
        mandate.close();
        assertTrue(mandate.closed());
        assertEq(currency.balanceOf(address(dao)), 1000e18);
        assertEq(mandate.allocated(), 300e18);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        mandate.approveProject(bytes32("replacement"), BOB, 1, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
        currency.mint(address(mandate), 10e18);
        mandate.returnUnused();
        assertEq(currency.balanceOf(address(dao)), 1010e18);
    }

    function test_deployment_sizes_fit_real_evm_limits() public {
        assertLe(address(mandate).code.length, 24576);
        assertLe(address(mandate.claims()).code.length, 24576);
        AllocationVoting implementation = new AllocationVoting(ledger.mandateFactory());
        assertLe(address(implementation).code.length, 24576);
        assertLe(address(ledger.mandateFactory()).code.length, 24576);
        assertLe(type(TreasuryMandateFactory).creationCode.length, 49152);
        assertLe(type(TreasuryMandate).creationCode.length + 32 * 8 + 32 * 32, 49152);
        assertLe(type(AllocationVoting).creationCode.length + 32, 49152);
    }
}
