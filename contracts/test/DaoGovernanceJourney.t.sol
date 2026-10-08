// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {Call, Moloch, Summoner, newSummoner} from "../src/majeur/MolochPatched.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice A DAO lifecycle on Foundry's local EVM. Time and initial capital are
/// simulated; every subsequent authority check and transfer uses real contracts.
contract DaoGovernanceJourneyTest is Test {
    address internal constant FOUNDER = address(0xF0);
    address internal constant TEAM = address(0xF1);
    address internal constant MEMBER = address(0xF2);
    address internal constant COALITION = address(0xF3);
    address internal constant INVESTOR = address(0xF4);
    bytes32 internal constant CHECK = keccak256("published acceptance criteria");
    Moloch internal dao;
    MandateCurrency internal cash;
    AllocationVoting internal policy;
    TreasuryMandate internal mandate;

    function ballot(address owner, uint256 id, uint256 shares_) internal {
        vm.prank(owner);
        dao.castVote(id, 1, shares_);
    }

    function oppose(address owner, uint256 id, uint256 shares_) internal {
        vm.prank(owner);
        dao.castVote(id, 0, shares_);
    }

    function majority(uint256 id) internal {
        ballot(FOUNDER, id, 400e18);
        ballot(TEAM, id, 200e18);
        ballot(MEMBER, id, 100e18);
    }

    function execute(address to, bytes memory data, bytes32 nonce, uint256 review) internal returns (uint256 id) {
        id = dao.proposalId(0, to, 0, data, nonce);
        majority(id);
        vm.warp(vm.getBlockTimestamp() + review);
        dao.queue(id);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        dao.executeByVotes(0, to, 0, data, nonce);
        vm.roll(block.number + 1);
    }

    function project(bytes32 name, address manager, uint128 amount, address voter, uint256 backing) internal {
        bytes memory data = abi.encodeCall(
            TreasuryMandate.approveProject,
            (name, manager, amount, uint128(20e18), uint64(vm.getBlockTimestamp() + 30 days), CHECK)
        );
        vm.prank(voter);
        uint256 id = dao.openProposalWithAction(0, address(mandate), 0, data, name);
        ballot(voter, id, backing);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        dao.queue(id);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        dao.executeByVotes(0, address(mandate), 0, data, name);
        vm.roll(block.number + 1);
    }

    function submit(address contributor, bytes32 id, uint256 amount, uint256 stake, bytes32 projectId) internal {
        ClaimStake claims = mandate.claims();
        cash.mint(contributor, stake);
        vm.startPrank(contributor);
        cash.approve(address(claims), stake);
        claims.submitClaim(id, amount, stake, keccak256(abi.encode(id, contributor)));
        claims.setCheck(id, CHECK);
        vm.stopPrank();
        (address manager,,,,,,) = mandate.projects(projectId);
        vm.prank(manager);
        mandate.fundMilestone(projectId, id, contributor);
    }

    function test_simulated_dao_invests_prioritizes_delivers_rejects_self_payment_and_exits() public {
        vm.warp(1 days);
        uint256 started = vm.getBlockTimestamp();
        Summoner summoner = newSummoner();
        address[] memory owners = new address[](4);
        owners[0] = FOUNDER;
        owners[1] = TEAM;
        owners[2] = MEMBER;
        owners[3] = COALITION;
        uint256[] memory amounts = new uint256[](4);
        amounts[0] = 400e18;
        amounts[1] = 200e18;
        amounts[2] = 100e18;
        amounts[3] = 300e18;
        dao = summoner.summon(
            "Working DAO", "WORK", "", 500, true, address(0), bytes32(0), owners, amounts, new Call[](0)
        );
        // Bootstrap configuration only. All issuance, mandates, projects and awards below go through ballots.
        vm.prank(address(dao));
        dao.setProposalThreshold(10e18);
        vm.prank(address(dao));
        dao.setProposalTTL(14 days);
        vm.prank(address(dao));
        dao.setTimelockDelay(1 days);
        vm.roll(block.number + 1);
        policy = AllocationVoting(dao.votingWeight());
        cash = new MandateCurrency();
        cash.mint(address(dao), 100000e18);
        execute(
            address(dao),
            abi.encodeCall(Moloch.setSale, (address(cash), uint256(10), uint256(100e18), true, true, true)),
            bytes32("investment"),
            48 hours
        );
        cash.mint(INVESTOR, 1000e18);
        vm.startPrank(INVESTOR);
        cash.approve(address(dao), 1000e18);
        dao.buyShares(address(cash), 100e18, 1000e18);
        vm.stopPrank();
        vm.roll(block.number + 1);
        assertEq(cash.balanceOf(address(dao)), 101000e18);
        assertEq(dao.loot().balanceOf(INVESTOR), 100e18);
        assertEq(policy.capacity(INVESTOR), 0, "Loot investment has economics, no implicit votes");

        // A 30% coalition proposes to withdraw almost the whole treasury. Unopposed it would clear the 20% quorum
        // with 100% approval: a low bar is what makes opposition necessary, and opposition is free.
        bytes memory drain = abi.encodeCall(IERC20.transfer, (COALITION, uint256(90000e18)));
        uint256 drainId = dao.proposalId(0, address(cash), 0, drain, bytes32("drain"));
        ballot(COALITION, drainId, 300e18);
        assertTrue(policy.thresholdsMet(drainId), "an unopposed 30% holder meets the bars; only opposition stops it");
        TreasuryMandateFactory factory = policy.mandateFactory();
        address[] memory reviewers = new address[](3);
        reviewers[0] = FOUNDER;
        reviewers[1] = MEMBER;
        reviewers[2] = INVESTOR;
        Call[] memory calls = new Call[](3);
        calls[0] = Call(address(cash), 0, abi.encodeCall(IERC20.approve, (address(factory), uint256(10000e18))));
        calls[1] = Call(
            address(factory),
            0,
            abi.encodeCall(
                TreasuryMandateFactory.create,
                (
                    address(cash),
                    uint128(10000e18),
                    uint128(2000e18),
                    uint128(100e18),
                    uint128(50e18),
                    uint64(vm.getBlockTimestamp() + 90 days),
                    reviewers,
                    uint256(2)
                )
            )
        );
        calls[2] = Call(address(cash), 0, abi.encodeCall(IERC20.approve, (address(factory), uint256(0))));
        bytes memory budget = abi.encodeCall(Moloch.batchCalls, (calls));
        bytes32 budgetNonce = bytes32("finite mandate");
        uint256 budgetId = dao.proposalId(0, address(dao), 0, budget, budgetNonce);
        uint256 competingId = dao.proposalId(
            0, address(dao), 0, abi.encodeCall(Moloch.setQuorumBps, (uint16(1000))), bytes32("competing priority")
        );
        ballot(FOUNDER, budgetId, 200e18);
        ballot(TEAM, budgetId, 100e18);
        ballot(MEMBER, budgetId, 50e18);
        ballot(FOUNDER, competingId, 200e18);
        ballot(TEAM, competingId, 100e18);
        ballot(MEMBER, competingId, 50e18);
        // Every Share of the other 700 backs a priority, and they still oppose the drain at full weight.
        oppose(FOUNDER, drainId, 400e18);
        oppose(TEAM, drainId, 200e18);
        oppose(MEMBER, drainId, 100e18);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        assertFalse(policy.qualifies(drainId), "300 FOR against 700 AGAINST");
        assertTrue(policy.qualifies(budgetId), "two priorities at 350 each can both clear the bars");
        assertTrue(policy.qualifies(competingId));
        vm.expectRevert(Moloch.NotOk.selector);
        dao.executeByVotes(0, address(cash), 0, drain, bytes32("drain"));
        ballot(FOUNDER, competingId, 0);
        ballot(TEAM, competingId, 0);
        ballot(MEMBER, competingId, 0);
        majority(budgetId);
        dao.queue(budgetId);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.recordLogs();
        dao.executeByVotes(0, address(dao), 0, budget, budgetNonce);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(factory)
                    && logs[i].topics[0]
                        == keccak256("MandateCreated(address,address,address,uint128,uint128,uint128,uint128)")
            ) mandate = TreasuryMandate(address(uint160(uint256(logs[i].topics[2]))));
        }
        assertTrue(address(mandate) != address(0));
        assertEq(cash.balanceOf(address(mandate)), 10000e18);
        assertEq(cash.allowance(address(dao), address(factory)), 0);
        assertEq(cash.balanceOf(address(dao)), 91000e18);
        vm.roll(block.number + 1);

        project(bytes32("real project"), TEAM, 2000e18, FOUNDER, 250e18);
        submit(INVESTOR, bytes32("delivered"), 1400e18, 50e18, bytes32("real project"));
        ClaimStake claims = mandate.claims();
        VerifierSet panel = mandate.verifiers();
        vm.prank(INVESTOR);
        vm.expectPartialRevert(VerifierSet.ClaimantCannotAttest.selector);
        panel.attest(bytes32("delivered"), true);
        vm.prank(FOUNDER);
        panel.attest(bytes32("delivered"), true);
        vm.prank(MEMBER);
        panel.attest(bytes32("delivered"), true);
        claims.settle(bytes32("delivered"));
        vm.prank(INVESTOR);
        vm.expectPartialRevert(ClaimStake.InChallengeWindow.selector);
        claims.payout(bytes32("delivered"));
        vm.warp(vm.getBlockTimestamp() + 3 days);
        vm.prank(INVESTOR);
        claims.payout(bytes32("delivered"));
        assertEq(cash.balanceOf(INVESTOR), 1450e18, "payment and returned stake");

        // Lower-support approval cannot bypass verification or obtain extra lifetime funding.
        ballot(COALITION, drainId, 0);
        project(bytes32("self project"), COALITION, 2000e18, COALITION, 300e18);
        submit(COALITION, bytes32("self payment"), 2000e18, 10e18, bytes32("self project"));
        vm.prank(FOUNDER);
        panel.attest(bytes32("self payment"), false);
        vm.prank(MEMBER);
        panel.attest(bytes32("self payment"), false);
        claims.settle(bytes32("self payment"));
        assertEq(cash.balanceOf(COALITION), 0, "objection quorum rejects self-payment and slashes the stake");
        assertEq(mandate.allocated(), 4000e18, "refund does not refill lifetime authority");

        execute(
            address(dao),
            abi.encodeCall(Moloch.awardContribution, (address(mandate), bytes32("delivered"), uint96(10e18), true)),
            bytes32("earned standing"),
            48 hours
        );
        assertEq(dao.shares().balanceOf(INVESTOR), 10e18);
        assertEq(dao.loot().balanceOf(INVESTOR), 90e18);
        assertEq(policy.available(INVESTOR), 10e18);
        address[] memory assets = new address[](1);
        assets[0] = address(cash);
        uint256 expectedExit = cash.balanceOf(address(dao)) * 20e18 / 1100e18;
        vm.prank(INVESTOR);
        dao.ragequit(assets, 0, 20e18);
        assertEq(cash.balanceOf(INVESTOR), 1450e18 + expectedExit);
        assertEq(policy.capacity(INVESTOR), 10e18, "economic Loot exit does not change Shares votes");
        uint256 completed = vm.getBlockTimestamp();
        vm.warp(mandate.expiresAt());
        mandate.returnUnused();
        assertEq(cash.balanceOf(address(mandate)), 0);
        assertEq(cash.balanceOf(address(dao)), 99610e18 - expectedExit);
        string memory key = "journey";
        vm.serializeString(
            key, "engine", "Foundry local EVM; actors and time simulated; deployed contracts enforce every action"
        );
        vm.serializeUint(key, "initialTreasury", 100000);
        vm.serializeUint(key, "investment", 1000);
        vm.serializeUint(key, "mandateLifetimeBudget", 10000);
        vm.serializeUint(key, "perProjectCap", 2000);
        vm.serializeUint(key, "paidDelivery", 1400);
        vm.serializeUint(key, "rejectedSelfPayment", 2000);
        vm.serializeUint(key, "earnedShares", 10);
        vm.serializeUint(key, "workflowHours", (completed - started) / 1 hours);
        string memory report = vm.serializeBool(key, "unrestrictedMinorityDrainBlocked", true);
        vm.writeJson(report, "./deployments/governance-dao-journey.json");
    }
}
