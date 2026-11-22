// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";
import {DeployPot} from "../script/DeployPot.s.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {HolderVote} from "../src/HolderVote.sol";
import {IHolderVote} from "../src/Interfaces.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice The deploy script with the Council switch (COUNCIL-PLAN 4.3), run in-process (`new DeployPot().run()`): with COUNCIL=1
/// and HOLDER_PAUSE=1 it deploys `HolderVote` as the pause implementation (not a `HolderPause`) and a `Council`, binds both to the
/// Launcher in the same broadcast, writes `holderVote`/`holderVoteCodehash` to `deployments/pot-<chainid>.json` (and the code hash
/// of the vote contract as the pause's), and a project launched from it is born with a `HolderVote` as its pause bound to its
/// project. With COUNCIL=0 it deploys a plain `HolderPause`, nothing names a `holderVote`, and a launched project has a plain
/// pause. Run on chain id 11155111 (a test network) so the file the script writes never touches the local chain's; the test
/// removes it again.
///
/// One test function runs every case in order, as `DeployPotSettings.t.sol` does: the script reads process environment variables,
/// and test contracts run in parallel, so separate tests would see each other's settings. (That same rule means this file and
/// `DeployPotSettings.t.sol` both set COUNCIL and HOLDER_PAUSE, which is the env race they share: each passes alone; see the K2
/// report.)
contract DeployVoteSettingsTest is Test {
    address internal founder = makeAddr("founder");

    function _run() internal returns (DeployPot.Deployed memory d) {
        d = new DeployPot().run();
    }

    /// @dev Launch a project on `l` as `founder` and return its Treasury.
    function _launchOn(Launcher l, bytes32 id) internal returns (Treasury tr) {
        bytes32 h = l.settingsHash();
        vm.prank(founder);
        (,, address treasury,) =
            l.launch(id, "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: 1_000_000e18}), h);
        tr = Treasury(treasury);
    }

    /// @dev True when `who` answers `isVote()` (true only for a `HolderVote`).
    function _isVote(address who) internal view returns (bool answers, bool saidYes) {
        (bool ok, bytes memory ret) = who.staticcall(abi.encodeCall(IHolderVote.isVote, ()));
        answers = ok;
        saidYes = ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    function test_everySettingOfTheDeployScriptWithTheCouncilSwitch() public {
        vm.chainId(11_155_111);
        vm.setEnv("UNIT", "1680");

        // ================================================== COUNCIL=0: a plain pause, no vote contract
        vm.setEnv("HOLDER_PAUSE", "1");
        vm.setEnv("COUNCIL", "0");
        DeployPot.Deployed memory d = _run();
        Launcher l = Launcher(d.launcher);
        assertTrue(d.holderPause != address(0), "the pause is deployed");
        assertEq(d.holderVote, address(0), "with the Council off no HolderVote is deployed");
        assertEq(d.council, address(0));
        assertEq(l.holderPauseImpl(), d.holderPause, "the plain pause is bound");
        assertEq(l.councilImpl(), address(0));
        assertFalse(l.councilBound());
        (bool answers, bool saidYes) = _isVote(d.holderPause);
        assertFalse(answers && saidYes, "the pause implementation is not a HolderVote");
        string memory json = vm.readFile("deployments/pot-11155111.json");
        assertEq(vm.parseJsonAddress(json, ".holderVote"), address(0), "holderVote is zero in the file");
        assertEq(vm.parseJsonAddress(json, ".holderPause"), d.holderPause);
        assertEq(vm.parseJsonBytes32(json, ".holderPauseCodehash"), d.holderPause.codehash);
        // a project launched from it gets a plain pause, not a vote contract
        Treasury tr = _launchOn(l, "plain");
        address gate = tr.pauseGate();
        assertTrue(gate != address(0), "the project has a pause");
        (answers, saidYes) = _isVote(gate);
        assertFalse(answers && saidYes, "a project launched with the Council switch off has a plain pause");
        assertEq(HolderPause(gate).day(), 240, "the demo unit's four-minute day");

        // ============================== COUNCIL=1 (and HOLDER_PAUSE=1): the vote contract is the pause, and a Council
        vm.setEnv("COUNCIL", "1");
        vm.recordLogs();
        d = _run();
        l = Launcher(d.launcher);
        assertTrue(d.holderVote != address(0), "the vote contract is deployed");
        assertEq(d.holderPause, d.holderVote, "with the Council on, the pause implementation IS the vote contract");
        assertEq(l.holderPauseImpl(), d.holderVote, "and that is what is bound to the Launcher");
        assertTrue(d.council != address(0));
        assertEq(l.councilImpl(), d.council, "the Council implementation is bound");
        assertTrue(l.councilBound());
        assertTrue(HolderVote(d.holderVote).isVote(), "a HolderVote");
        assertLe(block.timestamp, uint256(l.deployedAt()) + 1 hours, "the bindings landed inside the first hour");
        // the events publish the bound code's hash
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 boundPause;
        uint256 boundCouncil;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != d.launcher) continue;
            if (logs[i].topics[0] == Launcher.HolderPauseBound.selector) {
                ++boundPause;
                (address impl, bytes32 h) = abi.decode(logs[i].data, (address, bytes32));
                assertEq(impl, d.holderVote, "HolderPauseBound names the vote contract (it is the pause)");
                assertEq(h, d.holderVote.codehash);
            }
            if (logs[i].topics[0] == Launcher.CouncilBound.selector) {
                ++boundCouncil;
                (address impl, bytes32 h) = abi.decode(logs[i].data, (address, bytes32));
                assertEq(impl, d.council);
                assertEq(h, d.council.codehash);
            }
        }
        assertEq(boundPause, 1, "one HolderPauseBound");
        assertEq(boundCouncil, 1, "one CouncilBound");
        // the file names both, with the vote contract's code hash under both its own key and the pause's
        json = vm.readFile("deployments/pot-11155111.json");
        assertEq(vm.parseJsonAddress(json, ".holderVote"), d.holderVote);
        assertEq(vm.parseJsonBytes32(json, ".holderVoteCodehash"), d.holderVote.codehash);
        assertEq(vm.parseJsonAddress(json, ".holderPause"), d.holderVote);
        assertEq(vm.parseJsonBytes32(json, ".holderPauseCodehash"), d.holderVote.codehash);
        assertEq(vm.parseJsonAddress(json, ".council"), d.council);
        assertEq(vm.parseJsonBytes32(json, ".councilCodehash"), d.council.codehash);
        // a launched project is born with a HolderVote as its pause, bound to its own project
        bytes32 id = "voted";
        Treasury trV = _launchOn(l, id);
        HolderVote gateV = HolderVote(trV.pauseGate());
        assertTrue(address(gateV) != address(0), "the project has a pause");
        assertTrue(address(gateV) != d.holderVote, "its own clone, not the implementation");
        assertTrue(gateV.isVote(), "the project's pause is the vote contract");
        assertEq(address(gateV.treasury()), address(trV), "bound to its Treasury");
        assertEq(gateV.key(), l.keyOf(founder, id), "bound to its project's key");
        assertEq(address(gateV.launcher()), d.launcher, "and to the Launcher");
        assertEq(gateV.day(), 240);
        assertEq(
            l.settingsHash(),
            keccak256(abi.encode(_platformOf(l), d.holderVote, address(0), d.council)),
            "the founder's hash covers the Council switch"
        );

        // ================================================== back to COUNCIL=0: the plain pause again, holderVote zero
        vm.setEnv("COUNCIL", "0");
        d = _run();
        l = Launcher(d.launcher);
        assertEq(d.holderVote, address(0));
        assertTrue(d.holderPause != address(0));
        assertEq(l.holderPauseImpl(), d.holderPause);
        assertEq(l.councilImpl(), address(0));
        json = vm.readFile("deployments/pot-11155111.json");
        assertEq(vm.parseJsonAddress(json, ".holderVote"), address(0));
        assertEq(vm.parseJsonAddress(json, ".holderPause"), d.holderPause);
        (answers, saidYes) = _isVote(d.holderPause);
        assertFalse(answers && saidYes, "a plain pause again");

        // ---- leave nothing behind
        vm.setEnv("HOLDER_PAUSE", "0");
        vm.setEnv("COUNCIL", "0");
        vm.removeFile("deployments/pot-11155111.json");
    }

    function _platformOf(Launcher l) internal view returns (Launcher.Platform memory p) {
        (p.quote, p.platform, p.feeBps, p.unit, p.agentUsd) = l.platform();
    }
}
