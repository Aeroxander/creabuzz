// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {PotBase} from "./helpers/PotBase.sol";

/// @notice From any reachable state (random joins, partial leaves, outside money, check-ins, Team take-outs; a dust backer first
/// in a third of the runs), a join followed at once by taking everything out must not return more than was paid, beyond the
/// quote offset: 1e14 wei of Shares at the value of one Share, a ten-thousandth of it, plus two units.
contract RoundTripFuzzTest is PotBase {
    address internal attacker = makeAddr("attacker");
    address internal dave = makeAddr("dave");
    uint256 internal rnd;

    function _r(uint256 mod) internal returns (uint256) {
        rnd = uint256(keccak256(abi.encode(rnd)));
        return rnd % mod;
    }

    function _step() internal {
        uint256 k = _r(9);
        address[3] memory us = [alice, bob, carol];
        address u = us[_r(3)];
        if (k <= 2) {
            uint256[6] memory amts = [uint256(1e6), 3e6, 1e8, 1e9, 5e10, 1e12];
            uint256 a = amts[_r(6)] + _r(1e6);
            if (!t.doorOpenNow()) return;
            usd.mint(u, a);
            vm.startPrank(u);
            usd.approve(address(t), a);
            try t.join(a, 0, u) {} catch {}
            vm.stopPrank();
        } else if (k == 3 || k == 4) {
            uint256 bal = shares.balanceOf(u);
            if (bal == 0) return;
            uint256 mode = _r(4);
            uint256 n = mode == 0 ? bal : mode == 1 ? bal - 1 : mode == 2 ? bal / 2 : bal / 1e6 + 1;
            if (n == 0) return;
            vm.prank(u);
            try t.leave(n, 0, u) {} catch {}
        } else if (k == 5) {
            uint256 a = 1e6 + _r(1e11);
            if (shares.totalSupply() == 0 && team.totalSupply() == 0) return; // refused: nobody would own it
            _revenue(dave, a);
        } else if (k == 6) {
            vm.warp(block.timestamp + _r(9 days));
            _checkIn();
        } else if (k == 7) {
            // a Team holder takes out part of a vested grant (the vester stands in)
            uint256 g = team.balanceOf(address(vester));
            if (g == 0) return;
            uint256 x = g / (1 + _r(50));
            vm.prank(address(vester));
            team.transfer(dave, x);
            uint256 n = x / (1 + _r(3));
            if (n == 0) return;
            vm.prank(dave);
            try t.leaveTeam(n, 0, dave) {} catch {}
        } else {
            vm.warp(block.timestamp + _r(2 days));
            _checkIn();
        }
    }

    function testFuzz_roundTripNeverNets(uint256 seed, uint8 cfg, uint8 steps, uint256 aSel) public {
        rnd = seed;
        uint256[3] memory pools = [uint256(0), 1000e18, POOL];
        uint16[2] memory fees = [uint16(200), 200];
        uint32[2] memory rates = [uint32(0), 1000];
        (t, shares, team, vester) =
            _launch(IERC20(address(usd)), pools[cfg % 3], rates[(cfg / 3) % 2], fees[(cfg / 6) % 2], UNIT);
        uint256 n = uint256(steps) % 60;
        for (uint256 i; i < n; ++i) {
            _step();
        }
        vm.warp(block.timestamp + 8 days);
        _checkIn();
        // the attacker may keep dust first
        if (aSel % 3 == 0) {
            _join(attacker, 1e6);
            uint256 bal = shares.balanceOf(attacker);
            vm.prank(attacker);
            try t.leave(bal - 1, 0, attacker) {} catch {}
        }
        // Money that nobody owns (no backer, no Team Share, but dollars in the pot or still arriving: a payment whose last
        // backer took out before it arrived, in a project with no Team pool) goes to whoever joins next. No holder loses, so
        // it is outside this property (the report, "declined").
        if (shares.totalSupply() == 0 && team.totalSupply() == 0 && t.pot() + t.arriving() > 1e4) return;
        uint256[5] memory sizes = [uint256(1e6), 1e8, 1e10, 1e12, 1e14];
        uint256 a = sizes[aSel % 5] + (aSel / 5) % 1e6;
        uint256 lv = shares.totalSupply() == 0 ? 0 : t.leaveValue();
        usd.mint(attacker, a);
        uint256 balBefore = usd.balanceOf(attacker);
        vm.startPrank(attacker);
        usd.approve(address(t), a);
        try t.join(a, 0, attacker) {}
        catch {
            vm.stopPrank();
            return;
        }
        uint256 held = shares.balanceOf(attacker);
        try t.leave(held, 0, attacker) {} catch {}
        vm.stopPrank();
        uint256 balAfter = usd.balanceOf(attacker);
        assertLe(balAfter, balBefore + 2 + lv / 1e4, "round trip nets more than the offset allows");
    }
}
