// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IContinuousClearingAuction, ILBPInitializer} from "./CCA.sol";

/// @title AppTokenLBPInitializer
/// @notice Graduation handoff: consumes a graduated CCA's
/// `lbpInitializationParams` and routes value into apptoken rails instead of
/// a Uniswap v4 pool.
///
/// Superseded by `GraduationExecutor` (same directory) for launches that want
/// the money to actually move: the executor IS the sweep recipient and pulls,
/// splits, and forwards the proceeds atomically. Keep this accounting-only
/// contract for reference/history; do not deploy it for new launches.
///
/// Phase 1 (this contract): permissioned accounting + events. Anyone calls
/// `graduate(auction)`; the call pulls the auction's final clearing price,
/// tokens sold, and net currency raised, verifies graduation, and splits the
/// proceeds into a reserve share (TokenMaster floor) and a treasury share
/// (Moloch treasury). Actual TokenMaster/LBAMM pool deployment is performed
/// by the apptoken-skills generated scripts observing `Graduated` — the pool
/// addresses are recorded here via `recordPools` so the launch has one
/// onchain source of truth.
///
/// @dev Holds no funds. Currency/token movement stays in the auction's own
/// sweep path (`sweepCurrency`/`sweepUnsoldTokens` to the configured
/// recipients); this contract only directs and records.
contract AppTokenLBPInitializer is ILBPInitializer {
    /// @notice Launch treasury allowed to record pools and set splits.
    address public immutable treasury;
    /// @notice Reserve share in basis points (e.g. 4000 = 40% to the floor).
    uint16 public reserveBps;

    struct Graduation {
        uint256 initialPriceX96;
        uint256 tokensSold;
        uint256 currencyRaised;
        uint256 reserveShare;
        uint256 treasuryShare;
        address tokenMasterPool;
        address lbammPool;
        bool poolsRecorded;
    }

    mapping(address auction => Graduation) public graduations;

    event Graduated(
        address indexed auction,
        uint256 initialPriceX96,
        uint256 tokensSold,
        uint256 currencyRaised,
        uint256 reserveShare,
        uint256 treasuryShare
    );
    event PoolsRecorded(address indexed auction, address tokenMasterPool, address lbammPool);
    event ReserveBpsUpdated(uint16 reserveBps);

    error NotGraduated(address auction);
    error AlreadyGraduated(address auction);
    error OnlyTreasury(address caller);
    error BadReserveBps(uint16 reserveBps);

    constructor(address treasury_, uint16 reserveBps_) {
        treasury = treasury_;
        if (reserveBps_ > 10_000) revert BadReserveBps(reserveBps_);
        reserveBps = reserveBps_;
    }

    /// @notice Pull graduation params from a finalized, graduated auction.
    /// Reverts unless the auction graduated. Idempotent-guarded: one shot.
    function onGraduation(address auction, IContinuousClearingAuction.LBPInitializationParams calldata params)
        external
        override
    {
        if (!IContinuousClearingAuction(auction).isGraduated()) revert NotGraduated(auction);
        Graduation storage g = graduations[auction];
        if (g.currencyRaised != 0 || g.tokensSold != 0) revert AlreadyGraduated(auction);
        uint256 reserveShare = (params.currencyRaised * reserveBps) / 10_000;
        g.initialPriceX96 = params.initialPriceX96;
        g.tokensSold = params.tokensSold;
        g.currencyRaised = params.currencyRaised;
        g.reserveShare = reserveShare;
        g.treasuryShare = params.currencyRaised - reserveShare;
        emit Graduated(
            auction,
            params.initialPriceX96,
            params.tokensSold,
            params.currencyRaised,
            reserveShare,
            params.currencyRaised - reserveShare
        );
    }

    /// @notice Convenience entry: read params from the auction, then route.
    function graduate(address auction) external {
        IContinuousClearingAuction.LBPInitializationParams memory params =
            IContinuousClearingAuction(auction).lbpInitializationParams();
        this.onGraduation(auction, params);
    }

    /// @notice Record the apptoken pools once the offchain deployment lands.
    function recordPools(address auction, address tokenMasterPool, address lbammPool) external {
        if (msg.sender != treasury) revert OnlyTreasury(msg.sender);
        Graduation storage g = graduations[auction];
        g.tokenMasterPool = tokenMasterPool;
        g.lbammPool = lbammPool;
        g.poolsRecorded = true;
        emit PoolsRecorded(auction, tokenMasterPool, lbammPool);
    }

    /// @notice Treasury may retune the floor share before any graduation uses it.
    function setReserveBps(uint16 reserveBps_) external {
        if (msg.sender != treasury) revert OnlyTreasury(msg.sender);
        if (reserveBps_ > 10_000) revert BadReserveBps(reserveBps_);
        reserveBps = reserveBps_;
        emit ReserveBpsUpdated(reserveBps_);
    }
}
