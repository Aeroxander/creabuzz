// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArbitrator, OpenBounty} from "../src/OpenBounty.sol";
import {ForecastPool, IOpenBountyView} from "../src/ForecastPool.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice Money forecasts (N8): two pools on "will this bounty be paid?", against a real bounty on a post.
contract ForecastPoolTest is Test {
    address internal constant BEN = address(0xBE11);
    address internal constant CARA = address(0xCA2A);
    address internal constant DEV = address(0xDE7);
    address internal constant EVE = address(0xE7E);
    address internal constant ANA = address(0xA11A);
    bytes32 internal constant POST = keccak256("post");

    MandateCurrency internal usd;
    OpenBounty internal bounty;
    ForecastPool internal pool;
    uint64 internal deadline;
    uint256 internal id;

    function setUp() public {
        vm.warp(100 days);
        usd = new MandateCurrency();
        bounty = new OpenBounty(IERC20(address(usd)), IArbitrator(address(0)));
        pool = new ForecastPool(IERC20(address(usd)), IOpenBountyView(address(bounty)));
        address[5] memory people = [BEN, CARA, DEV, EVE, ANA];
        for (uint256 i; i < people.length; ++i) {
            usd.mint(people[i], 5_000e6);
            vm.startPrank(people[i]);
            usd.approve(address(bounty), type(uint256).max);
            usd.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }
        deadline = uint64(block.timestamp + 30 days);
        vm.prank(BEN);
        id = bounty.open(POST, "Paint the lane.", deadline, 100e6);
    }

    function _bet(address who, bool yes, uint256 amount) internal {
        vm.prank(who);
        pool.bet(id, yes, amount);
    }

    function _pay() internal {
        vm.prank(DEV);
        bounty.fileClaim(id, "https://example.com/lane");
        vm.prank(BEN);
        bounty.back(id, 1);
        vm.warp(block.timestamp + bounty.RUN());
        bounty.pay(id);
    }

    function test_the_winners_share_the_losing_pool_by_what_they_put_in() public {
        _bet(CARA, true, 30e6);
        _bet(ANA, true, 10e6);
        _bet(EVE, false, 20e6);
        _pay();
        pool.settle(id);
        (,, uint8 outcome) = pool.pools(id);
        assertEq(outcome, 1);
        assertEq(pool.owed(id, CARA), 30e6 + 15e6);
        assertEq(pool.owed(id, ANA), 10e6 + 5e6);
        assertEq(pool.owed(id, EVE), 0);
        uint256 before = usd.balanceOf(CARA);
        pool.collect(id, CARA); // anyone may send it; it goes to Cara
        assertEq(usd.balanceOf(CARA), before + 45e6);
        vm.expectRevert(abi.encodeWithSelector(ForecastPool.NothingOwed.selector, id, CARA));
        pool.collect(id, CARA);
        vm.expectRevert(abi.encodeWithSelector(ForecastPool.NothingOwed.selector, id, EVE));
        pool.collect(id, EVE);
        pool.collect(id, ANA);
        assertEq(usd.balanceOf(address(pool)), 0);
    }

    function test_a_bounty_whose_refunds_open_settles_no() public {
        _bet(CARA, true, 10e6);
        _bet(EVE, false, 10e6);
        vm.expectRevert(abi.encodeWithSelector(ForecastPool.NotSettled.selector, id));
        pool.settle(id);
        vm.warp(deadline);
        pool.settle(id);
        assertEq(pool.owed(id, EVE), 20e6);
        vm.expectRevert(abi.encodeWithSelector(ForecastPool.AlreadySettled.selector, id));
        pool.settle(id);
    }

    function test_nobody_on_the_winning_side_means_everyone_takes_back_their_own() public {
        _bet(EVE, false, 10e6);
        _bet(CARA, false, 5e6);
        _pay();
        pool.settle(id);
        (,, uint8 outcome) = pool.pools(id);
        assertEq(outcome, 3);
        assertEq(pool.owed(id, EVE), 10e6);
        assertEq(pool.owed(id, CARA), 5e6);
    }

    function test_betting_closes_a_day_before_the_deadline_and_while_work_is_winning() public {
        vm.warp(deadline - 1 days - 1);
        _bet(CARA, true, 1e6);
        vm.warp(deadline - 1 days);
        vm.prank(CARA);
        vm.expectRevert(abi.encodeWithSelector(ForecastPool.Closed.selector, id));
        pool.bet(id, true, 1e6);
    }

    function test_no_bets_while_a_run_is_on() public {
        vm.prank(DEV);
        bounty.fileClaim(id, "https://example.com/lane");
        vm.prank(BEN);
        bounty.back(id, 1);
        vm.prank(CARA);
        vm.expectRevert(abi.encodeWithSelector(ForecastPool.Closed.selector, id));
        pool.bet(id, true, 1e6);
    }

    function test_the_creator_and_claimants_cannot_bet_against_the_work() public {
        vm.prank(BEN);
        vm.expectRevert(abi.encodeWithSelector(ForecastPool.Barred.selector, id));
        pool.bet(id, false, 1e6);
        _bet(BEN, true, 1e6);
        vm.prank(DEV);
        bounty.fileClaim(id, "https://example.com/lane");
        vm.prank(DEV);
        vm.expectRevert(abi.encodeWithSelector(ForecastPool.Barred.selector, id));
        pool.bet(id, false, 1e6);
        _bet(DEV, true, 1e6);
    }

    function test_each_wallet_puts_at_most_the_cap_and_something() public {
        _bet(CARA, true, 600e6);
        vm.prank(CARA);
        vm.expectRevert(abi.encodeWithSelector(ForecastPool.OverCap.selector, id, 400e6));
        pool.bet(id, false, 401e6);
        _bet(CARA, false, 400e6);
        vm.prank(EVE);
        vm.expectRevert(ForecastPool.NothingToBet.selector);
        pool.bet(id, true, 0);
        vm.prank(EVE);
        vm.expectRevert(abi.encodeWithSelector(ForecastPool.UnknownBounty.selector, 9));
        pool.bet(9, true, 1e6);
    }

    function testFuzz_payouts_never_exceed_the_pools(uint64[4] memory amounts, bool[4] memory sides, bool paid) public {
        address[4] memory people = [CARA, EVE, ANA, address(0xF00)];
        usd.mint(people[3], 5_000e6);
        vm.prank(people[3]);
        usd.approve(address(pool), type(uint256).max);
        uint256 total;
        for (uint256 i; i < 4; ++i) {
            uint256 a = bound(amounts[i], 1, 1_000e6);
            _bet(people[i], sides[i], a);
            total += a;
        }
        if (paid) _pay();
        else vm.warp(deadline);
        pool.settle(id);
        uint256 out;
        for (uint256 i; i < 4; ++i) {
            out += pool.owed(id, people[i]);
        }
        assertLe(out, total);
        assertLe(total - out, 4, "only rounding stays behind");
    }
}
