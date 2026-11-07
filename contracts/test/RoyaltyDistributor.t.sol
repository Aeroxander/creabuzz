// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {RoyaltyDistributor, IERC20Bal} from "../src/RoyaltyDistributor.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {ClaimStake} from "../src/ClaimStake.sol";

/// @notice Mock revenue currency (USDC-style). `failTransfers` simulates a
///         blacklisted receiver so push-failure paths are testable.
contract MockCurrency {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransfers;

    function setFailTransfers(bool v) external {
        failTransfers = v;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address who, uint256 amt) external returns (bool) {
        allowance[msg.sender][who] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        if (failTransfers) revert("transfer failed");
        require(balanceOf[msg.sender] >= amt, "balance");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (failTransfers) revert("transfer failed");
        require(balanceOf[from] >= amt, "balance");
        if (allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= amt, "allowance");
            allowance[from][msg.sender] -= amt;
        }
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// @notice Mock project token with mutable balances (holders trade) and the
///         minimal ERC-20 surface `ClaimStake` escrows tranches with.
contract MockProjectToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function setBalance(address who, uint256 amt) external {
        balanceOf[who] = amt;
    }

    function approve(address who, uint256 amt) external returns (bool) {
        allowance[msg.sender][who] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "balance");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(balanceOf[from] >= amt, "balance");
        if (allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= amt, "allowance");
            allowance[from][msg.sender] -= amt;
        }
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// @notice Royalty lifecycle: split-first settlement, credited-is-owned,
///         accrual scaling, carry-forward. Invariants I1-I8 from
///         docs/token-lifecycle-design.md.
contract RoyaltyDistributorTest is Test {
    uint64 internal constant WINDOW = 30 days;
    // D10 locked: β 40%, τ 20%, π 40%.
    uint16 internal constant B_BPS = 4000;
    uint16 internal constant T_BPS = 2000;

    MockCurrency internal usd;
    MockProjectToken internal pt;
    RoyaltyDistributor internal dist;
    VerifierSet internal verifiers;
    ClaimStake internal stake;

    address internal treasury = makeAddr("treasury");
    address internal buybackSink = makeAddr("buybackSink");
    address internal governance = makeAddr("governance");
    address internal verifierA = makeAddr("verifierA");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant CLAIM_A = keccak256("claim-a");
    bytes32 internal constant CLAIM_B = keccak256("claim-b");

    function setUp() public {
        usd = new MockCurrency();
        pt = new MockProjectToken();
        verifiers = new VerifierSet(treasury, 1); // quorum 1 for test speed
        stake = new ClaimStake(verifiers, treasury, address(usd));
        dist = new RoyaltyDistributor(
            IERC20Bal(address(usd)),
            IERC20Bal(address(pt)),
            treasury,
            buybackSink,
            address(stake),
            governance,
            WINDOW,
            B_BPS,
            T_BPS
        );
        vm.startPrank(treasury);
        stake.setRoyalties(address(dist));
        verifiers.acceptVerifier(verifierA);
        vm.stopPrank();
    }

    // ----------------------------------------------------------- helpers

    /// @dev Royalty-bearing claim, approved at quorum -> schedule minted.
    function _approvedSchedule(bytes32 claimId, address who, uint32 w, uint64 term, uint8 band, uint128 alloc) internal {
        vm.prank(who);
        stake.submitClaimWithSchedule(claimId, 1e6, 0, keccak256("evidence"), w, term, band, alloc);
        vm.prank(verifierA);
        verifiers.attest(claimId, true);
        stake.settle(claimId);
    }

    function _fund(uint256 amt) internal {
        usd.mint(address(this), amt);
        usd.approve(address(dist), amt);
        dist.fund(address(this), amt);
    }

    function _rollPastWindow() internal {
        vm.warp(dist.nextClose());
    }

    // ------------------------------------------------- split math (D3, I2)

    function test_SplitFirst_BuybackAndTreasuryFixed_PoolToContributor() public {
        pt.setBalance(alice, 100); // held == alloc -> h = 1
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _fund(10_000);
        _rollPastWindow();
        dist.settle();

        assertEq(usd.balanceOf(buybackSink), 4_000, "buyback share");
        assertEq(usd.balanceOf(treasury), 2_000, "treasury share");
        assertEq(usd.balanceOf(alice), 4_000, "full pool to sole contributor");
        assertEq(dist.carry(), 0, "no carry");
    }

    function test_TwoContributors_SplitByWeightTimesOverlap() public {
        pt.setBalance(alice, 100);
        pt.setBalance(bob, 100);
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _approvedSchedule(CLAIM_B, bob, 2, 365 days, 2, 100);
        _fund(10_000);
        _rollPastWindow();
        dist.settle();

        // Pool 4000 split 1:2 (weights 1x vs 2x, equal overlap).
        uint256 pool = 4_000;
        uint256 aliceShare = (pool * 1) / 3;
        uint256 bobShare = (pool * 2) / 3;
        assertEq(usd.balanceOf(alice), aliceShare, "alice 1/3");
        assertEq(usd.balanceOf(bob), bobShare, "bob 2/3");
        assertEq(dist.carry(), pool - aliceShare - bobShare, "remainder carries");
    }

    // ------------------------------------------------ accrual scaling (D5)

    function test_HalfHolding_ScalesAccrual_HalfCarries() public {
        pt.setBalance(alice, 50); // h = 0.5 both samples
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _fund(10_000);
        _rollPastWindow();
        dist.settle();

        assertEq(usd.balanceOf(alice), 2_000, "half the pool");
        assertEq(dist.carry(), 2_000, "unattributable half carries (D4)");
    }

    function test_SoldEverything_StopsAccrual_BuyerWithNoScheduleEarnsNothing() public {
        pt.setBalance(alice, 0); // sold it all
        pt.setBalance(stranger, 10_000); // bare holder, no schedule
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _fund(10_000);
        _rollPastWindow();
        dist.settle();

        assertEq(usd.balanceOf(alice), 0, "sell = forego (prospective)");
        assertEq(usd.balanceOf(stranger), 0, "no yield without attestation (I8)");
        assertEq(dist.carry(), 4_000, "all unattributable -> next pool");
    }

    function test_SellMidWindow_TrapezoidAverages() public {
        pt.setBalance(alice, 100); // open sample at mint
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _fund(10_000);
        pt.setBalance(alice, 0); // sold everything mid-window
        _rollPastWindow();
        dist.settle();

        assertEq(usd.balanceOf(alice), 2_000, "trapezoid h = 0.5");
    }

    // -------------------------------------------- credited is owned (D2, I1)

    function test_CreditedIsOwned_NoAdminPathTouchesBalances() public {
        pt.setBalance(alice, 100);
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _fund(10_000);
        usd.setFailTransfers(true); // force pull-fallback credits
        _rollPastWindow();
        dist.settle();
        uint256 credited = dist.claimableOf(alice);
        assertEq(credited, 4_000, "credited despite failed push");
        usd.setFailTransfers(false);

        // Stop alice's accrual so any balance change must be a reduction.
        pt.setBalance(alice, 0);

        // Throw every admin power at it.
        vm.prank(treasury);
        stake.freeze(CLAIM_A); // suspends FUTURE accrual
        pt.setBalance(bob, 100);
        _approvedSchedule(CLAIM_B, bob, 1, 365 days, 1, 100);
        _fund(5_000);
        _rollPastWindow();
        dist.settle();
        vm.prank(governance);
        dist.unsuspend(CLAIM_A);
        _fund(5_000);
        _rollPastWindow();
        dist.settle();

        assertEq(dist.claimableOf(alice), credited, "credited balance never moved");
    }

    function test_CreditedIsOwned_Fuzz(uint256 seed) public {
        pt.setBalance(alice, 100);
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _fund(10_000);
        usd.setFailTransfers(true);
        _rollPastWindow();
        dist.settle();
        usd.setFailTransfers(false);
        uint256 credited = dist.claimableOf(alice);
        pt.setBalance(alice, 0); // no further accrual: any change = a reduction

        uint256 ops = bound(seed, 1, 40);
        for (uint256 i = 0; i < ops; i++) {
            uint256 which = uint256(keccak256(abi.encode(seed, i))) % 4;
            if (which == 0) {
                _fund(1 + (i * 13) % 1000);
            } else if (which == 1) {
                _rollPastWindow();
                dist.settle();
            } else if (which == 2) {
                vm.prank(treasury);
                stake.freeze(CLAIM_A);
            } else {
                vm.prank(governance);
                dist.unsuspend(CLAIM_A);
            }
        }
        assertEq(dist.claimableOf(alice), credited, "I1: fuzzed admin ops never reduce credits");
    }

    function test_Claim_PullsOnce_NeverExpires() public {
        pt.setBalance(alice, 100);
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _fund(10_000);
        usd.setFailTransfers(true);
        _rollPastWindow();
        dist.settle();
        usd.setFailTransfers(false);

        vm.prank(alice);
        dist.claim();
        assertEq(usd.balanceOf(alice), 4_000, "pull works after failed push");
        assertEq(dist.claimableOf(alice), 0, "paid out");

        vm.prank(alice);
        vm.expectRevert(RoyaltyDistributor.NothingToClaim.selector);
        dist.claim();

        // Stranger claims nothing.
        vm.prank(stranger);
        vm.expectRevert(RoyaltyDistributor.NothingToClaim.selector);
        dist.claim();
    }

    function test_ClaimRevertOnTransferFailure_KeepsBalance() public {
        pt.setBalance(alice, 100);
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _fund(10_000);
        usd.setFailTransfers(true);
        _rollPastWindow();
        dist.settle();

        vm.prank(alice);
        vm.expectRevert(RoyaltyDistributor.TransferFailed.selector);
        dist.claim();
        assertEq(dist.claimableOf(alice), 4_000, "failed claim restores the credit");
    }

    // ------------------------------------------------- carry mechanics (D4)

    function test_CarryGrowsNextPool_NeverBuybackOrTreasury() public {
        // Bob holds nothing all along: his share is unattributable and must
        // grow the NEXT pool. Alice holds steady: h = 1 in both windows.
        pt.setBalance(alice, 100);
        pt.setBalance(bob, 0);
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _approvedSchedule(CLAIM_B, bob, 1, 365 days, 1, 100);
        _fund(10_000);
        _rollPastWindow();
        dist.settle();

        // Pool 4000 split 1:1 -> alice 2000; bob's 2000 carries.
        assertEq(usd.balanceOf(alice), 2_000, "window 1");
        assertEq(dist.carry(), 2_000, "bob's unattributable half carried");
        assertEq(usd.balanceOf(buybackSink), 4_000, "B fixed at split");

        // Window 2: pool = fresh 4000 + carried 2000 = 6000, again 1:1.
        _fund(10_000);
        _rollPastWindow();
        dist.settle();

        assertEq(usd.balanceOf(alice), 2_000 + 3_000, "pool2 = fresh 40% + carried");
        assertEq(usd.balanceOf(bob), 0, "bob still holds nothing");
        assertEq(dist.carry(), 3_000, "bob's share carries again");
        assertEq(usd.balanceOf(buybackSink), 8_000, "B from revenue only (I2)");
        assertEq(usd.balanceOf(treasury), 4_000, "T from revenue only (I2)");
    }

    function test_NoActiveWeight_PoolCarries() public {
        _fund(10_000);
        _rollPastWindow();
        dist.settle();
        assertEq(dist.carry(), 4_000, "unattributable pool carries");
    }

    // --------------------------------------------- schedules and terms (I3)

    function test_TermProration_ShortTermVsLongTerm() public {
        // Alice: 1x but active only 1/4 of the window (7.5-day term).
        // Bob: 1x for the whole window.
        pt.setBalance(alice, 100);
        pt.setBalance(bob, 100);
        vm.prank(alice);
        stake.submitClaimWithSchedule(CLAIM_A, 1e6, 0, keccak256("e"), 1, 7 days + 12 hours, 1, 100);
        vm.prank(bob);
        stake.submitClaimWithSchedule(CLAIM_B, 1e6, 0, keccak256("e"), 1, 365 days, 1, 100);
        vm.startPrank(verifierA);
        verifiers.attest(CLAIM_A, true);
        verifiers.attest(CLAIM_B, true);
        vm.stopPrank();
        stake.settle(CLAIM_A);
        stake.settle(CLAIM_B);

        _fund(10_000);
        _rollPastWindow();
        dist.settle();

        // num: alice 1x(7.5d) vs bob 1x(30d) => 1:4 within the pool.
        uint256 pool = 4_000;
        assertEq(usd.balanceOf(alice), (pool * 1) / 5, "prorated share");
        assertEq(usd.balanceOf(bob), (pool * 4) / 5, "full-window share");
    }

    function test_SuspendStopsFutureAccrual_UnsuspendRestores() public {
        pt.setBalance(alice, 100);
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _fund(10_000);
        _rollPastWindow();
        dist.settle();
        assertEq(usd.balanceOf(alice), 4_000, "window 1 earned");

        vm.prank(treasury);
        stake.freeze(CLAIM_A); // suspends the schedule
        _fund(10_000);
        _rollPastWindow();
        dist.settle();
        assertEq(usd.balanceOf(alice), 4_000, "suspended: no accrual");
        assertEq(dist.carry(), 4_000, "pool carried instead");

        vm.prank(governance);
        dist.unsuspend(CLAIM_A);
        _fund(10_000);
        _rollPastWindow();
        dist.settle();
        // Window 3 pool = fresh 4000 + window 2's carried 4000 (D4: the
        // suspended window's pool was not lost — it came back to the pool).
        assertEq(usd.balanceOf(alice), 4_000 + 8_000, "restored, plus carried pool");
        assertEq(dist.carry(), 0, "all attributed");
    }

    function test_MintOnlyClaimStake_BandCapsEnforced() public {
        vm.expectRevert(RoyaltyDistributor.NotClaimStake.selector);
        dist.mint(CLAIM_A, alice, 1, 365 days, 1, 100);

        // weight above band cap.
        vm.prank(address(stake));
        vm.expectRevert(RoyaltyDistributor.BadSchedule.selector);
        dist.mint(CLAIM_A, alice, 2, 365 days, 1, 100);
        // term above band cap.
        vm.prank(address(stake));
        vm.expectRevert(RoyaltyDistributor.BadSchedule.selector);
        dist.mint(CLAIM_A, alice, 1, 730 days, 1, 100);
        // zero allocation.
        vm.prank(address(stake));
        vm.expectRevert(RoyaltyDistributor.BadSchedule.selector);
        dist.mint(CLAIM_A, alice, 1, 365 days, 1, 0);
        // bad band.
        vm.prank(address(stake));
        vm.expectRevert(RoyaltyDistributor.BadSchedule.selector);
        dist.mint(CLAIM_A, alice, 1, 365 days, 4, 100);
    }

    function test_GovernanceCannotTouchCredits_OnlyUnsuspend() public {
        pt.setBalance(alice, 100);
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _fund(10_000);
        usd.setFailTransfers(true);
        _rollPastWindow();
        dist.settle();
        usd.setFailTransfers(false);

        vm.prank(governance);
        vm.expectRevert(RoyaltyDistributor.NotClaimStake.selector);
        dist.mint(CLAIM_B, governance, 1, 365 days, 1, 1);
        // Governance's only power touches schedule flags, never balances.
        vm.prank(governance);
        dist.unsuspend(CLAIM_A);
        assertEq(dist.claimableOf(alice), 4_000, "untouched");
    }

    // ----------------------------------------------------- window discipline

    function test_SettleBeforeCloseReverts_NoWindowBeforeFund() public {
        vm.expectRevert(RoyaltyDistributor.NoWindow.selector);
        dist.settle();
        _fund(1);
        vm.expectRevert(RoyaltyDistributor.TooEarly.selector);
        dist.settle();
    }

    // ------------------------------------------------------- solvency (fuzz)

    function testFuzz_SolvencyHolds(uint96 amount, uint8 hPct) public {
        pt.setBalance(alice, (uint256(hPct) * 100)); // 0..25500 vs alloc 100
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _fund(bound(amount, 1, 1_000_000));
        _rollPastWindow();
        dist.settle();

        // Accounting never promises more than the contract holds.
        assertGe(usd.balanceOf(address(dist)), dist.carry() + dist.pendingRevenue() + dist.totalClaimable(), "solvency");
    }

    function testFuzz_SplitNeverDrainsContributorMoney(uint96 revenue, uint32 w2) public {
        w2 = uint32(bound(w2, 1, 2));
        pt.setBalance(alice, 100);
        pt.setBalance(bob, 100);
        _approvedSchedule(CLAIM_A, alice, 1, 365 days, 1, 100);
        _approvedSchedule(CLAIM_B, bob, w2, 365 days, uint8(w2), 100);
        uint256 rev = bound(revenue, 1, type(uint96).max);
        _fund(rev);
        _rollPastWindow();
        dist.settle();

        // Buyback + treasury draws are exactly their bps of revenue (I2);
        // contributors split at most the pool (floor-split matches the
        // contract: each share floors independently).
        assertLe(usd.balanceOf(buybackSink), (rev * B_BPS) / 10_000, "B bounded");
        assertLe(usd.balanceOf(treasury), (rev * T_BPS) / 10_000, "T bounded");
        assertLe(
            usd.balanceOf(alice) + usd.balanceOf(bob),
            rev - (rev * B_BPS) / 10_000 - (rev * T_BPS) / 10_000,
            "pool bounded"
        );
    }
}
