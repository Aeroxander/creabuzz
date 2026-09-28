// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {RoyaltyDistributor, IERC20Bal} from "../src/RoyaltyDistributor.sol";
import {SellRateGate} from "../src/SellRateGate.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {MockCurrency, MockProjectToken} from "./RoyaltyDistributor.t.sol";

/// @notice The dogfood journey, end to end, through the real seams.
///
/// This is the test that closes the gap `unlock-plans.ts` names out loud —
/// "nothing onchain moves a token tranche when a verdict arrives" — by
/// escrowing the PROJECT TOKEN in `ClaimStake` (it is currency-agnostic):
/// `fund()` the tranches, submit each wizard milestone row as a claim, and
/// the VerifierSet's approval quorum releases the tranche on attestation.
///
/// The journey mirrors the web join module
/// (`web/src/features/launchpad/lib/tranche-claims.ts`): plan rows m1/m2 at
/// 60/40 of a 20% milestone allocation on 1,000,000 supply -> tranches
/// 120,000 / 80,000, claim words `bytes32("m1")` (ASCII right-padded — the
/// exact encoding `claimIdWord` produces).
contract TokenLifecycleJourneyTest is Test {
    uint64 internal constant WINDOW = 30 days;

    MockCurrency internal usd; // revenue currency
    MockProjectToken internal pt; // the project token: tranche asset + h-sampling
    VerifierSet internal verifiers;
    ClaimStake internal stake;
    RoyaltyDistributor internal dist;
    SellRateGate internal gate;

    address internal treasury = makeAddr("treasury");
    address internal buybackSink = makeAddr("buybackSink");
    address internal governance = makeAddr("governance");
    address internal venue = makeAddr("venue");
    address internal verifierA = makeAddr("verifierA");
    address internal alice = makeAddr("alice");

    bytes32 internal constant M1 = bytes32("m1"); // == claimIdWord("m1")
    bytes32 internal constant M2 = bytes32("m2");
    bytes32 internal constant EVIDENCE = keccak256("evidence-1");

    uint256 internal constant SUPPLY = 1_000_000;
    uint256 internal constant TRANCHE_1 = 120_000; // 20% * 60%
    uint256 internal constant TRANCHE_2 = 80_000; // 20% * 40%

    function setUp() public {
        usd = new MockCurrency();
        pt = new MockProjectToken();
        verifiers = new VerifierSet(treasury, 1);
        // The escrowed asset IS the project token (the named gap's fix).
        stake = new ClaimStake(verifiers, treasury, address(pt));
        dist = new RoyaltyDistributor(
            IERC20Bal(address(usd)),
            IERC20Bal(address(pt)),
            treasury,
            buybackSink,
            address(stake),
            governance,
            WINDOW,
            4000,
            2000
        );
        gate = new SellRateGate(dist, venue);
        // Treasury holds the milestone allocation and escrows it on approve.
        pt.setBalance(treasury, TRANCHE_1 + TRANCHE_2);
        vm.startPrank(treasury);
        pt.approve(address(stake), type(uint256).max);
        stake.setRoyalties(address(dist));
        verifiers.acceptVerifier(verifierA);
        vm.stopPrank();
    }

    function _fundRevenue(uint256 amount) internal {
        usd.mint(address(this), amount);
        usd.approve(address(dist), amount);
        dist.fund(address(this), amount);
    }

    function _closeWindow() internal {
        vm.warp(dist.nextClose());
        dist.settle();
    }

    function test_WizardRowToTrancheReleaseAndRoyalty() public {
        // --- Launch: treasury escrows the milestone allocation (fund()).
        vm.prank(treasury);
        stake.fund(treasury, TRANCHE_1 + TRANCHE_2);

        // --- Alice submits wizard row m1 with a royalty schedule ride-along.
        // (Weight 1 / 12mo / Tier I: inside the band caps.)
        vm.prank(alice);
        stake.submitClaimWithSchedule(
            M1, TRANCHE_1, 0, EVIDENCE, 1, 365 days, 1, uint128(TRANCHE_1)
        );

        // --- Verifier approves; settle releases on ATTESTATION.
        vm.prank(verifierA);
        verifiers.attest(M1, true);
        stake.settle(M1);
        vm.prank(alice);
        stake.payout(M1);

        assertEq(pt.balanceOf(alice), TRANCHE_1, "tranche released on the verdict");
        (, , , ClaimStake.Status status, ) = stake.claims(M1);
        assertEq(uint256(status), uint256(ClaimStake.Status.Paid), "claim closed");
        (address schedWho,,,,,, bool suspended) = dist.schedules(M1);
        assertEq(schedWho, alice, "schedule minted to the claimant");
        assertFalse(suspended, "schedule live");
        assertEq(dist.allocOf(alice), TRANCHE_1, "allocation registered");

        // --- Window 1: revenue settles the same month the tranche released.
        // The trapezoid samples open=0 (pre-release) and close=120k, so h=0.5
        // — the known v1 sampling dip of a release month (design doc section
        // 3.3; upgrade path = poke accumulator). The dip CARRIES, it is not
        // lost: D4 sends it to the next pool.
        _fundRevenue(10_000);
        _closeWindow();
        assertEq(usd.balanceOf(alice), 2_000, "window 1: trapezoid-dipped");
        assertEq(dist.carry(), 2_000, "the dip carried forward (D4)");
        assertEq(usd.balanceOf(buybackSink), 4_000, "buyback share");
        assertEq(usd.balanceOf(treasury), 2_000, "treasury share");

        // --- Window 2: h = 1 at both samples; pool = 4000 + carried 2000.
        _fundRevenue(10_000);
        _closeWindow();
        assertEq(usd.balanceOf(alice), 2_000 + 6_000, "window 2: full pool + carried");
        assertEq(usd.balanceOf(buybackSink), 8_000, "B from revenue only (I2)");

        // --- Sell-rate gate: the tier drip, fail-closed.
        uint256 cap = (TRANCHE_1 * 300) / 10_000; // Tier I: 3%/window
        vm.prank(venue);
        gate.consumeSellAllowance(alice, cap);
        vm.prank(venue);
        vm.expectRevert(abi.encodeWithSelector(SellRateGate.SellRateExceeded.selector, 1, 0));
        gate.consumeSellAllowance(alice, 1);
    }

    function test_RejectedRow_Slashed_NoTranche_NoSchedule() public {
        vm.prank(treasury);
        stake.fund(treasury, TRANCHE_1 + TRANCHE_2);
        // Alice posts 100 of her own tokens as claim stake (skin in the game).
        pt.setBalance(alice, 100);
        vm.startPrank(alice);
        pt.approve(address(stake), 100);
        stake.submitClaimWithSchedule(
            M2, TRANCHE_2, 100, EVIDENCE, 1, 365 days, 1, uint128(TRANCHE_2)
        );
        vm.stopPrank();

        vm.prank(verifierA);
        verifiers.attest(M2, false); // objection quorum
        stake.settle(M2);

        (, , , ClaimStake.Status status, ) = stake.claims(M2);
        assertEq(uint256(status), uint256(ClaimStake.Status.Rejected), "rejected");
        assertEq(pt.balanceOf(alice), 0, "no tranche released");
        assertEq(dist.allocOf(alice), 0, "no schedule minted (I8)");
    }

    function test_SellingAllAllocation_StopsRoyalty_ButTrancheIsOurs() public {
        vm.prank(treasury);
        stake.fund(treasury, TRANCHE_1 + TRANCHE_2);
        vm.prank(alice);
        stake.submitClaimWithSchedule(
            M1, TRANCHE_1, 0, EVIDENCE, 1, 365 days, 1, uint128(TRANCHE_1)
        );
        vm.prank(verifierA);
        verifiers.attest(M1, true);
        stake.settle(M1);
        vm.prank(alice);
        stake.payout(M1);

        // Alice sells her whole allocation away.
        pt.setBalance(alice, 0);

        _fundRevenue(10_000);
        _closeWindow();

        assertEq(usd.balanceOf(alice), 0, "sold = stopped earning (prospective)");
        assertEq(dist.carry(), 4_000, "her share carried to the pool (D4)");
    }
}
