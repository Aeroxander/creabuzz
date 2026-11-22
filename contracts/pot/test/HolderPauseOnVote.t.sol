// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {HolderPauseTest} from "./HolderPause.t.sol";
import {HolderPauseAttacksTest} from "./HolderPauseAttacks.t.sol";
import {GasPauseOnTest, GasPauseOnTasksTest} from "./GasPause.t.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {HolderVote} from "../src/HolderVote.sol";
import {Launcher} from "../src/Launcher.sol";
import {Parts} from "../src/Parts.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";

/// @notice The pause's own rule set, re-run on a project whose pause is a `HolderVote` clone (COUNCIL-PLAN 4.4 point 4): with the
/// Council switch on, a project's pause *is* the vote contract (`Launcher.launch` clones `HolderVote` instead of `HolderPause`), so
/// every pause rule — the line, the day, the look, park and unpark, the views — and every call that carries the pause (join, draw,
/// announce, a Take out) must behave exactly as before, and the gas limits of `GasPause.t.sol` must still hold (with the vote
/// contract's one cold read allowed: the last test in `GasPauseOnVoteTest` pins that read to at most 2,300 gas).
///
/// The technique, and why it is not the three classes the plan sketched. No existing pause test file has a `setUp` a subclass can
/// override (`HolderPauseTest.setUp`, `HolderPauseAttacksTest.setUp`, `GasPauseOnTest.setUp` and `GasPauseOnTasksTest.setUp` are not
/// `virtual`), so a thin class cannot swap the stack under them. Instead each class here inherits the existing test contract
/// unedited and each wrapper test rebuilds the same stack out of the inherited state with a real `HolderVote` as the pause
/// implementation — one line different from `PauseBase.setUp`, which is the whole of the seam — and then runs the existing test
/// body itself through `this.`. The bodies are the old files', not a re-implementation. The inherited plain-stack tests still run
/// too, unedited (they pass: this file also re-proves the plain pause, and that is why its total count is about double its wrappers).
/// The one test not re-run is `test_aShortDemoUnitGivesAShortDay`, whose body builds its own short-unit Launcher from a fresh plain
/// `HolderPause` rather than using the project's.

/// @notice The rule set of `HolderPause.t.sol` (every test there that touches the pause) on a `HolderVote` clone.
contract HolderPauseOnVoteTest is HolderPauseTest {
    /// @dev As `HolderPauseTest.setUp`: the switch-on stack, Alice alone backing, a supply that is not a multiple of three.
    function _voteStack() internal {
        vm.warp(T0);
        clock = T0;
        usd = new QuoteToken();
        parts = new Parts();
        launcher = new Launcher(admin, _platform(UNIT), parts);
        HolderVote impl = new HolderVote();
        pauseImpl = HolderPause(address(impl));
        launcher.bindPause(address(impl));
        _use(_launch(founder, "p1", 1000, POOL));
        pause = HolderPause(t.pauseGate());
        assertTrue(HolderVote(address(pause)).isVote(), "the project's pause is the vote contract");
        _aliceBacks(10_204_081_633);
        _join(bob, 2000e6);
        _oddSupply();
    }

    function test_vote_aCloneIsBornOnceWithTheShareTokenAndADayOfUnitOverSeven() public {
        _voteStack();
        this.test_aCloneIsBornOnceWithTheShareTokenAndADayOfUnitOverSeven();
    }

    function test_vote_theImplementationIsLockedAndTheInputsAreChecked() public {
        _voteStack();
        this.test_theImplementationIsLockedAndTheInputsAreChecked();
    }

    function test_vote_parkMovesTheSharesIntoCustodyAndRecordsWhoseTheyAre() public {
        _voteStack();
        this.test_parkMovesTheSharesIntoCustodyAndRecordsWhoseTheyAre();
    }

    function test_vote_parkMovesNoDollars() public {
        _voteStack();
        this.test_parkMovesNoDollars();
    }

    function test_vote_parkRevertsForZeroAndWithoutBalanceOrAllowance() public {
        _voteStack();
        this.test_parkRevertsForZeroAndWithoutBalanceOrAllowance();
    }

    function test_vote_noOneCanParkForSomeoneElse() public {
        _voteStack();
        this.test_noOneCanParkForSomeoneElse();
    }

    function test_vote_unparkReturnsTheSharesAtOnceToTheParkerOnly() public {
        _voteStack();
        this.test_unparkReturnsTheSharesAtOnceToTheParkerOnly();
    }

    function test_vote_unparkRevertsForZeroAndForMoreThanParked() public {
        _voteStack();
        this.test_unparkRevertsForZeroAndForMoreThanParked();
    }

    function test_vote_aDonationIsNotParked() public {
        _voteStack();
        this.test_aDonationIsNotParked();
    }

    function test_vote_aBrokenShareTokenIsRefusedNotIgnored() public {
        _voteStack();
        this.test_aBrokenShareTokenIsRefusedNotIgnored();
    }

    function test_vote_theLineIsAThirdOfTheBackerSharesRoundedUp() public {
        _voteStack();
        this.test_theLineIsAThirdOfTheBackerSharesRoundedUp();
    }

    function test_vote_pausedOnlyAfterTheWholeDayAndEndsTheSecondTheLineIsLost() public {
        _voteStack();
        this.test_pausedOnlyAfterTheWholeDayAndEndsTheSecondTheLineIsLost();
    }

    function test_vote_parkingMoreWhileArmedKeepsTheClock() public {
        _voteStack();
        this.test_parkingMoreWhileArmedKeepsTheClock();
    }

    function test_vote_aNewReachIsANewDay() public {
        _voteStack();
        this.test_aNewReachIsANewDay();
    }

    function test_vote_noBackerSharesIsNeverAPause() public {
        _voteStack();
        this.test_noBackerSharesIsNeverAPause();
    }

    function test_vote_pokeArmsALineReachedByOthersLeaving() public {
        _voteStack();
        this.test_pokeArmsALineReachedByOthersLeaving();
    }

    function test_vote_pokeEmitsOnlyWhenTheClockChanged() public {
        _voteStack();
        this.test_pokeEmitsOnlyWhenTheClockChanged();
    }

    function test_vote_pokeDisarmsAClockWhoseLineIsLost() public {
        _voteStack();
        this.test_pokeDisarmsAClockWhoseLineIsLost();
    }

    function test_vote_parkAndUnparkLookBeforeTheyChangeAnything() public {
        _voteStack();
        this.test_parkAndUnparkLookBeforeTheyChangeAnything();
    }

    function test_vote_viewsOfAnUnparkedProject() public {
        _voteStack();
        this.test_viewsOfAnUnparkedProject();
    }

    function test_vote_onlyTheLauncherBindsAGateAndOnlyOnce() public {
        _voteStack();
        this.test_onlyTheLauncherBindsAGateAndOnlyOnce();
    }
}

