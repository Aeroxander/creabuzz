// SPDX-License-Identifier: MIT
pragma solidity >=0.8.26;

// Pinned interfaces: our fixed view of the vendored Uniswap pieces (the pool strategy, the auction, the pool manager
// and the position manager). First-party code (compiled with 0.8.37 and 200 optimizer runs) never imports the vendored
// source, which is held to its own compiler pin (0.8.26, 11,111 runs). It talks to it only through the small interfaces
// and struct copies in this file, and `test/PinnedDrift.t.sol` fails if the vendored code stops matching them (selectors,
// struct encodings, storage layout of the pool manager, action numbers, and a hash of each vendored contract's creation
// code). Everything here is a copy of something upstream, with the upstream file named beside it.
//
// The pragma is `>=0.8.26` so that both the 0.8.37 sources and the 0.8.26 drift test can import this one file.

/// @notice Copy of `PoolKey` (v4-core `types/PoolKey.sol`); `Currency` and `IHooks` are addresses on the wire.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice Copy of `PoolParameters` (liquidity-launcher `libraries/MigratorParams.sol`).
struct PoolParameters {
    uint24 fee;
    int24 tickSpacing;
    address hook;
}

/// @notice Copy of `MigratorParameters` (liquidity-launcher `libraries/MigratorParams.sol`): the strategy's settings of
/// one sale.
struct MigratorParameters {
    address token;
    address currency;
    uint64 migrationBlock;
    uint128 reservedTokenAmountForLP;
    address recipient;
    address positionRecipient;
    PoolParameters poolParameters;
    bytes positionDefinitions;
    bytes lpAllocationSchedule;
}

/// @notice Copy of `LiquidityAllocationBracket` (same file): one bracket of the share of the raise that goes to the pool.
struct LiquidityAllocationBracket {
    uint128 lowerThreshold;
    uint24 rate;
}

/// @notice Copy of `AuctionParameters` (continuous-clearing-auction `interfaces/IContinuousClearingAuction.sol`).
struct AuctionParameters {
    address currency;
    address tokensRecipient;
    address fundsRecipient;
    uint64 startBlock;
    uint64 endBlock;
    uint64 claimBlock;
    uint256 tickSpacing;
    address validationHook;
    uint256 floorPrice;
    uint128 requiredCurrencyRaised;
    bytes auctionStepsData;
}

/// @notice What the auction reports once a sale is over (copy of `LBPInitializationParams`).
struct LBPInitializationParams {
    uint256 initialPriceX96;
    uint256 tokensSold;
    uint256 currencyRaised;
}

/// @notice The strategy functions this code calls (liquidity-launcher `strategies/lbp/LBPStrategy.sol`).
interface IPinnedStrategy {
    /// @notice Open a sale: builds the auction, takes the Shares from the caller, reserves the pool.
    function initializeDistribution(address token, uint256 totalSupply, bytes calldata configData, bytes32 salt)
        external;
    /// @notice The pool step. Anyone may call it, once per sale; a failure inside it is swallowed and reported as success.
    function migrate(address initializer) external;
    /// @notice The sale's stored settings (`migrationBlock` is zero for an unknown sale).
    function initializers(address initializer) external view returns (MigratorParameters memory);
    /// @notice The auction a pool id is reserved for; zero once the pool step has run (or never reserved).
    function registeredPoolIds(bytes32 poolId) external view returns (address);
    /// @notice The Uniswap v4 pool manager.
    function poolManager() external view returns (address);
    /// @notice The Uniswap v4 position manager.
    function positionManager() external view returns (address);
    /// @notice The factory that builds the auctions.
    function initializerFactory() external view returns (address);
}

/// @notice The auction functions this code calls (continuous-clearing-auction `ContinuousClearingAuction.sol`).
interface IPinnedAuction {
    /// @notice True once the sale raised at least its minimum.
    function isGraduated() external view returns (bool);
    /// @notice Dollars raised, before the platform's fee.
    function currencyRaised() external view returns (uint256);
    /// @notice The sale's figures once it is over and checkpointed; reverts if it did not sell enough.
    function lbpInitializationParams() external view returns (LBPInitializationParams memory);
    /// @notice The last block of the sale.
    function endBlock() external view returns (uint64);
    /// @notice Send the unsold Shares to the tokens recipient. Only that recipient may call it.
    function sweepUnsoldTokens() external;
}

/// @notice The only auction-factory function the Launcher reads, to check the fee path (`ContinuousClearingAuctionFactory`).
interface IPinnedAuctionFactory {
    /// @notice The fee controller every auction of this factory asks for its fee.
    function protocolFeeController() external view returns (address);
}

