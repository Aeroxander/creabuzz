// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {CouncilBase} from "./helpers/CouncilBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {Pair} from "../src/Pair.sol";
import {Council} from "../src/Council.sol";

/// @notice What the calls the Council round touches cost, measured inside the call with the touched contracts made cold first.
/// The "runner calls" (`join`, `draw` and `announceTask` by a founder alone and through a Pair) were recorded on the build at
/// 4c36f73d6 BEFORE the Council round changed the Treasury and the Launcher, with these very tests, and the gates below are those
/// numbers: the runner calls must cost no more than they did (the Treasury still reads one Launcher slot).
contract GasCouncilBaselineTest is StackBase {
    uint256 internal constant BASE_JOIN = 133_298;
    uint256 internal constant BASE_DRAW_FOUNDER = 102_121;
    uint256 internal constant BASE_ANNOUNCE_FOUNDER = 217_942;
    uint256 internal constant BASE_DRAW_PAIR = 116_101;
    uint256 internal constant BASE_ANNOUNCE_PAIR = 232_295;
    address internal second = makeAddr("second signer");

    function _cold() internal {
        vm.cool(address(t));
        vm.cool(address(shares));
        vm.cool(address(team));
        vm.cool(address(usd));
        vm.cool(address(v));
        vm.cool(address(launcher));
        vm.cool(address(_book()));
    }

    function setUp() public override {
        super.setUp();
        _join(alice, 50_000e6);
        _join(bob, 20_000e6);
        _active(14 * uint256(UNIT));
        vm.warp(block.timestamp + 2 days);
        _checkIn();
    }

    function test_gas_join() public {
        usd.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usd.approve(address(t), 100e6);
        _cold();
        uint256 g = gasleft();
        t.join(100e6, 0, stranger);
        uint256 used = g - gasleft();
        emit log_named_uint("join, gas", used);
        assertLe(used, BASE_JOIN, "a join costs what it cost before the Council");
        vm.stopPrank();
    }

    function test_gas_draw_founder() public {
        uint256 box = t.box();
        vm.prank(founder);
        t.settle();
        box = t.box();
        vm.startPrank(founder);
        _cold();
        uint256 g = gasleft();
        t.draw(founder, box / 2);
        uint256 used = g - gasleft();
        emit log_named_uint("draw by a founder alone, gas", used);
        assertLe(used, BASE_DRAW_FOUNDER, "a founder's draw costs what it cost before the Council");
        vm.stopPrank();
    }

    function test_gas_announce_founder() public {
        vm.startPrank(founder);
        _cold();
        uint256 g = gasleft();
        t.announceTask(bytes32(uint256(7)), address(0), 100e6, 50);
        uint256 used = g - gasleft();
        emit log_named_uint("announceTask by a founder alone, gas", used);
        assertLe(used, BASE_ANNOUNCE_FOUNDER, "a founder's announceTask costs what it cost before the Council");
        vm.stopPrank();
    }

    function test_gas_draw_andAnnounce_pair() public {
        Pair pair = _makePair(second);
        _checkIn();
        t.settle();
        bytes memory dr = abi.encodeCall(Treasury.draw, (founder, t.box() / 2));
        uint256 n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), dr);
        vm.startPrank(second);
        _cold();
        vm.cool(address(pair));
        uint256 g = gasleft();
        pair.confirm(address(t), dr, n);
        uint256 used = g - gasleft();
        emit log_named_uint("draw through a Pair (confirm, whole), gas", used);
        assertLe(used, BASE_DRAW_PAIR, "a Pair's draw costs what it cost before the Council");
        vm.stopPrank();
        bytes memory an = abi.encodeCall(Treasury.announceTask, (bytes32(uint256(8)), address(0), 100e6, 50));
        n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), an);
        vm.startPrank(second);
        _cold();
        vm.cool(address(pair));
        g = gasleft();
        pair.confirm(address(t), an, n);
        used = g - gasleft();
        emit log_named_uint("announceTask through a Pair (confirm, whole), gas", used);
        assertLe(used, BASE_ANNOUNCE_PAIR, "a Pair's announceTask costs what it cost before the Council");
        vm.stopPrank();
    }
}

/// @notice What the Council's own calls cost (gates from the plan: `propose` at most 130,000; an `agree` that does not run the call
/// at most 60,000; `makeCouncil` at most 600,000), and what a draw costs through three seats against through a Pair.
contract GasCouncilTest is CouncilBase {
    function _cold() internal {
        vm.cool(address(t));
        vm.cool(address(shares));
        vm.cool(address(team));
        vm.cool(address(usd));
        vm.cool(address(v));
        vm.cool(address(launcher));
        vm.cool(address(_book()));
        vm.cool(address(council));
    }

    function setUp() public override {
        super.setUp();
        _join(alice, 50_000e6);
        _join(bob, 20_000e6);
    }

    function test_gas_makeCouncil() public {
        address[5] memory m = _five();
        address predicted = launcher.councilAddress(key, m, bytes32(0));
        vm.prank(founder);
        t.handOver(predicted, false);
        vm.cool(address(launcher));
        vm.cool(address(t));
        uint256 g = gasleft();
        launcher.makeCouncil(key, m, bytes32(0));
        uint256 used = g - gasleft();
        emit log_named_uint("makeCouncil, gas", used);
        assertLe(used, 600_000);
        council = Council(predicted);
    }

    function test_gas_proposeAgreeAndTheRun() public {
        _makeCouncil();
        _warp(2 days);
        _councilCheckIn();
        _warp(1 days);
        t.settle();
        bytes memory data = abi.encodeCall(Treasury.draw, (founder, t.box() / 2));
        uint256 n = council.nonce();
        _cold();
        vm.prank(s1);
        uint256 g = gasleft();
        council.propose(address(t), data);
        uint256 used = g - gasleft();
        emit log_named_uint("propose, gas", used);
        assertLe(used, 130_000);
        _cold();
        vm.prank(s2);
        g = gasleft();
        council.agree(address(t), data, n);
        used = g - gasleft();
        emit log_named_uint("agree (second seat), gas", used);
        assertLe(used, 60_000);
        _cold();
        vm.prank(s3);
        g = gasleft();
        council.agree(address(t), data, n);
        used = g - gasleft();
        emit log_named_uint("agree (third seat, runs a draw), gas", used);
    }

    function test_gas_resign() public {
        _makeCouncil();
        _cold();
        vm.prank(s5);
        uint256 g = gasleft();
        council.resign();
        emit log_named_uint("resign, gas", g - gasleft());
    }
}
