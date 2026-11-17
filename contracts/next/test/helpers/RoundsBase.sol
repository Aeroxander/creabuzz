// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "./Base.sol";
import {Rounds} from "../../src/Rounds.sol";
import {Pair} from "../../src/Pair.sol";
import {Launcher} from "../../src/Launcher.sol";
import {Treasury} from "../../src/Treasury.sol";

/// @notice The milestone 2 world (mock strategy and guard, the real Launcher, Treasury, Vester, Rounds and Pair) with helpers for
/// backing rounds, the Pair and the stage rules. The real auction is tested on the Uniswap stack in `AuctionV2.t.sol`.
abstract contract RoundsBase is Base {
    Rounds internal rd;
    bytes32 internal key;
    address internal cosigner = makeAddr("cosigner");
    address internal stranger = makeAddr("stranger");
    uint256 internal constant DAY = 1 days;
    uint256 internal constant WEEK = 7 days;

    function setUp() public virtual override {
        super.setUp();
        rd = Rounds(rounds);
        key = launcher.keyOf(founder, PROJECT);
    }

    /// @dev The runner (founder, or both signers of the Pair) opens a round; returns its id.
    function _openRound() internal returns (uint256 id) {
        address r = t.runner();
        if (launcher.isPair(r)) {
            return abi.decode(_both(address(launcher), abi.encodeCall(Launcher.openRound, (key))), (uint256));
        }
        vm.prank(r);
        return launcher.openRound(key);
    }

    function _ask(uint256 id, address who, uint256 amount) internal {
        usd.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(rd), type(uint256).max);
        rd.ask(id, amount);
        vm.stopPrank();
    }

    /// @dev Let the round's 24 hours pass and close it.
    function _close(uint256 id) internal {
        Rounds.Round memory r = rd.roundOf(id);
        if (_now() < r.openedAt + 1 days) vm.warp(r.openedAt + 1 days);
        rd.close(id);
    }

    /// @dev A whole round: the runner checks in, opens it, `who` asks `amount`, it closes and `who` is settled.
    function _round(address who, uint256 amount) internal returns (uint256 id) {
        _checkIn();
        id = _openRound();
        _ask(id, who, amount);
        _close(id);
        rd.settle(id, who);
    }

    function _checkIn() internal {
        address r = t.runner();
        if (launcher.isPair(r)) {
            address first = Pair(r).first();
            vm.prank(first);
            Pair(r).checkIn();
        } else {
            vm.prank(r);
            t.checkIn();
        }
    }

    /// @dev Let `span` pass with the runner checking in every 10 days, so no release time is lost.
    function _live(uint256 span) internal {
        uint256 end = _now() + span;
        while (_now() < end) {
            uint256 step = end - _now() < 10 days ? end - _now() : 10 days;
            vm.warp(_now() + step);
            _checkIn();
        }
    }

    /// @dev Team: the founder offers the seat to the Pair of (founder, cosigner) and the cosigner accepts.
    function _team() internal returns (Pair pair) {
        address predicted = launcher.pairAddress(key, founder, cosigner);
        vm.prank(founder);
        t.handOver(predicted, false);
        vm.prank(cosigner);
        pair = Pair(launcher.makePair(key, founder));
    }

    /// @dev Both signers of the Pair agree to a call.
    function _both(address target, bytes memory data) internal returns (bytes memory) {
        Pair pair = Pair(t.runner());
        (address first, address second) = (pair.first(), pair.second());
        vm.prank(first);
        pair.propose(target, data);
        uint256 n = pair.nonce() - 1;
        vm.prank(second);
        return pair.confirm(target, data, n);
    }

    /// @dev Both signers agree to a call and it reverts with `err`.
    function _bothRefused(address target, bytes memory data, bytes memory err) internal {
        Pair pair = Pair(t.runner());
        (address first, address second) = (pair.first(), pair.second());
        vm.prank(first);
        pair.propose(target, data);
        uint256 n = pair.nonce() - 1;
        vm.prank(second);
        vm.expectRevert(err);
        pair.confirm(target, data, n);
    }

    function _refund(uint256 id, address who) internal returns (uint256 paid) {
        vm.prank(who);
        paid = rd.refund(id);
    }

    /// @dev The market opens the milestone 2 way: the opener (the Finisher's address) proves the pool. The stake moves then.
    function _market() internal {
        vm.prank(opener);
        t.markPoolOpen();
    }

    function _heldOf(uint256 id, address who) internal view returns (uint256 total, uint256 claimed) {
        return v.heldGrants(id, who);
    }
}