/// @notice The fee controller functions read (liquidity-launcher `interfaces/IProtocolFeeController.sol`).
interface IPinnedFeeController {
    /// @notice The fee on `amount` of `currency`, rounded down.
    function getProtocolFeeAmount(address currency, uint256 amount) external view returns (uint256);
    /// @notice Who receives the fee.
    function protocolFeeRecipient() external view returns (address);
}

/// @notice The bid hook's two settings (our `MinBid`).
interface IPinnedMinBid {
    /// @notice The smallest accepted bid in raw dollar units.
    function minAmount() external view returns (uint128);
    /// @notice The top-price limit as a multiple of the clearing price.
    function maxPriceMultiple() external view returns (uint256);
}

/// @notice The one pool-manager function used: a raw read of its storage (v4-core `Extsload`).
interface IPinnedPoolManager {
    /// @notice Read one storage slot.
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @notice The position manager functions used (v4-periphery `PositionManager.sol`).
interface IPinnedPositionManager {
    /// @notice Owner of a position NFT.
    function ownerOf(uint256 tokenId) external view returns (address);
    /// @notice The pool a position belongs to. The second value is the packed position info (not read here).
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory poolKey, uint256 info);
    /// @notice The position's current liquidity.
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity);
    /// @notice Run a batch of position actions.
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
}

/// @notice The guard hook's one function (liquidity-launcher `interfaces/IInitializerHook.sol`).
interface IPinnedGuard {
    /// @notice The only address allowed to create the guarded pool.
    function authorized() external view returns (address);
}

/// @notice Reading a pool's state straight from the pool manager's storage, as v4's `StateLibrary` does, so first-party
/// code does not import it. `PinnedDrift.t.sol` checks every constant and formula against `StateLibrary` and a real pool.
library PoolRead {
    /// @dev `PoolManager`'s `mapping(PoolId => Pool.State) pools` is its storage slot 6 (v4-core `StateLibrary.POOLS_SLOT`).
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));
    /// @dev `liquidity` sits three slots after the pool's first slot (v4-core `StateLibrary.LIQUIDITY_OFFSET`).
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    /// @notice The pool id: the hash of the key (v4-core `PoolId.toId`).
    function id(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// @notice The pool's price (sqrt, Q96); zero when the pool was never created.
    function sqrtPrice(IPinnedPoolManager pm, bytes32 poolId) internal view returns (uint160) {
        return uint160(uint256(pm.extsload(keccak256(abi.encodePacked(poolId, POOLS_SLOT)))));
    }

    /// @notice The liquidity in range right now (zero when the pool does not exist or holds nothing).
    function liquidity(IPinnedPoolManager pm, bytes32 poolId) internal view returns (uint128) {
        bytes32 first = keccak256(abi.encodePacked(poolId, POOLS_SLOT));
        return uint128(uint256(pm.extsload(bytes32(uint256(first) + LIQUIDITY_OFFSET))));
    }
}

/// @notice The numbers of one sale that the Launcher and the Finisher must agree on. One place, so a sale cannot be
/// opened with one set and finished with another.
library SaleParams {
    /// @notice The auction runs 7,200 blocks: 24 hours at 12 seconds a block (the length of a Sepolia or Ethereum slot).
    uint64 internal constant SALE_BLOCKS = 7200;
    /// @notice Pool trading fee: 1% in v4's hundredths of a basis point.
    uint24 internal constant POOL_FEE = 10_000;
    /// @notice Pool tick spacing.
    int24 internal constant POOL_TICK_SPACING = 200;
    /// @notice The pool's share of the dollars raised after the platform's fee, in ten-millionths: 22 of every 100 raised,
    /// because 22 / 97 of the 97 left after the 3 is 22 of the 100 (rounded: 2,268,041 / 10,000,000).
    uint24 internal constant POOL_RATE = 2_268_041;
    /// @notice The scale of `POOL_RATE`.
    uint256 internal constant RATE_SCALE = 10_000_000;
    /// @notice Shares in the sale: 40% of 1,000,000,000.
    uint256 internal constant SALE_SHARES = 400_000_000e18;
    /// @notice Shares held back to match the pool's dollars: 10% of 1,000,000,000.
    uint128 internal constant POOL_SHARES = 100_000_000e18;
    /// @notice Blocks after the sale ends before anyone may abandon a sale whose pool never opened: 7 days at 12 seconds.
    uint64 internal constant ABANDON_DELAY_BLOCKS = 50_400;
}
