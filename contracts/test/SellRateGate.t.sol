// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {RoyaltyDistributor, IERC20Bal} from "../src/RoyaltyDistributor.sol";
import {SellRateGate} from "../src/SellRateGate.sol";
import {MockCurrency, MockProjectToken} from "./RoyaltyDistributor.t.sol";

/// @notice D8 sell-rate gating: tier-capped, window-reset, venue-only,
///         fail-closed. Non-contributors pass through ungated (LBAMM wallet
///         caps handle them).
contract SellRateGateTest is Test {
    uint64 internal constant WINDOW = 30 days;

    MockCurrency internal usd;
    MockProjectToken internal pt;
    RoyaltyDistributor internal dist;
    SellRateGate internal gate;

    address internal treasury = makeAddr("treasury");
    address internal venue = makeAddr("venue");
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");
    address internal attacker = makeAddr("attacker");

    bytes32 internal constant CLAIM_A = keccak256("claim-a");

    function setUp() public {
        usd = new MockCurrency();
        pt = new MockProjectToken();
        // The test acts as the ClaimStake minter for direct schedule setup.
        dist = new RoyaltyDistributor(
            IERC20Bal(address(usd)),
            IERC20Bal(address(pt)),
            treasury,
            makeAddr("buybackSink"),
            address(this),
            makeAddr("governance"),
            WINDOW,
            4000,
            2000
        );
        gate = new SellRateGate(dist, venue);
    }

    function _mint(address who, uint32 w, uint8 band, uint128 alloc) internal {
        dist.mint(CLAIM_A, who, w, 365 days, band, alloc);
    }

    function _nextWindow() internal {
        usd.mint(address(this), 1);
        usd.approve(address(dist), 1);
        dist.fund(address(this), 1);
        vm.warp(dist.nextClose());
        dist.settle();
    }

    function test_AllowanceByBand_FailClosed() public {
        _mint(alice, 1, 1, 100); // Tier I: 3% of 100 = 3
        assertEq(gate.sellAllowance(alice), 3, "cap 3%");
        assertTrue(gate.canSell(alice, 3), "at cap is fine");
        assertFalse(gate.canSell(alice, 4), "over cap is not");

        vm.prank(venue);
        gate.consumeSellAllowance(alice, 2);
        assertEq(gate.sellAllowance(alice), 1, "2 consumed");

        vm.prank(venue);
        vm.expectRevert(abi.encodeWithSelector(SellRateGate.SellRateExceeded.selector, 2, 1));
        gate.consumeSellAllowance(alice, 2);

        vm.prank(venue);
        gate.consumeSellAllowance(alice, 1); // exactly to the cap
        assertEq(gate.sellAllowance(alice), 0, "drained");
    }

    function test_NonContributor_PassesUngated() public {
        assertEq(gate.sellAllowance(stranger), type(uint256).max, "no schedule, no gate");
        vm.prank(venue);
        gate.consumeSellAllowance(stranger, 1_000_000e18); // never reverts
        assertTrue(gate.canSell(stranger, type(uint256).max), "still ungated");
    }

    function test_OnlyVenueMayConsume() public {
        _mint(alice, 1, 1, 100);
        vm.prank(attacker);
        vm.expectRevert(SellRateGate.NotVenue.selector);
        gate.consumeSellAllowance(alice, 1);
    }

    function test_WindowRollover_ResetsAllowance() public {
        _mint(alice, 1, 1, 100);
        vm.prank(venue);
        gate.consumeSellAllowance(alice, 3);
        assertEq(gate.sellAllowance(alice), 0, "window drained");

        _nextWindow();
        assertEq(gate.windowId(), 1, "new window");
        assertEq(gate.sellAllowance(alice), 3, "allowance reset (continuous drip, no cliff)");
    }

    function test_BandAndAllocationScaleTheCap() public {
        bytes32 claimB = keccak256("claim-b");
        bytes32 claimC = keccak256("claim-c");
        dist.mint(claimB, alice, 2, 730 days, 2, 100); // Tier II: 5%
        assertEq(gate.sellAllowance(alice), 5, "Tier II cap");
        dist.mint(claimC, alice, 3, 1095 days, 3, 900); // Tier III wins (bandOf = max)
        // bandOf = 3 -> 8% of allocOf 1000 = 80.
        assertEq(gate.sellAllowance(alice), 80, "Tier III, total allocation");
    }

    function test_SuspendedSchedule_StillGated() public {
        _mint(alice, 1, 1, 100);
        dist.suspend(CLAIM_A); // fraud freeze: accrual stops, sell gate stays
        assertEq(gate.sellAllowance(alice), 3, "gate is not a back door");
    }

    function test_ZeroAmount_ConsumesNothing() public {
        _mint(alice, 1, 1, 100);
        vm.prank(venue);
        gate.consumeSellAllowance(alice, 0);
        assertEq(gate.sellAllowance(alice), 3, "unchanged");
    }

    function testFuzz_NeverExceedsCap(uint8 consumedA, uint8 consumedB) public {
        _mint(alice, 1, 1, 100);
        uint256 cap = 3;
        uint256 a = bound(consumedA, 0, 5);
        uint256 b = bound(consumedB, 0, 5);
        vm.prank(venue);
        if (a <= cap) {
            gate.consumeSellAllowance(alice, a);
        } else {
            vm.expectRevert(abi.encodeWithSelector(SellRateGate.SellRateExceeded.selector, a, cap));
            gate.consumeSellAllowance(alice, a);
        }
        uint256 sold = gate.soldInWindow(gate.windowId(), alice);
        assertLe(sold, cap, "never exceeds the tier cap");
        if (a <= cap) {
            vm.prank(venue);
            if (b <= cap - a) {
                gate.consumeSellAllowance(alice, b);
            } else {
                vm.expectRevert();
                gate.consumeSellAllowance(alice, b);
            }
        }
        assertLe(gate.soldInWindow(gate.windowId(), alice), cap, "cumulative cap holds");
    }
}
