// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Vester} from "../src/Vester.sol";
import {IShares} from "../src/Interfaces.sol";
import {Clones} from "oz5/proxy/Clones.sol";

/// @notice Vester alone, with a plain address standing in for the pool-open signal (the treasury, in a real project).
contract VesterTest is Test {
    ShareToken internal token;
    Vester internal v;
    address internal starter = makeAddr("starter");
    address internal granter = makeAddr("granter");
    address internal founder = makeAddr("founder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint256 internal constant FOUNDER_SHARES = 200_000_000e18;
    uint256 internal constant YEAR = 365 days;

    function setUp() public {
        vm.warp(1_800_000_000);
        v = Vester(Clones.clone(address(new Vester())));
        token = ShareToken(Clones.clone(address(new ShareToken())));
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (to[0], amounts[0]) = (address(v), 250_000_000e18); // 200M for the founder and 50M for gifts
        (to[1], amounts[1]) = (alice, 750_000_000e18);
        token.initialize("P", "P", to, amounts);
        v.initialize(IShares(address(token)), starter, granter, founder, FOUNDER_SHARES);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp(); // `block.timestamp` is constant to the optimizer, so it is stale after vm.warp
    }

    function _start() internal {
        vm.prank(starter);
        v.startNow();
    }

    function test_init_recordsTheFounderGrantAndRolesAndRefusesASecondCall() public {
        (uint256 total, uint256 claimed) = v.grants(founder);
        assertEq(total, FOUNDER_SHARES);
        assertEq(claimed, 0);
        assertEq(v.committed(), FOUNDER_SHARES);
        assertEq(v.starter(), starter);
        assertEq(v.granter(), granter);
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        v.initialize(IShares(address(token)), alice, alice, alice, 1);
    }

    function test_init_theImplementationIsLocked() public {
        Vester impl = new Vester();
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        impl.initialize(IShares(address(token)), alice, alice, alice, 1);
    }

    function test_init_theFounderGrantMustBeHeldHere() public {
        Vester fresh = Vester(Clones.clone(address(new Vester())));
        vm.expectRevert(Vester.NotFunded.selector);
        fresh.initialize(IShares(address(token)), starter, granter, founder, 1);
    }

    function test_nothingIsReleasedUntilTheClockStarts() public {
        vm.warp(_now() + 5 * YEAR);
        assertEq(v.released(founder), 0);
        assertEq(v.claimable(founder), 0);
        assertEq(v.claim(founder), 0);
        assertEq(token.balanceOf(founder), 0);
    }

    function test_start_onlyTheStarterAndOnlyOnce() public {
        vm.expectRevert(Vester.NotAllowed.selector);
        v.startNow();
        _start();
        assertEq(v.start(), _now());
        vm.prank(starter);
        vm.expectRevert(Vester.WrongPhase.selector);
        v.startNow();
    }

    function test_release_isLinearOverAYearFromTheStart() public {
        _start();
        vm.warp(_now() + YEAR / 4);
        assertEq(v.released(founder), FOUNDER_SHARES / 4);
        assertEq(v.claim(founder), FOUNDER_SHARES / 4);
        assertEq(token.balanceOf(founder), FOUNDER_SHARES / 4);
        vm.warp(_now() + YEAR / 4);
        assertEq(v.claimable(founder), FOUNDER_SHARES / 4); // only the new quarter
        vm.warp(_now() + 10 * YEAR);
        v.claim(founder);
        assertEq(token.balanceOf(founder), FOUNDER_SHARES); // everything, nothing more
        assertEq(v.claim(founder), 0);
        assertEq(v.committed(), 0);
    }

    function test_claim_anyoneMayCallButTheSharesGoToTheBeneficiary() public {
        _start();
        vm.warp(_now() + YEAR);
        vm.prank(bob);
        v.claim(founder);
        assertEq(token.balanceOf(founder), FOUNDER_SHARES);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_grant_onlyTheGranter_onlyBeforeStart_onlyIfFunded() public {
        vm.prank(alice);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.grant(alice, 1);
        vm.startPrank(granter);
        vm.expectRevert(Vester.BadGrant.selector);
        v.grant(address(0), 1);
        vm.expectRevert(Vester.BadGrant.selector);
        v.grant(alice, 0);
        v.grant(alice, 50_000_000e18); // exactly what is left over
        vm.expectRevert(Vester.NotFunded.selector);
        v.grant(bob, 1); // nothing left to cover it
        vm.stopPrank();
        _start();
        vm.prank(granter);
        vm.expectRevert(Vester.WrongPhase.selector);
        v.grant(bob, 1);
    }

    function test_grant_shareTheSameScheduleFromTheSameStart() public {
        vm.prank(granter);
        v.grant(alice, 40e18);
        vm.warp(_now() + 100 days); // time before the pool opens does not count
        _start();
        vm.warp(_now() + YEAR / 2);
        assertEq(v.released(alice), 20e18);
        assertEq(v.released(founder), FOUNDER_SHARES / 2);
    }

    function test_strayShares_sentHereAreNotAnyonesToClaim() public {
        vm.prank(alice);
        token.transfer(address(v), 7e18);
        assertEq(v.committed(), FOUNDER_SHARES);
        vm.prank(granter);
        v.grant(bob, 40e18);
        _start();
        vm.warp(_now() + YEAR);
        v.claim(founder);
        v.claim(bob);
        assertEq(token.balanceOf(founder) + token.balanceOf(bob), FOUNDER_SHARES + 40e18);
        assertEq(v.committed(), 0);
        assertEq(token.balanceOf(address(v)), 50_000_000e18 + 7e18 - 40e18); // the rest stays here, claimed by nobody
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_releasedNeverExceedsTheGrantAndNeverFallsAsTimePasses(uint256 g, uint256 t1, uint256 t2) public {
        g = bound(g, 1, 50_000_000e18);
        vm.prank(granter);
        v.grant(alice, g);
        _start();
        t1 = bound(t1, 0, 2 * YEAR);
        t2 = bound(t2, t1, 3 * YEAR);
        uint256 s = v.start();
        vm.warp(s + t1);
        uint256 r1 = v.released(alice);
        vm.warp(s + t2);
        uint256 r2 = v.released(alice);
        assertLe(r1, r2);
        assertLe(r2, g);
        assertEq(r2, t2 >= YEAR ? g : g * t2 / YEAR);
        v.claim(alice);
        assertEq(token.balanceOf(alice), 750_000_000e18 + r2);
    }
}
