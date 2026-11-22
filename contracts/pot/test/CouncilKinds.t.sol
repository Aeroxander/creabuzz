// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {CouncilBase} from "./helpers/CouncilBase.sol";
import {Proj} from "./helpers/StackBase.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Council} from "../src/Council.sol";

/// @notice Hands the runner seat of six projects to a Pair or a Council, in any order and with any accounts.
contract KindsHandler is Test {
    Launcher internal launcher;
    address[6] internal founders;
    bytes32[6] internal keys;
    Treasury[6] internal treasuries;
    address[] public pairs;
    address[] public councils;
    mapping(uint256 => bool) internal done;

    constructor(Launcher l, address[6] memory f, bytes32[6] memory k, Treasury[6] memory t) {
        (launcher, founders, keys, treasuries) = (l, f, k, t);
    }

    function makePairFor(uint256 seed) external {
        uint256 i = seed % 6;
        if (done[i]) return;
        done[i] = true;
        address second = makeAddr(string.concat("second", vm.toString(seed)));
        address predicted = launcher.pairAddress(keys[i], founders[i], second);
        vm.prank(founders[i]);
        treasuries[i].handOver(predicted, false);
        vm.prank(second);
        pairs.push(launcher.makePair(keys[i], founders[i]));
    }

    function makeCouncilFor(uint256 seed) external {
        uint256 i = seed % 6;
        if (done[i]) return;
        done[i] = true;
        address[5] memory m;
        for (uint256 k; k < 5; ++k) {
            m[k] = makeAddr(string.concat("m", vm.toString(i), "-", vm.toString(k)));
        }
        address predicted = launcher.councilAddress(keys[i], m, bytes32(seed));
        vm.prank(founders[i]);
        treasuries[i].handOver(predicted, false);
        councils.push(launcher.makeCouncil(keys[i], m, bytes32(seed)));
    }

    function nPairs() external view returns (uint256) {
        return pairs.length;
    }

    function nCouncils() external view returns (uint256) {
        return councils.length;
    }
}

/// @notice What the Launcher registers: every Pair it made is kind 1, every Council kind 2, nothing else is anything but kind 0,
/// no address is both, and a project's runner is the contract made for it.
contract CouncilKindsInvariantTest is CouncilBase {
    KindsHandler internal h;
    Treasury[6] internal ts;
    address[6] internal fs;

    function setUp() public override {
        super.setUp();
        bytes32[6] memory ks;
        for (uint256 i; i < 6; ++i) {
            fs[i] = makeAddr(string.concat("kinds founder", vm.toString(i)));
            Proj memory p = _launch(fs[i], bytes32(i + 1), 1000, POOL);
            ks[i] = p.key;
            ts[i] = p.t;
        }
        h = new KindsHandler(launcher, fs, ks, ts);
        targetContract(address(h));
    }

    function invariant_everyRegisteredRunnerContractHasItsKindAndNothingElseHasOne() public view {
        for (uint256 i; i < h.nPairs(); ++i) {
            address p = h.pairs(i);
            assertEq(launcher.runnerKindOf(p), 1);
            assertTrue(launcher.isPair(p));
            assertFalse(launcher.isCouncil(p));
        }
        for (uint256 i; i < h.nCouncils(); ++i) {
            address c = h.councils(i);
            assertEq(launcher.runnerKindOf(c), 2);
            assertTrue(launcher.isCouncil(c));
            assertFalse(launcher.isPair(c));
        }
        for (uint256 i; i < 6; ++i) {
            assertEq(launcher.runnerKindOf(fs[i]), 0, "a founder is no runner contract");
            assertEq(launcher.runnerKindOf(address(ts[i])), 0);
            assertFalse(launcher.isPair(address(ts[i])));
        }
        assertEq(launcher.runnerKindOf(address(0)), 0);
        assertEq(launcher.runnerKindOf(address(launcher)), 0);
    }

    function invariant_aProjectsRunnerIsThatContractAndACouncilKnowsItsProject() public view {
        for (uint256 i; i < h.nCouncils(); ++i) {
            Council c = Council(h.councils(i));
            assertEq(c.launcher(), address(launcher));
            assertEq(Treasury(address(c.treasury())).runner(), address(c), "the Council holds its project's seat");
            assertEq(c.vote(), Treasury(address(c.treasury())).pauseGate());
        }
        for (uint256 i; i < h.nPairs(); ++i) {
            address p = h.pairs(i);
            bool held;
            for (uint256 j; j < 6; ++j) {
                if (ts[j].runner() == p) held = true;
            }
            assertTrue(held, "a Pair made for a project holds its seat");
        }
    }
}
