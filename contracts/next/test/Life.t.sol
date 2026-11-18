// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Platform} from "./helpers/Platform.sol";
import {IPositionManagerTest} from "./helpers/UniswapTest.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Finisher} from "../src/Finisher.sol";
import {PoolKey, SaleParams} from "../src/Pinned.sol";

/// @notice A project's whole life on the real platform contracts and real Uniswap code: launch, give Shares, open the sale,
/// bid from five accounts, end, finish, claim, trade, collect fees, hand back at the floor, and pay out over time with a
/// check-in lapse. Every step asserts exact balances against the plan's 3 / 22 / 15 / 60 arithmetic and the 40 / 10 / 20 / 20 /
/// 10 allocation. Runs four ways: the local twin and the Sepolia fork, each with the dollar token sorted before and after the
/// Shares in the pool (Uniswap prices the pool differently for the two orders).
abstract contract LifeBase is Platform {
    function _fork() internal pure virtual returns (bool);
    function _quoteIsCurrency0() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    /// @dev Everything after the sale ends, in the order a stranger would call it, with the numbers asserted.
    struct Money {
        uint256 raised;
        uint256 fee;
        uint256 net;
        uint256 poolDollars;
        uint256 poolShares;
        uint256 toTreasury;
    }

    function test_life_aWholeProjectLife() public {
        // ---- launch: the 40 / 10 / 20 / 20 / 10 allocation is where the plan says --------------------------------
        Proj memory p = _launchOrdered(founder, _quoteIsCurrency0());
        assertEq(
            (address(usd) < address(p.shares)), _quoteIsCurrency0(), "the dollar token is on the side the test wants"
        );
        assertEq(p.shares.totalSupply(), SUPPLY);
        assertEq(
            p.shares.balanceOf(address(p.finisher)), 350_000_000 * SHARE, "25% auction + 10% pool match: the Finisher"
        );
        assertEq(p.shares.balanceOf(address(p.vester)), 200_000_000 * SHARE, "20% founder: the Vester");
        assertEq(
            p.shares.balanceOf(address(p.treasury)), 300_000_000 * SHARE, "20% work pot + 10% reserve: the Treasury"
        );
        assertEq(p.treasury.workPot(), 200_000_000 * SHARE);
        assertEq(p.treasury.reserve(), 100_000_000 * SHARE);
        assertEq(p.treasury.opener(), address(p.finisher), "only the project's own Finisher can open its pool");
        assertEq(p.treasury.salePath(), address(launcher));

        // ---- give Shares before the pool: they go to the Vester and follow its release ---------------------------
        vm.prank(founder);
        p.treasury.giveShares(bob, 1_000_000 * SHARE);
        assertEq(p.shares.balanceOf(bob), 0, "a gift before the pool opens is not in the person's hands");
        (uint256 granted,) = p.vester.grants(bob);
        assertEq(granted, 1_000_000 * SHARE);

        // ---- open the sale: one transaction by the founder ----------------------------------------------------------
        Sale memory s = _open(p);
        assertEq(p.shares.balanceOf(address(p.finisher)), 0, "the Finisher handed everything to the strategy");
        assertEq(p.shares.balanceOf(address(s.auction)), SaleParams.SALE_SHARES, "the auction holds the 25% for sale");
        assertEq(p.shares.balanceOf(strategy), SaleParams.POOL_SHARES, "the strategy holds the 10% for the pool");
        assertEq(s.auction.fundsRecipient(), strategy, "the strategy receives the raise");
        assertEq(
            s.auction.tokensRecipient(), address(p.finisher), "the Finisher receives unsold Shares, never the founder"
        );
        assertEq(s.auction.validationHook(), minBid, "the bid rules are the platform's");
        assertEq(s.endBlock - s.startBlock, SaleParams.SALE_BLOCKS, "24 hours");
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Open));
        assertEq(usd.balanceOf(founder), 0, "the founder never holds the money");

        // ---- bids from five accounts ----------------------------------------------------------------------------------
        uint256[5] memory ids = _fiveBids(s);
        assertEq(usd.balanceOf(address(s.auction)), 320_000 * DOLLAR, "every dollar bid is held by the auction");

        // ---- the sale ends; the figures are the auction's ------------------------------------------------------------
        _toEnd(s);
        assertTrue(s.auction.isGraduated());
        Money memory m;
        m.raised = s.auction.currencyRaised();
        m.fee = m.raised * 30_000 / 1_000_000;
        m.net = m.raised - m.fee;
        uint256 budget = m.net * SaleParams.POOL_RATE / SaleParams.RATE_SCALE;
        uint256 finalPrice = s.auction.clearingPrice();
        assertGt(finalPrice, s.floorQ96, "demand lifted the price above the floor");

        // ---- step 1: the pool step ----------------------------------------------------------------------------------
        IPositionManagerTest pm = IPositionManagerTest(positionManager);
        uint256 positionId = pm.nextTokenId();
        vm.roll(s.endBlock + 1);
        uint256 poolDollarsBefore = usd.balanceOf(poolManager);
        vm.prank(stranger);
        assertTrue(p.finisher.openPool(), "the pool step ran");
        m.poolDollars = usd.balanceOf(poolManager) - poolDollarsBefore;
        m.poolShares = p.shares.balanceOf(poolManager);
        assertEq(usd.balanceOf(platform), m.fee, "the platform got exactly 3% of the raise");
        assertLe(m.poolDollars, budget, "the pool took no more than 22 of every 100");
        assertGe(m.poolDollars + 1000, budget, "and nearly all of it");
        assertEq(
            usd.balanceOf(address(p.finisher)),
            m.net - m.poolDollars,
            "the rest came back to the Finisher, not the founder"
        );
        assertEq(
            p.shares.balanceOf(address(p.finisher)),
            SaleParams.POOL_SHARES - m.poolShares,
            "unused pool Shares came back too"
        );
        assertEq(pm.ownerOf(positionId), address(holder), "the LiquidityHolder owns the position from its first block");
        assertTrue(p.finisher.poolIsOpen(), "the pool exists, read from the pool manager");
        assertFalse(p.treasury.poolOpen(), "but nothing is settled until step 2");
        assertEq(usd.balanceOf(address(p.treasury)), 0, "no dollars reached the Treasury yet");

        // ---- exits are closed through the first two steps -----------------------------------------------------------------
        vm.prank(alice);
        vm.expectRevert(Treasury.NotSettled.selector);
        p.treasury.handBack(1);

        // ---- step 2: settle in one transaction ------------------------------------------------------------------------
        vm.prank(stranger);
        assertTrue(p.finisher.settle());
        m.toTreasury = m.net - m.poolDollars;
        assertTrue(p.treasury.poolOpen(), "the pool is marked open");
        assertGt(p.vester.start(), 0, "and the Vester's clock started");
        assertEq(p.treasury.spendable(), m.toTreasury * 15 / 75, "15 of the 75 that reach the Treasury are spendable");
        assertEq(p.treasury.melting(), m.toTreasury - p.treasury.spendable(), "the rest is the melting floor");
        assertEq(usd.balanceOf(address(p.treasury)), m.toTreasury, "every dollar that came back is in the Treasury");
        assertEq(usd.balanceOf(address(p.finisher)), 0, "none is left in the Finisher");
        assertApproxEqAbs(
            p.treasury.spendable(), m.raised * 15 / 100, m.raised / 1_000_000 + 2, "15 of every 100 raised"
        );
        assertApproxEqAbs(p.treasury.melting(), m.raised * 60 / 100, m.raised / 1_000_000 + 2, "60 of every 100 raised");
        assertApproxEqAbs(m.poolDollars, m.raised * 22 / 100, m.raised / 1_000_000 + 2, "22 of every 100 raised");
        assertEq(
            m.fee + m.poolDollars + p.treasury.spendable() + p.treasury.melting(),
            m.raised,
            "3 + 22 + 15 + 60 is every dollar raised"
        );
        vm.prank(alice);
        vm.expectRevert(Treasury.SaleNotClosed.selector);
        p.treasury.handBack(1); // settled, but unsold Shares are not swept yet: still closed

        // ---- step 3: sweep ------------------------------------------------------------------------------------------------
        uint256 unsold = s.auction.remainingSupply();
        vm.prank(stranger);
        assertTrue(p.finisher.sweep());
        assertEq(p.shares.balanceOf(address(p.finisher)), 0, "the Finisher holds nothing");
        assertEq(
            p.shares.balanceOf(address(p.treasury)),
            279_000_000 * SHARE + unsold + (SaleParams.POOL_SHARES - m.poolShares),
            "work pot (less the 1M gift) + reserve (less the 20M stake) + unsold + unused pool Shares"
        );
        assertEq(
            p.treasury.reserve(),
            80_000_000 * SHARE + unsold + (SaleParams.POOL_SHARES - m.poolShares),
            "the rest is plain reserve (the 20M stake went to the Vester as held Shares)"
        );
        assertTrue(p.treasury.saleClosed(), "exits are open");
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Done));
        // repeating any step is harmless
        vm.startPrank(stranger);
        assertFalse(p.finisher.openPool());
        assertFalse(p.finisher.settle());
        assertFalse(p.finisher.sweep());
        vm.stopPrank();
        assertEq(p.treasury.spendable() + p.treasury.melting(), m.toTreasury, "nothing was split twice");

        // ---- bidders claim ----------------------------------------------------------------------------------------------
        address[5] memory who = [erin, dave, carol, bob, alice];
        uint256 refunds;
        uint256 filled;
        for (uint256 i; i < 5; ++i) {
            (uint256 r, uint256 sh) = _collectBid(s, ids[i]);
            refunds += r;
            filled += sh;
            assertEq(p.shares.balanceOf(who[i]), sh + (who[i] == bob ? 0 : 0));
        }
        assertGt(p.shares.balanceOf(erin), 0, "the early low bid bought some Shares before it was outbid");
        assertGt(usd.balanceOf(erin), 0, "and got the unspent dollars back");
        assertApproxEqAbs(320_000 * DOLLAR, m.raised + refunds, 10, "dollars bid = dollars raised + dollars refunded");
        assertApproxEqAbs(filled, s.auction.totalCleared(), 10, "Shares claimed = Shares sold");
        uint256 accounted = filled + m.poolShares + p.shares.balanceOf(address(p.treasury))
            + p.shares.balanceOf(address(p.vester)) + p.shares.balanceOf(address(s.auction))
            + p.shares.balanceOf(strategy) + p.shares.balanceOf(address(p.rounds));
        assertEq(accounted, SUPPLY, "all 1,000,000,000 Shares are accounted for");

        // ---- the exit denominator, with the pool's Shares counted as in people's hands (owner call 1) ---------------
        uint256 counting = p.treasury.countingSupply();
        assertEq(
            counting,
            SUPPLY - p.shares.balanceOf(address(p.treasury)) - p.shares.balanceOf(address(p.rounds))
                - p.shares.balanceOf(address(p.finisher)) - p.vester.unreleased(),
            "every Share but the Treasury's, the Rounds' (unsold backing Shares), the Finisher's and the unreleased"
        );
        assertApproxEqAbs(
            counting,
            filled + m.poolShares,
            10,
            "buyers' Shares plus the pool's (the auction keeps a few units of dust)"
        );
    }
}

