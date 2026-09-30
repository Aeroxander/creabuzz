// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AuctionLauncher
/// @notice Phase-1 launch registry: validates CCA auction parameters off the
/// critical path and commits to them onchain before the auction deploys.
/// The CCA factory remains the deployment path; this contract is the
/// parameter gate + directory so misconfigured sales fail fast with a clear
/// reason instead of silently mispricing.
contract AuctionLauncher {
    struct LaunchParams {
        address currency;
        uint256 floorPrice;
        uint256 tickSpacing;
        uint128 requiredRaised;
        uint64 startBlock;
        uint64 endBlock;
        uint64 claimBlock;
        bytes steps;
        address validationHook;
    }

    mapping(bytes32 launchId => bytes32) public paramsHash;
    mapping(bytes32 launchId => address) public curator;

    event LaunchRegistered(bytes32 indexed launchId, address indexed curator, bytes32 paramsHash);

    error BadFloorPrice();
    error BadTickSpacing();
    error BadThreshold();
    error BadBlocks();
    error BadSteps();
    error AlreadyRegistered(bytes32 launchId);

    /// @notice Minimum enforced tick spacing upstream is 2; require at least
    /// ~1bp of resolution in practice via caller discipline (see docs).
    uint256 public constant MIN_TICK_SPACING = 2;

    function registerLaunch(bytes32 launchId, LaunchParams calldata params) external {
        if (paramsHash[launchId] != bytes32(0)) revert AlreadyRegistered(launchId);
        if (params.floorPrice < (uint256(1) << 32) + 1) revert BadFloorPrice();
        if (params.tickSpacing < MIN_TICK_SPACING) revert BadTickSpacing();
        if (params.requiredRaised == 0) revert BadThreshold();
        if (params.startBlock == 0 || params.endBlock <= params.startBlock || params.claimBlock <= params.endBlock) {
            revert BadBlocks();
        }
        if (params.steps.length == 0 || params.steps.length % 8 != 0) revert BadSteps();
        bytes32 hash = keccak256(
            abi.encode(
                params.currency,
                params.floorPrice,
                params.tickSpacing,
                params.requiredRaised,
                params.startBlock,
                params.endBlock,
                params.claimBlock,
                params.steps,
                params.validationHook
            )
        );
        paramsHash[launchId] = hash;
        curator[launchId] = msg.sender;
        emit LaunchRegistered(launchId, msg.sender, hash);
    }
}
