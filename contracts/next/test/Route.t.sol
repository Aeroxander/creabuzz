// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ILBPStrategy} from "liquidity-launcher/src/interfaces/ILBPStrategy.sol";
import {ILBPInitializer} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {Bid} from "continuous-clearing-auction/src/libraries/BidLib.sol";
import {SaleBase} from "./helpers/SaleBase.sol";
import {IAuctionSweeps} from "./mocks/MockTreasury.sol";

/// @notice Step 4 of milestone 1: the whole route with the plan's numbers, one assertion on exact balances at each
/// step. Same code runs four ways: the local twin and the Sepolia fork, each with the dollar sorted before the Share
/// (currency0) and after it (currency1), because the pool price is converted differently in the two orders.
abstract contract RouteBase is SaleBase {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant DOLLAR = 1e6;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal erin = makeAddr("erin");
    address internal trader = makeAddr("trader");

    function _fork() internal pure virtual returns (bool);
    function _quoteIsCurrency0() internal pure virtual returns (bool);

    function setUp() public virtual {
        if (!_setUpStack(_fork())) return;
        _deployTokens(_quoteIsCurrency0());
        _deployInfra(_defaultConfig());
    }

    struct Bids {
        uint256 erinId;
        uint256 daveId;
        uint256 carolId;
        uint256 bobId;
        uint256 aliceId;
        uint256 total;
    }

    /// @dev Five bidders, 32,000 dollars of demand for a 10,000-dollar sale: a low early bid that ends up outbid, and
    /// bids at 1.2x, 1.5x, 3x and 4x the floor price. Bids come in at different blocks across the 24 hours.
    function _placeBids(Sale memory s) internal returns (Bids memory b) {
        vm.roll(s.startBlock);
        b.erinId = _bid(s, erin, 2000 * DOLLAR, 1); // 2,000 dollars, top price 1.01x floor
        vm.roll(s.startBlock + 500);
        b.daveId = _bid(s, dave, 3000 * DOLLAR, 20); // 1.2x
        vm.roll(s.startBlock + 2000);
        b.carolId = _bid(s, carol, 12_000 * DOLLAR, 150); // 2.5x
        vm.roll(s.startBlock + 4000);
        b.bobId = _bid(s, bob, 9000 * DOLLAR, 200); // 3x
        vm.roll(s.startBlock + 6000);
        b.aliceId = _bid(s, alice, 6000 * DOLLAR, 300); // 4x, the most the hook allows
        b.total = 32_000 * DOLLAR;
    }

    function _migrated(Vm.Log[] memory logs) internal view returns (bool migrated, bool failed) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(strategy)) continue;
            if (logs[i].topics[0] == ILBPStrategy.Migrated.selector) migrated = true;
            if (logs[i].topics[0] == ILBPStrategy.MigrationFailed.selector) failed = true;
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // The route
    // ------------------------------------------------------------------------------------------------------------

    function test_route_saleThenPoolThenTrade() public {
        // ---- open ---------------------------------------------------------------------------------------------
        Sale memory s = _openSale(_standard());
        assertEq(share.balanceOf(address(s.auction)), SALE_SHARES, "the auction holds the 40% for sale");
        assertEq(share.balanceOf(address(strategy)), POOL_RESERVE, "the strategy holds the 10% for the pool");
        assertEq(share.balanceOf(address(this)), SHARES - SALE_AND_RESERVE, "the opener keeps the other 50%");
        assertEq(s.auction.fundsRecipient(), address(strategy), "the strategy receives the raise");
        assertEq(s.auction.tokensRecipient(), address(treasury), "the treasury receives unsold Shares");
        assertEq(address(s.auction.validationHook()), address(minBid), "bid rules are set");
        assertEq(strategy.registeredPoolIds(s.key.toId()), address(s.auction), "the pool key is reserved");
        assertEq(_poolSqrtPrice(s.key), 0, "no pool yet");
        assertEq(uint160(address(feeController)) != 0 ? feeController.feePips() : 0, FEE_PIPS, "fee is fixed");

        // ---- bids -----------------------------------------------------------------------------------------------
        Bids memory b = _placeBids(s);
        assertEq(quote.balanceOf(address(s.auction)), b.total, "every dollar bid is held by the auction");

        // ---- the sale ends; a stranger finishes it --------------------------------------------------------------
        _toEnd(s);
        assertTrue(s.auction.isGraduated(), "raised more than the minimum");
        uint256 raised = s.auction.currencyRaised();
        assertGt(raised, 10_000 * DOLLAR, "demand lifted the price above the goal");
        uint256 fee = raised * FEE_PIPS / 1_000_000;
        uint256 net = raised - fee;
        uint256 budget = net * LP_RATE / 10_000_000; // what the pool may take
        uint256 finalPrice = s.auction.clearingPrice();
        assertGt(finalPrice, s.floorQ96, "price rose above the floor");

        uint256 positionId = positionManager.nextTokenId();
        vm.roll(s.endBlock + 1);
        vm.recordLogs();
        vm.prank(stranger);
        uint256 g = gasleft();
        bool ran = treasury.openPool(strategy, ILBPInitializer(address(s.auction)));
        emit log_named_uint("gas: pool step (openPool through migrate)", g - gasleft());
        assertTrue(ran, "the pool step ran");
        (bool migrated, bool failed) = _migrated(vm.getRecordedLogs());
        assertTrue(migrated, "event: Migrated");
        assertFalse(failed, "no MigrationFailed");

        // ---- exact balances after the pool step -------------------------------------------------------------------
        assertEq(quote.balanceOf(platform), fee, "platform got exactly 3% of the raise");
        uint256 poolQuote = quote.balanceOf(address(poolManager));
        uint256 toTreasury = quote.balanceOf(address(treasury));
        assertEq(
            poolQuote + toTreasury + fee, raised, "every raised dollar is in the pool, the treasury or the platform"
        );
        assertLe(poolQuote, budget, "the pool took no more than its 22 of every 100");
        assertGe(poolQuote + 1000, budget, "and nearly all of it (within a thousandth of a dollar)");
        assertEq(quote.balanceOf(address(strategy)), 0, "the strategy keeps no dollars");
        assertEq(share.balanceOf(address(strategy)), 0, "the strategy keeps no Shares");
        uint256 poolShares = share.balanceOf(address(poolManager));
        assertEq(
            poolShares + share.balanceOf(address(treasury)), POOL_RESERVE, "the 10% reserve is split pool / treasury"
        );
        // The pool opened at the final price: Shares in the pool are worth the dollars in the pool.
        assertApproxEqRel(poolShares * finalPrice >> 96, poolQuote, 1e12, "pool holds both sides at the final price");
        assertLt(poolShares, POOL_RESERVE, "fewer than the full 10% of Shares are needed at 22 of 100");
        assertEq(
            IERC721(address(positionManager)).ownerOf(positionId), holder, "the pool position is owned by the holder"
        );
        assertGt(_poolSqrtPrice(s.key), 0, "the pool exists");

        // ---- treasury steps 2 and 3 -------------------------------------------------------------------------------
        uint256 fresh = treasury.settle(quote);
        assertEq(fresh, toTreasury, "settle sees exactly what arrived");
        assertEq(treasury.spendable(), toTreasury * 15 / 75, "15 of 75 is spendable");
        assertEq(treasury.spendable() + treasury.floorMoney(), toTreasury, "buckets equal the balance");
        // Against the raise: 15 and 60 of every 100, to within the rounding of the pool step.
        assertApproxEqAbs(
            treasury.spendable(), raised * 15 / 100, raised / 10_000, "about 15 of every 100 is spendable"
        );
        assertApproxEqAbs(
            treasury.floorMoney(), raised * 60 / 100, raised / 10_000, "about 60 of every 100 is the floor"
        );
        assertApproxEqAbs(poolQuote, raised * 22 / 100, raised / 10_000, "about 22 of every 100 is in the pool");
        assertApproxEqAbs(fee, raised * 3 / 100, 1, "3 of every 100 is the fee");

        uint256 unsold = s.auction.remainingSupply();
        uint256 treasurySharesBefore = share.balanceOf(address(treasury));
        assertTrue(treasury.sweepUnsold(IAuctionSweeps(address(s.auction))), "the treasury collected unsold Shares");
        assertEq(share.balanceOf(address(treasury)), treasurySharesBefore + unsold, "unsold Shares arrived");
        // repeating a step is harmless
        assertFalse(treasury.sweepUnsold(IAuctionSweeps(address(s.auction))), "second sweep does nothing");
        assertFalse(treasury.openPool(strategy, ILBPInitializer(address(s.auction))), "second pool step does nothing");

        // ---- bidders collect ----------------------------------------------------------------------------------------
        uint256[5] memory ids = [b.erinId, b.daveId, b.carolId, b.bobId, b.aliceId];
        address[5] memory who = [erin, dave, carol, bob, alice];
        uint256 refunds;
        uint256 filled;
        for (uint256 i; i < 5; ++i) {
            uint256 dollarsBefore = quote.balanceOf(who[i]);
            _exit(s, ids[i]);
            refunds += quote.balanceOf(who[i]) - dollarsBefore;
            vm.prank(stranger); // anyone may collect for a bidder; the Shares go to the bidder
            s.auction.claimTokens(ids[i]);
            filled += share.balanceOf(who[i]);
        }
        // The early low bid was filled while the price was low, then outbid: some Shares, and the unspent rest refunded.
        assertGt(share.balanceOf(erin), 0, "the early low bid bought some Shares before it was outbid");
        assertGt(quote.balanceOf(erin), 0, "and got the unspent dollars back");
        assertLt(quote.balanceOf(erin), 2000 * DOLLAR, "but not all of them");
        assertGt(share.balanceOf(alice), 0, "the top bidder got Shares");
        assertApproxEqAbs(b.total, raised + refunds, 10, "dollars bid = dollars raised + dollars refunded");
        assertApproxEqAbs(filled, s.auction.totalCleared(), 10, "Shares claimed = Shares sold");
        assertLe(s.auction.totalCleared(), SALE_SHARES, "never more than the 40% for sale");
        // Every Share of the 1,000,000,000 is somewhere.
        uint256 accounted = filled + poolShares + share.balanceOf(address(treasury)) + share.balanceOf(address(this))
            + share.balanceOf(address(s.auction));
        assertEq(accounted, SHARES, "all 1,000,000,000 Shares are accounted for");
        assertLe(share.balanceOf(address(s.auction)), 1e9, "at most dust is left in the auction");

        // ---- a trade through the new pool -------------------------------------------------------------------------------
        quote.mint(trader, 100 * DOLLAR);
        uint256 poolQuoteBefore = quote.balanceOf(address(poolManager));
        uint256 poolSharesBefore = share.balanceOf(address(poolManager));
        (uint256 paid, uint256 got) = _swap(s.key, trader, true, 100 * DOLLAR);
        assertEq(paid, 100 * DOLLAR, "the trader paid exactly 100 dollars");
        assertGt(got, 0, "and got Shares");
        assertEq(share.balanceOf(trader), got, "Shares arrived with the trader");
        assertEq(quote.balanceOf(address(poolManager)), poolQuoteBefore + paid, "the pool took the dollars");
        assertEq(share.balanceOf(address(poolManager)), poolSharesBefore - got, "the pool gave the Shares");
        // 100 dollars buy about 100 / price Shares less the 1% fee and the price move through a small pool.
        uint256 shareValueAtFinal = got * finalPrice >> 96;
        assertGt(shareValueAtFinal * 100, paid * 90, "within 10% of the auction's final price (small pool)");
        assertLt(shareValueAtFinal, paid, "and the trader paid more than the Shares were worth at the final price");
        (uint256 paidBack, uint256 gotBack) = _swap(s.key, trader, false, got);
        assertEq(paidBack, got, "selling back");
        assertGt(gotBack, 90 * DOLLAR * 90 / 100, "most of the dollars come back");
        assertLt(gotBack, paid, "minus fees both ways");
    }

    function test_route_gasNumbers() public {
        Sale memory s = _openSale(_standard());
        emit log_named_uint("gas: open a sale (initializeDistribution: auction + strategy)", s.gasOpen);
        Bids memory b = _placeBids(s);
        b; // silence
        emit log_named_uint("gas: last bid (the 4x bid, new tick)", lastBidGas);
        _toEnd(s);
        uint256 g = gasleft();
        s.auction.checkpoint();
        emit log_named_uint("gas: checkpoint at the end block (already done: cheap)", g - gasleft());
    }
}

contract RouteLocalQuote0Test is RouteBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract RouteLocalQuote1Test is RouteBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

contract RouteForkQuote0Test is RouteBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract RouteForkQuote1Test is RouteBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }

    function _quoteIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
