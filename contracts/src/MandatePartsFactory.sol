// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClaimStake} from "./ClaimStake.sol";
import {VerifierSet} from "./VerifierSet.sol";

/// @title MandatePartsFactory
/// @notice Makes a work budget's reviewer panel (`VerifierSet`) and claim escrow (`ClaimStake`). It is kept apart from
/// `TreasuryMandate` so that `TreasuryMandateFactory`, which carries the budget's own code, stays under the contract size
/// limit. It holds no authority: both parts are owned by the `owner` named in the call (the budget, which calls this from
/// its own constructor), and nothing anywhere honours a budget the DAO's own factory did not make.
contract MandatePartsFactory {
    /// @notice A panel that `owner` runs (`quorum` approvals settle a claim) and an escrow in `currency` whose treasury is
    /// `owner`, wired to that panel.
    function make(address owner, uint256 quorum, address currency)
        external
        returns (VerifierSet panel, ClaimStake claims)
    {
        panel = new VerifierSet(owner, quorum);
        claims = new ClaimStake(panel, owner, currency);
    }
}
