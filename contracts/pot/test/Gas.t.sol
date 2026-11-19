// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";

/// @notice What the calls people make cost, measured inside the call (the transaction's own 21,000 and calldata are not
/// counted), with the Treasury and the tokens made cold first so storage reads are priced as in a fresh transaction.
/// The numbers are logged; the assertions are generous ceilings that a heavy regression would break. The real receipts on a
/// local chain are in `scripts/pot-chain-loop.sh`.
contract GasTest is StackBase {
    function _cold() internal {
        vm.cool(address(t));
        vm.cool(address(shares));
        vm.cool(address(team));
        vm.cool(address(usd));
        vm.cool(address(v));
    }

    function setUp() public override {
        super.setUp();
        _join(alice, 50_000e6);
        _join(bob, 20_000e6);
        _revenue(carol, 5000e6);
        vm.prank(founder);
        t.grantTeam(dave, 1_000_000e18);
        _active(14 * uint256(UNIT));
        v.claim(0);
        vm.warp(block.timestamp + 2 days);
    }

    function test_gas_join() public {
        usd.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usd.approve(address(t), 100e6);
        _cold();
        uint256 g = gasleft();
        t.join(100e6, 0, stranger);
        uint256 used = g - gasleft();
        vm.stopPrank();
        emit log_named_uint("join (approve path, other backers exist), gas", used);
        assertLt(used, 300_000);
    }

    function test_gas_leaveSomeAndLeaveAll() public {
        uint256 n = shares.balanceOf(alice);
        vm.startPrank(alice);
        _cold();
        uint256 g = gasleft();
        t.leave(n / 4, 0, alice);
        uint256 used = g - gasleft();
        emit log_named_uint("leave a quarter (others remain), gas", used);
        assertLt(used, 200_000);
        _cold();
        g = gasleft();
        t.leave(shares.balanceOf(alice), 0, alice);
        used = g - gasleft();
        emit log_named_uint("leave the rest (others remain), gas", used);
        assertLt(used, 200_000);
        vm.stopPrank();
    }

    function test_gas_leaveTeam() public {
        uint256 n = team.balanceOf(dave) / 2;
        vm.startPrank(dave);
        _cold();
        uint256 g = gasleft();
        t.leaveTeam(n, 0, dave);
        uint256 used = g - gasleft();
        vm.stopPrank();
        emit log_named_uint("leave Team Shares, gas", used);
        assertLt(used, 200_000);
    }

    function test_gas_draw_checkIn_settle_revenue() public {
        _cold();
        uint256 g = gasleft();
        t.settle();
        emit log_named_uint("settle (time has passed), gas", g - gasleft());
        uint256 box = t.box();
        vm.startPrank(founder);
        _cold();
        g = gasleft();
        t.draw(founder, box);
        uint256 used = g - gasleft();
        emit log_named_uint("draw, gas", used);
        assertLt(used, 200_000);
        _cold();
        g = gasleft();
        t.checkIn(bytes32(uint256(1)));
        used = g - gasleft();
        emit log_named_uint("check in, gas", used);
        assertLt(used, 150_000);
        vm.stopPrank();
        usd.mint(carol, 10e6);
        vm.startPrank(carol);
        usd.approve(address(t), 10e6);
        _cold();
        g = gasleft();
        t.addRevenue(10e6);
        used = g - gasleft();
        vm.stopPrank();
        emit log_named_uint("add outside money, gas", used);
        assertLt(used, 200_000);
    }

    function test_gas_grantAndClaim() public {
        vm.startPrank(founder);
        _cold();
        uint256 g = gasleft();
        uint256 id = t.grantTeam(stranger, 1000e18);
        uint256 used = g - gasleft();
        vm.stopPrank();
        emit log_named_uint("grant Team Shares, gas", used);
        assertLt(used, 250_000);
        _active(14 * uint256(UNIT));
        _cold();
        g = gasleft();
        v.claim(id);
        used = g - gasleft();
        emit log_named_uint("claim vested Team Shares, gas", used);
        assertLt(used, 150_000);
    }
}
