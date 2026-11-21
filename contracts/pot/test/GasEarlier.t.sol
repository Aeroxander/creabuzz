// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {StackBase} from "./helpers/StackBase.sol";
import {Launcher} from "../src/Launcher.sol";
import {Parts} from "../src/Parts.sol";
import {EarlierGrants} from "../src/EarlierGrants.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";

/// @notice What the earlier grants cost, in gas inside the call, cold, with the scenario built in `setUp` and only the call
/// measured (as `Gas.t.sol` and `GasPause.t.sol` do). Baselines are ABSOLUTE, measured on the K1 build (the pause, switch off)
/// before K2 touched anything, recorded below as constants:
///  - a launch with nothing bound may cost at most 2,500 more (one cold read of `earlier`);
///  - an ordinary `grantTeam` may cost at most 8,000 more (the Vester now reads three more slots: the claim contract, the
///    reserve and the member's earlier-grant count);
///  - a claim with a proof of depth 20 is measured and bounded.
/// Every other call carries no new instruction.
contract GasEarlierTest is StackBase {
    /// @dev Launch with the pause switch off, on the K1 build (the figure `GasPause.t.sol` states for it).
    uint256 internal constant LAUNCH_K1 = 901_177;
    /// @dev An ordinary first `grantTeam` to a fresh account, cold, on the K1 build.
    uint256 internal constant GRANT_K1 = 190_945;

    bytes32 internal constant TEXT = keccak256("an invented text, version one");
    address internal claimant = makeAddr("deep-row");
    bytes32[] internal deep;
    bytes32 internal deepRoot;
    EarlierGrants internal e;
    Launcher internal withEarlier;

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function setUp() public override {
        super.setUp(); // a stack with nothing bound: project p1
        // a second stack with a claim contract whose list is 2^20 rows deep on one path (siblings are arbitrary words)
        bytes32 node = keccak256(bytes.concat(keccak256(abi.encode(uint256(5), claimant, uint256(100e18)))));
        for (uint256 i; i < 20; ++i) {
            bytes32 sib = keccak256(abi.encode("sibling", i));
            deep.push(sib);
            node = _pair(node, sib);
        }
        deepRoot = node;
        withEarlier = new Launcher(admin, _platform(UNIT), parts);
        e = new EarlierGrants(
            address(withEarlier), deepRoot, TEXT, 1_000_000e18, uint32(1 << 20), withEarlier.keyOf(founder, "zero")
        );
        withEarlier.bindEarlier(address(e));
        bytes32 h = withEarlier.settingsHash(); // read first: a prank is spent by the first call after it
        vm.prank(founder);
        withEarlier.launch("zero", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
    }

    function _coldAll() internal {
        vm.cool(address(launcher));
        vm.cool(address(withEarlier));
        vm.cool(address(e));
    }

    function test_launchWithNothingBound() public {
        bytes32 h = launcher.settingsHash();
        vm.startPrank(alice);
        _coldAll();
        uint256 g = gasleft();
        launcher.launch("gas-1", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        uint256 used = g - gasleft();
        vm.stopPrank();
        console2.log("launch, nothing bound:", used);
        assertLe(used, LAUNCH_K1 + 2500, "one cold read of `earlier` and no more");
    }

    function test_launchOfAnotherKeyOnADeploymentWithTheClaimContract() public {
        bytes32 h = withEarlier.settingsHash();
        vm.startPrank(alice);
        _coldAll();
        uint256 g = gasleft();
        withEarlier.launch("gas-2", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        uint256 used = g - gasleft();
        vm.stopPrank();
        console2.log("launch, another key, claim contract bound:", used);
        assertLe(used, LAUNCH_K1 + 6000);
    }

    function test_launchOfProjectZero() public {
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        EarlierGrants z =
            new EarlierGrants(address(l), deepRoot, TEXT, 1_000_000e18, uint32(1 << 20), l.keyOf(founder, "zero"));
        l.bindEarlier(address(z));
        bytes32 h = l.settingsHash();
        vm.startPrank(founder);
        vm.cool(address(l));
        vm.cool(address(z));
        uint256 g = gasleft();
        l.launch("zero", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        uint256 used = g - gasleft();
        vm.stopPrank();
        console2.log("launch of project zero, with the reserve:", used);
        assertLe(used, LAUNCH_K1 + 120_000);
    }

    function test_claimAtDepthTwenty() public {
        address vs = withEarlier.projectByKey(withEarlier.keyOf(founder, "zero")).vester;
        vm.startPrank(claimant);
        vm.cool(address(e));
        vm.cool(vs);
        uint256 g = gasleft();
        e.claim(5, 100e18, deep, TEXT);
        uint256 used = g - gasleft();
        vm.stopPrank();
        console2.log("claim, proof of depth 20:", used);
        assertLe(used, 330_000);
    }

    function test_ordinaryGrantTeam() public {
        vm.startPrank(founder);
        vm.cool(address(t));
        vm.cool(address(v));
        vm.cool(address(team));
        uint256 g = gasleft();
        t.grantTeam(dave, 1000e18);
        uint256 used = g - gasleft();
        vm.stopPrank();
        console2.log("grantTeam, first grant to an account:", used);
        assertLe(used, GRANT_K1 + 8000);
    }
}
