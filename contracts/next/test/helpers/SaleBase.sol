// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ContinuousClearingAuction} from "continuous-clearing-auction/src/ContinuousClearingAuction.sol";
import {ContinuousClearingAuctionFactory} from "continuous-clearing-auction/src/ContinuousClearingAuctionFactory.sol";
import {AuctionParameters} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol";
import {Checkpoint} from "continuous-clearing-auction/src/libraries/CheckpointLib.sol";
import {Bid} from "continuous-clearing-auction/src/libraries/BidLib.sol";
import {IDistributorFactory} from "liquidity-launcher/src/interfaces/IDistributorFactory.sol";
import {LBPStrategy} from "liquidity-launcher/src/strategies/lbp/LBPStrategy.sol";
import {ILBPStrategy} from "liquidity-launcher/src/interfaces/ILBPStrategy.sol";
import {
    MigratorParameters,
    PoolParameters,
    LiquidityAllocationBracket
} from "liquidity-launcher/src/libraries/MigratorParams.sol";
import {PositionDefinition} from "liquidity-launcher/src/types/PositionPlannerTypes.sol";
import {Stack} from "./Stack.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockTreasury} from "../mocks/MockTreasury.sol";
import {FixedFeeController} from "../../src/FixedFeeController.sol";
import {MinBid} from "../../src/MinBid.sol";
import {PoolGuard} from "../../src/PoolGuard.sol";