abstract contract LifeBase2 is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }
    function _quoteIsCurrency0() internal pure virtual returns (bool);

    /// @dev The second half of the life: with a finished sale and the bids collected, a trade through the pool, the pool fees
    /// collected and split, a hand back at the floor, and the daily release over time with a check-in lapse.
    function test_life_tradesFeesHandBackAndTheDailyRelease() public {
        Proj memory p = _launchOrdered(founder, _quoteIsCurrency0());
        vm.prank(founder);
        p.treasury.giveShares(bob, 1_000_000 * SHARE);
        Sale memory s = _open(p);
        uint256[5] memory ids = _fiveBids(s);
        _toEnd(s);
        IPositionManagerTest pm = IPositionManagerTest(positionManager);
        uint256 positionId = pm.nextTokenId();
        _finish(p, s);
        for (uint256 i; i < 5; ++i) {
            _collectBid(s, ids[i]);
        }
        assertEq(pm.ownerOf(positionId), address(holder));
        uint256 finalPrice = s.auction.clearingPrice();
        finalPrice;

        // ---- a trade through the pool, then collect the pool fees ------------------------------------------------------------
        usd.mint(trader, 100 * DOLLAR);
        PoolKey memory key = _key(p);
        uint256 poolQ = usd.balanceOf(poolManager);
        uint256 poolS = p.shares.balanceOf(poolManager);
        (uint256 paid, uint256 got) = _swap(key, address(p.shares), trader, true, 100 * DOLLAR);
        assertEq(paid, 100 * DOLLAR, "the trader paid exactly 100 dollars");
        assertEq(p.shares.balanceOf(trader), got);
        assertEq(usd.balanceOf(poolManager), poolQ + paid, "the pool took the dollars");
        assertEq(p.shares.balanceOf(poolManager), poolS - got, "and gave the Shares");
        (uint256 soldShares, uint256 back) = _swap(key, address(p.shares), trader, false, got);
        assertEq(soldShares, got);
        assertLt(back, paid, "selling straight back loses the fee both ways");

        uint256 supplyBefore = p.shares.totalSupply();
        uint256 spendableBefore = p.treasury.spendable();
        uint256 platformBefore = usd.balanceOf(platform);
        vm.prank(stranger);
        (uint256 feeDollars, uint256 feeShares) = holder.collect(positionId);
        assertApproxEqAbs(feeDollars, 1 * DOLLAR, 2, "the 1% pool fee on 100 dollars in");
        assertGt(feeShares, 0, "the pool fee on the Shares sold back");
        assertEq(usd.balanceOf(platform) - platformBefore, feeDollars / 2, "half the dollar fee to the platform");
        assertEq(
            p.treasury.spendable() - spendableBefore, feeDollars - feeDollars / 2, "half to the project's spendable"
        );
        assertEq(supplyBefore - p.shares.totalSupply(), feeShares, "the Share fee was burned");
        assertEq(usd.balanceOf(address(holder)), 0, "the holder keeps nothing");
        assertEq(p.shares.balanceOf(address(holder)), 0);
        assertEq(pm.ownerOf(positionId), address(holder), "and still owns the position");
        // collecting again with nothing new pays nothing
        vm.prank(stranger);
        (uint256 d2, uint256 s2) = holder.collect(positionId);
        assertEq(d2 + s2, 0);

        // ---- a hand back at the floor --------------------------------------------------------------------------------
        uint256 amount = p.shares.balanceOf(alice) / 2;
        assertGt(amount, 0);
        vm.prank(alice);
        p.shares.approve(address(p.treasury), type(uint256).max);
        uint256 floorTotal = p.treasury.melting() + p.treasury.permanentFloor();
        uint256 slice = floorTotal * amount / p.treasury.countingSupply();
        uint256 expectedPaid = slice - (slice * 500 + 9999) / 10_000;
        uint256 aliceUsd = usd.balanceOf(alice);
        vm.prank(alice);
        uint256 got2 = p.treasury.handBack(amount);
        assertEq(got2, expectedPaid, "paid the slice less the 5% fee, exactly");
        assertEq(usd.balanceOf(alice) - aliceUsd, expectedPaid);
        assertEq(p.treasury.feesOwed(), slice * 100 / 10_000, "1 of the 5 is owed to the platform");

        // ---- the daily release over time, with a check-in lapse ----------------------------------------------------------
        uint256 m0 = p.treasury.melting();
        uint256 sp0 = p.treasury.spendable();
        vm.warp(_now() + 10 days);
        _checkIn(p); // accrues the 10 days first, then renews the window (a signer of the Pair)
        uint256 r1 = m0 * 10 days / 365 days;
        assertEq(p.treasury.melting(), m0 - r1, "ten days of the year released, exactly");
        assertEq(p.treasury.spendable(), sp0 + r1);
        uint256 rem1 = 365 days - 10 days;
        vm.warp(_now() + 40 days); // the founder goes quiet: only 14 of the 40 days count
        uint256 m1 = p.treasury.melting();
        uint256 r2 = m1 * 14 days / rem1;
        assertEq(p.treasury.pendingRelease(), r2, "only the 14 days inside the check-in window are paid");
        p.treasury.release();
        assertEq(p.treasury.melting(), m1 - r2);
        vm.warp(_now() + 30 days);
        assertEq(p.treasury.pendingRelease(), 0, "and nothing more while the founder stays quiet");
        // the founder's Shares: the clock started when the pool opened, so 50 days are released now
        uint256 elapsed = _now() - p.vester.start();
        assertEq(p.vester.released(founder), 200_000_000 * SHARE * elapsed / 365 days);
        assertEq(p.vester.released(bob), 1_000_000 * SHARE * elapsed / 365 days);
    }
}

