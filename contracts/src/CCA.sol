// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view of the Uniswap Continuous Clearing Auction surface the
/// launchpad integrates with. Mirrors
/// `Uniswap/continuous-clearing-auction` (factory v2.1.0). Full auction logic
/// lives upstream; this interface binds only the handoff points.
interface IContinuousClearingAuction {
    struct LBPInitializationParams {
        uint256 initialPriceX96;
        uint256 tokensSold;
        uint256 currencyRaised;
    }

    function isGraduated() external view returns (bool);
    function currencyRaised() external view returns (uint256);
    function lbpInitializationParams() external view returns (LBPInitializationParams memory);
}

/// @notice Downstream strategy consumed by a graduated auction. The canonical
/// implementation seeds a Uniswap v4 pool; the launchpad deploys
/// `AppTokenLBPInitializer` instead to seed apptoken rails.
interface ILBPInitializer {
    function onGraduation(address auction, IContinuousClearingAuction.LBPInitializationParams calldata params) external;
}

/// @notice Bid-gating hook called by the auction before accepting a bid.
/// Mirrors `IValidationHook` upstream: revert to reject the bid.
interface IValidationHook {
    function validate(uint256 maxPrice, uint128 amount, address owner, address sender, bytes calldata hookData) external;
}