/// @notice The Take out rules of `HolderPauseAttacks.t.sol` on a `HolderVote` clone: a parked holder's one-press Take out pays the
/// quote in one batch, un-parking works while paused, wound down and shut, un-parking then sending ends the count, and parked
/// Shares cannot be moved by anyone but their holder.
contract PauseOnVoteAttacksTest is HolderPauseAttacksTest {
    /// @dev As `HolderPauseAttacksTest.setUp`: the switch-on stack (each test builds its own project on it).
    function _voteStack() internal {
        vm.warp(T0);
        clock = T0;
        usd = new QuoteToken();
        parts = new Parts();
        launcher = new Launcher(admin, _platform(UNIT), parts);
        HolderVote impl = new HolderVote();
        pauseImpl = HolderPause(address(impl));
        launcher.bindPause(address(impl));
        _use(_launch(founder, "p1", 1000, POOL));
        pause = HolderPause(t.pauseGate());
        assertTrue(HolderVote(address(pause)).isVote(), "the project's pause is the vote contract");
    }

    function test_vote_takeOutWithParkedSharesPaysTheQuoteInOneBatch() public {
        _voteStack();
        this.test_takeOutWithParkedSharesPaysTheQuoteInOneBatch();
    }

    function test_vote_unparkWorksWhenPausedWoundDownAndShut() public {
        _voteStack();
        this.test_unparkWorksWhenPausedWoundDownAndShut();
    }

    function test_vote_unparkThenSendEndsTheCount() public {
        _voteStack();
        this.test_unparkThenSendEndsTheCount();
    }

    function test_vote_parkedSharesCannotBeSent() public {
        _voteStack();
        this.test_parkedSharesCannotBeSent();
    }
}

