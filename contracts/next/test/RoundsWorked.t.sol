// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RoundsBase} from "./helpers/RoundsBase.sol";
import {Rounds} from "../src/Rounds.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice Plan version 2, section 4, the worked examples of backing rounds as exact numbers (the 100,000 auction is in
/// `AuctionV2.t.sol`, on the real Uniswap stack).
contract RoundsWorkedTest is RoundsBase {
    /// @dev 2,500, Solo to Backed: 7.5M Shares (0.75%), platform 75, 375 at once and 78.85 a week; 690.38 after four weeks,
    /// 1,400 at week 13, 2,425 at week 26. A backer of 100 takes back 77.90 on day 0 and 58.64 on day 45 (the plan says 58.60:
    /// it rounded down; 82 x 137/182 x 0.95 = 58.639).
    function test_worked_2500_SoloToBacked() public {
        _checkIn();
        uint256 id = _openRound();
        _ask(id, alice, 2400 * DOLLAR);
        _ask(id, bob, 100 * DOLLAR);
        _close(id);
        rd.settle(id, alice);
        rd.settle(id, bob);
        uint256 snap = vm.snapshotState();
        assertEq(uint256(launcher.stageOf(key)), uint256(Launcher.Stage.Backed));
        assertEq(rd.positionOf(id, alice).bought + rd.positionOf(id, bob).bought, 7_500_000 * SHARE, "0.75%");
        assertEq(rd.platformOwed(), 75 * DOLLAR);
        assertEq(t.spendable(), 375 * DOLLAR, "375 at once");
        assertEq(rd.refundable(id, bob), 77.9e6, "bob can take back 77.90 on day 0");
        _live(1 weeks);
        assertEq(rd.releasable(id), uint256(2050 * DOLLAR) * 7 / 182, "78.85 a week");
        _live(3 weeks);
        rd.release(id);
        assertEq(t.spendable(), 375 * DOLLAR + uint256(2050 * DOLLAR) * 28 / 182, "690.38 after four weeks");
        vm.revertToState(snap);
        _live(45 days);
        assertEq(rd.refundable(id, bob), 58_639_010, "58.64 on day 45");
        _live(91 days - 45 days);
        rd.release(id);
        assertEq(t.spendable(), 1400 * DOLLAR, "1,400 at week 13");
        _live(91 days);
        rd.release(id);
        assertEq(t.spendable(), 2425 * DOLLAR, "2,425 at week 26");
    }

    /// @dev 10,000, the Backed cap: 30M Shares (3%), platform 300, 1,500 at once, 315.38 a week, 2,761.54 after four weeks, 9,700
    /// at week 26. And the most the founder side can have by day 15: 21.76 of each 100 (2,175.82).
    function test_worked_10000_theBackedCap() public {
        uint256 id = _round(alice, 10_000 * DOLLAR);
        assertEq(rd.positionOf(id, alice).bought, 30_000_000 * SHARE, "3%");
        assertEq(rd.platformOwed(), 300 * DOLLAR);
        assertEq(t.spendable(), 1500 * DOLLAR);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Launcher.CapReached.selector, 10_000 * DOLLAR));
        launcher.openRound(key);
        _live(15 days);
        rd.release(id);
        assertEq(t.spendable(), 1500 * DOLLAR + uint256(8200 * DOLLAR) * 15 / 182, "21.76 of each 100 by day 15");
        _live(13 days);
        rd.release(id);
        assertEq(t.spendable(), 1500 * DOLLAR + uint256(8200 * DOLLAR) * 28 / 182, "2,761.54 after four weeks");
        _live(154 days);
        rd.release(id);
        assertEq(t.spendable(), 9700 * DOLLAR, "9,700 at week 26");
    }

    /// @dev 50,000, Team: 10,000 alone, then a second person, then a 40,000 round opened by both: 120M Shares, platform 1,200,
    /// 6,000 at once (two touches), 1,261.54 a week. 150M Shares (15%) sold in all.
    function test_worked_50000_Team() public {
        uint256 first = _round(alice, 10_000 * DOLLAR);
        _team();
        uint256 id = _openRound(); // both signers
        assertEq(rd.roundOf(id).size, 40_000 * DOLLAR);
        _ask(id, bob, 40_000 * DOLLAR);
        _close(id);
        rd.settle(id, bob);
        assertEq(rd.positionOf(id, bob).bought, 120_000_000 * SHARE);
        assertEq(rd.platformOwed(), 300 * DOLLAR + 1200 * DOLLAR);
        assertEq(rd.positionOf(first, alice).bought + rd.positionOf(id, bob).bought, 150_000_000 * SHARE, "15% sold");
        assertEq(
            t.spendable(), 1500 * DOLLAR + 6000 * DOLLAR, "1,500 from the first round and 6,000 at once from this one"
        );
        _live(7 days);
        assertEq(rd.releasable(id), uint256(32_800 * DOLLAR) * 7 / 182, "1,261.54 a week");
    }
}

