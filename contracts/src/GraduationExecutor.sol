// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IContinuousClearingAuction, ICcaFinalization, ILBPInitializer} from "./CCA.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title GraduationExecutor
/// @notice Executes the graduation handoff: sweeps the auction's proceeds and
/// routes them into apptoken rails (plan §7.2 decision — apptoken, not v4).
///
/// The CCA's own `sweepCurrency`/`sweepUnsoldTokens` are recipient-only; this
/// contract is deployed as BOTH recipients at launch, so only it can pull.
/// A launch ends in one of two terminal outcomes:
///
/// Graduated (raise >= threshold): one `executeGraduation` call does everything
/// atomically:
///   1. materialize the auction's final checkpoint (the end-block raise does
///      not exist until checkpointed),
///   2. sweep net raised currency into this contract (protocol fee already
///      taken by the immutable fee controller),
///   3. sweep unsold tokens back here,
///   4. split: `reserveBps` → reserve escrow (the TokenMaster floor), the
///      remainder → treasury,
///   5. unsold tokens → treasury (they are launch supply, not sale value),
///   6. record the graduation and emit the receipts an indexer mirrors as
///      47005 `sweep`/`lock` events.
///
/// Failed (raise < threshold): every bidder wei refunds through exits, and
/// `recoverFailedLaunch` returns the sale supply to `treasury` — without it the
/// supply would be stranded forever in the auction, whose sweep is
/// `tokensRecipient`-only. Recovery is legal ONLY when the auction is over and
/// did NOT graduate: it is `treasury`-only, runs once per auction, and refuses
/// graduated (hence also executed) launches with `AuctionGraduated`.
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
    /// @notice One recovery per auction: once a failed launch's sale supply has
    /// been returned to `treasury`, `recoverFailedLaunch` refuses to run again.
    mapping(address auction => bool) public launchRecovered;

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
    /// @notice Emitted when a failed launch's sale supply is returned to the treasury.
    event FailedLaunchRecovered(address indexed auction, address token, uint256 amount);

    error NotGraduated(address auction);
    error AlreadyExecuted(address auction);
    error NotFundsRecipient(address auction, address expected, address actual);
    error NotTokensRecipient(address auction, address expected, address actual);
    error OnlyTreasury(address caller);
    error AlreadyReleased(address auction);
    error NothingToRelease(address auction);
    error BadReserveBps(uint16 reserveBps);
    /// @notice Thrown when `recoverFailedLaunch` is called before the auction is over.
    error AuctionStillRunning(address auction);
    /// @notice Thrown when `recoverFailedLaunch` is called on a graduated launch.
    error AuctionGraduated(address auction);
    /// @notice Thrown when the failed launch's supply has already been recovered.
    error AlreadyRecovered(address auction);

    constructor(address treasury_, uint16 reserveBps_) {
        if (treasury_ == address(0)) revert OnlyTreasury(address(0));
        if (reserveBps_ > 10_000) revert BadReserveBps(reserveBps_);
        treasury = treasury_;
        reserveBps = reserveBps_;
    }

    /// @notice One atomic graduation. Callable by anyone; the recipient
    /// guards inside the auction decide who can actually move the money.
    /// @dev Materializes the auction's final checkpoint BEFORE reading
    /// `isGraduated()`, which only sees the latest checkpoint — without this a
    /// keeper calling right after `endBlock` gets `NotGraduated` even for a
    /// launch that cleared the threshold.
    function executeGraduation(address auction) external {
        IContinuousClearingAuction cca = IContinuousClearingAuction(auction);
        Graduation storage g = graduations[auction];
        if (g.executed) revert AlreadyExecuted(auction);
        ICcaFinalization(auction).checkpoint();
        if (!cca.isGraduated()) revert NotGraduated(auction);

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

    /// @notice Return a failed launch's sale supply to the treasury.
    /// @dev Legal ONLY when the auction is over and did NOT graduate. The final
    /// checkpoint is materialized first, so a graduated launch whose end-block
    /// raise is not yet checkpointed is still refused (`AuctionGraduated`) — an
    /// executed launch is necessarily graduated, so the same check shields it.
    /// The executor is the auction's `tokensRecipient`, which is what authorizes
    /// the `sweepUnsoldTokens` pull. Exactly the swept amount is forwarded (the
    /// executor's pre-existing token balance is left alone). Runs once per
    /// auction; the auction's own one-shot sweep is the backstop.
    function recoverFailedLaunch(address auction) external {
        if (msg.sender != treasury) revert OnlyTreasury(msg.sender);
        if (launchRecovered[auction]) revert AlreadyRecovered(auction);
        IContinuousClearingAuction cca = IContinuousClearingAuction(auction);
        if (block.number < ICcaFinalization(auction).endBlock()) {
            revert AuctionStillRunning(auction);
        }
        ICcaFinalization(auction).checkpoint();
        if (cca.isGraduated()) revert AuctionGraduated(auction);
        if (cca.tokensRecipient() != address(this)) {
            revert NotTokensRecipient(auction, address(this), cca.tokensRecipient());
        }

        address token = cca.token();
        uint256 balanceBefore = _tokenBalance(token, address(this));
        launchRecovered[auction] = true;
        cca.sweepUnsoldTokens();
        uint256 recovered = _tokenBalance(token, address(this)) - balanceBefore;
        if (recovered > 0) {
            token.safeTransfer(treasury, recovered);
        }
        emit FailedLaunchRecovered(auction, token, recovered);
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
