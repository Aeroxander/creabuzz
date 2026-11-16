// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RollingCap} from "../src/RollingCap.sol";

contract CapHarness {
    using RollingCap for RollingCap.Ring;

    RollingCap.Ring internal ring;

    function consume(uint256 window, uint256 buckets, uint256 cap, uint256 amount) external {
        ring.consume(window, buckets, cap, amount);
    }

    function used(uint256 window, uint256 buckets) external view returns (uint256) {
        return ring.used(window, buckets);
    }
}

/// @notice The limit behind agent daily caps and the 1% in 30 days. The promise: in no stretch of `window` seconds is
/// more than the cap let through; a used amount may stay counted up to one part longer than the window.
contract RollingCapTest is Test {
    CapHarness internal h;
    uint256 internal constant DAY = 1 days;

    function setUp() public {
        h = new CapHarness();
        vm.warp(1_800_000_000);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function test_capHolds_andCountsForBetween24And28Hours() public {
        uint256 t0 = _now() + 1 hours; // an alignment inside a 4 hour part
        vm.warp(t0);
        h.consume(DAY, 6, 100, 100);
        assertEq(h.used(DAY, 6), 100);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.CapExceeded.selector, 100, 1, 100));
        h.consume(DAY, 6, 100, 1);
        vm.warp(t0 + DAY); // exactly 24 hours: still counted, which is the safe side
        assertEq(h.used(DAY, 6), 100);
        vm.warp(t0 + 27 hours - 1);
        assertEq(h.used(DAY, 6), 100);
        vm.warp(t0 + 27 hours); // the part it was used in is 7 parts old
        assertEq(h.used(DAY, 6), 0);
        h.consume(DAY, 6, 100, 100);
    }

    function test_aUseNearTheEndOfADayBoundaryDoesNotLetASecondCapThroughRightAfterIt() public {
        // a counter that resets at a fixed hour lets the cap through twice around the reset; this ring never does
        vm.warp(_now() + 3 hours + 59 minutes); // the last minute of a 4 hour part
        h.consume(DAY, 6, 100, 100);
        vm.warp(_now() + 2 minutes); // the next part: a fixed daily reset would be free here
        vm.expectRevert();
        h.consume(DAY, 6, 100, 1);
        vm.warp(_now() + DAY - 3 minutes); // 23h59 after the use: still counted
        vm.expectRevert();
        h.consume(DAY, 6, 100, 1);
        vm.warp(_now() + 2 minutes); // 24h01 after the use: free (this alignment is the shortest case)
        h.consume(DAY, 6, 100, 100);
    }

    function test_amountTooLargeIsRefused() public {
        vm.expectRevert(RollingCap.CapAmountTooLarge.selector);
        h.consume(DAY, 6, type(uint256).max, uint256(type(uint192).max) + 1);
    }

    function test_manySmallCallsAddUpToTheSameLimit() public {
        for (uint256 i; i < 100; ++i) {
            h.consume(DAY, 6, 100, 1);
        }
        vm.expectRevert();
        h.consume(DAY, 6, 100, 1);
        assertEq(h.used(DAY, 6), 100);
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_noStretchOfOneWindowEverPassesTheCap(uint256 seed, uint8 count) public {
        uint256 cap = 1000;
        uint256 n = bound(count, 1, 40);
        uint256[] memory at = new uint256[](n);
        uint256[] memory amt = new uint256[](n);
        uint256 accepted;
        for (uint256 i; i < n; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(_now() + seed % (9 hours));
            uint256 a = (seed >> 64) % 700 + 1;
            try h.consume(DAY, 6, cap, a) {
                at[accepted] = _now();
                amt[accepted] = a;
                accepted++;
            } catch {}
        }
        // for every accepted use, the uses in the 24 hours ending then (itself included) are within the cap
        for (uint256 i; i < accepted; ++i) {
            uint256 sum;
            for (uint256 j; j <= i; ++j) {
                if (at[j] + DAY > at[i]) sum += amt[j];
            }
            assertLe(sum, cap);
        }
    }
}
