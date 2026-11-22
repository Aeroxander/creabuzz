// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {CouncilBase} from "./helpers/CouncilBase.sol";
import {MockPair} from "./helpers/Mocks.sol";
import {StackBase} from "./helpers/StackBase.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";
import {Council} from "../src/Council.sol";
import {EarlierGrants} from "../src/EarlierGrants.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {Launcher} from "../src/Launcher.sol";
import {Parts} from "../src/Parts.sol";
import {Treasury} from "../src/Treasury.sol";

/// @dev The Launcher's platform settings as the struct `settingsHash` encodes (the public getter returns the fields).
function platformOfL(Launcher l) view returns (Launcher.Platform memory p) {
    (p.quote, p.platform, p.feeBps, p.unit, p.agentUsd) = l.platform();
}

/// @notice The Council switch with it OFF (the default): nothing bound, no Council can be made, and the settings hash is each of
/// its three old formulas.
contract LauncherCouncilOffTest is StackBase {
    function test_withTheSwitchOffNothingIsBoundAndNoCouncilCanBeMade() public {
        assertEq(launcher.councilImpl(), address(0));
        assertFalse(launcher.councilBound());
        address[5] memory m = [alice, bob, carol, dave, stranger];
        vm.expectRevert(Launcher.NoCouncil.selector);
        launcher.makeCouncil(key, m, bytes32(0));
        vm.expectRevert(Launcher.NoCouncil.selector);
        vm.prank(founder);
        launcher.makeCouncil(key, m, bytes32(uint256(1)));
        // a Pair is unaffected: kind 1, and `isPair` still says so
        address pair = address(_makePair(bob));
        assertEq(launcher.runnerKindOf(pair), 1);
        assertTrue(launcher.isPair(pair));
        assertFalse(launcher.isCouncil(pair));
        assertEq(launcher.runnerKindOf(alice), 0);
        assertFalse(launcher.isPair(alice));
    }

    function test_theSettingsHashIsTheOldFormulaWhenNothingIsBound() public view {
        assertEq(launcher.settingsHash(), keccak256(abi.encode(platformOfL(launcher))));
    }

    function test_theSettingsHashIsTheOldFormulaWhenOnlyThePauseIsBound() public {
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        address impl = address(new HolderPause());
        l.bindPause(impl);
        assertEq(l.settingsHash(), keccak256(abi.encode(platformOfL(l), impl)));
    }

    function test_theSettingsHashIsTheOldFormulaWithTheClaimContractBound() public {
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        EarlierGrants e =
            new EarlierGrants(address(l), keccak256("root"), keccak256("text"), 1000e18, 4, l.keyOf(founder, "zero"));
        l.bindEarlier(address(e));
        assertEq(l.settingsHash(), keccak256(abi.encode(platformOfL(l), address(0), address(e))));
        address impl = address(new HolderPause());
        l.bindPause(impl);
        assertEq(
            l.settingsHash(), keccak256(abi.encode(platformOfL(l), impl, address(e))), "pause and claims, no Council"
        );
    }
}

