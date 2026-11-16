// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ILBPInitializer} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {AuctionParameters} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol";
import {IContinuousClearingAuction} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol";
import {ITickStorage} from "continuous-clearing-auction/src/interfaces/ITickStorage.sol";
import {MaxBidPriceLib} from "continuous-clearing-auction/src/libraries/MaxBidPriceLib.sol";
import {ConstantsLib} from "continuous-clearing-auction/src/libraries/ConstantsLib.sol";
import {SaleBase} from "./helpers/SaleBase.sol";
import {IAuctionSweeps} from "./mocks/MockTreasury.sol";

/// @notice Step 6 of milestone 1: gas of each step of the route, and the limits of the price grid for a 6-decimal dollar
/// against an 18-decimal Share with 1,000,000,000 supply. Numbers are printed with `-vv`; the assertions pin the ones
/// the plan relies on.
abstract contract MeasureBase is SaleBase {
    uint256 internal constant DOLLAR = 1e6;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal trader = makeAddr("trader");

    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        if (!_setUpStack(_fork())) return;
        _deployTokens(true);
        _deployInfra(_defaultConfig());
    }

    // ===================================================== gas ====================================================

    function test_gas_everyStepOfTheRoute() public {
        Sale memory s = _openSale(_standard());
        emit log_named_uint("gas open a sale: strategy.initializeDistribution (auction + strategy state)", s.gasOpen);

        vm.roll(s.startBlock);
        // first bid of the sale, at a new tick, hint = floor
        _bid(s, alice, 6000 * DOLLAR, 100);
        emit log_named_uint("gas bid #1 (new tick at 2x... first bid of the sale)", lastBidGas);
        vm.roll(s.startBlock + 100);
        _bid(s, bob, 5000 * DOLLAR, 150);
        emit log_named_uint("gas bid #2 (new tick, floor hint, later block)", lastBidGas);
        // a bid at a tick that already exists, same block as another bid (no new checkpoint)
        address carol = makeAddr("carol");
        _bid(s, carol, 1000 * DOLLAR, 150);
        emit log_named_uint("gas bid #3 (existing tick, same block)", lastBidGas);
        vm.roll(s.startBlock + 3000);
        address dave = makeAddr("dave");
        _bid(s, dave, 2000 * DOLLAR, 300);
        emit log_named_uint("gas bid #4 (new tick at 4x, floor hint, later block)", lastBidGas);

        vm.roll(s.endBlock);
        uint256 g = gasleft();
        s.auction.checkpoint();
        emit log_named_uint("gas final checkpoint (first call after the end)", g - gasleft());

        vm.roll(s.endBlock + 1);
        vm.prank(stranger);
        g = gasleft();
        strategy.migrate(ILBPInitializer(address(s.auction)));
        emit log_named_uint("gas pool step: strategy.migrate (sweep, fee, create pool, mint position)", g - gasleft());

        g = gasleft();
        treasury.settle(quote, strategy, ILBPInitializer(address(s.auction)));
        emit log_named_uint("gas settle (split new money into buckets, stand-in treasury)", g - gasleft());
        g = gasleft();
        treasury.sweepUnsold(IAuctionSweeps(address(s.auction)));
        emit log_named_uint("gas sweep unsold Shares (stand-in treasury calls the auction)", g - gasleft());

        g = gasleft();
        s.auction.exitBid(0);
        emit log_named_uint("gas exitBid (bid above the final price)", g - gasleft());
        g = gasleft();
        s.auction.claimTokens(0);
        emit log_named_uint("gas claimTokens", g - gasleft());

        quote.mint(trader, 100 * DOLLAR);
        g = gasleft();
        _swap(s.key, trader, true, 100 * DOLLAR);
        emit log_named_uint("gas trade: buy through v4's test swap router (includes approve)", g - gasleft());
        uint256 shares = share.balanceOf(trader);
        g = gasleft();
        _swap(s.key, trader, false, shares);
        emit log_named_uint("gas trade: sell back (includes approve)", g - gasleft());
    }

    /// @notice The extra cost of a far-away tick: a bid at 4x the floor with the floor as the hint walks every tick in
    /// between, a correct hint does not.
    function test_gas_bidHintMatters() public {
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        for (uint256 k = 10; k <= 250; k += 10) {
            _bid(s, makeAddr(string.concat("b", vm.toString(k))), 2 * DOLLAR, k);
        }
        address far = makeAddr("far");
        _fund(far, 10 * DOLLAR, s);
        uint256 hintPrice = _price(s, 250);
        uint256 before = vm.snapshotState();
        vm.prank(far);
        uint256 g = gasleft();
        s.auction.submitBid(_price(s, 300), uint128(5 * DOLLAR), far, s.floorQ96, "");
        uint256 withFloorHint = g - gasleft();
        vm.revertToState(before);
        vm.prank(far);
        g = gasleft();
        s.auction.submitBid(_price(s, 300), uint128(5 * DOLLAR), far, hintPrice, "");
        uint256 withGoodHint = g - gasleft();
        emit log_named_uint("gas bid at 4x with 25 ticks below, floor hint", withFloorHint);
        emit log_named_uint("gas bid at 4x with 25 ticks below, hint = nearest tick below", withGoodHint);
        assertLt(withGoodHint, withFloorHint, "a good hint is cheaper");
    }

    // ===================================================== price limits ===========================================

    /// @dev Dollars per Share (as a number with 18 decimals) for a Q96 price of raw dollars per raw Share.
    function _dollarsPerShareE18(uint256 priceQ96) internal pure returns (uint256) {
        // price_raw = priceQ96 / 2^96 (6-decimal dollar units per 18-decimal Share unit)
        // dollars per Share = price_raw * 1e18 / 1e6
        return priceQ96 * 1e12 * 1e18 / (1 << 96);
    }

    function test_limits_theSmallestAndLargestFloorPrice() public {
        uint256 minFloor = ConstantsLib.MIN_FLOOR_PRICE;
        uint256 maxBid = MaxBidPriceLib.maxBidPrice(uint128(SALE_SHARES));
        emit log_named_uint("smallest floor price, Q96 (2^32+1)", minFloor);
        emit log_named_decimal_uint("smallest floor price in dollars per Share", _dollarsPerShareE18(minFloor), 18);
        emit log_named_decimal_uint(
            "  the 1,000,000,000 Shares are then worth (dollars)", _dollarsPerShareE18(minFloor) * 1e9, 18
        );
        emit log_named_uint("largest top price the auction accepts for 400M Shares, Q96", maxBid);
        emit log_named_decimal_uint("largest top price in dollars per Share", _dollarsPerShareE18(maxBid), 18);
        // The smallest sale a 400M-Share sale can be: goal = floor * 400M Shares.
        uint256 minGoalRaw = (minFloor * SALE_SHARES) >> 96;
        emit log_named_decimal_uint("smallest goal for a 400M-Share sale at the minimum floor (dollars)", minGoalRaw, 6);
        assertGt(minGoalRaw, 21 * DOLLAR, "about 21.7 dollars");
        assertLt(minGoalRaw, 22 * DOLLAR, "about 21.7 dollars");

        // The auction itself enforces the lower bound and the "one tick above the floor" rule.
        AuctionParameters memory p = _auctionParams(_standard(), uint64(block.number + 1), minFloor - 1, 641);
        p.requiredCurrencyRaised = 1;
        vm.expectRevert(ITickStorage.FloorPriceTooLow.selector);
        factory.create(address(share), SALE_SHARES, abi.encode(p), bytes32(0));
        p.floorPrice = minFloor; // 2^32 + 1 = 641 x 6,700,417: the tick must divide the floor
        p.tickSpacing = 641;
        factory.create(address(share), SALE_SHARES, abi.encode(p), bytes32(uint256(1)));
        p.tickSpacing = 1;
        vm.expectRevert(ITickStorage.TickSpacingTooSmall.selector);
        factory.create(address(share), SALE_SHARES, abi.encode(p), bytes32(uint256(2)));
        p.tickSpacing = 641;
        p.floorPrice = maxBid; // at the maximum there is no room for even one tick above
        p.floorPrice = (maxBid / 641) * 641;
        vm.expectRevert();
        factory.create(address(share), SALE_SHARES, abi.encode(p), bytes32(uint256(3)));
    }

    function test_limits_theTickGridOfAStandardSale() public {
        Sale memory s = _openSale(_standard());
        emit log_named_uint("floor price, Q96", s.floorQ96);
        emit log_named_decimal_uint("floor price in dollars per Share", _dollarsPerShareE18(s.floorQ96), 18);
        emit log_named_uint("tick spacing, Q96 (1 percent of the floor)", s.tickQ96);
        emit log_named_decimal_uint("tick in dollars per Share", _dollarsPerShareE18(s.tickQ96), 18);
        emit log_named_decimal_uint("4x top price in dollars per Share", _dollarsPerShareE18(_price(s, 300)), 18);
        assertEq(s.floorQ96 % s.tickQ96, 0, "floor is a tick");
        assertEq(
            s.floorQ96 / s.tickQ96, 100, "floor is tick number 100: top prices run in steps of 1 percent of the floor"
        );
        // 10,000 dollars at the floor: the auction sells 400M Shares for the goal
        assertApproxEqAbs((s.floorQ96 * SALE_SHARES) >> 96, 10_000 * DOLLAR, 2, "floor x 400M Shares = the goal");
    }

    struct Row {
        uint128 goal;
        bool ok;
        bool graduated;
        bool poolOpen;
        uint256 finalPrice;
        uint256 raised;
        uint256 poolDollars;
    }

    /// @notice A sweep over sale sizes: does the whole route (sale, pool step) work at each? One bidder bids 1.5x the goal
    /// at up to 4x the floor. The pool step failing would be swallowed by the strategy, so the pool is read directly.
    function test_limits_theRouteWorksAcrossSaleSizes() public {
        uint128[8] memory goals = [
            uint128(22 * DOLLAR), // just above the smallest possible sale
            100 * uint128(DOLLAR),
            1000 * uint128(DOLLAR),
            10_000 * uint128(DOLLAR),
            1_000_000 * uint128(DOLLAR),
            1_000_000_000 * uint128(DOLLAR),
            1_000_000_000_000 * uint128(DOLLAR),
            1_000_000_000_000_000 * uint128(DOLLAR)
        ];
        Row[8] memory rows;
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < goals.length; ++i) {
            rows[i] = _runSize(goals[i]);
            vm.revertToState(snap);
        }
        for (uint256 i; i < goals.length; ++i) {
            emit log_named_decimal_uint(
                rows[i].poolOpen ? "goal (dollars): pool OPEN" : "goal (dollars): pool NOT open", rows[i].goal, 6
            );
            emit log_named_decimal_uint(
                "   final price, dollars per Share", _dollarsPerShareE18(rows[i].finalPrice), 18
            );
            emit log_named_decimal_uint("   dollars in the pool", rows[i].poolDollars, 6);
        }
        for (uint256 i; i < 7; ++i) {
            assertTrue(rows[i].poolOpen, "the pool opens for goals from 22 dollars to a trillion");
        }
    }

    function _runSize(uint128 goal) internal returns (Row memory r) {
        r.goal = goal;
        Size memory size = Size({goal: goal, minimum: goal / 4});
        Sale memory s = _openSale(size);
        vm.roll(s.startBlock);
        uint256 amount = uint256(goal) * 3 / 2;
        // the hook allows no bid under 1 dollar; for the tiny sale a 1.5x goal bid is still above 1 dollar
        _bid(s, alice, amount < DOLLAR ? DOLLAR : amount, 100);
        _toEnd(s);
        r.graduated = s.auction.isGraduated();
        r.raised = s.auction.currencyRaised();
        r.finalPrice = s.auction.clearingPrice();
        vm.roll(s.endBlock + 1);
        treasury.openPool(strategy, ILBPInitializer(address(s.auction)));
        r.poolOpen = treasury.poolIsOpen(strategy, ILBPInitializer(address(s.auction)));
        r.poolDollars = quote.balanceOf(address(poolManager));
        r.ok = r.graduated && r.poolOpen;
    }
}

contract MeasureLocalTest is MeasureBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract MeasureForkTest is MeasureBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}
