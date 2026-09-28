// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SellRateGate} from "./SellRateGate.sol";

/// @title TieredSellRouter
/// @notice The documented SellRateGate integration point
///         (`docs/token-lifecycle-design.md` section 6: "the LBAMM router
///         wrapper calls `consumeSellAllowance` before executing a sell").
///         The router is wired as the gate's single `venue`.
///
/// Semantics: `executeSell` consumes the contributor's window allowance
/// FIRST (fail-closed at the gate) and then forwards the venue call. The two
/// steps are atomic: a failed venue call reverts the consumption with it, and
/// a failed consumption never reaches the venue. The operator is the keeper
/// that runs sells (later: the LBAMM integrator-router flow with per-sell
/// contributor signatures); `allowedVenue` bounds where value may go.
///
/// The TV whitelist (deployment config) must list ONLY this router, the
/// treasury, and the distributor as token-transfer venues — that whitelist is
/// what stops a contributor from selling outside the rate gate entirely.
contract TieredSellRouter {
    error ZeroAddress();
    error NotOperator();
    error VenueNotAllowed();
    error VenueCallFailed(bytes reason);

    event VenueSet(address indexed venue, bool allowed);
    event SellExecuted(address indexed contributor, uint256 amount, address indexed venue, bytes data);

    SellRateGate public immutable gate;
    address public immutable operator;

    mapping(address => bool) public allowedVenue;

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(SellRateGate gate_, address operator_) {
        if (address(gate_) == address(0) || operator_ == address(0)) revert ZeroAddress();
        gate = gate_;
        operator = operator_;
    }

    function setVenue(address venue, bool allowed) external onlyOperator {
        if (venue == address(0)) revert ZeroAddress();
        allowedVenue[venue] = allowed;
        emit VenueSet(venue, allowed);
    }

    /// @notice Consume `contributor`'s window allowance, then forward `data`
    ///         to the approved `venue` (the LBAMM integrator router). The
    ///         venue call's exact calldata is venue-specific — this router
    ///         guarantees only the ordering and the atomicity.
    function executeSell(
        address contributor,
        uint256 amount,
        address venue,
        bytes calldata data
    ) external onlyOperator returns (bytes memory) {
        if (!allowedVenue[venue]) revert VenueNotAllowed();
        gate.consumeSellAllowance(contributor, amount);
        (bool ok, bytes memory ret) = venue.call(data);
        if (!ok) revert VenueCallFailed(ret);
        emit SellExecuted(contributor, amount, venue, data);
        return ret;
    }
}
