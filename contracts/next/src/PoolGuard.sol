// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {InitializerHook} from "liquidity-launcher/src/periphery/hooks/InitializerHook.sol";

/// @title PoolGuard
/// @notice The hook of a project's Uniswap v4 pool. It lets only the strategy create the pool, so a stranger cannot
/// create the project's pool first (at a price of their choosing) or block the sale from opening.
/// @dev `InitializerHook` does the whole job: it asks for the `beforeInitialize` hook bit and reverts
/// `InvalidInitializer` for any `sender` other than `authorized` (here the strategy). It does nothing on swaps or
/// liquidity. The address of a hook carries its permissions, so this must be deployed at a mined address (see
/// `HookSalt`); the pool manager checks the bit and the strategy checks `authorized()` when a sale opens.
contract PoolGuard is InitializerHook {
    /// @param poolManager The Uniswap v4 pool manager.
    /// @param strategy The only address allowed to create the pool.
    constructor(IPoolManager poolManager, address strategy) InitializerHook(poolManager, strategy) {}
}
