// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LifeHandler} from "./helpers/LifeHandler.sol";
import {Finisher} from "../src/Finisher.sol";
import {IPositionManagerTest} from "./helpers/UniswapTest.sol";

/// @notice Rules of the whole sale that must hold after any sequence of what people can do: bids, time, the three finish steps in
/// any order by any stranger (and the strategy's pool step called directly), a failing pool step, abandon, a new try after a failed
/// sale, claims, trades, fee collection, hand backs, check-ins and donations.
contract LifeInvariantsTest is Test {
    LifeHandler internal h;

    function setUp() public {
        h = new LifeHandler();
        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](14);
        sels[0] = h.bid.selector;
        sels[1] = h.pass.selector;
        sels[2] = h.endSale.selector;
        sels[3] = h.freezePoolStep.selector;
        sels[4] = h.step.selector;
        sels[5] = h.abandon.selector;
        sels[6] = h.reopen.selector;
        sels[7] = h.collectBid.selector;
        sels[8] = h.trade.selector;
        sels[9] = h.collectFees.selector;
        sels[10] = h.handBack.selector;
        sels[11] = h.checkIn.selector;
        sels[12] = h.donate.selector;
        sels[13] = h.skipAWeek.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    /// No dollar is ever in the project's floor before the pool is open or the sale abandoned: floor money only comes from the
    /// settle, which only the Finisher does and only with a pool.
    function invariant_noFloorMoneyBeforeThePoolIsOpen() public view {
        (,,,,,,,,, bool poolOpen) = _treasuryFlags();
        if (!poolOpen) {
            assertEq(h.T().melting() + h.T().permanentFloor(), 0);
        }
    }

    /// Once the pool is marked open (not abandoned), the pool manager shows the pool: nothing removes its liquidity.
    function invariant_aPoolMarkedOpenReallyExistsAndKeepsItsLiquidity() public view {
        (,,,,,,,, bool abandoned, bool poolOpen) = _treasuryFlags();
        if (poolOpen && !abandoned) {
            Finisher f = h.F();
            assertTrue(f.poolIsOpen());
            IPositionManagerTest pm = IPositionManagerTest(h.PM());
            uint256 id = h.positionId();
            assertEq(pm.ownerOf(id), address(h.H()), "the LiquidityHolder owns it");
            assertGt(pm.getPositionLiquidity(id), 0);
        }
    }

    /// A settle never happened without a pool, and split exactly 15 : 60 when it happened; nothing was split after a failed step.
    function invariant_theMoneyIsSplitOnlyWithAPoolAndExactly15To60() public view {
        assertFalse(h.settledWithoutPool());
        assertFalse(h.splitWrong());
        assertFalse(h.failedStepSplit());
    }

    /// No exit before the sale is closed.
    function invariant_noExitBeforeTheSaleIsClosed() public view {
        assertFalse(h.exitBeforeClose());
    }

    /// The flags agree: a closed sale was settled (or abandoned) and had its pool marked open; a done sale is closed.
    function invariant_theStagesAgreeWithTheTreasury() public view {
        (,,,,,, bool saleClosed, bool settled, bool abandoned, bool poolOpen) = _treasuryFlags();
        Finisher f = h.F();
        if (saleClosed) {
            assertTrue(poolOpen);
            assertTrue(settled);
        }
        if (f.stage() == Finisher.Stage.Done) {
            assertTrue(saleClosed);
            assertTrue(f.settled());
            assertFalse(abandoned);
        }
        if (f.stage() == Finisher.Stage.Abandoned) {
            assertTrue(abandoned);
            assertTrue(saleClosed);
        }
        if (abandoned) assertTrue(poolOpen);
    }

    /// Once a sale is done or abandoned the Finisher holds no dollar and no Share, and no one else does either by the Treasury's
    /// leave: the Launcher and the founder never hold a dollar.
    function invariant_nobodyButTheRulesHoldsTheMoney() public view {
        Finisher f = h.F();
        Finisher.Stage st = f.stage();
        if (st == Finisher.Stage.Done || st == Finisher.Stage.Abandoned) {
            assertEq(h.U().balanceOf(address(f)), 0);
            assertEq(h.S().balanceOf(address(f)), 0);
        }
        assertEq(h.U().balanceOf(h.FOUNDER()), 0, "the founder never holds a dollar");
        assertEq(h.U().balanceOf(address(h.L())), 0);
        assertEq(h.U().balanceOf(address(h.H())), h.H().owed(address(h.U()), h.PLATFORM()), "the holder keeps only what it owes");
        assertEq(h.U().balanceOf(h.STRATEGY()), 0, "the strategy never keeps a dollar");
    }

    /// The buckets never add up to more than the dollars held.
    function invariant_theBucketsNeverExceedTheBalance() public view {
        (uint256 sp, uint256 me, uint256 pe, uint256 fo) = (
            h.T().spendable(), h.T().melting(), h.T().permanentFloor(), h.T().feesOwed()
        );
        assertGe(h.U().balanceOf(address(h.T())), sp + me + pe + fo);
    }

    /// Shares: the supply falls only by what exits and fee collection burned, and the Launcher and the holder hold none.
    function invariant_sharesAreConserved() public view {
        assertEq(h.S().totalSupply(), 1_000_000_000e18 - h.burned());
        assertEq(h.S().balanceOf(address(h.L())), 0);
        assertEq(h.S().balanceOf(address(h.H())), 0);
    }

    /// After a sale that failed, all 500M Shares are with the Finisher again (nothing was lost to the auction or the strategy).
    function invariant_aFailedSaleReturnsEveryShare() public view {
        Finisher f = h.F();
        if (f.stage() == Finisher.Stage.Failed) {
            assertEq(h.S().balanceOf(address(f)), 500_000_000e18);
            assertEq(h.U().balanceOf(address(h.H())), 0);
        }
    }

    function afterInvariant() public {
        emit log_named_uint("reach: bids placed", h.total(0));
        emit log_named_uint("reach: sale ended", h.total(1));
        emit log_named_uint("reach: pool step ran (all the ways)", h.total(2) + h.total(5));
        emit log_named_uint("reach: settled", h.total(3));
        emit log_named_uint("reach: swept", h.total(4));
        emit log_named_uint("reach: abandoned", h.total(6));
        emit log_named_uint("reach: reopened", h.total(7));
        emit log_named_uint("reach: claimed", h.total(8));
        emit log_named_uint("reach: traded", h.total(9));
        emit log_named_uint("reach: fees collected", h.total(10));
        emit log_named_uint("reach: handed back", h.total(11));
        emit log_named_uint("reach: a week passed", h.total(14));
    }

    function _treasuryFlags()
        internal
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256, bool saleClosed, bool settled, bool abandoned, bool poolOpen)
    {
        (saleClosed, settled, abandoned, poolOpen) = (
            h.T().saleClosed(), h.T().settled(), h.T().abandoned(), h.T().poolOpen()
        );
    }
}
