// SPDX-License-Identifier: MIT
pragma solidity >=0.8.26;

import {PoolKey} from "../../src/Pinned.sol";

// Test-side views of Uniswap contracts, as small interfaces and struct copies, so that the milestone 3 tests (compiled with
// the first-party compiler, 0.8.37) never import the vendored source. The deployments themselves are loaded from build
// artifacts. `test/PinnedDrift.t.sol` checks the ones that matter against the vendored code.

/// @notice Copy of v4's `SwapParams`.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// @notice Copy of `PoolSwapTest.TestSettings`.
struct TestSettings {
    bool takeClaims;
    bool settleUsingBurn;
}

/// @notice Copy of the auction's `Bid`.
struct Bid {
    uint64 startBlock;
    uint24 startCumulativeMps;
    uint64 exitedBlock;
    uint256 maxPrice;
    address owner;
    uint256 amountQ96;
    uint256 tokensFilled;
}

/// @notice Copy of the auction's `Checkpoint` (`ValueX7` is a `uint256` on the wire).
struct Checkpoint {
    uint256 clearingPrice;
    uint256 currencyRaisedAtClearingPriceQ96X7;
    uint256 cumulativeMpsPerPrice;
    uint24 cumulativeMps;
    uint64 prev;
    uint64 next;
}

/// @notice The auction functions the tests call.
interface IAuctionTest {
    function submitBid(uint256 maxPrice, uint128 amount, address owner, uint256 prevTickPrice, bytes calldata hookData)
        external
        payable
        returns (uint256);
    function nextBidId() external view returns (uint256);
    function bids(uint256 bidId) external view returns (Bid memory);
    function checkpoints(uint64 blockNumber) external view returns (Checkpoint memory);
    function lastCheckpointedBlock() external view returns (uint64);
    function checkpoint() external returns (Checkpoint memory);
    function exitBid(uint256 bidId) external;
    function exitPartiallyFilledBid(uint256 bidId, uint64 lastFullyFilledCheckpointBlock, uint64 outbidBlock) external;
    function claimTokens(uint256 bidId) external;
    function clearingPrice() external view returns (uint256);
    function currencyRaised() external view returns (uint256);
    function totalCleared() external view returns (uint256);
    function remainingSupply() external view returns (uint256);
    function isGraduated() external view returns (bool);
    function startBlock() external view returns (uint64);
    function endBlock() external view returns (uint64);
    function claimBlock() external view returns (uint64);
    function floorPrice() external view returns (uint256);
    function tickSpacing() external view returns (uint256);
    function sweepCurrency() external;
    function sweepUnsoldTokens() external;
    function sweepCurrencyBlock() external view returns (uint256);
    function sweepUnsoldTokensBlock() external view returns (uint256);
    function fundsRecipient() external view returns (address);
    function tokensRecipient() external view returns (address);
    function validationHook() external view returns (address);
    function currency() external view returns (address);
    function token() external view returns (address);
    function totalSupply() external view returns (uint128);
}

/// @notice Permit2's allowance function: a bid is paid through it.
interface IPermit2Test {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice v4's own test swap router (`PoolSwapTest`): deployed on Sepolia, and built locally for the twin.
interface ISwapTest {
    function swap(PoolKey memory key, SwapParams memory params, TestSettings memory settings, bytes memory hookData)
        external
        payable
        returns (int256 delta);
}

/// @notice The view of `Deployer` the tests use (the contract itself is deployed from its artifact).
interface IDeployer {
    function localStack(address permit2)
        external
        returns (address poolManager, address positionManager, address swapTest);
    function auctionFactory(address feeController) external returns (address);
    function strategy(address positionManager, address poolManager, address factory) external returns (address);
    function guard(address poolManager, address strategy) external returns (address);
    function liquidityRouter(address poolManager) external returns (address);
}

/// @notice The Uniswap universal router.
interface IUniversalRouterTest {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice The position manager functions the tests call besides the ones in `Pinned.sol`.
interface IPositionManagerTest {
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function permit(address spender, uint256 tokenId, uint256 deadline, uint256 nonce, bytes calldata signature)
        external
        payable;
    function permitForAll(address owner, address operator, uint256 deadline, uint256 nonce, bytes calldata signature)
        external
        payable;
}

/// @notice The pool manager functions the tests call besides `extsload`.
interface IPoolManagerTest {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
}

/// @notice v4's own liquidity router for tests (`PoolModifyLiquidityTest`).
interface ILiquidityRouterTest {
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes memory hookData)
        external
        payable
        returns (int256 delta);
}

/// @notice Copy of v4's `ModifyLiquidityParams`.
struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}
