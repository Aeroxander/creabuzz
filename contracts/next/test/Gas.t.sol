// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "./helpers/Base.sol";
import {Launcher} from "../src/Launcher.sol";

/// @notice Gas of the steps a person presses, measured with the production compiler settings (0.8.37, 200 runs). Numbers
/// print with `-vv`; the assertions pin each one with room to spare so a slip shows up.
contract GasTest is Base {
    /// @dev Make every contract of the project cold again, so a measured call pays for its first read of each slot, as a
    /// real transaction does. The 21,000 base cost and the calldata of the transaction are not included in any number.
    function _cold() internal {
        vm.cool(address(t));
        vm.cool(address(shares));
        vm.cool(address(v));
        vm.cool(address(usd));
        vm.cool(address(launcher));
    }

    function _measure(string memory label, uint256 g, uint256 limit) internal {
        emit log_named_uint(label, g);
        assertLt(g, limit, label);
    }

    function test_gas_launchTheProject() public {
        bytes memory call =
            abi.encodeCall(Launcher.launch, (keccak256("gas"), "Project Gas", "GAS", launcher.settingsHash()));
        vm.prank(alice);
        _cold();
        uint256 g = gasleft();
        (bool ok,) = address(launcher).call(call);
        g -= gasleft();
        assertTrue(ok);
        _measure("Launcher.launch: four clones, the allocation, the setup (first project of this founder)", g, 1_100_000);
        // a second project in the same network is the same work with warm settings
        vm.prank(bob);
        _cold();
        g = gasleft();
        (ok,) = address(launcher).call(call);
        g -= gasleft();
        assertTrue(ok);
        _measure("Launcher.launch: another founder", g, 1_100_000);
    }

    function test_gas_deployTheLauncher() public {
        bytes memory args = abi.encode(admin, _settings(), STRATEGY, GUARD, minBid);
        _cold();
        uint256 g = gasleft();
        deployCode("Launcher.sol:Launcher", args);
        g -= gasleft();
        _measure("deploy Launcher (with the five implementations inside)", g, 9_000_000);
    }

    function test_gas_giveShares() public {
        // before the pool: to the Vester
        vm.prank(founder);
        _cold();
        uint256 g = gasleft();
        t.giveShares(alice, 1000 * SHARE);
        g -= gasleft();
        _measure("giveShares before the pool (first gift: new beneficiary in the Vester)", g, 300_000);
        vm.prank(founder);
        _cold();
        g = gasleft();
        t.giveShares(alice, 1000 * SHARE);
        g -= gasleft();
        _measure("giveShares before the pool (same beneficiary again)", g, 200_000);
        _openPool();
        vm.prank(founder);
        _cold();
        g = gasleft();
        t.giveShares(bob, 1000 * SHARE);
        g -= gasleft();
        _measure("giveShares after the pool (straight to the person, first gift of the month)", g, 200_000);
        vm.prank(founder);
        _cold();
        g = gasleft();
        t.giveShares(carol, 1000 * SHARE);
        g -= gasleft();
        _measure("giveShares after the pool (second gift in the same period)", g, 150_000);
        vm.prank(founder);
        t.authoriseAgent(agent);
        vm.prank(agent);
        _cold();
        g = gasleft();
        t.giveShares(carol, 1000 * SHARE);
        g -= gasleft();
        _measure("giveShares by an agent after the pool (first use of its cap)", g, 250_000);
    }

    function test_gas_checkIn() public {
        _sale(7500 * DOLLAR);
        vm.warp(_now() + 3 days);
        vm.prank(founder);
        _cold();
        uint256 g = gasleft();
        t.checkIn();
        g -= gasleft();
        _measure("checkIn (works out 3 days of release first)", g, 100_000);
        vm.warp(_now() + 3 days);
        vm.prank(founder);
        _cold();
        g = gasleft();
        t.checkIn();
        g -= gasleft();
        _measure("checkIn (again)", g, 100_000);
    }

    function test_gas_dailyRelease_isLazy() public {
        _sale(7500 * DOLLAR);
        vm.warp(_now() + 5 days);
        _cold();
        uint256 g = gasleft();
        t.release();
        g -= gasleft();
        _measure("release (asked by anyone after 5 days)", g, 80_000);
        vm.warp(_now() + 5 days);
        vm.prank(founder);
        _cold();
        g = gasleft();
        t.spend(carol, 100 * DOLLAR);
        g -= gasleft();
        _measure("spend by the founder (works out the release inside the call, nothing runs by itself)", g, 130_000);
    }

    function test_gas_handBack() public {
        _world();
        vm.prank(alice);
        _cold();
        uint256 g = gasleft();
        t.handBack(10_000_000 * SHARE);
        g -= gasleft();
        _measure("handBack (first exit: fee owed starts, burn, pay)", g, 200_000);
        vm.prank(bob);
        _cold();
        g = gasleft();
        t.handBack(10_000_000 * SHARE);
        g -= gasleft();
        _measure("handBack (second exit)", g, 150_000);
    }

    function test_gas_theRest() public {
        _cold();
        uint256 g = gasleft();
        _arrive(7500 * DOLLAR);
        vm.prank(opener);
        t.markPoolOpen();
        g -= gasleft();
        _measure("markPoolOpen (starts the Vester's clock)", g, 200_000);
        _cold();
        g = gasleft();
        t.settle(7500 * DOLLAR);
        g -= gasleft();
        _measure("settle (first split)", g, 200_000);
        vm.prank(founder);
        _cold();
        g = gasleft();
        t.spend(carol, DOLLAR);
        g -= gasleft();
        _measure("spend by the founder", g, 120_000);
        vm.warp(_now() + 365 days);
        _cold();
        g = gasleft();
        v.claim(founder);
        g -= gasleft();
        _measure("Vester.claim", g, 100_000);
    }
}
