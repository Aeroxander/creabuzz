// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title HookSalt
/// @notice Finds a CREATE2 salt so a contract lands on an address whose lowest 14 bits equal a chosen Uniswap v4 hook
/// flag word (`0x2000` is "beforeInitialize only"). The strategy and the pool guard both need this. One salt in
/// 16,384 fits on average.
/// @dev Same job as the periphery `HookMiner`, but it hashes the creation code once instead of on every try, which is
/// what makes mining affordable inside a test.
library HookSalt {
    /// @notice The low 14 bits of an address: the v4 hook permission word.
    uint160 internal constant FLAG_MASK = 0x3FFF;
    /// @notice The most salts tried before giving up.
    uint256 internal constant MAX_TRIES = 500_000;

    /// @notice No salt in range matches.
    error NoSaltFound();

    /// @param deployer The contract that will run the CREATE2.
    /// @param flags The exact low 14 bits wanted.
    /// @param creationCode `type(C).creationCode`.
    /// @param constructorArgs `abi.encode(...)` of the constructor arguments.
    /// @return hookAddress The address the contract will have.
    /// @return salt The salt to use.
    function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        view
        returns (address hookAddress, bytes32 salt)
    {
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));
        for (uint256 i; i < MAX_TRIES; ++i) {
            address candidate = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, bytes32(i), initCodeHash))))
            );
            if (uint160(candidate) & FLAG_MASK == flags && candidate.code.length == 0) {
                return (candidate, bytes32(i));
            }
        }
        revert NoSaltFound();
    }
}
