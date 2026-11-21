// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";
import {DeployPot} from "../script/DeployPot.s.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {EarlierGrants} from "../src/EarlierGrants.sol";
import {Vester} from "../src/Vester.sol";

/// @notice The deploy script's settings, run in-process (`new DeployPot().run()`): the default (nothing set) binds nothing; the
/// pause switch binds a `HolderPause` to the Launcher in the same broadcast, the deployer is the broadcaster and the binding
/// lands inside the first hour; a setting out of range reverts before anything is sent. (There was no test of this script before
/// the pause: the chain loop was the first run.) Run on chain id 11155111 (a test network) so the file the script writes,
/// `deployments/pot-11155111.json`, never touches the local chain's; the test removes it again.
///
/// The earlier-grant settings are covered the same way: none is the default and nothing is claimable; any of the six without the
/// others reverts before anything is sent; all six deploy the claim contract and bind it in the same broadcast; a pool over the
/// founder cap needs `EARLIER_ALLOW_LARGE=1`. Every list, text and account here is invented.
///
/// One test function runs every case in order: the script reads process environment variables, and test functions of one
/// contract run in parallel, so separate tests would see each other's settings.
contract DeployPotSettingsTest is Test {
    bytes32 internal constant ROOT = keccak256("an invented list fingerprint");
    bytes32 internal constant TXT = keccak256("an invented text fingerprint");
    bytes32 internal constant ZID = "zero";
    address internal zeroFounder = makeAddr("zero-founder");

    /// @dev Set the six earlier settings and the large-pool switch (zero reads as "not set").
    function _earlierSettings(
        bytes32 root_,
        bytes32 text_,
        uint256 total_,
        uint256 rows_,
        address founder_,
        bytes32 id_,
        uint256 allowLarge
    ) internal {
        vm.setEnv("EARLIER_ROOT", vm.toString(root_));
        vm.setEnv("EARLIER_TEXT_HASH", vm.toString(text_));
        vm.setEnv("EARLIER_TOTAL", vm.toString(total_));
        vm.setEnv("EARLIER_ROWS", vm.toString(rows_));
        vm.setEnv("EARLIER_FOUNDER", vm.toString(founder_));
        vm.setEnv("EARLIER_PROJECT_ID", vm.toString(id_));
        vm.setEnv("EARLIER_ALLOW_LARGE", vm.toString(allowLarge));
    }

    function _expectEarlierRefusal(
        bytes32 root_,
        bytes32 text_,
        uint256 total_,
        uint256 rows_,
        address founder_,
        bytes32 id_,
        string memory why
    ) internal {
        _earlierSettings(root_, text_, total_, rows_, founder_, id_, 0);
        DeployPot bad = new DeployPot();
        vm.expectRevert(bytes(why));
        bad.run();
    }

    function _expectEarlierRefusal2(uint256 total_, uint256 allowLarge, string memory why) internal {
        _earlierSettings(ROOT, TXT, total_, 4, zeroFounder, ZID, allowLarge);
        DeployPot bad = new DeployPot();
        vm.expectRevert(bytes(why));
        bad.run();
    }

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

        // ---- the earlier grants: nothing set, nothing claimable (the default, checked on the file and on the Launcher)
        vm.setEnv("HOLDER_PAUSE", "0");
        _earlierSettings(0, 0, 0, 0, address(0), 0, 0);
        d = _run();
        l = Launcher(d.launcher);
        assertEq(l.earlier(), address(0), "default: no claim contract");
        assertEq(l.earlierKey(), bytes32(0));
        assertEq(d.earlier, address(0));
        assertEq(l.settingsHash(), keccak256(abi.encode(_platformOf(l))), "default: the old settings hash");
        json = vm.readFile("deployments/pot-11155111.json");
        assertEq(vm.parseJsonAddress(json, ".earlierGrants"), address(0));
        assertEq(vm.parseJsonBytes32(json, ".earlierKey"), bytes32(0));

        // ---- one earlier setting without the others reverts, whichever it is
        _expectEarlierRefusal(ROOT, 0, 0, 0, address(0), 0, "EARLIER settings: give all six or none");
        _expectEarlierRefusal(ROOT, TXT, 0, 0, address(0), 0, "EARLIER settings: give all six or none");
        _expectEarlierRefusal(0, TXT, 5000e18, 4, zeroFounder, ZID, "EARLIER settings: give all six or none");
        _expectEarlierRefusal(ROOT, TXT, 5000e18, 4, zeroFounder, 0, "EARLIER settings: give all six or none");
        _expectEarlierRefusal(0, 0, 5000e18, 0, address(0), 0, "EARLIER settings: give all six or none");
        _expectEarlierRefusal(0, 0, 0, 0, zeroFounder, 0, "EARLIER settings: give all six or none");

        // ---- all six: deployed and bound in the same broadcast, before any project can be launched
        _earlierSettings(ROOT, TXT, 5000e18, 4, zeroFounder, ZID, 0);
        vm.recordLogs();
        d = _run();
        l = Launcher(d.launcher);
        assertTrue(d.earlier != address(0));
        assertEq(l.earlier(), d.earlier, "bound");
        assertEq(l.earlierKey(), l.keyOf(zeroFounder, ZID), "the key is the founder's and the id");
        assertEq(l.deployer(), d.admin);
        assertLe(block.timestamp, uint256(l.deployedAt()) + 1 hours, "inside the first hour");
        EarlierGrants e = EarlierGrants(d.earlier);
        assertEq(e.root(), ROOT);
        assertEq(e.textHash(), TXT);
        assertEq(e.total(), 5000e18);
        assertEq(uint256(e.rows()), 4);
        assertEq(e.launcher(), d.launcher);
        assertEq(e.key(), l.earlierKey());
        assertEq(address(e.vester()), address(0), "not tied to a project until project zero launches");
        assertEq(l.holderPauseImpl(), address(0), "the pause switch is separate and stays off");
        logs = vm.getRecordedLogs();
        uint256 boundEarlier;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == d.launcher && logs[i].topics[0] == Launcher.EarlierBound.selector) ++boundEarlier;
        }
        assertEq(boundEarlier, 1, "one EarlierBound");
        json = vm.readFile("deployments/pot-11155111.json");
        assertEq(vm.parseJsonAddress(json, ".earlierGrants"), d.earlier);
        assertEq(vm.parseJsonBytes32(json, ".earlierKey"), l.earlierKey());
        assertTrue(l.settingsHash() != keccak256(abi.encode(_platformOf(l))), "the bound claim is in the hash");
        // project zero, launched by the founder under the id, is born with the reserve and the claim is tied to it
        bytes32 hash2 = l.settingsHash();
        vm.prank(zeroFounder);
        (,, address tr2, address vs2) =
            l.launch(ZID, "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: 1_000_000e18}), hash2);
        assertEq(Vester(vs2).earlierReserve(), 5000e18);
        assertEq(address(e.vester()), vs2);
        assertTrue(Treasury(tr2).founder() == zeroFounder);

        // ---- both switches together
        vm.setEnv("HOLDER_PAUSE", "1");
        d = _run();
        l = Launcher(d.launcher);
        assertTrue(l.holderPauseImpl() != address(0) && l.earlier() != address(0), "both bound");
        vm.setEnv("HOLDER_PAUSE", "0");

        // ---- a pool over the founder cap (100,000,000 Shares) needs EARLIER_ALLOW_LARGE=1; over the ceiling never
        _earlierSettings(ROOT, TXT, 100_000_000e18, 4, zeroFounder, ZID, 0);
        d = _run(); // exactly the cap is allowed
        assertEq(EarlierGrants(d.earlier).total(), 100_000_000e18);
        _expectEarlierRefusal2(100_000_000e18 + 1, 0, "EARLIER_TOTAL is over the founder cap: EARLIER_ALLOW_LARGE=1");
        _expectEarlierRefusal2(1_000_000_000e18, 0, "EARLIER_TOTAL is over the founder cap: EARLIER_ALLOW_LARGE=1");
        _earlierSettings(ROOT, TXT, 1_000_000_000e18, 4, zeroFounder, ZID, 1);
        d = _run(); // asked for on purpose
        assertEq(EarlierGrants(d.earlier).total(), 1_000_000_000e18);
        _expectEarlierRefusal2(1_000_000_000e18 + 1, 1, "EARLIER_TOTAL is over the ceiling");
        _expectEarlierRefusal2(1000e18, 2, "EARLIER_ALLOW_LARGE must be 0 or 1");

        // ---- leave nothing behind
        _earlierSettings(0, 0, 0, 0, address(0), 0, 0);
        vm.setEnv("HOLDER_PAUSE", "0");
        vm.removeFile("deployments/pot-11155111.json");
    }

    function _platformOf(Launcher l) internal view returns (Launcher.Platform memory p) {
        (p.quote, p.platform, p.feeBps, p.unit, p.agentUsd) = l.platform();
    }
}
