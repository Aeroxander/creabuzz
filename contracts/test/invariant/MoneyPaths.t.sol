// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {Call, Moloch, Summoner, Shares, Loot, newSummoner} from "../../src/majeur/MolochPatched.sol";
import {AllocationVoting} from "../../src/AllocationVoting.sol";
import {MilestoneChallenge} from "../../src/MilestoneChallenge.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../../src/TreasuryMandate.sol";
import {ClaimStake} from "../../src/ClaimStake.sol";
import {VerifierSet} from "../../src/VerifierSet.sol";
import {MockUSDC, MoneyPathsHandler} from "./MoneyPathsHandler.sol";

/// @notice The money paths of a launched project, held as invariants over thousands of random orders of events:
///  1. nothing leaves the treasury without a vote that met its bars (or a holder's own exit);
///  2. a locked Share never moves (transfer, transferFrom, ragequit);
///  3. leaving pays exactly what the web's exit preview computes from the same reads (D51);
///  4. an upheld late objection always has something to burn (D58), and no later milestone even starts while an earlier
///     one can still be objected to;
///  5. a reviewer's bond is slashed only by a vote and never beyond what they hold, and every bond, deposit and claim
///     escrow is fully backed by the contract that holds it.
/// The sale itself (the CCA) is upstream code and is exercised on a real chain by `scripts/simulate-raise.mjs`; here the
/// buyers have already claimed, so the state is the one every later money path starts from.
///
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 200
/// forge-config: default.invariant.fail-on-revert = true
contract MoneyPathsInvariantTest is Test {
    MoneyPathsHandler internal handler;
    Moloch internal dao;
    Shares internal shares;
    AllocationVoting internal policy;
    MilestoneChallenge internal lock;
    TreasuryMandate internal mandate;
    VerifierSet internal panel;
    ClaimStake internal claims;
    MockUSDC internal usdc;

    address internal constant T1 = address(0x7001);
    address internal constant T2 = address(0x7002);
    address internal constant LOOTER = address(0x1007);
    address internal constant CONTRIBUTOR = address(0xC0DE);
    address internal constant MANAGER = address(0x3A11);

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.roll(100);
        usdc = new MockUSDC();
        Summoner summoner = newSummoner();

        address[] memory backers = new address[](5);
        for (uint256 i; i < 5; ++i) {
            backers[i] = address(uint160(0xB001 + i));
        }
        address[] memory holders = new address[](7);
        uint256[] memory amounts = new uint256[](7);
        (holders[0], amounts[0]) = (T1, 100e18);
        (holders[1], amounts[1]) = (T2, 50e18);
        (holders[2], amounts[2]) = (backers[0], 60e18);
        (holders[3], amounts[3]) = (backers[1], 30e18);
        (holders[4], amounts[4]) = (backers[2], 20e18);
        (holders[5], amounts[5]) = (backers[3], 10e18);
        (holders[6], amounts[6]) = (backers[4], 0.5e18);
        // The launch kit's shape: quorum 5%, ragequit on.
        dao = summoner.summon("Project", "PRJ", "", 500, true, address(0), bytes32("money"), holders, amounts, new Call[](0));
        shares = dao.shares();
        policy = AllocationVoting(dao.votingWeight());

        // The DAO keeps an allocation of its own (outside voting and the exit denominator), and one holder has Loot.
        vm.startPrank(address(dao));
        shares.mintFromMoloch(address(dao), 200e18);
        dao.loot().mintFromMoloch(LOOTER, 25e18);
        vm.stopPrank();

        address[] memory team = new address[](2);
        team[0] = T1;
        team[1] = T2;
        uint256[] memory totals = new uint256[](2);
        totals[0] = 100e18;
        totals[1] = 50e18;
        bytes32[] memory checks = new bytes32[](3);
        checks[0] = keccak256("beta live");
        checks[1] = keccak256("first customers");
        checks[2] = keccak256("version one");
        uint16[] memory bps = new uint16[](3);
        (bps[0], bps[1], bps[2]) = (2000, 3000, 4000); // 10% of the team's Shares is never locked
        lock = new MilestoneChallenge(
            address(dao),
            team,
            totals,
            checks,
            bps,
            MilestoneChallenge.Terms({
                window: 7 days,
                votePeriod: 5 days,
                clawback: 30 days,
                minRejectBps: 300,
                earliestBlock: uint64(block.number),
                bondToken: address(usdc),
                bond: 100e6,
                deposit: 10e6
            })
        );
        vm.prank(address(dao));
        shares.setLockGuard(address(lock));

        // The raise, in the treasury.
        usdc.mint(address(dao), 500_000e6);
        vm.deal(address(dao), 50 ether);

        // A reviewed work budget, made the way a vote makes one (the DAO approves the factory for exactly the budget).
        address[] memory reviewers = new address[](3);
        reviewers[0] = address(0x4E01);
        reviewers[1] = address(0x4E02);
        reviewers[2] = address(0x4E03);
        TreasuryMandateFactory factory = policy.mandateFactory();
        vm.startPrank(address(dao));
        usdc.approve(address(factory), 100_000e6);
        mandate = factory.create(
            address(usdc), 100_000e6, 40_000e6, 0, 0, uint64(block.timestamp + 365 days), reviewers, 2, 1_000e6, address(usdc)
        );
        vm.stopPrank();
        panel = mandate.verifiers();
        claims = mandate.claims();
        for (uint256 i; i < 3; ++i) {
            usdc.mint(reviewers[i], 10_000e6);
            vm.startPrank(reviewers[i]);
            usdc.approve(address(panel), type(uint256).max);
            panel.bond(1_000e6);
            vm.stopPrank();
        }

        handler = new MoneyPathsHandler(dao, lock, mandate, usdc, team, backers, reviewers, LOOTER, CONTRIBUTOR, MANAGER);

        // Everyone can post a bond, a deposit or a stake.
        address[] memory everyone = new address[](10);
        (everyone[0], everyone[1], everyone[2], everyone[3]) = (T1, T2, LOOTER, CONTRIBUTOR);
        everyone[4] = handler.ATTACKER();
        for (uint256 i; i < 5; ++i) {
            everyone[5 + i] = backers[i];
        }
        for (uint256 i; i < everyone.length; ++i) {
            usdc.mint(everyone[i], 10_000e6);
            vm.startPrank(everyone[i]);
            usdc.approve(address(lock), type(uint256).max);
            usdc.approve(address(claims), type(uint256).max);
            vm.stopPrank();
        }
        vm.roll(block.number + 1);
        targetContract(address(handler));
        // Weighted: whole milestone rounds and whole votes reach deep states, so they come up more often than single steps.
        bytes4[] memory weighted = new bytes4[](38);
        uint256 n;
        for (uint256 i; i < 6; ++i) weighted[n++] = handler.milestoneRound.selector;
        for (uint256 i; i < 2; ++i) weighted[n++] = handler.governPay.selector;
        for (uint256 i; i < 2; ++i) weighted[n++] = handler.governApproveProject.selector;
        for (uint256 i; i < 2; ++i) weighted[n++] = handler.ragequit.selector;
        for (uint256 i; i < 2; ++i) weighted[n++] = handler.transferShares.selector;
        weighted[n++] = handler.transferFromShares.selector;
        weighted[n++] = handler.governMandate.selector;
        weighted[n++] = handler.governSlash.selector;
        weighted[n++] = handler.governForfeit.selector;
        weighted[n++] = handler.submitMilestone.selector;
        weighted[n++] = handler.objectMilestone.selector;
        weighted[n++] = handler.voteMilestone.selector;
        weighted[n++] = handler.finishMilestone.selector;
        weighted[n++] = handler.resolveMilestone.selector;
        weighted[n++] = handler.releaseBond.selector;
        weighted[n++] = handler.donateToLock.selector;
        weighted[n++] = handler.submitClaim.selector;
        weighted[n++] = handler.fundClaim.selector;
        weighted[n++] = handler.attestClaim.selector;
        weighted[n++] = handler.settleClaim.selector;
        weighted[n++] = handler.payoutClaim.selector;
        weighted[n++] = handler.expireClaim.selector;
        for (uint256 i; i < 3; ++i) weighted[n++] = handler.workRound.selector;
        weighted[n++] = handler.returnUnused.selector;
        weighted[n++] = handler.reviewerBond.selector;
        weighted[n++] = handler.attack.selector;
        weighted[n++] = handler.elapse.selector;
        assert(n == weighted.length);
        targetSelector(FuzzSelector({addr: address(handler), selectors: weighted}));
    }

    // ---- 1, 2, 3 and the per-step checks ------------------------------------------------------------

    function invariant_no_money_moved_outside_its_rules() public view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }

    /// @notice A team member's balance never falls below what the lock holds back.
    function invariant_locked_shares_are_always_held() public view {
        address[] memory team = handler.team();
        for (uint256 i; i < team.length; ++i) {
            assertGe(shares.balanceOf(team[i]), lock.lockedOf(team[i]), "locked Shares left their holder");
        }
    }

    /// @notice A tranche is freed only by a milestone that stood, and is never both freed and given up.
    function invariant_tranches_free_only_with_their_milestone() public view {
        address[] memory team = handler.team();
        for (uint256 i; i < team.length; ++i) {
            for (uint256 k; k < lock.milestoneCount(); ++k) {
                MilestoneChallenge.Tranche memory t = lock.trancheOf(team[i], k);
                (MilestoneChallenge.Phase phase,,,,,,,) = lock.milestone(k);
                if (t.unlocked) assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.Stood), "freed without standing");
                assertFalse(t.unlocked && t.forfeited, "freed and forfeited");
            }
        }
    }

    // ---- 4. D58 -------------------------------------------------------------------------------------

    /// @notice While any milestone can still be objected to late (or has a vote open), no later milestone has even been
    /// published, so every later tranche is still locked and is what an upheld late objection burns.
    function invariant_later_milestones_wait_while_an_earlier_can_be_objected_to() public view {
        uint256 n = lock.milestoneCount();
        for (uint256 k; k < n; ++k) {
            (MilestoneChallenge.Phase phase, bool lateObjected,,,,, uint64 unlockedAt,) = lock.milestone(k);
            (bool open,,,,,,,,) = lock.objection(k);
            bool exposed = open
                || (phase == MilestoneChallenge.Phase.Stood && !lateObjected && block.timestamp < unlockedAt + lock.clawback());
            if (!exposed) continue;
            for (uint256 j = k + 1; j < n; ++j) {
                (MilestoneChallenge.Phase later,,,,,,,) = lock.milestone(j);
                assertEq(uint8(later), uint8(MilestoneChallenge.Phase.None), "a later milestone moved while an earlier was exposed");
            }
        }
    }

    // ---- 5. bonds, deposits and escrows -------------------------------------------------------------

    /// @notice The lock holds exactly the bonds it has not paid out and the deposits of open objections (plus anything
    /// pushed into it from outside, which nothing can take out).
    function invariant_lock_holds_exactly_bonds_and_open_deposits() public view {
        uint256 owed;
        for (uint256 k; k < lock.milestoneCount(); ++k) {
            (,,,,,,, uint128 bond) = lock.milestone(k);
            (bool open,,,,, uint128 deposit,,,) = lock.objection(k);
            owed += bond;
            if (open) owed += deposit;
        }
        assertEq(usdc.balanceOf(address(lock)), owed + handler.donatedToLock(), "lock custody");
    }

    /// @notice The reviewer panel holds exactly every reviewer's stake and the bond they are waiting to take back.
    function invariant_panel_holds_exactly_the_bonds() public view {
        address[] memory reviewers = handler.reviewers();
        uint256 owed;
        for (uint256 i; i < reviewers.length; ++i) {
            (, uint256 stake,,) = panel.verifiers(reviewers[i]);
            (uint256 pending,) = panel.unbonds(reviewers[i]);
            owed += stake + pending;
        }
        assertEq(usdc.balanceOf(address(panel)), owed, "panel custody");
    }

    /// @notice The claim escrow holds exactly the stakes and reservations of claims still in play.
    function invariant_claim_escrow_is_fully_backed() public view {
        bytes32[] memory ids = handler.claimIds();
        uint256 owed;
        for (uint256 i; i < ids.length; ++i) {
            (,, uint256 stake, ClaimStake.Status status,,,,) = claims.claims(ids[i]);
            uint256 funded = claims.funded(ids[i]);
            if (
                status == ClaimStake.Status.Open || status == ClaimStake.Status.Approved
                    || status == ClaimStake.Status.Frozen
            ) owed += stake + funded;
            else if (status == ClaimStake.Status.Paid) owed += funded;
            else assertEq(funded, 0, "a settled claim kept a reservation");
        }
        assertEq(usdc.balanceOf(address(claims)), owed, "claim escrow custody");
    }

    function invariant_budget_and_vote_ledger_bounds() public view {
        assertLe(mandate.allocated(), mandate.budget(), "budget over-allocated");
        assertEq(policy.totalCapacity(), shares.totalSupply(), "voting ledger lost track of Shares");
    }

    /// @notice What the run reached, so a run that never exercised a path shows it.
    function afterInvariant() external view {
        bytes32[] memory keys = handler.countKeys();
        for (uint256 i; i < keys.length; ++i) {
            console.log(string(abi.encodePacked(keys[i])), handler.count(keys[i]));
        }
    }
}