abstract contract LifeBase3 is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }
    function _quoteIsCurrency0() internal pure virtual returns (bool);

    /// @dev Prints the figures of the main sale (the numbers the milestone 3 report quotes): where every dollar and Share went and
    /// what the floor pays per Share with and without the pool's Shares in the count.
    function test_life_theFiguresOfTheMainSale() public {
        Proj memory p = _launchOrdered(founder, _quoteIsCurrency0());
        Sale memory s = _open(p);
        uint256[5] memory ids = _fiveBids(s);
        _toEnd(s);
        uint256 dollarsBefore = usd.balanceOf(poolManager);
        _finish(p, s);
        uint256 unsold = s.auction.remainingSupply();
        uint256 filled;
        for (uint256 i; i < 5; ++i) {
            (, uint256 got) = _collectBid(s, ids[i]);
            filled += got;
        }
        uint256 raised = s.auction.currencyRaised();
        uint256 fee = raised * 30_000 / 1_000_000;
        uint256 poolDollars = usd.balanceOf(poolManager) - dollarsBefore;
        uint256 poolShares = p.shares.balanceOf(poolManager);
        uint256 counting = p.treasury.countingSupply();
        emit log_named_decimal_uint("life: dollars raised", raised, 6);
        emit log_named_decimal_uint("life: fee to the platform (3)", fee, 6);
        emit log_named_decimal_uint("life: dollars in the pool (22)", poolDollars, 6);
        emit log_named_decimal_uint("life: spendable by the project (15)", p.treasury.spendable(), 6);
        emit log_named_decimal_uint("life: melting floor (60)", p.treasury.melting(), 6);
        emit log_named_decimal_uint("life: Shares in the pool", poolShares, 18);
        emit log_named_decimal_uint(
            "life: Shares back with the Treasury from the pool reserve", SaleParams.POOL_SHARES - poolShares, 18
        );
        emit log_named_decimal_uint("life: unsold Shares to the Treasury", unsold, 18);
        emit log_named_decimal_uint("life: Shares bidders hold", filled, 18);
        emit log_named_decimal_uint("life: Shares counted for exits", counting, 18);
        emit log_named_decimal_uint(
            "life: floor per Share, dollars, counting the pool's Shares", p.treasury.melting() * 1e30 / counting, 18
        );
        emit log_named_decimal_uint(
            "life: floor per Share, dollars, leaving the pool's Shares out",
            p.treasury.melting() * 1e30 / (counting - poolShares),
            18
        );
        emit log_named_decimal_uint("life: price the pool opened at, dollars", _spot(_key(p)), 18);
    }

    function test_life_theStrangerWhoFinishesFirstChangesNothingAboutTheOutcome() public {
        // the same sale finished by a different mix of strangers gives the same buckets
        uint256[2] memory outcome;
        for (uint256 round; round < 2; ++round) {
            uint256 snap = vm.snapshotState();
            Proj memory p = _launchOrdered(founder, _quoteIsCurrency0());
            Sale memory s = _open(p);
            _fiveBids(s);
            _toEnd(s);
            vm.roll(s.endBlock + 1);
            if (round == 0) {
                // the natural order, one stranger
                vm.startPrank(stranger);
                p.finisher.openPool();
                p.finisher.settle();
                p.finisher.sweep();
                vm.stopPrank();
            } else {
                // the pool step called straight on the strategy by one stranger, settle by another, sweep by a third
                vm.prank(alice);
                (bool ok,) = strategy.call(abi.encodeWithSignature("migrate(address)", address(s.auction)));
                assertTrue(ok);
                vm.prank(bob);
                p.finisher.settle();
                vm.prank(carol);
                p.finisher.sweep();
            }
            outcome[round] = p.treasury.spendable() * 1e9 + p.treasury.melting();
            assertTrue(p.treasury.saleClosed());
            if (round == 0) vm.revertToState(snap);
        }
        assertEq(outcome[0], outcome[1], "who called which step changes nothing");
    }
}

contract LifeLocalQuote0Test is LifeBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract LifeLocalQuote1Test is LifeBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

contract LifeForkQuote0Test is LifeBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract LifeForkQuote1Test is LifeBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

contract LifeLocalQuote02Test is LifeBase2 {
    function _fork() internal pure override returns (bool) {
        return false;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract LifeLocalQuote03Test is LifeBase3 {
    function _fork() internal pure override returns (bool) {
        return false;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract LifeLocalQuote12Test is LifeBase2 {
    function _fork() internal pure override returns (bool) {
        return false;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

contract LifeLocalQuote13Test is LifeBase3 {
    function _fork() internal pure override returns (bool) {
        return false;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

contract LifeForkQuote02Test is LifeBase2 {
    function _fork() internal pure override returns (bool) {
        return true;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract LifeForkQuote03Test is LifeBase3 {
    function _fork() internal pure override returns (bool) {
        return true;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract LifeForkQuote12Test is LifeBase2 {
    function _fork() internal pure override returns (bool) {
        return true;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

contract LifeForkQuote13Test is LifeBase3 {
    function _fork() internal pure override returns (bool) {
        return true;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
