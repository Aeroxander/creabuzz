// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Platform} from "./helpers/Platform.sol";
import {IPositionManagerTest} from "./helpers/UniswapTest.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Finisher} from "../src/Finisher.sol";
import {PoolKey, SaleParams} from "../src/Pinned.sol";

/// @notice Attacks on the market once the pool is open: buying below the floor and handing back (the bear-market drain,
/// measured), a founder dumping at pool open, handing back before the finish is complete, sniping the pool at graduation, a
/// founder bidding in their own sale through a second account, and two projects sharing the one strategy at the same time.
abstract contract MarketAttacksBase is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    /// @dev A standard sale at exactly its goal (the price stays at the floor), finished, every bidder paid out.
    function _flatProject(bytes32 id, Launcher.Size size, uint256 total)
        internal
        returns (Proj memory p, Sale memory s, uint256 poolDollars)
    {
        p = _launch(founder, id);
        s = _open(p, size);
        uint256[5] memory ids = _flat(s, total);
        _toEnd(s);
        uint256 before = usd.balanceOf(poolManager);
        _finish(p, s);
        poolDollars = usd.balanceOf(poolManager) - before;
        for (uint256 i; i < 5; ++i) {
            _collectBid(s, ids[i]);
        }
    }

    /// @dev Dollars per whole Share, scaled by 1e18, that the floor pays at this moment before the 5% fee.
    function _floorPerShare(Proj memory p) internal view returns (uint256) {
        return (p.treasury.melting() + p.treasury.permanentFloor()) * 1e30 / p.treasury.countingSupply();
    }

    function _str(uint256 x, uint256 decimals) internal pure returns (string memory) {
        uint256 unit = 10 ** decimals;
        string memory frac = vm.toString(x % unit);
        while (bytes(frac).length < decimals) frac = string.concat("0", frac);
        return string.concat(vm.toString(x / unit), ".", frac);
    }

    // ============================================== the bear-market drain =============================================

    struct Trade {
        uint256 discountBps; // how far under the floor the pool's price stood (before the trade), in ten-thousandths
        uint256 spent;
        uint256 got;
        uint256 payout;
        uint256 gasBuy;
        uint256 gasExit;
    }

    /// @dev Sell Shares into the pool from holders' hands until the pool's price is at or under `target` (whole dollars per
    /// whole Share, scaled by 1e18). Returns the discount reached, in ten-thousandths under `floor`.
    function _dumpTo(Proj memory p, uint256 floorPS, uint256 target) internal returns (uint256) {
        PoolKey memory key = _key(p);
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 300 && _spot(key) > target; ++i) {
            address a = who[i / 100];
            _swap(key, address(p.shares), a, false, 1_000_000 * SHARE);
        }
        uint256 spot = _spot(key);
        return spot >= floorPS ? 0 : (floorPS - spot) * 10_000 / floorPS;
    }

    function _buyAndHandBack(Proj memory p, uint256 x) internal returns (Trade memory t) {
        PoolKey memory key = _key(p);
        usd.mint(trader, x);
        uint256 g = gasleft();
        (t.spent, t.got) = _swap(key, address(p.shares), trader, true, x);
        t.gasBuy = g - gasleft();
        vm.startPrank(trader);
        p.shares.approve(address(p.treasury), type(uint256).max);
        g = gasleft();
        t.payout = p.treasury.handBack(t.got);
        t.gasExit = g - gasleft();
        vm.stopPrank();
    }

    /// @dev The drain, measured. After a sale at its goal, holders sell Shares into the pool until its price is a chosen
    /// distance under the floor; a trader then buys with `x` dollars and hands everything straight back. Profit is the payout
    /// less what was spent, the pool's 1% fee, the price the trade itself moves and the 5% exit fee all included; gas is
    /// reported in units, separately. Asserted: no profit within 5% of the floor; a profit exists some way further down;
    /// and the deeper the discount the more is made.
    function test_attack_buyBelowTheFloorAndHandBack_measuredAtOnePercentFivePercentTenPercent() public {
        (Proj memory p,,) = _flatProject(keccak256("bear"), Launcher.Size.Standard, 10_000 * DOLLAR);
        uint256 floorPS = _floorPerShare(p);
        PoolKey memory key = _key(p);
        emit log_string(string.concat(
                "bear: pool opens at ",
                _str(_spot(key), 18),
                " dollars a Share; the floor pays ",
                _str(floorPS, 18),
                " before the exit fee"
            ));
        emit log_string(string.concat(
                "bear: Shares counted for exits ",
                _str(p.treasury.countingSupply(), 18),
                "; floor dollars ",
                _str(p.treasury.melting(), 6)
            ));
        uint256 base = vm.snapshotState();
        uint256[10] memory discounts = [uint256(0), 100, 200, 400, 500, 600, 700, 800, 1000, 1500];
        uint256[3] memory sizes = [uint256(20 * DOLLAR), 200 * DOLLAR, 1000 * DOLLAR];
        int256[3] memory last;
        uint256 breakEvenBps;
        for (uint256 d; d < discounts.length; ++d) {
            vm.revertToState(base);
            uint256 reached = discounts[d] == 0 ? 0 : _dumpTo(p, floorPS, floorPS * (10_000 - discounts[d]) / 10_000);
            uint256 inner = vm.snapshotState();
            for (uint256 k; k < sizes.length; ++k) {
                vm.revertToState(inner);
                Trade memory t = _buyAndHandBack(p, sizes[k]);
                int256 profit = int256(t.payout) - int256(t.spent);
                emit log_string(string.concat(
                        "bear: pool ",
                        vm.toString(reached / 100),
                        ".",
                        vm.toString(reached % 100 / 10),
                        "% under the floor, spend ",
                        vm.toString(sizes[k] / DOLLAR),
                        " dollars: Shares bought ",
                        _str(t.got / 1e12, 6),
                        ", paid back ",
                        _str(t.payout, 6),
                        ", ",
                        profit < 0 ? "loss " : "profit ",
                        _str(uint256(profit < 0 ? -profit : profit), 6),
                        ", gas buy ",
                        vm.toString(t.gasBuy),
                        " exit ",
                        vm.toString(t.gasExit)
                    ));
                if (reached <= 500) assertLt(profit, 0, "no profit when the pool is within 5% of the floor");
                if (k == 0 && profit > 0 && breakEvenBps == 0) breakEvenBps = reached;
                if (d > 0) {
                    assertGe(
                        profit,
                        last[k] - int256(sizes[k] / 50),
                        "the deeper the discount, the more is made (to a small rounding)"
                    );
                }
                last[k] = profit;
            }
        }
        emit log_named_uint(
            "bear: smallest discount (ten-thousandths) at which a 20-dollar trade profits", breakEvenBps
        );
        assertGt(breakEvenBps, 500, "the drain does not pay within 5% of the floor");
        assertLt(breakEvenBps, 1500, "but it does pay further down: this is the accepted bear-market drain");
    }

    // ============================================== sniping the pool at graduation ===================================

    struct Impact {
        uint256 spotBefore;
        uint256 spotAfter;
        uint256 shares;
        uint256 avgPrice;
    }

    function _snipe(Proj memory p, bool buy, uint256 amount) internal returns (Impact memory r) {
        PoolKey memory key = _key(p);
        r.spotBefore = _spot(key);
        if (buy) {
            usd.mint(trader, amount);
            (uint256 paid, uint256 got) = _swap(key, address(p.shares), trader, true, amount);
            r.shares = got;
            r.avgPrice = paid * 1e30 / got;
        } else {
            // sell Shares worth `amount` dollars at the opening price
            uint256 n = amount * 1e30 / r.spotBefore;
            vm.prank(address(p.treasury));
            p.shares.transfer(alice, n); // the seller is given the Shares; only the pool's reaction is measured
            (uint256 paid, uint256 got) = _swap(key, address(p.shares), alice, false, n);
            r.shares = paid;
            r.avgPrice = got * 1e30 / paid;
        }
        r.spotAfter = _spot(key);
    }

    function p_raise(Sale memory s) internal view returns (uint256) {
        return s.auction.currencyRaised();
    }

    function p_shares(address who, Proj memory a, Proj memory b) internal view returns (uint256) {
        return a.shares.balanceOf(who) + b.shares.balanceOf(who);
    }

    function _checkSplit(Proj memory p, Sale memory s) internal view {
        uint256 raised = s.auction.currencyRaised();
        uint256 net = raised - raised * 30_000 / 1_000_000;
        uint256 arrived = p.treasury.spendable() + p.treasury.melting();
        assertEq(p.treasury.spendable(), arrived * 15 / 75);
        assertLe(arrived, net);
        assertApproxEqAbs(
            arrived, raised * 75 / 100, raised / 1_000_000 + 2, "75 of every 100 reached the project's Treasury"
        );
        assertTrue(p.treasury.saleClosed());
    }
}

