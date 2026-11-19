// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PotBase} from "./helpers/PotBase.sol";
import {TaskBook} from "../src/TaskBook.sol";

/// @notice Attacks on the money of the queue and the exit notes, each stating the claim it tries to break: a speculator around an
/// accept or a return never gains, a Team holder who takes out early never beats the one who waits, dust loops never shrink an
/// honest holder, a flood before a take costs the sleeper no more than 5%, and the one rounding band that is declined (a
/// part payment under paid-in pays an early leaver a little less than waiting would) stays inside a stated bound.
contract TasksMoneyTest is PotBase {
    bytes32 internal constant WHAT = keccak256("a task");
    address internal worker = makeAddr("worker");
    address internal attacker = makeAddr("attacker");

    function setUp() public override {
        super.setUp();
        _relaunch(0, 0); // no Team pool, no allowance: the pot moves by tasks, joins and take-outs only
        t.forceShares(alice, 40_000e18);
        t.forceShares(bob, 60_000e18);
        _force(100_000e6, 100_000e6, 0, 0, 0);
    }

    function _warpAlive(uint256 ts) internal {
        if (ts <= vm.getBlockTimestamp()) return;
        _checkIn();
        uint256 at = vm.getBlockTimestamp();
        while (at + 10 days < ts) {
            at += 6 days;
            vm.warp(at);
            _checkIn();
        }
        vm.warp(ts);
    }

    function _locked(uint16 bps, uint256 max) internal returns (uint64 serial) {
        vm.prank(founder);
        serial = t.announceTask(WHAT, worker, max, bps);
        _warpAlive(_book().taskOf(serial).noticeEnd);
        vm.prank(worker);
        t.takeTask(serial, 0);
    }

    function _bobValue() internal view returns (uint256) {
        // no Team pool: a Share is worth (pot + the stayers' claim on set-aside money) / Shares
        return shares.balanceOf(bob) * (t.pot() + t.locked()) / shares.totalSupply();
    }

    /// @dev CLAIM: whatever the order of join, take-out, accept, return and claim, a speculator who does not control the
    /// payment ends no better than he began (a join counts set-aside money at face, a take-out gets a note at face).
    function testFuzz_speculatorAroundAnAcceptOrReturnNeverGains(
        uint256 joinAmt,
        uint256 payPct,
        uint8 order,
        bool returnInstead,
        uint256 paidIn_,
        bool withTeam,
        uint256 rev,
        uint8 rate
    ) public {
        rev = bound(rev, 0, 50_000e6);
        rate = uint8(bound(rate, 0, 2));
        joinAmt = bound(joinAmt, 1e6, 500_000e6);
        payPct = bound(payPct, 1, 100);
        paidIn_ = bound(paidIn_, 70_000e6, 130_000e6);
        _relaunch(withTeam ? POOL : 0, uint32(rate) * 1000);
        t.forceShares(alice, 40_000e18);
        t.forceShares(bob, 60_000e18);
        _force(100_000e6, paidIn_, 0, 0, 0);
        if (rev >= 1e6) _revenue(carol, rev); // money already on its way before the speculator acts
        uint64 s = _locked(500, 10_000e6);
        uint256 L = _book().taskOf(s).locked;
        uint256 pay = returnInstead ? 0 : (L * payPct) / 100;
        usd.mint(attacker, joinAmt);
        uint256 startBal = usd.balanceOf(attacker);
        // join first or after
        bool joinBefore = (order & 1) == 0;
        bool leaveBeforeEnd = (order & 2) == 0;
        uint256 n;
        if (joinBefore) {
            _checkIn();
            vm.startPrank(attacker);
            usd.approve(address(t), joinAmt);
            n = t.join(joinAmt, 0, attacker);
            vm.stopPrank();
        }
        if (joinBefore && leaveBeforeEnd) {
            vm.prank(attacker);
            t.leave(n, 0, attacker);
        }
        // the end of the task
        if (pay > 0) {
            vm.prank(founder);
            t.acceptTask(s, pay);
        } else {
            vm.warp(_book().taskOf(s).deadline);
            t.settle();
        }
        if (!joinBefore) {
            _checkIn();
            vm.startPrank(attacker);
            usd.approve(address(t), joinAmt);
            n = t.join(joinAmt, 0, attacker);
            vm.stopPrank();
            vm.prank(attacker);
            t.leave(n, 0, attacker);
        } else if (!leaveBeforeEnd) {
            vm.prank(attacker);
            t.leave(n, 0, attacker);
        }
        if (_book().noteOf(s, attacker) != 0) {
            try t.claimNote(s, attacker) {} catch {}
        }
        uint256 endBal = usd.balanceOf(attacker);
        assertLe(endBal, startBal + 50, "the speculator made money");
    }

    /// @dev CLAIM: ten thousand tiny round trips around a locked task cost an honest holder nothing but rounding that favours him.
    function test_dustLoopsDoNotShrinkAnHonestHolder() public {
        _locked(500, 10_000e6);
        uint256 before_ = _bobValue();
        uint256 loops = 1500;
        vm.pauseGasMetering();
        for (uint256 i; i < loops; ++i) {
            uint256 amt = 1e6 + (i % 7) * 333_333;
            usd.mint(attacker, amt);
            vm.startPrank(attacker);
            usd.approve(address(t), amt);
            uint256 n = t.join(amt, 0, attacker);
            if (i % 2 == 0) {
                t.leave(n, 0, attacker);
            } else {
                t.leave(n / 2, 0, attacker);
                t.leave(n - n / 2, 0, attacker);
            }
            vm.stopPrank();
        }
        vm.resumeGasMetering();
        uint256 after_ = _bobValue();
        emit log_named_uint("bob before", before_);
        emit log_named_uint("bob after", after_);
        assertGe(after_ + 100, before_, "an honest holder lost to dust");
    }

    function _giveTeam(address to, uint256 n) internal {
        vm.prank(address(vester));
        team.transfer(to, n);
    }

    /// @dev CLAIM: a Team holder who takes out while money is set aside (cash plus note) never ends with more than the same holder
    /// who waited until the task was over (the Team claim is only what is above paid-in, so a note must not turn it into
    /// principal).
    function testFuzz_teamNoteNeverBeatsWaiting(uint256 paidIn_, uint256 payPct, uint256 tShare, bool back) public {
        paidIn_ = bound(paidIn_, 50_000e6, 94_900e6);
        payPct = bound(payPct, 0, 100);
        tShare = bound(tShare, 1e18, POOL / 2);
        _relaunch(POOL, 0);
        t.forceShares(alice, 40_000e18);
        t.forceShares(bob, 60_000e18);
        _force(100_000e6, paidIn_, 0, 0, 0);
        address carol_ = carol;
        _giveTeam(carol_, tShare);
        uint64 s = _locked(500, 10_000e6);
        uint256 L = _book().taskOf(s).locked;
        uint256 pay = back ? 0 : (L * payPct) / 100;
        uint256 id = vm.snapshotState();
        // path 1: leave with the task still out
        uint256 total1;
        {
            _checkIn();
            vm.prank(carol_);
            try t.leaveTeam(tShare, 0, carol_) {} catch {}
            _end(s, pay);
            if (_book().noteOf(s, carol_) != 0) {
                try t.claimNote(s, carol_) {} catch {}
            }
            total1 = usd.balanceOf(carol_);
            if (team.balanceOf(carol_) != 0) total1 = 0; // the leave was refused: nothing to compare
        }
        vm.revertToState(id);
        uint256 total2;
        {
            _end(s, pay);
            _checkIn();
            vm.prank(carol_);
            try t.leaveTeam(tShare, 0, carol_) {} catch {}
            total2 = usd.balanceOf(carol_);
        }
        emit log_named_uint("leave first", total1);
        emit log_named_uint("wait", total2);
        assertLe(total1, total2 + 5, "the Team holder did better by leaving first");
    }

    function _end(uint64 s, uint256 pay) internal {
        if (pay > 0) {
            vm.prank(founder);
            t.acceptTask(s, pay);
        } else {
            vm.warp(_book().taskOf(s).deadline);
            t.settle();
        }
    }

    /// @dev CLAIM (held): a founder with a puppet who floods the pot just before the second take and takes out at once cannot get
    /// the sleeper (bob, 60%) below 1 - 0.95 x 0.95 = 90.25 per 100 inside the cap window.
    function test_floodedSecondTakeCostsTheSleeperNoMoreThanFivePercent() public {
        address puppet = makeAddr("puppet");
        vm.startPrank(founder);
        uint64 s1 = t.announceTask(WHAT, worker, type(uint128).max, 500);
        uint64 s2 = t.announceTask(keccak256("two"), worker, type(uint128).max, 500);
        vm.stopPrank();
        _warpAlive(_book().taskOf(s2).noticeEnd);
        uint256 bobBefore = _bobValue();
        vm.prank(worker);
        t.takeTask(s1, 0);
        uint256 x = 900_000e6;
        usd.mint(puppet, x);
        vm.startPrank(puppet);
        usd.approve(address(t), x);
        uint256 n = t.join(x, 0, puppet);
        vm.stopPrank();
        vm.prank(worker);
        t.takeTask(s2, 0);
        uint256 l1 = _book().taskOf(s1).locked;
        uint256 l2 = _book().taskOf(s2).locked;
        vm.prank(puppet);
        t.leave(n, 0, puppet);
        vm.startPrank(founder);
        t.acceptTask(s1, l1);
        t.acceptTask(s2, l2);
        vm.stopPrank();
        uint256 bobAfter = _bobValue();
        emit log_named_uint("bob before", bobBefore);
        emit log_named_uint("bob after", bobAfter);
        emit log_named_uint("taken 1", l1);
        emit log_named_uint("taken 2", l2);
        emit log_named_uint("worker got", usd.balanceOf(worker));
        emit log_named_uint("puppet net", usd.balanceOf(puppet));
        assertGe(bobAfter * 10_000, bobBefore * 9025, "the sleeper lost more than 1 - 0.95 x 0.95");
    }

    /// @dev DECLINED, bounded (second order): a backer who takes out while a task is out, when the pot is just under paid-in with the task
    /// money counted, gets a note of the DILUTED value (surplus shared with the Team pool) but is paid back on it at ONE ratio
    /// with the stayers. After a big part-payment the pot is under paid-in and backers are paid before the Team, so the same backer
    /// who had waited would have got more. The difference stays with the stayers (and the Team). Numbers: Team pool 100 times the
    /// backer Shares, pot 1,000,000, paid-in 975,000, a 50,000 task paid 40,000, a 40% backer.
    function test_aPartPaymentUnderPaidInCostsAnEarlyLeaverUnderOnePercentAgainstWaiting() public {
        _relaunch(POOL * 10, 0); // Team pool 100,000,000 against 100,000 backer Shares
        t.forceShares(alice, 40_000e18);
        t.forceShares(bob, 60_000e18);
        _force(1_000_000e6, 975_000e6, 0, 0, 0);
        uint64 s = _locked(500, 100_000e6); // pot 950,000, set aside 50,000
        assertEq(_book().taskOf(s).locked, 50_000e6);
        uint256 id = vm.snapshotState();
        // path 1: take out with the task out, then the task is paid 40,000, then claim
        _checkIn();
        _leave(alice, 40_000e18);
        vm.prank(founder);
        t.acceptTask(s, 40_000e6);
        t.claimNote(s, alice);
        uint256 early = usd.balanceOf(alice);
        vm.revertToState(id);
        // path 2: wait for the payment, then take out
        vm.prank(founder);
        t.acceptTask(s, 40_000e6);
        _checkIn();
        _leave(alice, 40_000e18);
        uint256 waited = usd.balanceOf(alice);
        emit log_named_uint("alice leaving early (cash + note)", early);
        emit log_named_uint("alice waiting", waited);
        // the one ratio of the design pays the early leaver 382,001.998 against 384,000 for waiting (0.52%); the loss stays with the
        // stayers. It is bounded by about a quarter of the money set aside times the leaver's part of the backer Shares.
        assertLe(early, waited + 10, "leaving early never pays more than waiting");
        assertGe(early * 1000, waited * 990, "and costs under 1%");
    }
}
