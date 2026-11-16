// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Platform} from "./helpers/Platform.sol";
import {Launcher} from "../src/Launcher.sol";
import {Finisher} from "../src/Finisher.sol";
import {SaleParams} from "../src/Pinned.sol";

/// @notice Random sales through the whole route on the real platform: a random size, a random set of bids at random times and
/// prices (some refused by the auction's own rules, which is part of the point), the finish steps called by strangers in a random
/// order, then every bidder collects. After each, the money is accounted for to the unit that can be accounted for:
/// raised = 3 + 22 + 15 + 60 and every dollar bid is the raise or a refund, every Share is somewhere, and a sale that fails to
/// reach its minimum changes nothing for anybody.
contract LifeFuzzTest is Platform {
    function setUp() public {
        _setUpPlatform(false);
    }

    struct Placed {
        uint256 id;
        uint256 amount;
        address who;
    }

    /// @dev Place up to `n` random bids; the auction may refuse some (price at or under the clearing price, over the cap).
    function _randomBids(Sale memory s, uint256 seed, uint256 n)
        internal
        returns (Placed[] memory placed, uint256 count)
    {
        placed = new Placed[](n);
        uint256 at = s.startBlock;
        // how big the bids are for this sale: 300 up to 120,000 dollars at most, so small sales fall short and big ones overshoot
        uint256 scale =
            [uint256(300), 1500, 6000, 30_000, 120_000][uint256(keccak256(abi.encode(seed, "scale"))) % 5] * DOLLAR;
        vm.roll(at);
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            at += (r % 1500);
            if (at >= s.endBlock) at = s.endBlock - 1;
            vm.roll(at);
            address who = address(uint160(0x7000 + (r >> 8) % 12));
            uint256 amount = DOLLAR + (r >> 16) % scale;
            uint256 k = 1 + (r >> 80) % 300;
            _fund(who, amount, s);
            uint256 id = s.auction.nextBidId();
            vm.prank(who);
            (bool ok,) = address(s.auction)
                .call(abi.encodeCall(s.auction.submitBid, (_price(s, k), uint128(amount), who, s.floorQ96, bytes(""))));
            if (ok) placed[count++] = Placed(id, amount, who);
        }
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_everyDollarAndShareIsAccountedForOverTheWholeSale(uint256 seed, uint8 sizeSel, uint8 nBids)
        public
    {
        Launcher.Size size = Launcher.Size(sizeSel % 3);
        uint256 n = 1 + nBids % 10;
        Proj memory p = _launch(founder, keccak256(abi.encode("fuzz", seed)));
        Sale memory s = _open(p, size);
        (Placed[] memory placed, uint256 count) = _randomBids(s, seed, n);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        bool graduated = s.auction.isGraduated();
        uint256 raised = s.auction.currencyRaised();
        (, uint256 minimum) = launcher.sizeOf(size);
        assertEq(
            graduated,
            raised >= minimum || (raised + count >= minimum && raised >= minimum - count),
            "graduation follows the minimum"
        );

        // the three steps, called in a random order by strangers, some of them refused; then the natural order finishes it
        uint256 r = uint256(keccak256(abi.encode(seed, "order")));
        bytes4[3] memory sel = _selectors();
        for (uint256 i; i < 6; ++i) {
            vm.prank(address(uint160(0x9000 + i)));
            address(p.finisher).call(abi.encodeWithSelector(sel[(r >> (i * 8)) % 3]));
        }
        vm.startPrank(stranger);
        p.finisher.openPool();
        if (graduated) p.finisher.settle();
        p.finisher.sweep();
        vm.stopPrank();

        // everyone collects
        uint256 bid;
        uint256 refunds;
        uint256 claimed;
        for (uint256 i; i < count; ++i) {
            bid += placed[i].amount;
            (uint256 refund, uint256 got) = _collectBid(s, placed[i].id);
            refunds += refund;
            claimed += got;
        }
        uint256 dust = 2 * count + 4;
        assertApproxEqAbs(bid, (graduated ? raised : 0) + refunds, dust, "every dollar bid is the raise or a refund");

        if (!graduated) {
            assertEq(refunds, bid, "a sale under its minimum refunds every bidder in full, to the unit");
            assertEq(usd.balanceOf(platform), 0);
            assertEq(usd.balanceOf(poolManager), 0);
            assertEq(usd.balanceOf(address(p.treasury)), 0);
            assertEq(
                p.shares.balanceOf(address(p.finisher)), 500_000_000 * SHARE, "all 500M Shares are back for a new try"
            );
            assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Failed));
            assertFalse(p.treasury.poolOpen());
        } else {
            uint256 fee = raised * 30_000 / 1_000_000;
            uint256 net = raised - fee;
            uint256 budget = net * SaleParams.POOL_RATE / SaleParams.RATE_SCALE;
            uint256 inPool = usd.balanceOf(poolManager);
            assertEq(usd.balanceOf(platform), fee, "3");
            assertLe(inPool, budget, "the pool takes no more than 22 of every 100");
            assertGe(inPool + 1000, budget, "and nearly exactly that");
            uint256 arrived = p.treasury.spendable() + p.treasury.melting();
            assertEq(fee + inPool + arrived, raised, "3 + 22 + 75 is every dollar raised");
            assertEq(p.treasury.spendable(), arrived * 15 / 75, "15 of the 75");
            assertEq(usd.balanceOf(address(p.finisher)), 0, "the Finisher keeps nothing");
            assertEq(usd.balanceOf(strategy), 0);
            assertEq(usd.balanceOf(address(p.treasury)), arrived, "the Treasury holds exactly its buckets");
            assertEq(usd.balanceOf(founder), 0, "the founder never held a dollar");
            assertTrue(p.treasury.saleClosed());
            assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Done));
            assertApproxEqAbs(p.treasury.melting(), raised * 60 / 100, raised / 1_000_000 + 4, "60");
        }
        // every Share is somewhere
        uint256 total = claimed + p.shares.balanceOf(address(p.finisher)) + p.shares.balanceOf(address(p.treasury))
            + p.shares.balanceOf(address(p.vester)) + p.shares.balanceOf(poolManager) + p.shares.balanceOf(strategy)
            + p.shares.balanceOf(address(s.auction)) + p.shares.balanceOf(address(holder));
        assertEq(total, SUPPLY, "all 1,000,000,000 Shares are accounted for");
        assertLe(p.shares.balanceOf(address(s.auction)), 1e9, "at most dust is left in the auction");
        assertEq(p.shares.balanceOf(strategy), 0);
    }

    /// @dev How often the random sales reach each state, over 90 seeds taken in order: the fuzz test is worth what it reaches.
    function test_fuzzReach_bothGraduatedAndFailedSalesAndAllSizesAreReached() public {
        uint256[3] memory bySize;
        uint256 graduated;
        uint256 refused;
        uint256 placedTotal;
        uint256 attempted;
        uint256 snap = vm.snapshotState();
        for (uint256 seed; seed < 90; ++seed) {
            vm.revertToState(snap);
            Launcher.Size size = Launcher.Size(seed % 3);
            uint256 n = 1 + (seed * 7) % 10;
            Proj memory p = _launch(founder, keccak256(abi.encode("reach", seed)));
            Sale memory s = _open(p, size);
            (, uint256 count) = _randomBids(s, seed, n);
            attempted += n;
            placedTotal += count;
            refused += n - count;
            _toEnd(s);
            bySize[uint256(size)]++;
            if (s.auction.isGraduated()) graduated++;
        }
        emit log_named_uint("fuzz reach: sales", 90);
        emit log_named_uint("fuzz reach: graduated", graduated);
        emit log_named_uint("fuzz reach: failed (under the minimum)", 90 - graduated);
        emit log_named_uint("fuzz reach: bids attempted", attempted);
        emit log_named_uint("fuzz reach: bids the auction refused (price rules)", refused);
        assertGt(graduated, 15);
        assertGt(90 - graduated, 15);
        assertGt(refused, 30);
        assertEq(bySize[0] + bySize[1] + bySize[2], 90);
    }
}
