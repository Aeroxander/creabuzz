// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Launcher} from "../../src/Launcher.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {Treasury} from "../../src/Treasury.sol";
import {Vester} from "../../src/Vester.sol";
import {Rounds} from "../../src/Rounds.sol";
import {Pair} from "../../src/Pair.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";

/// @notice The random user of one project's backing rounds and everything around them, for `RoundsInvariants.t.sol`: the runner
/// opens rounds (alone, or as a Pair after `team`), backers ask, lower, get settled, take money back and claim Shares, time passes
/// with and without check-ins, the pauser pauses, the market opens (the milestone 2 way: sale money arrives, the opener proves
/// the pool, buyers get Shares), the runner gives Shares, holders hand back, the project may wind down. The handler keeps its own
/// books so the rules are checked against numbers the contracts did not produce.
contract RoundsHandler is Test {
    uint256 internal constant DOLLAR = 1e6;
    uint256 internal constant SHARE = 1e18;
    uint256 internal constant N = 6;

    Launcher public launcher;
    Treasury public t;
    Vester public v;
    Rounds public rd;
    ShareToken public shares;
    QuoteToken public usd;
    address public founder;
    address public opener;
    address public platform;
    bytes32 public key;
    address public cosigner = makeAddr("cosigner");
    address public pauser = makeAddr("pauser");
    address[N] public backers;
    address[3] public holders;

    // ---- the handler's own books
    uint256 public minted; // dollars given to backers to ask with
    uint256 public toTreasury; // dollars the Rounds moved into the Treasury (the 15, releases, the refund fee's 4)
    uint256 public burned; // Shares burned by exits
    bool public everPair; // the runner was ever a Pair
    bool public refundOverpaid; // a refund paid more than the backer's own unreleased money less 5%
    bool public refundMovedOthers; // a refund changed another backer's refundable number
    bool public platformOvercharged; // the platform's owed money rose by more than its fee in one action
    bool public marketOpen;
    uint256 public refunds;
    uint256 public settles;
    uint256 public releases;
    uint256 public closes;
    uint256 public exits;
    uint256 public claims;
    uint256 public gifts;

    constructor(Launcher l, bytes32 key_, address founder_, address councilMaker, QuoteToken usd_) {
        (launcher, key, founder, usd) = (l, key_, founder_, usd_);
        Launcher.Project memory p = l.projectByKey(key_);
        (t, v, rd, shares) = (Treasury(p.treasury), Vester(p.vester), Rounds(p.rounds), ShareToken(p.shares));
        (opener, platform) = (p.finisher, t.platform());
        for (uint256 i; i < N; ++i) {
            backers[i] = makeAddr(string.concat("backer", vm.toString(i)));
            vm.prank(backers[i]);
            usd.approve(address(rd), type(uint256).max);
        }
        for (uint256 i; i < 3; ++i) {
            holders[i] = makeAddr(string.concat("holder", vm.toString(i)));
            vm.prank(holders[i]);
            shares.approve(address(t), type(uint256).max);
        }
        vm.prank(councilMaker);
        l.setPauser(key_, pauser);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// @dev The runner does `data` on `target`: the founder alone, or both signers of the Pair.
    function _asRunner(address target, bytes memory data) internal returns (bool ok) {
        address r = t.runner();
        if (launcher.isPair(r)) {
            Pair pair = Pair(r);
            vm.prank(founder);
            pair.propose(target, data);
            uint256 n = pair.nonce() - 1;
            vm.prank(cosigner);
            (ok,) = address(pair).call(abi.encodeCall(Pair.confirm, (target, data, n)));
        } else {
            vm.prank(r);
            (ok,) = target.call(data);
        }
    }

    function _round(uint256 sel) internal view returns (uint256) {
        uint256 c = rd.count();
        return c == 0 ? 0 : 1 + sel % c;
    }

    // ================================================ the rounds ====================================================

    function openRound() external {
        _asRunner(address(launcher), abi.encodeCall(Launcher.openRound, (key)));
    }

    function team() external {
        if (everPair || t.runner() != founder) return;
        address predicted = launcher.pairAddress(key, founder, cosigner);
        vm.prank(founder);
        t.handOver(predicted, false);
        vm.prank(cosigner);
        launcher.makePair(key, founder);
        everPair = true;
    }

    function ask(uint256 i, uint256 amount) external {
        uint256 id = rd.count();
        address b = backers[i % N];
        amount = bound(amount, DOLLAR, 20_000 * DOLLAR);
        usd.mint(b, amount);
        minted += amount;
        vm.prank(b);
        try rd.ask(id, amount) {} catch {}
    }

    function lower(uint256 i, uint256 to) external {
        uint256 id = rd.count();
        address b = backers[i % N];
        uint256 old = id == 0 ? 0 : rd.positionOf(id, b).ask;
        to = bound(to, 0, old);
        vm.prank(b);
        try rd.lower(id, to) {} catch {}
    }

    function close() external {
        uint256 id = rd.count();
        if (id == 0) return;
        try rd.close(id) {
            closes++;
        } catch {}
    }

    function settle(uint256 i, uint256 sel) external {
        uint256 id = _round(sel);
        if (id == 0) return;
        address b = backers[i % N];
        uint256 owed0 = rd.platformOwed();
        uint256 t0 = usd.balanceOf(address(t));
        try rd.settle(id, b) {
            settles++;
            uint256 acc = rd.positionOf(id, b).bought / rd.SHARES_PER_RAW_DOLLAR();
            if (rd.platformOwed() - owed0 != acc * 300 / 10_000) platformOvercharged = true;
        } catch {}
        toTreasury += usd.balanceOf(address(t)) - t0;
    }

    function refund(uint256 i, uint256 sel) external {
        uint256 id = _round(sel);
        if (id == 0) return;
        address b = backers[i % N];
        Rounds.Position memory pos = rd.positionOf(id, b);
        if (!pos.settled && pos.ask != 0 && rd.roundOf(id).closedAt != 0) {
            this.settle(i, id - 1); // the refund would settle first; do it here so its 3% is checked on its own
            pos = rd.positionOf(id, b);
        }
        Rounds.Round memory r = rd.roundOf(id);
        uint256[N][] memory before = new uint256[N][](rd.count() + 1);
        for (uint256 k = 1; k <= rd.count(); ++k) {
            for (uint256 j; j < N; ++j) {
                before[k][j] = rd.refundable(k, backers[j]);
            }
        }
        // the bound from the rule, worked out here: the backer's own held money, less what the clock has released, less 5%
        uint256 e = r.closedAt == 0 ? 0 : rd.activeNow() - r.activeAtClose;
        if (e > 182 days) e = 182 days;
        uint256 own = pos.held - pos.held * e / 182 days;
        uint256 owed0 = rd.platformOwed();
        uint256 t0 = usd.balanceOf(address(t));
        vm.prank(b);
        try rd.refund(id) returns (uint256 paid) {
            refunds++;
            // the fee is 5 of each 100, or the platform's 1 after a wind-down
            uint256 feePct = rd.woundDown() ? 1 : 5;
            if (pos.settled && paid > own - own * feePct / 100) refundOverpaid = true;
            if (rd.platformOwed() - owed0 > paid / 95 + 1 && !rd.woundDown()) platformOvercharged = true;
            for (uint256 k = 1; k <= rd.count(); ++k) {
                for (uint256 j; j < N; ++j) {
                    if ((k != id || j != i % N) && rd.refundable(k, backers[j]) != before[k][j]) {
                        refundMovedOthers = true;
                    }
                }
            }
        } catch {}
        toTreasury += usd.balanceOf(address(t)) - t0;
    }

    function release(uint256 sel) external {
        uint256 id = _round(sel);
        if (id == 0) return;
        uint256 t0 = usd.balanceOf(address(t));
        if (rd.release(id) != 0) releases++;
        toTreasury += usd.balanceOf(address(t)) - t0;
    }

    function claimHeld(uint256 i, uint256 sel) external {
        uint256 id = _round(sel);
        if (id == 0) return;
        if (v.claimHeld(id, backers[i % N]) != 0) claims++;
    }

    function sweepFees() external {
        rd.sweepFees();
    }

    function returnUnsold() external {
        try rd.returnUnsold() {} catch {}
    }

    // ================================================ time and the window ==========================================

    function warp(uint256 dt) external {
        vm.warp(_now() + bound(dt, 0, 20 days));
    }

    function checkIn() external {
        address r = t.runner();
        if (launcher.isPair(r)) {
            vm.prank(cosigner);
            Pair(r).checkIn();
        } else {
            vm.prank(r);
            t.checkIn();
        }
    }

    function pause(bool on) external {
        vm.prank(pauser);
        t.setPaused(on);
    }

    // ================================================ the market and the exit =======================================

    /// @dev The market opens the milestone 2 way: 7,500 dollars of sale money arrive, the opener proves the pool, the money is
    /// split, the sale is closed, and the Finisher's 350M Shares go to three buyers.
    function market() external {
        if (marketOpen || t.poolOpen() || rd.isOpen()) return;
        marketOpen = true;
        usd.mint(address(t), 7500 * DOLLAR);
        vm.startPrank(opener);
        t.markPoolOpen();
        t.markSaleClosed();
        shares.transfer(holders[0], 50_000_000 * SHARE);
        shares.transfer(holders[1], 100_000_000 * SHARE);
        shares.transfer(holders[2], 200_000_000 * SHARE);
        vm.stopPrank();
        t.settle(7500 * DOLLAR);
    }

    function give(uint256 i, uint256 amount) external {
        amount = bound(amount, 1, 5_000_000 * SHARE);
        if (_asRunner(address(t), abi.encodeCall(Treasury.giveShares, (holders[i % 3], amount)))) gifts++;
    }

    function handBack(uint256 i, uint256 amount) external {
        address h = holders[i % 3];
        amount = bound(amount, 0, shares.balanceOf(h));
        vm.prank(h);
        try t.handBack(amount) {
            exits++;
            burned += amount;
        } catch {}
    }

    function windDown(uint256 sel) external {
        if (sel % 20 != 0) return; // rare
        _asRunner(address(launcher), abi.encodeCall(Launcher.windDown, (key)));
    }
}
