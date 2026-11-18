// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ECDSA} from "oz5/utils/cryptography/ECDSA.sol";

/// @dev EIP-1271's answer for a valid signature.
bytes4 constant MAGIC_1271 = 0x1626ba7e;

/// @notice A plain EIP-1271 wallet: one owner key; a signature is valid when it recovers to the owner. It can also make
/// calls in person (for a holder's direct consent).
contract Wallet1271 {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address got, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && got == owner ? MAGIC_1271 : bytes4(0xffffffff);
    }

    function exec(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == owner, "not owner");
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}

/// @notice A Kernel-style account (ZeroDev Kernel v3's EIP-1271 replay protection, reproduced): the owner signs the app's
/// digest wrapped in the account's own EIP-712 domain, so a signature made for one account never verifies for another.
contract KernelStyleAccount {
    bytes32 public constant WRAPPER_TYPEHASH = keccak256("Kernel(bytes32 hash)");
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function accountDomain() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Kernel"),
                keccak256("0.3.3"),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice What the owner's key signs for an app digest `hash`.
    function wrapped(bytes32 hash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", accountDomain(), keccak256(abi.encode(WRAPPER_TYPEHASH, hash))));
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address got, ECDSA.RecoverError err,) = ECDSA.tryRecover(wrapped(hash), signature);
        return err == ECDSA.RecoverError.NoError && got == owner ? MAGIC_1271 : bytes4(0xffffffff);
    }
}

/// @notice A Safe-style multisig: `threshold` of its owners sign the digest; the signatures are concatenated, each 65 bytes, in
/// ascending order of the signer's address (as a Safe checks them).
contract SafeStyleWallet {
    mapping(address => bool) public isOwner;
    uint256 public immutable threshold;

    constructor(address[] memory owners, uint256 threshold_) {
        for (uint256 i; i < owners.length; ++i) {
            isOwner[owners[i]] = true;
        }
        threshold = threshold_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signatures) external view returns (bytes4) {
        if (signatures.length < threshold * 65) return bytes4(0xffffffff);
        address last;
        for (uint256 i; i < threshold; ++i) {
            (address got, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signatures[i * 65:i * 65 + 65]);
            if (err != ECDSA.RecoverError.NoError || !isOwner[got] || got <= last) return bytes4(0xffffffff);
            last = got;
        }
        return MAGIC_1271;
    }
}

/// @notice A contract that answers every claim view like an `EarlierBackers` but has other code (for the Launcher's code
/// check).
contract FakeClaim {
    address public launcher;
    bytes32 public key;
    uint256 public total;

    constructor(address launcher_, bytes32 key_, uint256 total_) {
        (launcher, key, total) = (launcher_, key_, total_);
    }

    function undelivered() external pure returns (uint256) {
        return 0;
    }

    function bind() external {}
}
