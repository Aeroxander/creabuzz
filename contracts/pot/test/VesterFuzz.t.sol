// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Vester} from "../src/Vester.sol";

/// @notice Random runs of grants, vesting, quiet spells, claims, own exits, burns and joins through the real stack. After every
/// step: the Vester still holds what it owes, the burn queue Z is exactly the announced grants' unburned part, Team Shares are
/// never created after birth, and no member's claimed part passes what has vested.
contract VesterFuzzTest is StackBase {
    function testFuzz_theVesterAlwaysHoldsWhatItOwesAndZIsTheAnnouncedPart(uint256 seed) public {
        _use(_launch(founder, "fz", 1000, POOL));
        _join(alice, 50_000e6);
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 40; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = seed % 7;
            uint256 r = seed >> 8;
            uint256 n = v.grantCount();
            if (op == 0) {
                vm.prank(founder);
                try t.grantTeam(who[r % 3], 1 + (r >> 4) % (POOL / 20)) {} catch {}
            } else if (op == 1) {
                _active((r % (20 * UNIT)) + 1);
            } else if (op == 2) {
                vm.warp(block.timestamp + (r % (5 * UNIT)));
            } else if (op == 3 && n > 0) {
                try v.claim(r % n) {} catch {}
            } else if (op == 4 && n > 0) {
                uint256 id = r % n;
                vm.prank(v.grantOf(id).member);
                try v.announceForfeit(id) {} catch {}
            } else if (op == 5 && n > 0) {
                try v.execute(r % n) {} catch {}
            } else if (op == 6 && t.doorOpenNow()) {
                _join(who[r % 3], 1e6 + r % 1000e6);
            }
            _checkInvariants();
        }
    }

    function _checkInvariants() internal view {
        uint256 owed;
        uint256 pendingBurn;
        for (uint256 id; id < v.grantCount(); ++id) {
            Vester.Grant memory g = v.grantOf(id);
            owed += g.total - g.claimed + g.burn;
            if (g.state == Vester.State.Announced) pendingBurn += g.burn;
            assertLe(g.claimed, v.vestedOf(id), "claimed more than vested");
            assertLe(v.vestedOf(id), g.total);
        }
        assertEq(v.committed(), owed, "committed is exactly what is owed");
        assertGe(team.balanceOf(address(v)), v.committed(), "the Vester holds what it owes");
        assertEq(t.Z(), pendingBurn, "Z is the announced, unburned part");
        assertLe(t.Z(), team.totalSupply());
        assertLe(team.totalSupply(), POOL, "Team Shares are never created after birth");
    }
}