abstract contract MarketAttacksBase2 is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    function _str(uint256 x, uint256 decimals) internal pure returns (string memory) {
        uint256 unit = 10 ** decimals;
        string memory frac = vm.toString(x % unit);
        while (bytes(frac).length < decimals) frac = string.concat("0", frac);
        return string.concat(vm.toString(x / unit), ".", frac);
    }

    // ============================================== hand back before the finish is complete ==========================

    /// @dev A holder tries to hand Shares back at each stage of the finish: nothing before step 2 (no money has been split), nothing
    /// between steps 2 and 3 even with Shares bought from the new pool (unsold Shares would still count as held), and the exit works
    /// after step 3.
    function test_attack_handBackBeforeSettleAndBeforeTheSaleIsClosed() public {
        Proj memory p = _launch(founder, keccak256("early"));
        Sale memory s = _open(p, Launcher.Size.Standard);
        uint256[5] memory ids = _flat(s, 6000 * DOLLAR); // a partial sale, so unsold Shares exist to dilute
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        // a bidder with Shares tries to hand them back before anything is done
        (, uint256 got) = _collectBid(s, ids[0]);
        assertGt(got, 0);
        vm.startPrank(alice);
        p.shares.approve(address(p.treasury), type(uint256).max);
        vm.expectRevert(Treasury.NotSettled.selector);
        p.treasury.handBack(got);
        vm.stopPrank();
        p.finisher.openPool();
        vm.prank(alice);
        vm.expectRevert(Treasury.NotSettled.selector);
        p.treasury.handBack(got);
        p.finisher.settle();
        // the pool exists now: a trader buys from it and tries to exit at once
        usd.mint(trader, 100 * DOLLAR);
        (, uint256 bought) = _swap(_key(p), address(p.shares), trader, true, 100 * DOLLAR);
        vm.startPrank(trader);
        p.shares.approve(address(p.treasury), type(uint256).max);
        vm.expectRevert(Treasury.SaleNotClosed.selector);
        p.treasury.handBack(bought);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(Treasury.SaleNotClosed.selector);
        p.treasury.handBack(got);
        // only a stranger can finish it, and then the exit opens
        p.finisher.sweep();
        vm.prank(alice);
        uint256 paid = p.treasury.handBack(got);
        assertGt(paid, 0);
    }

    // ============================================== founder dump at pool open ========================================

    /// @dev What the founder and the people they paid before the pool opened can do at the moment it opens: nothing. Their Shares
    /// sit in the Vester and release evenly over 365 days from that moment. What they can do is the plan's own allowance:
    /// Shares given after the pool opens are free at once, at most 1% of all Shares in 30 days. That allowance is measured here.
    function test_attack_aFounderDumpAtPoolOpen() public {
        Proj memory p = _launch(founder, keccak256("dump"));
        // gifts before the pool: to a friend and to a second wallet of the founder's
        address friend = makeAddr("friend");
        address wallet2 = makeAddr("founder wallet two");
        vm.startPrank(founder);
        p.treasury.giveShares(friend, 50_000_000 * SHARE);
        p.treasury.giveShares(wallet2, 50_000_000 * SHARE);
        vm.stopPrank();
        Sale memory s = _open(p, Launcher.Size.Standard);
        uint256[5] memory ids = _flat(s, 10_000 * DOLLAR);
        _toEnd(s);
        // in the block the pool opens
        _finish(p, s);
        for (uint256 i; i < 5; ++i) {
            _collectBid(s, ids[i]);
        }
        assertEq(p.vester.claimable(founder), 0, "the founder's 20% released nothing yet");
        assertEq(p.vester.claimable(friend), 0);
        assertEq(p.vester.claimable(wallet2), 0);
        assertEq(p.vester.claim(founder), 0);
        assertEq(
            p.shares.balanceOf(founder) + p.shares.balanceOf(friend) + p.shares.balanceOf(wallet2),
            0,
            "nobody holds a Share to sell"
        );
        assertEq(
            p.shares.balanceOf(address(p.vester)),
            300_000_000 * SHARE,
            "200M + 100M of gifts are all still in the Vester"
        );
        // the pool's Shares and the dollars in it are untouched by anything the team can do
        // no new grant after the clock has started: a last-second pre-pool gift cannot be made once the pool is open
        vm.prank(founder);
        p.treasury.giveShares(friend, 1_000_000 * SHARE); // after the pool: straight to the person, inside the 1% cap
        assertEq(p.shares.balanceOf(friend), 1_000_000 * SHARE, "a gift after the pool is free at once");
        vm.expectRevert(); // the Vester takes no grant after the pool opened
        vm.prank(address(p.treasury));
        p.vester.grant(friend, 1);
        // one day on, exactly one 365th of each grant is released
        vm.warp(_now() + 1 days);
        assertEq(p.vester.claimable(founder), 200_000_000 * SHARE * 1 days / 365 days);
        assertEq(p.vester.claimable(friend), 50_000_000 * SHARE * 1 days / 365 days);

        // the allowance, measured: 1% of all Shares (10,000,000) gifted to a fresh wallet and sold into the pool at once
        PoolKey memory key = _key(p);
        uint256 before = _spot(key);
        vm.prank(founder);
        p.treasury.giveShares(wallet2, 9_000_000 * SHARE); // 1M already given this month: the cap is 10M in all
        vm.prank(founder);
        vm.expectRevert(); // one Share more than the cap
        p.treasury.giveShares(wallet2, 1 * SHARE + 1);
        uint256 dollars0 = usd.balanceOf(wallet2);
        _swap(key, address(p.shares), wallet2, false, 9_000_000 * SHARE);
        uint256 after_ = _spot(key);
        emit log_string(string.concat(
                "dump: 9,000,000 Shares sold at once right after the pool opens move the price from ",
                _str(before, 18),
                " to ",
                _str(after_, 18),
                " and raise ",
                _str(usd.balanceOf(wallet2) - dollars0, 6),
                " dollars"
            ));
        assertLt(after_, before);
    }
}

