// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice Design 2.1: "existing holders never lose to a join". The join price carries a tiny quote-only offset (one dollar
/// unit and 1e14 wei of Shares); these tests are the attacks that a LARGE offset (one dollar, 100 Shares) allowed, run against
/// the small one: a join and an immediate take-out must never net more than a few cents, in a tiny project, with no Team
/// pool, with a dust backer, with no fee, or in a project with no backers at all.
contract QuoteOffsetTest is PotBase {
    address internal attacker = makeAddr("attacker");

    function _round(uint256 a) internal returns (int256 net, int256 stayersChange, uint256 fee) {
        uint256 potBefore = t.pot();
        fee = t.feeFor(a);
        usd.mint(attacker, a);
        vm.startPrank(attacker);
        usd.approve(address(t), a);
        uint256 n = t.join(a, 0, attacker);
        uint256 cash = t.leave(n, 0, attacker);
        vm.stopPrank();
        net = int256(cash) - int256(a);
        stayersChange = int256(t.pot()) - int256(potBefore);
    }

    /// Pool 0 (the founder may pick it), a tiny first backer, 10,000 dollars of outside money arrived: with the large offset a
    /// 20,000 join and take-out netted +3,632 dollars from the first backer.
    function test_poolZeroTinyProjectGivesTheJoinerNothing() public {
        _relaunch(0, 0);
        _join(alice, 1e6);
        _revenue(bob, 10_000e6);
        vm.warp(block.timestamp + 8 days);
        _checkIn();
        (int256 net, int256 stay, uint256 fee) = _round(20_000e6);
        assertLe(net, -int256(fee) + 20_000, "the joiner is out the fee, less a cent of offset at most");
        assertGe(stay, -20_000, "the holders lose at most a cent");
    }

    /// The same with the default 10M Team pool, repeated.
    function test_defaultPoolRepeatedRoundTripsNeverNet() public {
        _relaunch(POOL, 0);
        _join(alice, 1e6);
        _revenue(bob, 10_000_000e6);
        vm.warp(block.timestamp + 8 days);
        _checkIn();
        for (uint256 i; i < 5; ++i) {
            (int256 net,, uint256 fee) = _round(20_000e6);
            assertLe(net, -int256(fee) + 20_000);
        }
    }

    /// Fee 0 (the platform may set it): with the large offset 20 round trips of a million gained about 18 dollars from a
    /// 200-dollar pot.
    function test_feeZeroRoundTripsGainAtMostTheOffsetRounding() public {
        (t, shares, team, vester) = _launch(IERC20(address(usd)), 0, 0, 0, UNIT);
        _join(alice, 100e6);
        _revenue(bob, 100e6);
        vm.warp(block.timestamp + 8 days);
        _checkIn();
        int256 total;
        uint256 potBefore = t.pot();
        for (uint256 i; i < 20; ++i) {
            (int256 net,,) = _round(1_000_000e6);
            total += net;
        }
        assertLe(total, 20 * 20_000, "20 round trips gain no more than 20 offset roundings of a cent");
        assertGe(int256(t.pot()), int256(potBefore) - 20 * 20_000);
    }

    /// A dust backer (1 wei of Shares) keeps paid-in per Share astronomical. With a credit computed from the Share count alone
    /// a whole join counted as paid-in, and the joiner took the Team's surplus: +79,803 dollars on a 100,000 join.
    function test_aDustBackerCannotTakeTheTeamsSurplus() public {
        _relaunch(POOL, 0);
        _join(attacker, 1e6);
        uint256 bal = shares.balanceOf(attacker);
        vm.prank(attacker);
        t.leave(bal - 1, 0, attacker);
        assertEq(shares.totalSupply(), 1, "one wei of backer Shares is left");
        _revenue(bob, 1_000_000e6);
        vm.warp(block.timestamp + 8 days);
        _checkIn();
        uint256 a = 100_000e6;
        usd.mint(attacker, a);
        vm.startPrank(attacker);
        usd.approve(address(t), a);
        uint256 n = t.join(a, 0, attacker);
        uint256 credit = t.paidIn();
        uint256 cash = t.leave(shares.balanceOf(attacker), 0, attacker);
        vm.stopPrank();
        assertLt(credit, 98_000e6, "most of the join paid for a slice of the Team's surplus, not paid-in");
        assertLe(cash, a - t.feeFor(a) + 20_000, "the joiner gets back at most what was put in, less the fee");
        assertGt(n, 0);
    }

    /// With no backers and no Team Shares the money would belong to no one, and the first backer would take it for one
    /// dollar (+49,999.98 dollars). Outside money is refused until someone holds a Share.
    function test_outsideMoneyIsRefusedWhileNobodyOwnsAnyShare() public {
        _relaunch(0, 0);
        usd.mint(bob, 50_000e6);
        vm.startPrank(bob);
        usd.approve(address(t), 50_000e6);
        vm.expectRevert(Treasury.NoOwner.selector);
        t.addRevenue(50_000e6);
        vm.stopPrank();
        // once a backer exists it is accepted
        _join(alice, 1e6);
        _revenue(bob, 50_000e6);
        assertEq(t.arriving(), 50_000e6);
    }

    /// A small Team pool (1,000 Team Shares) with 100,000 dollars left from outside money and no backer: the first backer's
    /// join and immediate take-out nets +684 dollars with the large offset.
    function test_smallPoolFirstBackerIntoMoneyAlreadyThereNetsNothing() public {
        uint256[2] memory pools = [uint256(1000e18), POOL];
        for (uint256 i; i < 2; ++i) {
            _relaunch(pools[i], 0);
            _revenue(bob, 100_000e6);
            vm.warp(block.timestamp + 8 days);
            _checkIn();
            uint256[4] memory sizes = [uint256(1e6), 100e6, 10_000e6, 1_000_000e6];
            for (uint256 j; j < 4; ++j) {
                uint256 snap = vm.snapshotState();
                (int256 net,, uint256 fee) = _round(sizes[j]);
                assertLe(net, -int256(fee) + 20_000, "no gain from money that was there before the first backer");
                vm.revertToState(snap);
            }
        }
    }
}