/// @notice Everything a sale test needs on top of the Uniswap stack: a 6-decimal dollar, a 1,000,000,000 Share token
/// (18 decimals), our fee controller, auction factory, strategy, pool guard and bid hook, a stand-in treasury, and
/// helpers to open a sale with the plan's parameters, place bids, exit, claim and trade.
abstract contract SaleBase is Stack {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using BalanceDeltaLibrary for BalanceDelta;

    // ---- the plan's numbers (section 3 and 4) ------------------------------------------------------------------
    uint256 internal constant SHARES = 1_000_000_000e18;
    uint256 internal constant SALE_SHARES = 400_000_000e18; // 40 percent
    uint128 internal constant POOL_RESERVE = 100_000_000e18; // 10 percent held back for the pool
    uint256 internal constant SALE_AND_RESERVE = SALE_SHARES + POOL_RESERVE;
    uint24 internal constant FEE_PIPS = 30_000; // 3 percent of the raise, to the platform
    uint24 internal constant LP_RATE = 2_268_041; // 22 / 97 of the post-fee raise, in 1e-7: 22 of every 100 raised
    uint24 internal constant POOL_FEE = 10_000; // 1 percent trading fee
    int24 internal constant POOL_TICK_SPACING = 200;
    uint128 internal constant ONE_DOLLAR = 1e6;
    uint64 internal constant SALE_BLOCKS = 7200; // 24 hours at 12 seconds
    uint256 internal constant TOP_PRICE_MULTIPLE = 4;

    // ---- the actors ---------------------------------------------------------------------------------------------
    address internal platform = makeAddr("platform");
    address internal holder = makeAddr("liquidityHolder"); // owns the pool position NFTs
    address internal stranger = makeAddr("stranger");
    MockTreasury internal treasury;

    // ---- the tokens and our contracts ---------------------------------------------------------------------------
    MockERC20 internal quote; // 6-decimal dollar
    MockERC20 internal share; // 18-decimal Share, 1,000,000,000 supply
    FixedFeeController internal feeController;
    ContinuousClearingAuctionFactory internal factory;
    LBPStrategy internal strategy;
    PoolGuard internal guard;
    MinBid internal minBid;
    uint256 internal lastBidGas; // gas of the most recent `submitBid`

    struct Config {
        bool useGuard; // put PoolGuard in the pool key
        uint24 feePips;
        uint128 minBid; // raw dollar units
        uint256 topPriceMultiple; // 0 = no check
    }

    struct Size {
        uint128 goal; // raw dollars: what selling every sale Share at the floor price raises
        uint128 minimum; // raw dollars: below this the sale fails and everyone is refunded
    }

    struct Sale {
        ContinuousClearingAuction auction;
        uint64 startBlock;
        uint64 endBlock;
        uint256 floorQ96;
        uint256 tickQ96;
        PoolKey key;
        uint256 gasOpen; // gas of the single `initializeDistribution` call that opens the sale
    }

    function _defaultConfig() internal pure returns (Config memory) {
        return Config({useGuard: true, feePips: FEE_PIPS, minBid: ONE_DOLLAR, topPriceMultiple: TOP_PRICE_MULTIPLE});
    }

    function _standard() internal pure returns (Size memory) {
        return Size({goal: 10_000e6, minimum: 2500e6});
    }

    /// @dev Tokens are plain test tokens; the order of their addresses matters to v4 (currency0 is the smaller), and
    /// the price conversion has a branch for each order, so a test chooses the order it wants.
    function _deployTokens(bool quoteIsCurrency0) internal {
        quote = new MockERC20("Test Dollar", "tUSD", 6);
        for (uint256 i; i < 64; ++i) {
            share = new MockERC20("Test Share", "SHARE", 18);
            if ((address(quote) < address(share)) == quoteIsCurrency0) return;
        }
        revert("could not order the tokens");
    }

    function _deployInfra(Config memory c) internal {
        treasury = new MockTreasury();
        feeController = new FixedFeeController(platform, c.feePips);
        factory = ContinuousClearingAuctionFactory(deployer.auctionFactory(address(feeController)));
        strategy = _deployStrategy(address(factory));
        if (c.useGuard) guard = _deployGuard(address(strategy));
        minBid = new MinBid(c.minBid, c.topPriceMultiple, 0);
    }

    // ---- opening a sale -------------------------------------------------------------------------------------------

    /// @dev Price in the auction's units: raw dollars per raw Share, times 2^96. The floor is the price at which
    /// selling all `SALE_SHARES` raises `goal`, rounded up to a multiple of the tick; the tick is 1/100 of the floor,
    /// so the floor is tick number 100.
    function _floorAndTick(uint128 goal) internal pure returns (uint256 floorQ96, uint256 tickQ96) {
        uint256 exact = (uint256(goal) << 96) / SALE_SHARES;
        tickQ96 = (exact + 99) / 100;
        floorQ96 = tickQ96 * 100;
    }

    /// @dev 7,200 blocks: 7,100 at 1,388 mps, then 100 at 1,452 mps. mps are ten-millionths of the supply per block;
    /// 1,388 x 7,100 + 1,452 x 100 = 10,000,000 exactly, which the auction requires.
    function _steps() internal pure returns (bytes memory) {
        return abi.encodePacked(bytes8(uint64(1388) << 40 | uint64(7100)), bytes8(uint64(1452) << 40 | uint64(100)));
    }

    function _poolKey(address hook) internal view returns (PoolKey memory key) {
        bool quoteFirst = address(quote) < address(share);
        key = PoolKey({
            currency0: Currency.wrap(quoteFirst ? address(quote) : address(share)),
            currency1: Currency.wrap(quoteFirst ? address(share) : address(quote)),
            fee: POOL_FEE,
            tickSpacing: POOL_TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    function _auctionParams(Size memory size, uint64 startBlock, uint256 floorQ96, uint256 tickQ96)
        internal
        view
        returns (AuctionParameters memory)
    {
        return AuctionParameters({
            currency: address(quote),
            tokensRecipient: address(treasury),
            fundsRecipient: address(strategy),
            startBlock: startBlock,
            endBlock: startBlock + SALE_BLOCKS,
            claimBlock: startBlock + SALE_BLOCKS + 1,
            tickSpacing: tickQ96,
            validationHook: address(minBid),
            floorPrice: floorQ96,
            requiredCurrencyRaised: size.minimum,
            auctionStepsData: _steps()
        });
    }

    function _migratorParams(uint64 endBlock, address hook) internal view returns (MigratorParameters memory) {
        LiquidityAllocationBracket[] memory brackets = new LiquidityAllocationBracket[](1);
        brackets[0] = LiquidityAllocationBracket({lowerThreshold: 0, rate: LP_RATE});
        return MigratorParameters({
            token: address(share),
            currency: address(quote),
            migrationBlock: endBlock + 1,
            reservedTokenAmountForLP: POOL_RESERVE,
            recipient: address(treasury),
            positionRecipient: holder,
            poolParameters: PoolParameters({fee: POOL_FEE, tickSpacing: POOL_TICK_SPACING, hook: hook}),
            positionDefinitions: abi.encode(new PositionDefinition[](0)),
            lpAllocationSchedule: abi.encode(brackets)
        });
    }

    /// @dev Opens a sale the way the Launcher will: this test contract holds the Shares, approves the strategy and
    /// calls `initializeDistribution`. Mints the whole 1,000,000,000 to this contract; only sale + pool reserve move.
    function _openSale(Size memory size) internal returns (Sale memory s) {
        share.mint(address(this), SHARES);
        share.approve(address(strategy), SALE_AND_RESERVE);

        s.startBlock = uint64(block.number + 1);
        s.endBlock = s.startBlock + SALE_BLOCKS;
        (s.floorQ96, s.tickQ96) = _floorAndTick(size.goal);
        address hook = address(guard); // zero when the config has no guard
        s.key = _poolKey(hook);

        bytes memory configData = abi.encode(
            _migratorParams(s.endBlock, hook), abi.encode(_auctionParams(size, s.startBlock, s.floorQ96, s.tickQ96))
        );

        vm.recordLogs();
        uint256 g = gasleft();
        strategy.initializeDistribution(address(share), SALE_AND_RESERVE, configData, bytes32(0));
        s.gasOpen = g - gasleft();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 created = ILBPStrategy.InitializerCreated.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(strategy) && logs[i].topics[0] == created) {
                s.auction = ContinuousClearingAuction(address(uint160(uint256(logs[i].topics[1]))));
            }
        }
        require(address(s.auction) != address(0), "no auction created");
    }

    // ---- bidding ---------------------------------------------------------------------------------------------------

    /// @dev Top price `k` ticks above the floor (the floor is tick 100, so 4 times the floor is `k = 300`).
    function _price(Sale memory s, uint256 k) internal pure returns (uint256) {
        return s.floorQ96 + k * s.tickQ96;
    }

    function _fund(address who, uint256 amount, Sale memory s) internal {
        quote.mint(who, amount);
        vm.startPrank(who);
        quote.approve(PERMIT2, type(uint256).max);
        permit2.approve(address(quote), address(s.auction), uint160(amount), type(uint48).max);
        vm.stopPrank();
    }

    /// @dev Funds `who` and places a bid of `amount` raw dollars with a top price `k` ticks above the floor.
    function _bid(Sale memory s, address who, uint256 amount, uint256 k) internal returns (uint256 bidId) {
        _fund(who, amount, s);
        bidId = s.auction.nextBidId();
        vm.prank(who);
        uint256 g = gasleft();
        s.auction.submitBid(_price(s, k), uint128(amount), who, s.floorQ96, "");
        lastBidGas = g - gasleft();
    }

    // ---- ending, exiting, claiming -------------------------------------------------------------------------------

    function _toEnd(Sale memory s) internal {
        vm.roll(s.endBlock);
        s.auction.checkpoint();
    }

    /// @dev Exit one bid with the right call and hints, found by walking the auction's checkpoint list.
    function _exit(Sale memory s, uint256 bidId) internal {
        Bid memory b = s.auction.bids(bidId);
        uint256 finalPrice = s.auction.checkpoints(s.auction.lastCheckpointedBlock()).clearingPrice;
        if (!s.auction.isGraduated() || b.maxPrice > finalPrice) {
            s.auction.exitBid(bidId); // a failed sale refunds in full; a bid above the final price is filled in full
            return;
        }
        uint64 blk = b.startBlock;
        uint64 lastFull = blk;
        uint64 outbid = 0;
        while (blk != type(uint64).max) {
            Checkpoint memory c = s.auction.checkpoints(blk);
            if (c.clearingPrice < b.maxPrice) {
                lastFull = blk;
            } else if (c.clearingPrice > b.maxPrice) {
                outbid = blk;
                break;
            }
            blk = c.next;
        }
        s.auction.exitPartiallyFilledBid(bidId, lastFull, outbid);
    }

    // ---- trading -----------------------------------------------------------------------------------------------------

    /// @dev Exact-input swap through v4's test swap router. `quoteIn` true spends dollars to get Shares. Returns what
    /// `who` paid and received (both positive).
    function _swap(PoolKey memory key, address who, bool quoteIn, uint256 amountIn)
        internal
        returns (uint256 paid, uint256 received)
    {
        bool zeroForOne = quoteIn == (address(quote) < address(share));
        MockERC20 tokenIn = quoteIn ? quote : share;
        vm.startPrank(who);
        tokenIn.approve(address(swapTest), type(uint256).max);
        BalanceDelta d = swapTest.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        int128 in_ = zeroForOne ? d.amount0() : d.amount1();
        int128 out = zeroForOne ? d.amount1() : d.amount0();
        paid = uint256(uint128(-in_));
        received = uint256(uint128(out));
    }

    function _poolSqrtPrice(PoolKey memory key) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
    }
}