abstract contract MarketAttacksBase3 is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    /// @dev A standard sale at exactly its goal (the price stays at the floor), finished, every bidder paid out.
    function _flatProject(bytes32 id, Launcher.Size size, uint256 total)
        internal
        returns (Proj memory p, Sale memory s, uint256 poolDollars)
    {
        p = _launch(founder, id);
        s = _open(p, size);
        uint256[5] memory ids = _flat(s, total);
        _toEnd(s);
        uint256 before = usd.balanceOf(poolManager);
        _finish(p, s);
        poolDollars = usd.balanceOf(poolManager) - before;
        for (uint256 i; i < 5; ++i) {
            _collectBid(s, ids[i]);
        }
    }

    function _str(uint256 x, uint256 decimals) internal pure returns (string memory) {
        uint256 unit = 10 ** decimals;
        string memory frac = vm.toString(x % unit);
        while (bytes(frac).length < decimals) frac = string.concat("0", frac);
        return string.concat(vm.toString(x / unit), ".", frac);
    }

    // ============================================== sniping the pool at graduation ===================================

    struct Impact {
        uint256 spotBefore;
        uint256 spotAfter;
        uint256 shares;
        uint256 avgPrice;
    }

    function _snipe(Proj memory p, bool buy, uint256 amount) internal returns (Impact memory r) {
        PoolKey memory key = _key(p);
        r.spotBefore = _spot(key);
        if (buy) {
            usd.mint(trader, amount);
            (uint256 paid, uint256 got) = _swap(key, address(p.shares), trader, true, amount);
            r.shares = got;
            r.avgPrice = paid * 1e30 / got;
        } else {
            // sell Shares worth `amount` dollars at the opening price
            uint256 n = amount * 1e30 / r.spotBefore;
            vm.prank(address(p.treasury));
            p.shares.transfer(alice, n); // the seller is given the Shares; only the pool's reaction is measured
            (uint256 paid, uint256 got) = _swap(key, address(p.shares), alice, false, n);
            r.shares = paid;
            r.avgPrice = got * 1e30 / paid;
        }
        r.spotAfter = _spot(key);
    }

    /// @dev What a trader can do to the price in the first block of the pool, for a 100 and a 2,500 dollar trade in each direction,
    /// at the Standard and the Small size. The pool is small, so the numbers are large; this is the plan's "small pools" warning
    /// measured.
    function test_attack_snipingThePoolAtGraduation_measured() public {
        Launcher.Size[2] memory sizes = [Launcher.Size.Standard, Launcher.Size.Small];
        uint256[2] memory totals = [uint256(10_000 * DOLLAR), 4000 * DOLLAR];
        uint256[2] memory amounts = [uint256(100 * DOLLAR), 2500 * DOLLAR];
        for (uint256 z; z < 2; ++z) {
            (Proj memory p,, uint256 poolDollars) = _flatProject(keccak256(abi.encode("snipe", z)), sizes[z], totals[z]);
            emit log_string(string.concat(
                    "snipe: ",
                    z == 0 ? "Standard" : "Small",
                    " sale: pool holds ",
                    _str(poolDollars, 6),
                    " dollars and ",
                    _str(p.shares.balanceOf(poolManager) / 1e12, 6),
                    " Shares; opening price ",
                    _str(_spot(_key(p)), 18)
                ));
            uint256 base = vm.snapshotState();
            for (uint256 k; k < 2; ++k) {
                for (uint256 dir; dir < 2; ++dir) {
                    vm.revertToState(base);
                    Impact memory r = _snipe(p, dir == 0, amounts[k]);
                    uint256 moveBps = r.spotAfter > r.spotBefore
                        ? (r.spotAfter - r.spotBefore) * 10_000 / r.spotBefore
                        : (r.spotBefore - r.spotAfter) * 10_000 / r.spotBefore;
                    uint256 slipBps = r.avgPrice > r.spotBefore
                        ? (r.avgPrice - r.spotBefore) * 10_000 / r.spotBefore
                        : (r.spotBefore - r.avgPrice) * 10_000 / r.spotBefore;
                    emit log_string(string.concat(
                            "snipe: ",
                            z == 0 ? "Standard " : "Small ",
                            dir == 0 ? "buy " : "sell ",
                            vm.toString(amounts[k] / DOLLAR),
                            " dollars: the price goes ",
                            r.spotAfter > r.spotBefore ? "up " : "down ",
                            vm.toString(moveBps / 100),
                            ".",
                            vm.toString(moveBps % 100 / 10),
                            "%, and the average price paid is ",
                            vm.toString(slipBps / 100),
                            ".",
                            vm.toString(slipBps % 100 / 10),
                            "% ",
                            dir == 0 ? "above" : "below",
                            " the opening price"
                        ));
                    assertGt(moveBps, 0);
                    assertGt(slipBps, 100, "more than the 1% fee alone");
                }
            }
        }
    }

    // ============================================== the founder bids in their own sale ===============================

    /// @dev The founder can bid through a second account. The 4-times rule limits what ONE BLOCK of bids can do (every bid here is placed
    /// in the first block of the sale, when the price is the floor), not how far the price can go over several blocks: see the ladder
    /// test below. For three sizes of founder bid, against 10,000 dollars of honest demand: how far the price goes in that one block,
    /// what the honest bidders get, what the founder ends with, and what it cost the founder.
    function test_attack_theFounderBidsInTheirOwnSale_measured() public {
        uint256[4] memory founderBids = [uint256(0), 5000 * DOLLAR, 20_000 * DOLLAR, 100_000 * DOLLAR];
        uint256 honestSharesBase;
        for (uint256 z; z < founderBids.length; ++z) {
            Proj memory p = _launch(founder, keccak256(abi.encode("selfbid", z)));
            Sale memory s = _open(p, Launcher.Size.Standard);
            vm.roll(s.startBlock);
            uint256[3] memory ids;
            ids[0] = _bid(s, alice, 3334 * DOLLAR, 300);
            ids[1] = _bid(s, bob, 3333 * DOLLAR, 300);
            ids[2] = _bid(s, carol, 3333 * DOLLAR, 300);
            address second = makeAddr("founder's second account");
            uint256 fid;
            if (founderBids[z] != 0) fid = _bid(s, second, founderBids[z], 300);
            _toEnd(s);
            uint256 finalPrice = s.auction.clearingPrice();
            _finish(p, s);
            uint256 honest;
            for (uint256 i; i < 3; ++i) {
                (, uint256 g) = _collectBid(s, ids[i]);
                honest += g;
            }
            uint256 fShares;
            uint256 fRefund;
            if (founderBids[z] != 0) (fRefund, fShares) = _collectBid(s, fid);
            if (z == 0) honestSharesBase = honest;
            uint256 spent = founderBids[z] - fRefund;
            uint256 raised = s.auction.currencyRaised();
            // what the founder cannot get back: the platform's 3 and the pool's 22 of what they spent (their share of the raise)
            uint256 lost = spent * 25 / 100;
            emit log_string(string.concat(
                    "selfbid: founder bids ",
                    vm.toString(founderBids[z] / DOLLAR),
                    " on top of 10,000 honest: price ",
                    _str(finalPrice * 100 / s.floorQ96, 2),
                    "x the floor, raised ",
                    _str(raised, 6),
                    "; honest bidders get ",
                    _str(honest / 1e12, 6),
                    " Shares (",
                    vm.toString(honestSharesBase == 0 ? 100 : honest * 100 / honestSharesBase),
                    "% of the no-founder case); founder spent ",
                    _str(spent, 6),
                    " for ",
                    _str(fShares / 1e12, 6),
                    " Shares; of that spend ",
                    _str(lost, 6),
                    " goes to the platform and the pool and is not recoverable"
                ));
            assertLe(
                finalPrice,
                4 * s.floorQ96 + 4 * s.tickQ96,
                "within one block the 4-times rule bounds how far one account can pull the price (it is against the price of that block)"
            );
        }
    }

    /// @dev The rule is "4 times the clearing price AT THE TIME OF THE BID", not 4 times the floor. Bids placed some blocks apart can each
    /// name 4 times the price the one before set. A founder's second account places four such bids, 20 blocks apart and well before the
    /// closing window, each sized to buy every Share still to be sold at its top price, and the price climbs far past 4 times the floor.
    /// What stops it is what it costs: the Shares are bought at the lifted price, and 25 of each 100 spent (the platform's 3 and the pool's
    /// 22) never come back. Measured here; the report and the plan state this rule.
    function test_attack_aLadderOfBidsClimbsFarPastFourTimesTheFloor_measured() public {
        Proj memory p = _launch(founder, keccak256("ladder"));
        Sale memory s = _open(p, Launcher.Size.Standard);
        vm.roll(s.startBlock);
        uint256 honestBid = _bid(s, alice, 10_000 * DOLLAR, 300);
        address second = makeAddr("founder's second account");
        uint256 spentIn;
        uint256[4] memory ids;
        uint256[4] memory multiples; // the price at the next block, in hundredths of the floor
        for (uint256 step; step < 4; ++step) {
            vm.roll(s.startBlock + 100 + 20 * step);
            s.auction.checkpoint();
            uint256 c = s.auction.clearingPrice();
            uint256 maxPrice = s.floorQ96 + ((4 * c - s.floorQ96) / s.tickQ96) * s.tickQ96;
            uint256 amount = (maxPrice * ((s.endBlock - block.number) * 60_000e18) >> 96) * 3 + DOLLAR;
            _fund(second, amount, s);
            ids[step] = s.auction.nextBidId();
            vm.prank(second);
            s.auction.submitBid(maxPrice, uint128(amount), second, s.floorQ96, "");
            spentIn += amount;
            vm.roll(block.number + 1);
            s.auction.checkpoint();
            multiples[step] = s.auction.clearingPrice() * 100 / s.floorQ96;
            emit log_named_uint(
                string.concat("ladder: price after step ", vm.toString(step + 1), ", hundredths of the floor"),
                multiples[step]
            );
        }
        assertGt(multiples[0], 380, "the first bid lifts the price to about 4 times the floor");
        assertGt(multiples[1], 1500, "the second names 4 times THAT price: about 16 times the floor");
        assertGt(multiples[3], 4 * 6000, "after four steps the price is above 240 times the floor, not capped at 4");
        _toEnd(s);
        _finish(p, s);
        (uint256 refund,) = _collectBid(s, ids[0]);
        uint256 spent;
        for (uint256 i = 1; i < 4; ++i) {
            (uint256 r,) = _collectBid(s, ids[i]);
            refund += r;
        }
        spent = spentIn - refund;
        _collectBid(s, honestBid);
        emit log_named_uint("ladder: dollars raised", s.auction.currencyRaised());
        emit log_named_uint("ladder: dollars the second account spent net of refunds", spent);
        emit log_named_uint("ladder: dollars in the pool", usd.balanceOf(poolManager));
        assertGt(spent * 25 / 100, 0);
    }
}

