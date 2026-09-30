// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Bal} from "./RoyaltyDistributor.sol";

/// @title BuybackKeeper
/// @notice The `buybackSink` of `RoyaltyDistributor` (D3): the vessel that
///         receives the buyback share `B` at every settlement close and can
///         spend it ONLY on approved buyback targets — the TokenMaster market
///         (`transferCreatorShareToMarket` is the onchain buyback) and the
///         LBAMM refill path.
///
/// The invariant this contract exists to hold: **the buyback share is spent
/// on buybacks or it sits here**. There is no arbitrary currency withdrawal —
/// the operator can only route the balance to allowlisted buyback targets,
/// and governance rotates those targets. Contributor money never arrives
/// here (I2: `B` is fixed at the split; the pool goes to contributors).
contract BuybackKeeper {
    error ZeroAddress();
    error NotOperator();
    error NotGovernance();
    error TargetNotAllowed();
    error CallFailed(bytes reason);

    event TargetSet(address indexed target, bool allowed);
    event BuybackExecuted(address indexed target, bytes data, uint256 spent);

    IERC20Bal public immutable currency; // the revenue currency (B accumulates here)
    address public immutable governance; // rotates targets; cannot withdraw

    address public operator;
    mapping(address => bool) public allowedTarget;

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(IERC20Bal currency_, address governance_, address operator_) {
        if (
            address(currency_) == address(0) ||
            governance_ == address(0) ||
            operator_ == address(0)
        ) revert ZeroAddress();
        currency = currency_;
        governance = governance_;
        operator = operator_;
    }

    /// @notice Governance rotates the keeper; the spend surface does not
    ///         widen with it (targets stay allowlisted).
    function setOperator(address operator_) external onlyGovernance {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
    }

    function setTarget(address target, bool allowed) external onlyGovernance {
        if (target == address(0)) revert ZeroAddress();
        allowedTarget[target] = allowed;
        emit TargetSet(target, allowed);
    }

    /// @notice Run one buyback step against an approved target (the TM
    ///         market buy, the LBAMM refill). The caller encodes the target's
    ///         calldata; this keeper guarantees only that `B` can go to
    ///         approved buyback targets and nothing else. `spent` is the
    ///         currency balance consumed by the call (recorded, not guessed).
    function executeBuyback(address target, bytes calldata data)
        external
        onlyOperator
        returns (bytes memory)
    {
        if (!allowedTarget[target]) revert TargetNotAllowed();
        uint256 before = currency.balanceOf(address(this));
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) revert CallFailed(ret);
        uint256 afterBal = currency.balanceOf(address(this));
        uint256 spent = afterBal >= before ? 0 : before - afterBal;
        emit BuybackExecuted(target, data, spent);
        return ret;
    }
}
