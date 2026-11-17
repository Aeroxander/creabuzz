// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Platform} from "./Platform.sol";
import {IPositionManagerTest} from "./UniswapTest.sol";
import {Launcher} from "../../src/Launcher.sol";
import {Finisher} from "../../src/Finisher.sol";
import {Treasury} from "../../src/Treasury.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {LiquidityHolder} from "../../src/LiquidityHolder.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";
import {PoolKey} from "../../src/Pinned.sol";

/// @notice The random user of one project's whole sale on the real platform, for the invariant tests: bidders, strangers who call
/// the finish steps (and the strategy's pool step directly), traders, fee collectors, holders who hand back, a founder who opens
/// again after a failed sale, time passing, a dollar token that can be made to fail the pool step, and donors. Every function is
/// one thing somebody can do; the invariant contract checks the rules after each sequence. The handler keeps its own books
/// ("ghosts") so that the rules are checked against numbers the platform did not produce.
contract LifeHandler is Platform {
    Proj public p;
    Sale public s;
    uint256[] public bidIds;
    address[5] public bidders;

    // ---- the handler's own books
    uint256 public burned; // Shares burned by exits and fee collection
    uint256 public positionId; // the project's position NFT, once the pool step has run
    uint128 public liquidityAtOpen; // its liquidity the first time it was seen
    bool public exitBeforeClose; // a hand back succeeded while the sale was not closed
    bool public splitWrong; // a settle did not split the arrived money 15 : 75
    bool public settledWithoutPool; // a settle succeeded while the pool manager showed no pool
    bool public failedStepSplit; // the money was split after a failed pool step
    bool public frozenForStep; // the pool step is being made to fail

    // ---- how often each thing happened (the invariants are worth what they reach)
    uint256[16] public reached;

    /// @dev A count that survives the revert between runs (an environment variable lives in the test process, not in the chain
    /// state), so the total over a whole campaign can be printed.
    function _count(uint256 i) internal {
        reached[i]++;
        string memory key = string.concat("LIFE_REACH_", vm.toString(i));
        vm.setEnv(key, vm.toString(vm.envOr(key, uint256(0)) + 1));
    }

    function total(uint256 i) external view returns (uint256) {
        return vm.envOr(string.concat("LIFE_REACH_", vm.toString(i)), uint256(0));
    }

    constructor() {
        _setUpPlatform(false);
        bidders = [alice, bob, carol, dave, erin];
        p = _launch(founder, keccak256("invariant"));
        s = _open(p);
        vm.roll(s.startBlock); // the sale is running from the first call
    }

    function _refresh() internal {
        if (positionId == 0 || liquidityAtOpen == 0) {
            if (strategyPending()) positionId = IPositionManagerTest(positionManager).nextTokenId();
        }
    }

    function strategyPending() public view returns (bool) {
        (bool ok, bytes memory r) = address(p.finisher).staticcall(abi.encodeWithSignature("poolIsOpen()"));
        return !(ok && abi.decode(r, (bool)));
    }

    // ================================================ the sale =======================================================

    function bid(uint256 who, uint256 amount, uint256 k) external {
        if (block.number < s.startBlock || block.number >= s.endBlock) return;
        who = who % 5;
        amount = bound(amount, DOLLAR, 400_000 * DOLLAR);
        k = bound(k, 1, 300);
        _fund(bidders[who], amount, s);
        uint256 id = s.auction.nextBidId();
        vm.prank(bidders[who]);
        (bool ok,) = address(s.auction)
            .call(
                abi.encodeCall(
                    s.auction.submitBid, (_price(s, k), uint128(amount), bidders[who], s.floorQ96, bytes(""))
                )
            );
        if (ok) {
            bidIds.push(id);
            _count(0);
        }
    }

    function pass(uint256 blocks) external {
        blocks = bound(blocks, 1, 3000);
        vm.roll(block.number + blocks);
        vm.warp(_now() + blocks * 12);
    }

    /// @dev Seven days pass: the way out of a pool that never opened is now open.
    function skipAWeek() external {
        vm.roll(block.number + 50_400);
        vm.warp(_now() + 50_400 * 12);
        _count(14);
    }

    function endSale() external {
        if (block.number < s.endBlock) {
            vm.warp(_now() + (s.endBlock - block.number) * 12);
            vm.roll(s.endBlock);
        }
        s.auction.checkpoint();
        vm.roll(s.endBlock + 1);
        vm.warp(_now() + 12);
        _count(1);
    }

    function freezePoolStep(bool on) external {
        // only while the pool step is still to come: afterwards it changes nothing about this sale
        _failThePoolStep(on);
        frozenForStep = on;
    }

    // ================================================ the finish =====================================================

    function step(uint256 which, uint256 caller) external {
        _refresh();
        which = which % 4;
        address who = address(uint160(0x9100 + caller % 7));
        bool settledBefore = p.treasury.settled();
        uint256 sp0 = p.treasury.spendable();
        uint256 me0 = p.treasury.melting();
        uint256 arrivedBefore = usd.balanceOf(address(p.treasury));
        uint256 strayBefore = p.treasury.unaccounted(); // dollars donated to the Treasury earlier are split too
        bool poolBefore = p.finisher.poolIsOpen();
        vm.prank(who);
        bool ok;
        if (which == 0) (ok,) = address(p.finisher).call(abi.encodeCall(Finisher.openPool, ()));
        else if (which == 1) (ok,) = address(p.finisher).call(abi.encodeCall(Finisher.settle, ()));
        else if (which == 2) (ok,) = address(p.finisher).call(abi.encodeCall(Finisher.sweep, ()));
        else (ok,) = strategy.call(abi.encodeWithSignature("migrate(address)", address(s.auction))); // a stranger skips the Finisher
        if (!ok) return;
        _count(2 + which);
        if (which == 1 && !settledBefore && p.treasury.settled()) {
            if (!poolBefore && !p.finisher.poolIsOpen()) settledWithoutPool = true;
            // every dollar that came in from the Finisher, plus any donated to the Treasury or the Finisher earlier, is split
            uint256 arrived = usd.balanceOf(address(p.treasury)) - arrivedBefore + strayBefore;
            uint256 dSp = p.treasury.spendable() - sp0;
            uint256 dMe = p.treasury.melting() - me0;
            if (dSp + dMe != arrived || dSp != arrived * 15 / 75) splitWrong = true;
        }
    }

    function abandon(uint256 caller) external {
        address who = address(uint160(0x9100 + caller % 7));
        bool poolWas = p.finisher.poolIsOpen();
        vm.prank(who);
        (bool ok,) = address(p.finisher).call(abi.encodeCall(Finisher.abandon, ()));
        if (ok) {
            _count(6);
            if (poolWas) failedStepSplit = true;
        }
    }

    function reopen(uint256) external {
        if (!p.finisher.canOpen() || p.treasury.poolOpen()) return;
        Proj memory q = p;
        _open(q); // both signers of the project's Pair
        {
            s = _saleOf(q);
            delete bidIds;
            positionId = 0;
            _count(7);
        }
    }

    // ================================================ after the finish ===============================================

    function collectBid(uint256 i) external {
        if (bidIds.length == 0 || block.number <= s.endBlock) return;
        uint256 id = bidIds[i % bidIds.length];
        (bool ok,) = address(this).call(abi.encodeCall(this.collectBidOrRevert, (id)));
        if (ok) _count(8);
    }

    function collectBidOrRevert(uint256 id) external {
        require(msg.sender == address(this));
        _collectBid(s, id);
    }

    function trade(uint256 amount, bool buy) external {
        if (!p.finisher.poolIsOpen()) return;
        amount = bound(amount, DOLLAR, 3000 * DOLLAR);
        PoolKey memory key = _key(p);
        if (buy) {
            usd.mint(trader, amount);
            (bool ok,) = address(this).call(abi.encodeCall(this.swapOrRevert, (true, amount)));
            if (ok) _count(9);
        } else {
            uint256 have = p.shares.balanceOf(trader);
            if (have == 0) return;
            (bool ok,) = address(this).call(abi.encodeCall(this.swapOrRevert, (false, have / 2 + 1)));
            if (ok) _count(9);
        }
        key;
    }

    function swapOrRevert(bool quoteIn, uint256 amount) external {
        require(msg.sender == address(this));
        _swap(_key(p), address(p.shares), trader, quoteIn, amount);
    }

    function collectFees() external {
        if (positionId == 0 || !p.finisher.poolIsOpen()) return;
        uint256 supply = p.shares.totalSupply();
        (bool ok,) = address(holder).call(abi.encodeWithSignature("collect(uint256)", positionId));
        if (ok) {
            burned += supply - p.shares.totalSupply();
            _count(10);
        }
    }

    function handBack(uint256 who, uint256 frac) external {
        address a = bidders[who % 5];
        uint256 have = p.shares.balanceOf(a);
        if (have == 0) return;
        uint256 amount = have * (1 + frac % 100) / 100;
        bool closedBefore = p.treasury.saleClosed();
        vm.startPrank(a);
        p.shares.approve(address(p.treasury), type(uint256).max);
        (bool ok,) = address(p.treasury).call(abi.encodeWithSignature("handBack(uint256)", amount));
        vm.stopPrank();
        if (ok) {
            burned += amount;
            _count(11);
            if (!closedBefore) exitBeforeClose = true;
        }
    }

    function checkIn() external {
        _checkIn(p);
        _count(12);
    }

    function donate(uint256 amount, uint256 to) external {
        amount = bound(amount, 1, 5000 * DOLLAR);
        usd.mint(stranger, amount);
        vm.prank(stranger);
        // to the Treasury at any time; to the Finisher only while its sale is open (after that it would never be swept)
        if (to % 2 == 0) usd.transfer(address(p.treasury), amount);
        else if (p.finisher.stage() == Finisher.Stage.Open) usd.transfer(address(p.finisher), amount);
        _count(13);
    }

    // ================================================ views for the invariants =======================================

    function T() external view returns (Treasury) {
        return p.treasury;
    }

    function F() external view returns (Finisher) {
        return p.finisher;
    }

    function S() external view returns (ShareToken) {
        return p.shares;
    }

    function U() external view returns (QuoteToken) {
        return usd;
    }

    function H() external view returns (LiquidityHolder) {
        return holder;
    }

    function L() external view returns (Launcher) {
        return launcher;
    }

    function PM() external view returns (address) {
        return positionManager;
    }

    function STRATEGY() external view returns (address) {
        return strategy;
    }

    function FOUNDER() external view returns (address) {
        return founder;
    }

    function PLATFORM() external view returns (address) {
        return platform;
    }

    function bidCount() external view returns (uint256) {
        return bidIds.length;
    }

    function finisherStage() external view returns (Finisher.Stage) {
        return p.finisher.stage();
    }
}