/// @notice The Council switch ON: the binding (deployer, once, first hour, code, pause first), the hash's fourth form, making a
/// Council (the offer, the address, who may make it, who may not be a seat), and the Launcher's wind-down for a Council runner.
contract LauncherCouncilTest is CouncilBase {
    function _fresh() internal returns (Launcher l) {
        l = new Launcher(admin, _platform(UNIT), parts);
    }

    // ---- the binding

    function test_theBindingIsTheDeployersAloneOnceInTheFirstHourWithCodeAndAPause() public {
        Launcher l = _fresh();
        address impl = address(new Council());
        vm.expectRevert(Launcher.BadStack.selector); // the pause must be bound first
        l.bindCouncil(impl);
        l.bindPause(address(new HolderPause()));
        vm.expectRevert(Launcher.NotDeployer.selector);
        vm.prank(admin);
        l.bindCouncil(impl);
        vm.expectRevert(Launcher.NotDeployer.selector);
        vm.prank(stranger);
        l.bindCouncil(impl);
        vm.expectRevert(Launcher.BadStack.selector);
        l.bindCouncil(stranger); // no code
        vm.recordLogs();
        l.bindCouncil(impl);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], Launcher.CouncilBound.selector);
        (address ev, bytes32 ch) = abi.decode(logs[0].data, (address, bytes32));
        assertEq(ev, impl);
        assertEq(ch, impl.codehash);
        assertEq(l.councilImpl(), impl);
        assertTrue(l.councilBound());
        address another = address(new Council());
        vm.expectRevert(Launcher.BindClosed.selector);
        l.bindCouncil(another); // once
    }

    function test_theBindingClosesAfterTheFirstHour() public {
        Launcher l = _fresh();
        l.bindPause(address(new HolderPause()));
        address impl = address(new Council());
        _warp(1 hours + 1);
        vm.expectRevert(Launcher.BindClosed.selector);
        l.bindCouncil(impl);
        assertEq(l.councilImpl(), address(0));
    }

    function test_theBindingIsOpenAtTheLastSecondOfTheFirstHour() public {
        Launcher l = _fresh();
        l.bindPause(address(new HolderPause()));
        _warp(1 hours);
        l.bindCouncil(address(new Council()));
        assertTrue(l.councilBound());
    }

    // ---- the settings hash

    function test_theFourthFormOfTheSettingsHashHasTheCouncilInIt() public {
        Launcher l = _fresh();
        address pauseImpl = address(new HolderPause());
        l.bindPause(pauseImpl);
        bytes32 before = l.settingsHash();
        address impl = address(new Council());
        l.bindCouncil(impl);
        assertEq(
            l.settingsHash(),
            keccak256(abi.encode(platformOfL(l), pauseImpl, address(0), impl)),
            "pause and Council, no claims"
        );
        assertTrue(l.settingsHash() != before);
        // a founder who read the hash before the Council was bound is refused at launch
        vm.prank(founder);
        vm.expectRevert(Launcher.SettingsMoved.selector);
        l.launch("late", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), before);
    }

    function test_withTheClaimContractAndACouncilTheHashIsTheFourPartOneAndTheCouncilTestComesFirst() public {
        Launcher l = _fresh();
        EarlierGrants e =
            new EarlierGrants(address(l), keccak256("root"), keccak256("text"), 1000e18, 4, l.keyOf(founder, "zero"));
        l.bindEarlier(address(e));
        address pauseImpl = address(new HolderPause());
        l.bindPause(pauseImpl);
        address impl = address(new Council());
        l.bindCouncil(impl);
        assertEq(l.settingsHash(), keccak256(abi.encode(platformOfL(l), pauseImpl, address(e), impl)));
        // and such a launch goes through with that hash
        vm.prank(alice);
        l.launch(
            "claims-and-council", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), l.settingsHash()
        );
    }

    // ---- making a Council

    function test_makingACouncilNeedsTheOfferAndTheAddressCommitsToTheFiveAccountsAndTheSalt() public {
        address[5] memory m = _five();
        bytes32 salt = bytes32(uint256(9));
        address predicted = launcher.councilAddress(key, m, salt);
        assertEq(predicted.code.length, 0);
        // no offer yet: the Council cannot take a seat nobody offered
        vm.expectRevert(Treasury.NotAllowed.selector);
        launcher.makeCouncil(key, m, salt);
        assertEq(launcher.runnerKindOf(predicted), 0, "a refused make leaves no registered Council");
        vm.prank(founder);
        t.handOver(predicted, false);
        // another set of accounts, or another salt, is another address and so another Council: not the one offered
        address[5] memory other = [s1, s2, s3, s4, s6];
        assertTrue(launcher.councilAddress(key, other, salt) != predicted);
        assertTrue(launcher.councilAddress(key, m, bytes32(uint256(10))) != predicted);
        vm.expectRevert(Treasury.NotAllowed.selector);
        launcher.makeCouncil(key, other, salt);
        vm.expectRevert(Treasury.NotAllowed.selector);
        launcher.makeCouncil(key, m, bytes32(uint256(10)));
        assertEq(t.runner(), founder);
        // anyone makes the real one
        vm.prank(s6);
        address c = launcher.makeCouncil(key, m, salt);
        assertEq(c, predicted);
        assertEq(t.runner(), c);
        assertEq(launcher.runnerKindOf(c), 2);
        assertTrue(launcher.isCouncil(c));
        assertFalse(launcher.isPair(c));
    }

    function test_anOfferThatRanOutCannotBeTaken() public {
        address[5] memory m = _five();
        address predicted = launcher.councilAddress(key, m, bytes32(0));
        vm.prank(founder);
        t.handOver(predicted, false);
        _warp(2 * uint256(UNIT) + 1);
        vm.expectRevert(Treasury.OfferExpired.selector);
        launcher.makeCouncil(key, m, bytes32(0));
        assertEq(t.runner(), founder, "a hand-over to a Council nobody makes cannot lock the seat");
    }

    function test_theSameFiveAccountsCanHaveAnotherCouncilWithAnotherSaltButNotTheSameOneTwice() public {
        Council c1 = _handOverTo(_five(), bytes32(uint256(1)));
        // it can hand the seat on to a second Council of the same five accounts with another salt
        address predicted = launcher.councilAddress(key, _five(), bytes32(uint256(2)));
        council = c1;
        _run(abi.encodeCall(Treasury.handOver, (predicted, false)));
        address c2 = launcher.makeCouncil(key, _five(), bytes32(uint256(2)));
        assertEq(c2, predicted);
        assertTrue(c2 != address(c1));
        assertEq(t.runner(), c2);
        // the same salt again cannot be made twice
        vm.expectRevert();
        launcher.makeCouncil(key, _five(), bytes32(uint256(2)));
    }

    function testFuzz_theAddressOfACouncilCommitsToTheProjectTheFiveAccountsAndTheSalt(
        bytes32 salt,
        bytes32 otherSalt,
        uint8 which,
        address stand
    ) public {
        vm.assume(stand != address(0) && stand != s1 && stand != s2 && stand != s3 && stand != s4 && stand != s5);
        address[5] memory m = _five();
        address base = launcher.councilAddress(key, m, salt);
        assertEq(launcher.councilAddress(key, m, salt), base, "the same inputs, the same address");
        if (otherSalt != salt) assertTrue(launcher.councilAddress(key, m, otherSalt) != base);
        address[5] memory other = m;
        other[which % 5] = stand;
        assertTrue(launcher.councilAddress(key, other, salt) != base, "another account is another Council");
        assertTrue(
            launcher.councilAddress(bytes32(uint256(key) + 1), m, salt) != base, "another project is another Council"
        );
    }

    function test_makingACouncilForAnUnknownProjectIsRefused() public {
        vm.expectRevert(Launcher.UnknownProject.selector);
        launcher.isProjectAccount(bytes32(uint256(77)), s1);
        vm.expectRevert(Launcher.UnknownProject.selector);
        launcher.makeCouncil(bytes32(uint256(1234)), _five(), bytes32(0));
    }

    function test_aCouncilMayIncludeTheFounderAndABeforeProjectsRunner() public {
        address[5] memory m = [founder, s2, s3, s4, s5];
        Council c = _handOverTo(m, bytes32(0));
        assertTrue(c.isSeat(founder));
    }

    // ---- who cannot be a seat

    function test_aProjectsOwnAccountsAndRunnerContractsCannotHoldASeat() public {
        _use(_launch(alice, "pairs", 1000, POOL));
        address pair = _pairOfAlice();
        address[10] memory bad = [
            address(t),
            address(v),
            address(shares),
            address(team),
            t.pauseGate(),
            address(t.tasks()),
            address(launcher),
            address(councilImpl),
            pair,
            address(0) // the zero address is refused by the Council itself
        ];
        for (uint256 i; i < bad.length; ++i) {
            address[5] memory m = _five();
            m[2] = bad[i];
            if (bad[i] == address(0)) {
                vm.expectRevert(Council.BadSetup.selector);
            } else {
                vm.expectRevert(abi.encodeWithSelector(Launcher.BadSeatHolder.selector, bad[i]));
            }
            launcher.makeCouncil(key, m, bytes32(uint256(50 + i)));
            if (bad[i] != address(0)) assertTrue(launcher.isProjectAccount(key, bad[i]), "the view agrees");
        }
        assertFalse(launcher.isProjectAccount(key, s1), "a person");
        assertFalse(launcher.isProjectAccount(key, alice), "the founder");
    }

    function _pairOfAlice() internal returns (address pair) {
        address predicted = launcher.pairAddress(key, alice, bob);
        vm.prank(alice);
        t.handOver(predicted, false);
        vm.prank(bob);
        pair = launcher.makePair(key, alice); // a runner contract now
    }

    function test_aSmartAccountThatIsNoneOfTheProjectsOwnStaysAllowedAsASeat() public {
        address smart = address(new QuoteToken());
        assertFalse(launcher.isProjectAccount(key, smart));
        address[5] memory ok = [smart, s2, s3, s4, s5];
        Council c = _handOverTo(ok, bytes32(uint256(7)));
        assertTrue(c.isSeat(smart));
    }

    function test_aCouncilOfOneProjectIsARunnerContractAndCannotSitOnAnother() public {
        Council c1 = _handOverTo(_five(), bytes32(0));
        _use(_launch(alice, "other", 1000, POOL));
        address[5] memory m = [address(c1), s2, s3, s4, s5];
        vm.expectRevert(abi.encodeWithSelector(Launcher.BadSeatHolder.selector, address(c1)));
        launcher.makeCouncil(key, m, bytes32(0));
    }

    // ---- the wind-down

    function test_aCouncilWindsTheProjectDownThroughTheLauncherOnlyWhileItRunsAProposal() public {
        _makeCouncil();
        vm.expectRevert(Launcher.NotRunner.selector);
        vm.prank(s1);
        launcher.windDown(key);
        vm.expectRevert(Launcher.NotRunner.selector);
        vm.prank(founder);
        launcher.windDown(key);
        // the Council itself, outside a proposal: bothSigned is false, so the Launcher refuses
        vm.expectRevert(Launcher.NotRunner.selector);
        vm.prank(address(council));
        launcher.windDown(key);
        bytes memory data = abi.encodeWithSignature("windDown(bytes32)", key);
        uint256 n = _proposeTo(s1, address(launcher), data);
        vm.prank(s2);
        council.agree(address(launcher), data, n);
        vm.prank(s3);
        council.agree(address(launcher), data, n);
        assertEq(t.windDownKind(), 1);
    }

    function test_aRunnerContractThatIsNotExecutingIsRefusedByTheLauncherWhateverItsKind() public {
        // a stand-in registered as a Council, holding the seat, calling the Launcher with bothSigned false
        MockPair like = new MockPair(founder, s6);
        _register(address(like), 2);
        vm.prank(founder);
        t.handOver(address(like), false);
        like.exec(address(t), abi.encodeCall(Treasury.takeSeat, ()), false);
        (bool ok, bytes memory ret) =
            like.exec(address(launcher), abi.encodeWithSignature("windDown(bytes32)", key), false);
        assertFalse(ok);
        assertEq(bytes4(ret), Launcher.NotRunner.selector);
        (ok,) = like.exec(address(launcher), abi.encodeWithSignature("windDown(bytes32)", key), true);
        assertTrue(ok, "while it executes a proposal it may");
    }
}