abstract contract MarketAttacksBase4 is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    function p_raise(Sale memory s) internal view returns (uint256) {
        return s.auction.currencyRaised();
    }

    function p_shares(address who, Proj memory a, Proj memory b) internal view returns (uint256) {
        return a.shares.balanceOf(who) + b.shares.balanceOf(who);
    }

    function _checkSplit(Proj memory p, Sale memory s) internal view {
        uint256 raised = s.auction.currencyRaised();
        uint256 net = raised - raised * 30_000 / 1_000_000;
        uint256 arrived = p.treasury.spendable() + p.treasury.melting();
        assertEq(p.treasury.spendable(), arrived * 15 / 75);
        assertLe(arrived, net);
        assertApproxEqAbs(
            arrived, raised * 75 / 100, raised / 1_000_000 + 2, "75 of every 100 reached the project's Treasury"
        );
        assertTrue(p.treasury.saleClosed());
    }

    // ============================================== two projects, one strategy ========================================

    /// @dev Two projects open sales in the same block, take bids in turn, finish in an interleaved order, trade, and collect fees.
    /// Each ends exactly as it would alone: its own buckets, its own pool, its own position, its own fees.
    function test_twoProjectsShareTheOneStrategyAtTheSameTime() public {
        address founderB = makeAddr("founder b");
        Proj memory a = _launch(founder, keccak256("project a"));
        Proj memory b = _launch(founderB, keccak256("project b"));
        Sale memory sa = _open(a, Launcher.Size.Standard);
        Sale memory sb = _open(b, Launcher.Size.Small);
        assertEq(sa.startBlock, sb.startBlock, "opened in the same block");
        vm.roll(sa.startBlock);
        uint256 a1 = _bid(sa, alice, 6000 * DOLLAR, 100);
        uint256 b1 = _bid(sb, bob, 3000 * DOLLAR, 100);
        uint256 a2 = _bid(sa, carol, 7000 * DOLLAR, 200);
        uint256 b2 = _bid(sb, dave, 2500 * DOLLAR, 50);
        _toEnd(sa);
        _toEnd(sb);
        vm.roll(sa.endBlock + 1);
        IPositionManagerTest pm = IPositionManagerTest(positionManager);
        uint256 idA = pm.nextTokenId();
        // interleaved: the stranger who finishes A first is not the one who finishes B
        vm.prank(erin);
        a.finisher.openPool();
        uint256 idB = pm.nextTokenId();
        vm.prank(trader);
        b.finisher.openPool();
        vm.prank(alice);
        b.finisher.settle();
        vm.prank(bob);
        a.finisher.settle();
        vm.prank(carol);
        a.finisher.sweep();
        vm.prank(dave);
        b.finisher.sweep();
        assertEq(pm.ownerOf(idA), address(holder));
        assertEq(pm.ownerOf(idB), address(holder), "one holder owns both projects' positions");
        assertEq(
            p_raise(sa) + p_raise(sb),
            usd.balanceOf(poolManager) + usd.balanceOf(platform) + a.treasury.spendable() + a.treasury.melting()
                + b.treasury.spendable() + b.treasury.melting()
        );
        // each project's buckets follow its own raise
        _checkSplit(a, sa);
        _checkSplit(b, sb);
        assertEq(usd.balanceOf(strategy), 0, "the strategy keeps nothing of either");
        assertEq(p_shares(strategy, a, b), 0);
        _collectBid(sa, a1);
        _collectBid(sa, a2);
        _collectBid(sb, b1);
        _collectBid(sb, b2);

        // trades in each pool, and each project's fees go to its own Treasury
        usd.mint(trader, 300 * DOLLAR);
        _swap(_key(a), address(a.shares), trader, true, 100 * DOLLAR);
        _swap(_key(b), address(b.shares), trader, true, 50 * DOLLAR);
        uint256 spA = a.treasury.spendable();
        uint256 spB = b.treasury.spendable();
        uint256 supplyB = b.shares.totalSupply();
        (uint256 fa,) = holder.collect(idA);
        assertApproxEqAbs(fa, 1 * DOLLAR, 2, "A's 1% fee on 100 dollars");
        assertEq(a.treasury.spendable() - spA, fa - fa / 2, "to A's Treasury");
        assertEq(b.treasury.spendable(), spB, "and nothing to B's");
        assertEq(b.shares.totalSupply(), supplyB, "nothing of B's Shares was burned");
        (uint256 fb,) = holder.collect(idB);
        assertApproxEqAbs(fb, DOLLAR / 2, 2, "B's 1% fee on 50 dollars");
        assertEq(b.treasury.spendable() - spB, fb - fb / 2, "to B's Treasury");
    }
}

contract MarketAttacksLocalTest is MarketAttacksBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract MarketAttacksForkTest is MarketAttacksBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}

contract MarketAttacksLocal2Test is MarketAttacksBase2 {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract MarketAttacksLocal3Test is MarketAttacksBase3 {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract MarketAttacksLocal4Test is MarketAttacksBase4 {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract MarketAttacksFork2Test is MarketAttacksBase2 {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}

contract MarketAttacksFork3Test is MarketAttacksBase3 {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}

contract MarketAttacksFork4Test is MarketAttacksBase4 {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}