/// @notice Attacks on backing rounds: a founder filling their own rounds through many accounts, fake demand that forces a
/// scale-back on honest backers, a refund after the market opens, a refund and a new ask to game the scale-back. (A single
/// founder past the cap or opening the auction, one Pair signer spending 501 or raising alone, and an agent checking in are in
/// `PairStages.t.sol`; gifts through fresh wallets and exits in pieces in `AttackM2.t.sol`.)
contract RoundsAttackTest is RoundsBase {
    /// @dev The founder fills their own 10,000 round through 20 accounts, then tries to sell before release. Before a market
    /// nothing is in any hand; on the market's first day 1/365 of the 30M is free; the money costs them the platform's 3.
    function test_attack_aFounderFillsTheirOwnRoundsThroughManyAccounts_andCannotSellBeforeRelease() public {
        _checkIn();
        uint256 id = _openRound();
        address[] memory sybils = new address[](20);
        for (uint256 i; i < 20; ++i) {
            sybils[i] = makeAddr(string.concat("sybil", vm.toString(i)));
            _ask(id, sybils[i], 500 * DOLLAR);
        }
        _close(id);
        rd.settleMany(id, sybils);
        uint256 inHand;
        for (uint256 i; i < 20; ++i) {
            inHand += shares.balanceOf(sybils[i]) + v.claimableHeld(id, sybils[i]);
        }
        assertEq(inHand, 0, "nothing to sell before a market");
        assertEq(t.countingSupply(), 0, "and nothing counts for an exit");
        vm.prank(sybils[0]);
        vm.expectRevert();
        shares.transfer(founder, 1); // the token is plain; the accounts simply hold nothing
        // the market opens; one day later
        _sale(7500 * DOLLAR);
        _live(1 days);
        uint256 freed;
        for (uint256 i; i < 20; ++i) {
            freed += v.claimHeld(id, sybils[i]);
        }
        assertEq(freed, 30_000_000 * SHARE / 365 / 20 * 20, "1/365 of the 30M on the first day (rounded per account)");
        emit log_named_uint("self-filled 30M: Shares free on the market's first day", freed / SHARE);
        // what it cost: if the founder takes every account's money back at once, the platform keeps its 3 and its 1
        uint256 back;
        for (uint256 i; i < 20; ++i) {
            back += _refund(id, sybils[i]);
        }
        emit log_named_uint("money the 20 accounts took back after paying 10,000 (dollars)", back / DOLLAR);
        assertLt(back, 10_000 * DOLLAR * 82 / 100, "under the 82 held");
    }

    /// @dev Fake demand: 60 honest backers ask 100 each; one account asks 94,000 to force a scale-back, keeps the ask past the 12th
    /// hour, then takes the money back at once. Everyone gets the same percent (10%); the attacker pays the platform's 3, the
    /// project's 15 and the 5% refund fee on what it was accepted for, and the round's 10,000 is used up.
    function test_attack_fakeDemandForcesAScaleBack_measured() public {
        _checkIn();
        uint256 id = _openRound();
        address[] memory honest = new address[](60);
        for (uint256 i; i < 60; ++i) {
            honest[i] = makeAddr(string.concat("honest", vm.toString(i)));
            _ask(id, honest[i], 100 * DOLLAR);
        }
        address faker = makeAddr("faker");
        _ask(id, faker, 94_000 * DOLLAR);
        vm.warp(_now() + 12 hours);
        vm.prank(faker);
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.lower(id, 0); // too late to pull the fake ask out for free
        _close(id);
        rd.settleMany(id, honest);
        rd.settle(id, faker);
        uint256 h = rd.positionOf(id, honest[0]).bought / 3e15;
        uint256 f = rd.positionOf(id, faker).bought / 3e15;
        assertEq(h, 10 * DOLLAR, "each honest backer: 10% of the ask");
        assertEq(f, 9400 * DOLLAR, "the faker: the same 10%");
        uint256 cost = 94_000 * DOLLAR - usd.balanceOf(faker); // returned at settle
        uint256 back = _refund(id, faker);
        uint256 lost = cost - back;
        emit log_named_uint("honest backers in all (dollars accepted)", h * 60 / DOLLAR);
        emit log_named_uint("faker accepted (dollars)", f / DOLLAR);
        emit log_named_uint("faker's loss after taking the money back at once (cents)", lost / 1e4);
        assertEq(lost, f - (f * 82 / 100) * 95 / 100, "3 + 15 + 5% of the 82: 22.1 of each 100 accepted");
        assertEq(rd.raised(), 10_000 * DOLLAR, "and the cap is used up: refunds do not reopen it");
    }

    /// @dev A backer withdraws in the first 12 hours and asks again later in the same round: the scale-back gives them the
    /// same percent as everyone else. A backer who refunds one round and asks in the next finds the cap was not reopened.
    function test_attack_refundThenReAskGainsNothing() public {
        _checkIn();
        uint256 id = _openRound();
        _ask(id, alice, 10_000 * DOLLAR);
        _ask(id, bob, 10_000 * DOLLAR);
        vm.warp(_now() + 11 hours);
        vm.prank(bob);
        rd.lower(id, 0);
        vm.warp(_now() + 12 hours);
        vm.prank(bob);
        rd.ask(id, 10_000 * DOLLAR); // back in, after the 12th hour
        _close(id);
        rd.settle(id, alice);
        rd.settle(id, bob);
        assertEq(rd.positionOf(id, alice).bought, rd.positionOf(id, bob).bought, "the same percent for both");
        // round 1 used 10,000 of the 10,000 cap; bob takes his money back, the cap stays used
        _refund(id, bob);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Launcher.CapReached.selector, 10_000 * DOLLAR));
        launcher.openRound(key);
    }

    /// @dev After the market opens a backer takes released Shares out and then refunds: the refund covers only what is still
    /// held, never touches the floor, and pays at most their own unreleased money for those Shares less 5%.
    function test_attack_aRefundAfterTheMarketTakesNothingFromTheFloor() public {
        uint256 id = _round(carol, 1000 * DOLLAR);
        _sale(7500 * DOLLAR);
        _buy(alice, 100_000_000 * SHARE);
        _live(100 days);
        v.claimHeld(id, carol);
        uint256 melting = t.melting();
        uint256 permanent = t.permanentFloor();
        (uint256 total, uint256 claimed) = v.heldGrants(id, carol);
        uint256 part = rd.positionOf(id, carol).held * (total - claimed) / total;
        uint256 e = rd.activeNow() - rd.roundOf(id).activeAtClose;
        uint256 most = (part - part * e / 182 days) * 95 / 100;
        uint256 paid = _refund(id, carol);
        assertLe(paid, most + 1, "never more than her own unreleased money for the Shares still held, less 5%");
        assertEq(t.melting(), melting, "the floor is untouched");
        assertEq(t.permanentFloor(), permanent);
    }
}
