// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoyaltyDistributor} from "./RoyaltyDistributor.sol";

/// @title SellRateGate
/// @notice D8 (docs/token-lifecycle-design.md): LBAMM sell access is
///         rate-gated by milestone tier — a continuous per-window allowance,
///         never an unlock cliff. A contributor's sell allowance per window
///         is `bandSellCapBps(band) × allocation / 10000` read from the
///         launch's RoyaltyDistributor band tables.
///
/// Scope (deliberate): this gate bounds the sells of ADDRESSES WITH ROYALTY
///         SCHEDULES — the contributor entitlement sells the design prices.
///         Addresses without schedules pass through ungated here; their
///         volume control is the LBAMM per-wallet cap and the TV venue
///         whitelist. A contributor address is gated on ALL its sells
///         (provenance of specific tokens is not observable at transfer
///         time; the TV whitelist keeps non-venue transfers blocked, so a
///         gated address cannot route around the gate).
///
/// Integration point: the TV custom ruleset or the LBAMM router wrapper
///         calls `consumeSellAllowance` before executing a sell to a
///         whitelisted venue; the caller is the single immutable `venue`.
///         Fail-closed: exceeding the allowance reverts.
contract SellRateGate {
    error ZeroAddress();
    error NotVenue();
    error SellRateExceeded(uint256 requested, uint256 remaining);

    event SellAllowanceConsumed(address indexed contributor, uint64 windowId, uint256 amount, uint256 remaining);

    RoyaltyDistributor public immutable distributor;
    address public immutable venue; // TV ruleset / LBAMM router wrapper

    mapping(uint64 windowId => mapping(address contributor => uint256)) public soldInWindow;

    constructor(RoyaltyDistributor distributor_, address venue_) {
        if (address(distributor_) == address(0) || venue_ == address(0)) revert ZeroAddress();
        distributor = distributor_;
        venue = venue_;
    }

    modifier onlyVenue() {
        if (msg.sender != venue) revert NotVenue();
        _;
    }

    /// @notice The current settlement window id (the allowance period).
    function windowId() public view returns (uint64) {
        return distributor.closedWindows();
    }

    /// @notice Remaining sell allowance for this window. Addresses without
    ///         schedules are ungated here (type(uint256).max).
    function sellAllowance(address contributor) public view returns (uint256) {
        uint8 band = distributor.bandOf(contributor);
        if (band == 0) return type(uint256).max;
        uint256 cap = (distributor.allocOf(contributor) * distributor.bandSellCapBps(band)) / 10_000;
        uint256 sold = soldInWindow[windowId()][contributor];
        return sold >= cap ? 0 : cap - sold;
    }

    /// @notice Non-consuming pre-check (UI / quoting).
    function canSell(address contributor, uint256 amount) external view returns (bool) {
        return amount <= sellAllowance(contributor);
    }

    /// @notice Consume window allowance. Reverts past the cap (fail closed).
    ///         Only the wired venue may call.
    function consumeSellAllowance(address contributor, uint256 amount) external onlyVenue {
        uint64 id = windowId();
        uint256 remaining = sellAllowance(contributor);
        if (amount > remaining) revert SellRateExceeded(amount, remaining);
        if (amount > 0 && remaining != type(uint256).max) {
            soldInWindow[id][contributor] += amount;
        }
        emit SellAllowanceConsumed(contributor, id, amount, remaining - amount);
    }
}
