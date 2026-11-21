// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../../src/Treasury.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {Vester} from "../../src/Vester.sol";
import {EarlierGrants} from "../../src/EarlierGrants.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";
import {Row} from "./EarlierBase.sol";

/// @notice Drives project zero from the claim side and the runner's side: claims by the listed accounts (in any order, also by
/// the wrong account), the runner's ordinary grants to the same accounts (to fill their slots), payouts of vested Shares,
/// Team take-outs, revenue and joins (so there is a surplus to take out), time, and one wind-down with the burn after it.
/// Every call is allowed to fail: the invariants say what must hold whatever the sequence.
contract EarlierHandler is Test {
    QuoteToken internal usd;
    Treasury internal t;
    ShareToken internal team;
    ShareToken internal shares;
    Vester internal v;
    EarlierGrants internal earlier;
    address internal founder;
    bytes32 internal constant TEXT = keccak256("an invented text, version one");

    Row[] internal rows;
    bytes32[][] internal proofs; // by row index
    address[] public accounts;
    uint256 public clock;
    uint256 public claims;
    uint256 public refused;
    uint256 public windDowns;

    constructor(
        QuoteToken usd_,
        Treasury t_,
        ShareToken team_,
        ShareToken shares_,
        Vester v_,
        EarlierGrants earlier_,
        address founder_,
        Row[] memory list,
        bytes32[][] memory proofs_,
        address[] memory accounts_,
        uint256 clock_
    ) {
        (usd, t, team, shares, v, earlier, founder) = (usd_, t_, team_, shares_, v_, earlier_, founder_);
        for (uint256 i; i < list.length; ++i) {
            rows.push(list[i]);
            proofs.push(proofs_[i]);
        }
        accounts = accounts_;
        clock = clock_;
    }

    function rowCount() external view returns (uint256) {
        return rows.length;
    }

    function rowAt(uint256 i) external view returns (Row memory) {
        return rows[i];
    }

    /// @dev Claim row `i` as its own account.
    function claim(uint256 seed) external {
        Row memory r = rows[seed % rows.length];
        vm.prank(r.account);
        try earlier.claim(r.index, r.amount, proofs[seed % rows.length], TEXT) {
            ++claims;
        } catch {
            ++refused;
        }
    }

    /// @dev Claim row `i` as someone else: always refused.
    function claimAsOther(uint256 seed, uint256 other) external {
        Row memory r = rows[seed % rows.length];
        address who = accounts[other % accounts.length];
        if (who == r.account) return;
        vm.prank(who);
        try earlier.claim(r.index, r.amount, proofs[seed % rows.length], TEXT) {
            revert("a row was claimed by the wrong account");
        } catch {}
    }

    /// @dev The runner gives a listed account an ordinary grant (it fills the 8 ordinary slots).
    function grantOrdinary(uint256 seed, uint256 amount) external {
        amount = bound(amount, 1e18, 2_000_000e18);
        vm.prank(founder);
        try t.grantTeam(accounts[seed % accounts.length], amount) {} catch {}
    }

    /// @dev Send what has vested of some grant to its member.
    function payOut(uint256 seed) external {
        uint256 n = v.grantCount();
        if (n == 0) return;
        try v.claim(seed % n) {} catch {}
    }

    function warp(uint256 secs) external {
        clock += bound(secs, 1 hours, 120 days);
        vm.warp(clock);
        vm.prank(founder);
        try t.checkIn(bytes32(0)) {} catch {}
    }

    function join(uint256 seed, uint256 amount) external {
        amount = bound(amount, 1e6, 50_000e6);
        address who = accounts[seed % accounts.length];
        usd.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(t), amount);
        try t.join(amount, 0, who) {} catch {}
        vm.stopPrank();
    }

    function revenue(uint256 amount) external {
        amount = bound(amount, 1e6, 20_000e6);
        usd.mint(address(this), amount);
        usd.approve(address(t), amount);
        try t.addRevenue(amount) {} catch {}
    }

    function leaveTeam(uint256 seed, uint256 pct) external {
        address who = accounts[seed % accounts.length];
        uint256 bal = team.balanceOf(who);
        if (bal == 0) return;
        vm.prank(who);
        try t.leaveTeam(bound(pct, 1, 100) * bal / 100 + 1, 0, who) {} catch {}
    }

    function windDown() external {
        if (windDowns != 0) return;
        vm.prank(founder);
        try t.windDown() {
            ++windDowns;
        } catch {}
    }

    function burnAfterWindDown() external {
        try v.burnUngrantedAfterWindDown() {} catch {}
    }
}
