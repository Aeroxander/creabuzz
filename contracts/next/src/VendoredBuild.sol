// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Compile check only. It pulls in the exact vendored Uniswap pieces milestone 1 uses, so `forge build` proves the
// remappings in remappings.txt find them. Nothing here is deployed.
import {LBPStrategy} from "liquidity-launcher/src/strategies/lbp/LBPStrategy.sol";
import {InitializerHook} from "liquidity-launcher/src/periphery/hooks/InitializerHook.sol";
import {ContinuousClearingAuctionFactory} from "continuous-clearing-auction/src/ContinuousClearingAuctionFactory.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
