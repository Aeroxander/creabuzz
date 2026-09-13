// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IContinuousClearingAuction, ILBPInitializer} from "./CCA.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title GraduationExecutor
/// @notice Executes the graduation handoff: sweeps the auction's proceeds and
/// routes them into apptoken rails (plan §7.2 decision — apptoken, not v4).
///
/// The CCA's own `sweepCurrency`/`sweepUnsoldTokens` are recipient-only; this
/// contract is deployed as BOTH recipients at launch, so only it can pull.
/// One call does everything atomically:
///   1. sweep net raised currency into this contract (protocol fee already
///      taken by the immutable fee controller),
///   2. sweep unsold tokens back here,
///   3. split: `reserveBps` → reserve escrow (the TokenMaster floor), the
///      remainder → treasury,
///   4. unsold tokens → treasury (they are launch supply, not sale value),
///   5. record the graduation and emit the receipts an indexer mirrors as
///      47005 `sweep`/`lock` events.
///
/// The reserve stays escrowed until the TokenMaster/LBAMM pool deploys and
/// the treasury records its address (`releaseReserve`). If the pool never
/// lands, the treasury can withdraw the stuck reserve — nothing is lost to a
/// contract that only documents.
contract GraduationExecutor is ILBPInitializer {
    using SafeTransferLib for address;

    address public immutable treasury;
    /// @notice Reserve share in basis points (e.g. 4000 = 40% to the TM floor).
    uint16 public immutable reserveBps;

    struct Graduation {
        uint256 initialPriceX96;
        uint256 tokensSold;
        uint256 currencyRaised;
        uint256 reserveEscrow;
        uint256 treasuryShare;
        uint256 unsoldTokens;
        address tokenMasterPool;
        bool executed;
    }

    mapping(address auction => Graduation) public graduations;

    event GraduationExecuted(
        address indexed auction,
        uint256 initialPriceX96,
        uint256 tokensSold,
        uint256 currencyRaised,
        uint256 reserveEscrow,
        uint256 treasuryShare,
        uint256 unsoldTokens
    );
    event ReserveReleased(address indexed auction, address pool, uint256 amount);
    event StuckReserveWithdrawn(address indexed auction, address currency);

    error NotGraduated(address auction);
    error AlreadyExecuted(address auction);
    error NotFundsRecipient(address auction, address expected, address actual);
    error NotTokensRecipient(address auction, address expected, address actual);
    error OnlyTreasury(address caller);
    error AlreadyReleased(address auction);
    error NothingToRelease(address auction);
    error BadReserveBps(uint16 reserveBps);

    constructor(address treasury_, uint16 reserveBps_) {
        if (treasury_ == address(0)) revert OnlyTreasury(address(0));
        if (reserveBps_ > 10_000) revert BadReserveBps(reserveBps_);
        treasury = treasury_;
        reserveBps = reserveBps_;
    }

    /// @notice One atomic graduation. Callable by anyone; the recipient
    /// guards inside the auction decide who can actually move the money.
    function executeGraduation(address auction) external {
        IContinuousClearingAuction cca = IContinuousClearingAuction(auction);
        if (!cca.isGraduated()) revert NotGraduated(auction);
        Graduation storage g = graduations[auction];
        if (g.executed) revert AlreadyExecuted(auction);

        // The executor is the designated sweep recipient; the CCA enforces
        // this itself, so a clear failure here means the launch misconfigured
        // the recipients rather than an opaque NotAuthorized.
        if (cca.fundsRecipient() != address(this)) {
            revert NotFundsRecipient(auction, address(this), cca.fundsRecipient());
        }
        if (cca.tokensRecipient() != address(this)) {
            revert NotTokensRecipient(auction, address(this), cca.tokensRecipient());
        }

        // Pull. On a graduated auction, sweepCurrency moves the net raise;
        // sweepUnsoldTokens returns the remaining supply.
        cca.sweepCurrency();
        cca.sweepUnsoldTokens();

        IContinuousClearingAuction.LBPInitializationParams memory params =
            cca.lbpInitializationParams();
        uint256 reserveShare = (params.currencyRaised * reserveBps) / 10_000;
        uint256 treasuryShare = params.currencyRaised - reserveShare;
        uint256 unsoldTokens = _tokenBalance(cca.token(), address(this));

        g.initialPriceX96 = params.initialPriceX96;
        g.tokensSold = params.tokensSold;
        g.currencyRaised = params.currencyRaised;
        g.reserveEscrow = reserveShare;
        g.treasuryShare = treasuryShare;
        g.unsoldTokens = unsoldTokens;
        g.executed = true;

        address currency = cca.currency();
        if (treasuryShare > 0) {
            currency.safeTransfer(treasury, treasuryShare);
        }
        if (unsoldTokens > 0) {
            cca.token().safeTransfer(treasury, unsoldTokens);
        }

        emit GraduationExecuted(
            auction,
            params.initialPriceX96,
            params.tokensSold,
            params.currencyRaised,
            reserveShare,
            treasuryShare,
            unsoldTokens
        );
    }

    /// @notice Send the escrowed reserve to the recorded TokenMaster pool.
    /// Treasury records the pool post-deploy; the reserve releases once, to
    /// the recorded pool only.
    function releaseReserve(address auction, address tokenMasterPool) external {
        if (msg.sender != treasury) revert OnlyTreasury(msg.sender);
        Graduation storage g = graduations[auction];
        if (g.tokenMasterPool != address(0)) revert AlreadyReleased(auction);
        if (g.reserveEscrow == 0) revert NothingToRelease(auction);
        g.tokenMasterPool = tokenMasterPool;
        address currency = IContinuousClearingAuction(auction).currency();
        uint256 amount = g.reserveEscrow;
        g.reserveEscrow = 0;
        currency.safeTransfer(tokenMasterPool, amount);
        emit ReserveReleased(auction, tokenMasterPool, amount);
    }

    /// @notice Governance escape hatch for an escrow whose pool never lands.
    function withdrawStuckReserve(address auction, address to) external {
        if (msg.sender != treasury) revert OnlyTreasury(msg.sender);
        Graduation storage g = graduations[auction];
        if (g.tokenMasterPool != address(0)) revert AlreadyReleased(auction);
        uint256 amount = g.reserveEscrow;
        g.reserveEscrow = 0;
        address currency = IContinuousClearingAuction(auction).currency();
        currency.safeTransfer(to, amount);
        emit StuckReserveWithdrawn(auction, currency);
    }

    function _tokenBalance(address token, address holder) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", holder)
        );
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// @notice The executor reads params from the chain itself at execution;
    /// an out-of-band params push is not a graduation and is refused.
    function onGraduation(
        address auction,
        IContinuousClearingAuction.LBPInitializationParams calldata
    ) external override {
        revert NotGraduated(auction);
    }
}
