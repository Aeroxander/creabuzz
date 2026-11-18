// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Platform} from "./helpers/Platform.sol";
import {Launcher} from "../src/Launcher.sol";
import {Finisher} from "../src/Finisher.sol";
import {Treasury} from "../src/Treasury.sol";
import {PoolKey, PoolRead, IPinnedStrategy, SaleParams} from "../src/Pinned.sol";

/// @notice The events are the contract with the server (milestone 4): each one is asserted here, with its figures, for every path of
/// a sale: the whole good finish, a sale under its minimum, the way out, and a stranger who runs the pool step directly. A test that
/// deletes one `emit` fails here. The LiquidityHolder's events (`Collected`, `Owed`, `OwedSent`) are asserted in `LiquidityHolder.t.sol`.
abstract contract FinishEventsBase is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    /// @dev A Standard sale with 10,000 dollars of demand from four buyers, at the floor price, ended.
    function _soldOut(bytes32 id) internal returns (Proj memory p, Sale memory s) {
        p = _launch(founder, id);
        s = _open(p);
        _flat(s, 100_000 * DOLLAR);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
    }

    // ===================================================== the good finish ============================================

    function test_events_openingASale() public {
        Proj memory p = _launch(founder, keccak256("ev-open"));
        vm.recordLogs();
        Sale memory s = _open(p);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        Vm.Log memory a = _one(logs, address(launcher), Launcher.SaleOpened.selector);
        assertEq(a.topics[1], p.key, "the project's key");
        assertEq(_addr(a.topics[2]), address(s.auction), "the auction");
        assertEq(_addr(a.topics[3]), p.treasury.runner(), "the runner that opened it (the Pair)");
        (address fin, uint256 minimum, uint64 startBlock, uint64 endBlock, uint256 floorQ96, uint256 tickQ96) =
            abi.decode(a.data, (address, uint256, uint64, uint64, uint256, uint256));
        assertEq(fin, address(p.finisher));
        assertEq(minimum, 100_000 * DOLLAR);
        assertEq(startBlock, block.number + 1, "the sale starts in the next block");
        assertEq(endBlock, startBlock + 7200);
        assertEq(floorQ96, s.floorQ96);
        assertEq(tickQ96, s.tickQ96);

        Vm.Log memory b = _one(logs, address(p.finisher), Finisher.SaleOpenedBy.selector);
        assertEq(_addr(b.topics[1]), address(s.auction));
        (uint64 end2, uint32 attempt) = abi.decode(b.data, (uint64, uint32));
        assertEq(end2, endBlock);
        assertEq(attempt, 0, "the first sale");
    }

    function test_events_theThreeStepsOfAGoodFinish() public {
        (Proj memory p, Sale memory s) = _soldOut(keccak256("ev-good"));
        PoolKey memory key = _key(p);
        uint256 raised = s.auction.currencyRaised();
        assertEq(raised, 100_000 * DOLLAR);
        uint256 afterFee = raised * 97 / 100;
        uint256 pmUsd = usd.balanceOf(poolManager);
        uint256 pmShares = p.shares.balanceOf(poolManager);

        // step 1
        vm.recordLogs();
        vm.prank(stranger);
        p.finisher.openPool();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory step = _one(logs, address(p.finisher), Finisher.PoolStep.selector);
        assertEq(_addr(step.topics[1]), address(s.auction));
        assertTrue(abi.decode(step.data, (bool)), "the pool is open after the step, read from the pool manager");
        uint256 poolUsd = usd.balanceOf(poolManager) - pmUsd;
        uint256 poolShares = p.shares.balanceOf(poolManager) - pmShares;
        assertGt(poolUsd, 21_999 * DOLLAR, "22 of each 100 raised went into the pool");

        // step 2
        vm.recordLogs();
        vm.prank(stranger);
        p.finisher.settle();
        logs = vm.getRecordedLogs();
        Vm.Log memory opened = _one(logs, address(p.finisher), Finisher.PoolOpened.selector);
        assertEq(_addr(opened.topics[1]), address(s.auction));
        (bytes32 poolId, uint160 sqrtPrice, uint256 evDollars, uint256 evShares) =
            abi.decode(opened.data, (bytes32, uint160, uint256, uint256));
        assertEq(poolId, keccak256(abi.encode(key)), "the pool's id");
        assertEq(sqrtPrice, _sqrtPrice(key), "the pool's price at the time");
        assertEq(evDollars, poolUsd, "the dollars the pool took");
        assertEq(evShares, poolShares, "the Shares the pool took");

        Vm.Log memory settled = _one(logs, address(p.finisher), Finisher.Settled.selector);
        assertEq(_addr(settled.topics[1]), address(s.auction));
        (uint256 evRaised, uint256 evAfterFee, uint256 evToTreasury) =
            abi.decode(settled.data, (uint256, uint256, uint256));
        assertEq(evRaised, raised);
        assertEq(evAfterFee, afterFee);
        assertEq(evToTreasury, afterFee - poolUsd, "what reached the Treasury");

        Vm.Log memory tOpen = _one(logs, address(p.treasury), Treasury.PoolOpened.selector);
        assertEq(abi.decode(tOpen.data, (uint256)), block.timestamp);
        Vm.Log memory tSettled = _one(logs, address(p.treasury), Treasury.Settled.selector);
        (uint256 amount, uint256 toSpendable, uint256 toFloor) = abi.decode(tSettled.data, (uint256, uint256, uint256));
        assertEq(amount, evToTreasury);
        assertEq(toSpendable, p.treasury.spendable());
        assertEq(toFloor, p.treasury.melting());
        assertEq(toSpendable + toFloor, amount);

        // step 3
        uint256 reserveBefore = p.shares.balanceOf(address(p.treasury));
        vm.recordLogs();
        vm.prank(stranger);
        p.finisher.sweep();
        logs = vm.getRecordedLogs();
        Vm.Log memory swept = _one(logs, address(p.finisher), Finisher.Swept.selector);
        assertEq(_addr(swept.topics[1]), address(s.auction));
        assertEq(
            abi.decode(swept.data, (uint256)),
            p.shares.balanceOf(address(p.treasury)) - reserveBefore,
            "the Shares that went to the Treasury"
        );
        Vm.Log memory closed = _one(logs, address(p.treasury), Treasury.SaleClosed.selector);
        assertEq(abi.decode(closed.data, (uint256)), block.timestamp);
        assertEq(_count(logs, address(p.finisher), Finisher.Abandoned.selector), 0);
    }

    // ===================================================== a sale under its minimum ===================================

    function test_events_aSaleUnderItsMinimum() public {
        Proj memory p = _launch(founder, keccak256("ev-fail"));
        Sale memory s = _open(p);
        _flat(s, 10_000 * DOLLAR); // the minimum is 100,000
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        vm.recordLogs();
        p.finisher.openPool();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory step = _one(logs, address(p.finisher), Finisher.PoolStep.selector);
        assertFalse(abi.decode(step.data, (bool)), "no pool opened");
        vm.recordLogs();
        p.finisher.sweep();
        logs = vm.getRecordedLogs();
        Vm.Log memory failed = _one(logs, address(p.finisher), Finisher.SaleFailed.selector);
        assertEq(_addr(failed.topics[1]), address(s.auction));
        assertEq(
            abi.decode(failed.data, (uint64)), s.endBlock + 7200, "a new sale may open 7,200 blocks after it ended"
        );
        assertEq(_count(logs, address(p.finisher), Finisher.Swept.selector), 0);
        assertEq(_count(logs, address(p.treasury), Treasury.SaleClosed.selector), 0);
    }

    // ===================================================== the way out =================================================

    /// @dev Abandon: the pool step failed and was swallowed. The server reads `Abandoned`, and must also know that the Treasury's
    /// first `Settled` (amount, 0, amount) is the floor-only part, followed by an ordinary `Settled` for the rest.
    function test_events_theWayOut() public {
        (Proj memory p, Sale memory s) = _soldOut(keccak256("ev-abandon"));
        uint256 raised = s.auction.currencyRaised();
        _failThePoolStep(true);
        vm.recordLogs();
        p.finisher.openPool();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory step = _one(logs, address(p.finisher), Finisher.PoolStep.selector);
        assertFalse(abi.decode(step.data, (bool)), "the swallowed failure is reported as no pool");
        _failThePoolStep(false);
        vm.roll(s.endBlock + 50_400);
        vm.recordLogs();
        vm.prank(stranger);
        p.finisher.abandon();
        logs = vm.getRecordedLogs();

        uint256 afterFee = raised * 97 / 100;
        uint256 toFloorOnly = afterFee * 2_268_041 / 10_000_000;
        Vm.Log memory ab = _one(logs, address(p.finisher), Finisher.Abandoned.selector);
        assertEq(_addr(ab.topics[1]), address(s.auction));
        (uint256 evFloorOnly, uint256 evSplit) = abi.decode(ab.data, (uint256, uint256));
        assertEq(evFloorOnly, toFloorOnly, "the part meant for the pool that went wholly to the floor");
        assertEq(evSplit, afterFee - toFloorOnly, "the rest, split 15 : 60");
        Vm.Log memory sw = _one(logs, address(p.finisher), Finisher.Swept.selector);
        assertGt(abi.decode(sw.data, (uint256)), 0, "all the Shares came back as reserve");
        assertEq(_count(logs, address(p.finisher), Finisher.Settled.selector), 0, "abandon is not a settle");
        assertEq(_count(logs, address(p.finisher), Finisher.PoolOpened.selector), 0, "and no pool opened");
        Vm.Log memory tAb = _one(logs, address(p.treasury), Treasury.SaleAbandoned.selector);
        assertEq(abi.decode(tAb.data, (uint256)), block.timestamp);
        _one(logs, address(p.treasury), Treasury.SaleClosed.selector);
        assertEq(
            _count(logs, address(p.treasury), Treasury.PoolOpened.selector),
            0,
            "the Treasury's PoolOpened is not emitted"
        );

        // two Treasury `Settled` logs, in this order: the floor-only part, then the ordinary split
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(p.treasury) || logs[i].topics[0] != Treasury.Settled.selector) continue;
            (uint256 amount, uint256 toSpendable, uint256 toFloor) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));
            if (seen == 0) {
                assertEq(amount, toFloorOnly, "first: the floor-only part");
                assertEq(toSpendable, 0);
                assertEq(toFloor, amount);
            } else {
                assertEq(amount, afterFee - toFloorOnly, "second: the ordinary split");
                assertGt(toSpendable, 0);
            }
            ++seen;
        }
        assertEq(seen, 2);
    }

    // ===================================================== a stranger runs the pool step directly =====================

    /// @dev Anyone may call the strategy's own `migrate`. The Finisher then emits no `PoolStep` (it is not in the call), but step 2
    /// emits `PoolOpened` and `Settled` all the same, so the server learns of the pool from step 2 whoever ran step 1.
    function test_events_aStrangerRunsThePoolStepDirectly() public {
        (Proj memory p, Sale memory s) = _soldOut(keccak256("ev-direct"));
        vm.recordLogs();
        vm.prank(stranger);
        IPinnedStrategy(strategy).migrate(address(s.auction));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(
            _count(logs, address(p.finisher), Finisher.PoolStep.selector), 0, "no PoolStep: the Finisher did not run it"
        );
        assertTrue(p.finisher.poolIsOpen(), "but the pool is open");
        vm.recordLogs();
        p.finisher.settle();
        logs = vm.getRecordedLogs();
        _one(logs, address(p.finisher), Finisher.PoolOpened.selector);
        _one(logs, address(p.finisher), Finisher.Settled.selector);
        _one(logs, address(p.treasury), Treasury.PoolOpened.selector);
    }
}

contract FinishEventsLocalTest is FinishEventsBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract FinishEventsForkTest is FinishEventsBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}
