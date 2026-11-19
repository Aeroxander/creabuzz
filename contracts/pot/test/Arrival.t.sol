// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "oz5/utils/math/Math.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {PotBase} from "./helpers/PotBase.sol";
import {TreasuryHarness} from "./helpers/TreasuryHarness.sol";

/// @notice Outside money arrives evenly over a time unit, and how much has arrived at any second is ONE formula on the
/// stream's own start, so calling `settle()` every second cannot hold money back (before, each call rounded down and moved the
/// start, so a stream of a few dollars over a real week lost a share of itself to a griefer who settled every second).
contract ArrivalTest is PotBase {
    function setUp() public override {
        super.setUp();
        _relaunch(POOL, 0); // no allowance: the pot moves only by what arrives
        _join(alice, 10_000e6);
    }

    /// @dev The money that should have arrived `elapsed` seconds into a stream of `total` over `unit_` seconds.
    function _arrived(uint256 total, uint256 elapsed, uint256 unit_) internal pure returns (uint256) {
        return elapsed >= unit_ ? total : Math.mulDiv(total, elapsed, unit_);
    }

    function test_settlingEverySecondReleasesTheSameAsSettlingOnce() public {
        uint256 start = vm.getBlockTimestamp();
        uint256 pot0 = t.pot();
        _revenue(carol, 1e6); // one dollar over seven days: one unit and a bit a second
        uint256 id = vm.snapshotState();
        // settled once, an hour later
        vm.warp(start + 1 hours);
        t.settle();
        uint256 potOnce = t.pot();
        uint256 arrivingOnce = t.arriving();
        vm.revertToState(id);
        // settled every second for an hour
        for (uint256 i = 1; i <= 1 hours; ++i) {
            vm.warp(start + i);
            t.settle();
        }
        assertEq(t.pot(), potOnce, "the same pot");
        assertEq(t.arriving(), arrivingOnce, "the same money still on its way");
        assertEq(t.pot() - pot0, _arrived(1e6, 1 hours, UNIT), "and it is exactly the formula");
        assertGt(
            t.pot() - pot0, 3600, "more than one unit a second: the old rule released a unit a second and held the rest"
        );
    }

    function test_theReleasedSoFarIsOneRoundingOfOneFormulaAtAnyCheckpoint() public {
        uint256 start = vm.getBlockTimestamp();
        uint256 pot0 = t.pot();
        _revenue(carol, 123_456_789);
        uint256[7] memory checkpoints = [uint256(1), 100, 3600, 1 days, 3 days, uint256(UNIT) - 1, uint256(UNIT)];
        for (uint256 i; i < checkpoints.length; ++i) {
            uint256 id = vm.snapshotState();
            // reach the checkpoint through several intermediate settles, the way a busy project would
            uint256 step = checkpoints[i] / 5;
            for (uint256 k = 1; k <= 4 && step > 0; ++k) {
                vm.warp(start + step * k);
                t.settle();
            }
            vm.warp(start + checkpoints[i]);
            t.settle();
            assertEq(t.pot() - pot0, _arrived(123_456_789, checkpoints[i], UNIT), "released so far");
            assertEq(t.arriving(), 123_456_789 - (t.pot() - pot0));
            vm.revertToState(id);
        }
    }

    function test_aSecondPaymentMergesAndStaysOneFormulaWhateverTheCadence() public {
        uint256 start = vm.getBlockTimestamp();
        uint256 pot0 = t.pot();
        _revenue(carol, 1e6);
        uint256 id = vm.snapshotState();
        // path A: settle every 7 minutes until the second payment, then every 7 minutes after
        uint256 mid = start + 2 days;
        for (uint256 s = start + 420; s < mid; s += 420) {
            vm.warp(s);
            t.settle();
        }
        vm.warp(mid);
        _revenue(bob, 3e6);
        uint256 endA = t.arrivalEnd();
        uint256 startA = t.arrivalStart();
        for (uint256 s = mid + 420; s < mid + 4 days; s += 420) {
            vm.warp(s);
            t.settle();
        }
        vm.warp(mid + 4 days);
        t.settle();
        uint256 potA = t.pot();
        uint256 arrivingA = t.arriving();
        vm.revertToState(id);
        // path B: no settle at all until the same two moments
        vm.warp(mid);
        _revenue(bob, 3e6);
        assertEq(t.arrivalEnd(), endA, "the merged end does not depend on the cadence");
        assertEq(t.arrivalStart(), startA);
        vm.warp(mid + 4 days);
        t.settle();
        assertEq(t.pot(), potA, "the same pot");
        assertEq(t.arriving(), arrivingA);
        assertEq(t.pot() - pot0 + t.arriving(), 4e6, "nothing was lost or made");
    }

    function test_theStreamIsAllInTheEndAndNothingIsLeftOver() public {
        uint256 start = vm.getBlockTimestamp();
        uint256 pot0 = t.pot();
        _revenue(carol, 7_777_777);
        for (uint256 i = 1; i <= 10; ++i) {
            vm.warp(start + i * 60);
            t.settle();
        }
        vm.warp(start + UNIT);
        t.settle();
        assertEq(t.arriving(), 0);
        assertEq(t.pot() - pot0, 7_777_777);
    }

    function test_aShortUnitProjectReleasesTheSameFormula() public {
        (TreasuryHarness small,,,) = _launch(IERC20(address(usd)), POOL, 0, 200, 168);
        usd.mint(alice, 20_000e6);
        vm.startPrank(alice);
        usd.approve(address(small), 20_000e6);
        small.join(10_000e6, 0, alice);
        small.addRevenue(1e6);
        vm.stopPrank();
        uint256 start = vm.getBlockTimestamp();
        uint256 pot0 = small.pot();
        for (uint256 i = 1; i <= 100; ++i) {
            vm.warp(start + i);
            small.settle();
        }
        assertEq(small.pot() - pot0, _arrived(1e6, 100, 168));
    }
}
