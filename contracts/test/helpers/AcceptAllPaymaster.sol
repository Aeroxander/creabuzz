// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The EntryPoint v0.7 user operation, as it hands it to a paymaster.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPointDeposit {
    function depositTo(address account) external payable;
}

/// @notice For browser journeys on a local fork only (scripts/web-passkey-contributor-e2e.sh): a paymaster that pays for
/// every operation, standing in for the hosted one a test-network site uses, so passkey accounts act with covered fees
/// exactly as testers' will. Never deployed anywhere real.
contract AcceptAllPaymaster {
    address public immutable entryPoint;

    constructor(address entryPoint_) {
        entryPoint = entryPoint_;
    }

    function validatePaymasterUserOp(PackedUserOperation calldata, bytes32, uint256)
        external
        view
        returns (bytes memory context, uint256 validationData)
    {
        require(msg.sender == entryPoint, "not the entry point");
        return ("", 0);
    }

    /// @dev Never called: an empty context skips it.
    function postOp(uint8, bytes calldata, uint256, uint256) external {}

    /// @notice Put ETH behind it at the entry point, which pays from that deposit.
    function deposit() external payable {
        IEntryPointDeposit(entryPoint).depositTo{value: msg.value}(address(this));
    }
}
