// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "oz5/proxy/Clones.sol";
import {IShares} from "../src/Interfaces.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {PauseBase} from "./helpers/PauseBase.sol";

/// @notice A share token that can be told to refuse every move with `false` (a broken token), for the revert paths a real
/// ShareToken never takes.
contract FalseShares {
    uint256 public totalSupply = 900e18;
    bool public failing;

    function setFailing(bool on) external {
        failing = on;
    }

    function transferFrom(address, address, uint256) external view returns (bool) {
        return !failing;
    }

    function transfer(address, uint256) external view returns (bool) {
        return !failing;
    }
}

/// @notice The holder pause contract on its own: birth, park and unpark, the line, the day, the look (`poke`), the views.
/// Every revert path has a test; the mutation script switches each guard off once.
contract HolderPauseTest is PauseBase {
    function setUp() public override {
        super.setUp();
        _aliceBacks(10_204_081_633); // a pot of exactly 10,000 dollars after the fee
        _join(bob, 2000e6);
        _oddSupply();
    }

    /// @dev Make the backer supply not a multiple of three, so rounding the line up and down differ.
    function _oddSupply() internal {
        for (uint256 i; i < 6 && shares.totalSupply() % 3 == 0; ++i) {
            _join(carol, (3 + i) * 1e6);
        }
        assertTrue(shares.totalSupply() % 3 != 0, "supply is a multiple of three");
    }

    // ---------------------------------------------------------------------------------------------------- birth

    function test_aCloneIsBornOnceWithTheShareTokenAndADayOfUnitOverSeven() public {
        assertEq(address(pause.shares()), address(shares));
        assertEq(pause.day(), UNIT / 7, "24 hours on a real network");
        assertEq(pause.LINE_DIVISOR(), 3);
        vm.expectRevert(HolderPause.AlreadyBorn.selector);
        pause.initialize(IShares(address(shares)), UNIT);
    }

    function test_theImplementationIsLockedAndTheInputsAreChecked() public {
        vm.expectRevert(HolderPause.AlreadyBorn.selector);
        pauseImpl.initialize(IShares(address(shares)), UNIT);
        HolderPause c = HolderPause(Clones.clone(address(pauseImpl)));
        vm.expectRevert(HolderPause.BadInput.selector);
        c.initialize(IShares(address(0)), UNIT);
        vm.expectRevert(HolderPause.BadInput.selector);
        c.initialize(IShares(address(shares)), 0);
        vm.expectRevert(HolderPause.BadInput.selector);
        c.initialize(IShares(address(shares)), 1000); // not a multiple of 168
        c.initialize(IShares(address(shares)), 1680);
        assertEq(c.day(), 240, "a demo network's day is four minutes");
    }

    function test_theSourceIsPinnedToTheProjectCompiler() public view {
        assertTrue(vm.contains(vm.readFile("src/HolderPause.sol"), "\npragma solidity 0.8.37;\n"));
    }

    // ------------------------------------------------------------------------------------------ park and unpark

    function test_parkMovesTheSharesIntoCustodyAndRecordsWhoseTheyAre() public {
        uint256 n = shares.balanceOf(alice) / 10;
        uint256 b = shares.totalSupply();
        vm.prank(alice);
        shares.approve(address(pause), n);
        vm.expectEmit(true, false, false, true, address(pause));
        emit HolderPause.Parked(alice, n, n, n, b, 0);
        vm.prank(alice);
        pause.park(n);
        assertEq(pause.parkedOf(alice), n);
        assertEq(pause.parkedTotal(), n);
        assertEq(shares.balanceOf(address(pause)), n);
        assertEq(shares.totalSupply(), b, "parking mints and burns nothing");
        _park(alice, 5);
        assertEq(pause.parkedOf(alice), n + 5);
        assertEq(pause.parkedTotal(), n + 5);
    }

    function test_parkMovesNoDollars() public {
        uint256 held = usd.balanceOf(address(t));
        (uint256 pot, uint256 box, uint256 feesOwed) = (t.pot(), t.box(), t.feesOwed());
        _park(alice, shares.balanceOf(alice) / 2);
        _unpark(alice, 1);
        pause.poke();
        assertEq(usd.balanceOf(address(t)), held);
        assertEq(usd.balanceOf(address(pause)), 0);
        assertEq(t.pot(), pot);
        assertEq(t.box(), box);
        assertEq(t.feesOwed(), feesOwed);
    }

    function test_parkRevertsForZeroAndWithoutBalanceOrAllowance() public {
        vm.prank(alice);
        vm.expectRevert(HolderPause.BadInput.selector);
        pause.park(0);
        vm.prank(alice);
        vm.expectRevert(ShareToken.InsufficientBalance.selector); // no allowance to the pause
        pause.park(1);
        vm.startPrank(stranger);
        shares.approve(address(pause), 1);
        vm.expectRevert(ShareToken.InsufficientBalance.selector); // no Shares
        pause.park(1);
        vm.stopPrank();
    }

    function test_noOneCanParkForSomeoneElse() public {
        // alice approves the pause for everything; bob calls park: it pulls bob's own Shares, never alice's
        vm.prank(alice);
        shares.approve(address(pause), type(uint256).max);
        uint256 aliceBefore = shares.balanceOf(alice);
        vm.prank(bob, alice); // the caller is bob; the transaction's origin is alice, who gave the allowance
        vm.expectRevert(ShareToken.InsufficientBalance.selector); // bob has none of his own to park and gave no allowance
        pause.park(aliceBefore);
        _park(bob, 1);
        assertEq(shares.balanceOf(alice), aliceBefore, "alice's Shares did not move");
        assertEq(pause.parkedOf(alice), 0);
        assertEq(pause.parkedOf(bob), 1);
    }

    function test_unparkReturnsTheSharesAtOnceToTheParkerOnly() public {
        uint256 n = shares.balanceOf(alice) / 4;
        _park(alice, n);
        uint256 b = shares.totalSupply();
        vm.expectEmit(true, false, false, true, address(pause));
        emit HolderPause.Unparked(alice, n / 2, n - n / 2, n - n / 2, b, 0);
        _unpark(alice, n / 2);
        assertEq(pause.parkedOf(alice), n - n / 2);
        assertEq(pause.parkedTotal(), n - n / 2);
        assertEq(shares.balanceOf(address(pause)), n - n / 2);
        // another holder cannot take alice's parked Shares
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(HolderPause.TooMuch.selector, 1, 0));
        pause.unpark(1);
    }

    function test_unparkRevertsForZeroAndForMoreThanParked() public {
        _park(alice, 100);
        vm.prank(alice);
        vm.expectRevert(HolderPause.BadInput.selector);
        pause.unpark(0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderPause.TooMuch.selector, 101, 100));
        pause.unpark(101);
    }

    function test_aDonationIsNotParked() public {
        uint256 b = shares.totalSupply();
        vm.prank(alice);
        shares.transfer(address(pause), b / 2); // sent straight to the contract: a gift, not parking
        assertEq(pause.parkedTotal(), 0);
        assertEq(pause.parkedOf(alice), 0);
        pause.poke();
        assertEq(pause.armedAt(), 0, "a donation arms nothing");
        _warp(10 * _day());
        assertFalse(pause.paused());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderPause.TooMuch.selector, 1, 0));
        pause.unpark(1); // and it cannot be taken back through unpark
    }

    function test_aBrokenShareTokenIsRefusedNotIgnored() public {
        FalseShares f = new FalseShares();
        HolderPause c = HolderPause(Clones.clone(address(pauseImpl)));
        c.initialize(IShares(address(f)), 1680);
        c.park(10);
        f.setFailing(true);
        vm.expectRevert(HolderPause.TransferFailed.selector);
        c.park(10);
        vm.expectRevert(HolderPause.TransferFailed.selector);
        c.unpark(5);
    }

    // ------------------------------------------------------------------------------------- the line and the day

    function test_theLineIsAThirdOfTheBackerSharesRoundedUp() public {
        uint256 b = shares.totalSupply();
        uint256 need = pause.line();
        assertEq(need, (b + 2) / 3);
        assertLt((need - 1) * 3, b, "one under the line is under a third");
        assertGe(need * 3, b);
        _park(alice, need - 1);
        assertEq(pause.armedAt(), 0, "one Share under the line arms nothing");
        _park(alice, 1);
        assertEq(pause.armedAt(), clock, "the Share that reaches the line arms it");
        (uint256 parked, uint256 backers, uint256 lineShares, uint64 armed, uint256 pausesAt, bool isPaused) =
            pause.state();
        assertEq(parked, need);
        assertEq(backers, b);
        assertEq(lineShares, need);
        assertEq(armed, clock);
        assertEq(pausesAt, clock + _day());
        assertFalse(isPaused);
        assertEq(pause.pausesFrom(), pausesAt);
    }

    function test_pausedOnlyAfterTheWholeDayAndEndsTheSecondTheLineIsLost() public {
        _parkToLine(alice);
        uint256 t0 = clock;
        assertFalse(pause.paused());
        _warpTo(t0 + _day() - 1);
        assertFalse(pause.paused(), "one second short of a day");
        _warpTo(t0 + _day());
        assertTrue(pause.paused(), "a full day");
        (,,,,, bool isPaused) = pause.state();
        assertTrue(isPaused);
        _unpark(alice, 1);
        assertFalse(pause.paused(), "ends the second parked falls under the line");
        assertEq(pause.armedAt(), 0, "and there is no memory");
        assertEq(pause.pausesFrom(), 0);
    }

    function test_parkingMoreWhileArmedKeepsTheClock() public {
        _parkToLine(alice);
        uint256 armed = pause.armedAt();
        _warp(3 hours);
        _park(alice, 5);
        assertEq(pause.armedAt(), armed, "more parked does not restart the day");
        assertEq(pause.pausesFrom(), armed + _day());
        _warp(_day() - 3 hours);
        assertTrue(pause.paused(), "a day after the first arming");
    }

    function test_aNewReachIsANewDay() public {
        _parkToLine(alice);
        _warp(_day() + 1);
        assertTrue(pause.paused());
        _unpark(alice, 1);
        assertFalse(pause.paused());
        _warp(5 * _day());
        _park(alice, 1);
        assertFalse(pause.paused(), "back at the line: the day starts again");
        _warp(_day());
        assertTrue(pause.paused());
    }

    function test_noBackerSharesIsNeverAPause() public {
        // a project nobody has backed: zero Shares, zero parked, and 3 x 0 >= 0 must not count as a line
        _use(_launch(founder, "empty", 1000, POOL));
        pause = HolderPause(t.pauseGate());
        pause.poke();
        assertEq(pause.armedAt(), 0);
        _warp(10 * _day());
        assertFalse(pause.paused());
        (,,, uint64 armed,, bool isPaused) = pause.state();
        assertEq(armed, 0);
        assertFalse(isPaused);
        // everyone leaves a project that was paused: the supply is zero and nothing is paused
        _join(alice, 100e6);
        _parkToLine(alice);
        _warp(_day());
        assertTrue(pause.paused());
        _unpark(alice, pause.parkedOf(alice));
        _leave(alice, shares.balanceOf(alice));
        assertEq(shares.totalSupply(), 0);
        pause.poke();
        _warp(5 * _day());
        assertFalse(pause.paused());
        assertEq(pause.armedAt(), 0);
    }

    function test_aShortDemoUnitGivesAShortDay() public {
        // a network with N = 1,680 seconds has a four-minute day
        (launcher, pauseImpl) = _shortLauncher();
        _use(_launch(founder, "short", 1000, POOL));
        pause = HolderPause(t.pauseGate());
        assertEq(pause.day(), 240);
        _join(alice, 100e6);
        _parkToLine(alice);
        _warp(239);
        assertFalse(pause.paused());
        _warp(1);
        assertTrue(pause.paused());
    }

    function _shortLauncher() internal returns (Launcher l, HolderPause impl) {
        l = new Launcher(admin, _platform(1680), parts);
        impl = new HolderPause();
        l.bindPause(address(impl));
    }

    // ------------------------------------------------------------------------------------------------ the look

    function test_pokeArmsALineReachedByOthersLeaving() public {
        // bob holds the smaller part; alice parks just under the line, then bob's exit lifts the ratio
        uint256 b = shares.totalSupply();
        uint256 park = pause.line() - 1;
        _park(alice, park);
        assertEq(pause.armedAt(), 0);
        _leave(bob, shares.balanceOf(bob));
        assertLt(shares.totalSupply(), b);
        assertGe(pause.parkedTotal() * 3, shares.totalSupply(), "the line is reached by the exit alone");
        assertEq(pause.armedAt(), 0, "nobody has looked yet");
        assertFalse(pause.paused());
        vm.expectEmit(false, false, false, true, address(pause));
        emit HolderPause.Observed(park, shares.totalSupply(), uint64(clock));
        pause.poke();
        assertEq(pause.armedAt(), clock);
    }

    function test_pokeEmitsOnlyWhenTheClockChanged() public {
        vm.recordLogs();
        pause.poke(); // nothing parked, nothing armed: no change
        assertEq(vm.getRecordedLogs().length, 0, "a poke that changes nothing says nothing");
        _parkToLine(alice);
        vm.recordLogs();
        pause.poke(); // already armed
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_pokeDisarmsAClockWhoseLineIsLost() public {
        _parkToLine(alice);
        assertTrue(pause.armedAt() != 0);
        // a join that lowers the parked share is poked by the Treasury itself (checked in the attack tests); here the supply
        // is raised and poke is called by anyone
        _join(carol, 50_000e6);
        assertEq(pause.armedAt(), 0, "the join's own poke saw it");
        pause.poke();
        assertEq(pause.armedAt(), 0);
    }

    function test_parkAndUnparkLookBeforeTheyChangeAnything() public {
        // plant an old clock over a line that is not reached (a dip nobody saw: the state the join hook rules out) and show
        // that park clears it before it counts, so the pause does not start with no day of seeing the line
        _park(alice, 1);
        vm.store(address(pause), bytes32(uint256(0)), _slot0WithArmedAt(uint64(clock)));
        assertEq(pause.armedAt(), clock);
        _warp(3 * _day()); // the old clock would have long run out
        assertFalse(pause.paused(), "the live line is not reached: not paused");
        _park(alice, pause.line() - 1); // now the line is reached with this park
        assertEq(pause.armedAt(), clock, "a new clock, not the old one");
        assertFalse(pause.paused(), "no pause on the old clock");
        // the same for unpark: stale clock over an unreached line
        _unpark(alice, pause.parkedTotal());
        assertEq(pause.armedAt(), 0);
        vm.store(address(pause), bytes32(uint256(0)), _slot0WithArmedAt(uint64(clock)));
        _park(alice, 5);
        assertEq(pause.armedAt(), 0, "park under the line cleared the stale clock");
    }

    /// @dev The first storage slot of the pause with `armedAt` set: shares (20 bytes), day (4), armedAt (8).
    function _slot0WithArmedAt(uint64 a) internal view returns (bytes32) {
        return bytes32(uint256(uint160(address(shares))) | (uint256(pause.day()) << 160) | (uint256(a) << 192));
    }

    // ------------------------------------------------------------------------------------------------- the views

    function test_viewsOfAnUnparkedProject() public view {
        (uint256 parked, uint256 b, uint256 lineShares, uint64 armed, uint256 pausesAt, bool isPaused) = pause.state();
        assertEq(parked, 0);
        assertEq(b, shares.totalSupply());
        assertEq(lineShares, pause.line());
        assertEq(armed, 0);
        assertEq(pausesAt, 0);
        assertFalse(isPaused);
        assertEq(pause.pausesFrom(), 0);
    }

    // ---------------------------------------------------------------------------- the Treasury's end of the gate

    function test_onlyTheLauncherBindsAGateAndOnlyOnce() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.bindPause(address(1));
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector); // not even the founder or the runner
        t.bindPause(address(1));
        vm.prank(address(launcher));
        vm.expectRevert(Treasury.BadInput.selector); // already bound
        t.bindPause(address(1));
    }
}