/// @notice The gas limits of `GasPause.t.sol`'s switch-on suite on a `HolderVote` clone, and the plan's allowance for the one cold
/// read the vote contract adds to `park` and `unpark` with no ballot live.
contract GasPauseOnVoteTest is GasPauseOnTest {
    /// @dev As `GasPauseOnTest.setUp`: the switch-on stack, then the scenario of `Gas.t.sol`.
    function _voteStack() internal {
        vm.warp(T0);
        clock = T0;
        usd = new QuoteToken();
        parts = new Parts();
        launcher = new Launcher(admin, _platform(UNIT), parts);
        HolderVote impl = new HolderVote();
        pauseImpl = HolderPause(address(impl));
        launcher.bindPause(address(impl));
        _use(_launch(founder, "p1", 1000, POOL));
        pause = HolderPause(t.pauseGate());
        assertTrue(HolderVote(address(pause)).isVote(), "the project's pause is the vote contract");
        _gasScenario();
    }

    function test_vote_gas_switchOn_join_nothingParked() public {
        _voteStack();
        this.test_gas_switchOn_join_nothingParked();
    }

    function test_vote_gas_switchOn_draw_nothingParked() public {
        _voteStack();
        this.test_gas_switchOn_draw_nothingParked();
    }

    function test_vote_gas_park_unpark_poke() public {
        _voteStack();
        this.test_gas_park_unpark_poke();
    }

    /// @dev `park` and `unpark` on the same scenario, cold, on whichever stack is built now.
    function _measureParkUnpark() internal returns (uint256 parkGas, uint256 unparkGas) {
        uint256 n = shares.balanceOf(alice) / 3;
        vm.startPrank(alice);
        shares.approve(address(pause), n);
        vm.cool(address(pause));
        vm.cool(address(pauseImpl));
        vm.cool(address(shares));
        uint256 g = gasleft();
        pause.park(n);
        parkGas = g - gasleft();
        vm.cool(address(pause));
        vm.cool(address(pauseImpl));
        vm.cool(address(shares));
        g = gasleft();
        pause.unpark(n);
        unparkGas = g - gasleft();
        vm.stopPrank();
    }

    /// @notice With no ballot live the vote contract's hooks still cost almost nothing: `park` and `unpark` stay under the same
    /// allowance `GasPause.t.sol` gives every switch-on call (`ON_EXTRA`, 25,000), and the measured additions are logged. The same
    /// project, the same balances and the same storage are measured twice and then a third time with only the pause implementation's
    /// code changed (etched with the vote contract's runtime), so the difference is the hooks' own cost and nothing else.
    function test_voteCloneHooksStayUnderThePausesGasAllowance() public {
        _measureParkUnpark(); // a warm-up: the first touch of a contract in the test's one transaction pays its cold account access
        (uint256 plainPark, uint256 plainUnpark) = _measureParkUnpark();
        (uint256 againPark, uint256 againUnpark) = _measureParkUnpark();
        assertEq(againPark, plainPark, "the plain measurement repeats");
        assertEq(againUnpark, plainUnpark, "the plain measurement repeats");
        vm.etch(address(pauseImpl), type(HolderVote).runtimeCode);
        (uint256 votePark, uint256 voteUnpark) = _measureParkUnpark();
        emit log_named_uint("park, plain pause code, gas", plainPark);
        emit log_named_uint("park, HolderVote code, gas", votePark);
        emit log_named_uint("park, added by the vote hooks", votePark - plainPark);
        emit log_named_uint("unpark, plain pause code, gas", plainUnpark);
        emit log_named_uint("unpark, HolderVote code, gas", voteUnpark);
        emit log_named_uint("unpark, added by the vote hooks", voteUnpark - plainUnpark);
        assertLe(votePark, plainPark + ON_EXTRA, "park added more than the pause suite allows");
        assertLe(voteUnpark, plainUnpark + ON_EXTRA, "unpark added more than the pause suite allows");
    }
}

/// @notice The announce and launch limits of `GasPause.t.sol`'s switch-on tasks suite on a `HolderVote` clone (the launch also runs
/// `bindProject`, which the plan's launch allowance of 150,000 covers).
contract GasPauseOnVoteTasksTest is GasPauseOnTasksTest {
    function _voteStack() internal {
        vm.warp(T0);
        clock = T0;
        usd = new QuoteToken();
        parts = new Parts();
        launcher = new Launcher(admin, _platform(UNIT), parts);
        HolderVote impl = new HolderVote();
        pauseImpl = HolderPause(address(impl));
        launcher.bindPause(address(impl));
        _use(_launch(founder, "p1", 1000, POOL));
        pause = HolderPause(t.pauseGate());
        assertTrue(HolderVote(address(pause)).isVote(), "the project's pause is the vote contract");
        _join(alice, 50_000e6);
        _join(bob, 20_000e6);
    }

    function test_vote_gas_switchOn_announce_nothingParked() public {
        _voteStack();
        this.test_gas_switchOn_announce_nothingParked();
    }

    function test_vote_gas_switchOn_launch() public {
        _voteStack();
        this.test_gas_switchOn_launch();
    }
}
