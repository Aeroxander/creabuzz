// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";
import {DeployPot} from "../script/DeployPot.s.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {HolderPause} from "../src/HolderPause.sol";

/// @notice The deploy script's settings, run in-process (`new DeployPot().run()`): the default (nothing set) binds nothing; the
/// pause switch binds a `HolderPause` to the Launcher in the same broadcast, the deployer is the broadcaster and the binding
/// lands inside the first hour; a setting out of range reverts before anything is sent. (There was no test of this script before
/// the pause: the chain loop was the first run.) Run on chain id 11155111 (a test network) so the file the script writes,
/// `deployments/pot-11155111.json`, never touches the local chain's; the test removes it again.
///
/// One test function runs every case in order: the script reads process environment variables, and test functions of one
/// contract run in parallel, so separate tests would see each other's settings.
contract DeployPotSettingsTest is Test {
    function _run() internal returns (DeployPot.Deployed memory d) {
        d = new DeployPot().run();
    }

    function test_everySettingOfTheDeployScript() public {
        vm.chainId(11_155_111);
        vm.setEnv("UNIT", "1680");
        vm.setEnv("HOLDER_PAUSE", "0");
        // ---- the default: nothing bound
        DeployPot.Deployed memory d = _run();
        Launcher l = Launcher(d.launcher);
        assertEq(l.holderPauseImpl(), address(0), "default: the pause is off");
        assertEq(d.holderPause, address(0));
        assertEq(
            l.deployer(), d.admin, "on a test network the sender is the default admin: the broadcaster deployed it"
        );
        assertEq(l.deployedAt(), block.timestamp);
        (,,,, uint128 agentUsd) = l.platform();
        assertEq(agentUsd, 25e6);
        string memory json = vm.readFile("deployments/pot-11155111.json");
        assertEq(vm.parseJsonAddress(json, ".holderPause"), address(0));
        assertEq(vm.parseJsonAddress(json, ".launcher"), d.launcher, "the file still names the Launcher");

        // ---- the pause switched on: deployed and bound in the same broadcast
        vm.setEnv("HOLDER_PAUSE", "1");
        vm.recordLogs();
        d = _run();
        l = Launcher(d.launcher);
        assertTrue(d.holderPause != address(0));
        assertEq(l.holderPauseImpl(), d.holderPause, "bound");
        assertEq(l.deployer(), d.admin);
        assertTrue(d.holderPause.code.length > 0);
        assertLe(block.timestamp, uint256(l.deployedAt()) + 1 hours, "the binding landed inside the first hour");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 bound;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == d.launcher && logs[i].topics[0] == Launcher.HolderPauseBound.selector) {
                ++bound;
                (address impl, bytes32 h) = abi.decode(logs[i].data, (address, bytes32));
                assertEq(impl, d.holderPause);
                assertEq(h, d.holderPause.codehash, "the published hash is the bound code's");
            }
        }
        assertEq(bound, 1, "one HolderPauseBound");
        json = vm.readFile("deployments/pot-11155111.json");
        assertEq(vm.parseJsonAddress(json, ".holderPause"), d.holderPause);
        assertEq(vm.parseJsonBytes32(json, ".holderPauseCodehash"), d.holderPause.codehash);
        // a project launched from it is born with a pause; the founder's hash covers the switch
        assertTrue(l.settingsHash() != keccak256(abi.encode(_platformOf(l))), "the bound switch is in the hash");
        address founder = makeAddr("founder");
        bytes32 hash_ = l.settingsHash();
        vm.prank(founder);
        (,, address tr,) =
            l.launch("p", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: 1_000_000e18}), hash_);
        assertTrue(Treasury(tr).pauseGate() != address(0));

        // ---- out of range: refused before anything is sent
        vm.setEnv("HOLDER_PAUSE", "2");
        DeployPot bad = new DeployPot();
        vm.expectRevert(bytes("HOLDER_PAUSE must be 0 or 1"));
        bad.run();

        // ---- leave nothing behind
        vm.setEnv("HOLDER_PAUSE", "0");
        vm.removeFile("deployments/pot-11155111.json");
    }

    function _platformOf(Launcher l) internal view returns (Launcher.Platform memory p) {
        (p.quote, p.platform, p.feeBps, p.unit, p.agentUsd) = l.platform();
    }
}
