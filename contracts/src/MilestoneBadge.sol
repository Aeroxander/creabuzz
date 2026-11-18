// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title MilestoneBadge
/// @notice A soulbound NFT that says "this wallet reached this milestone". It is minted by one contract only (the
/// `MilestoneLock` that created it) when a reviewed claim is paid, and it can never move: not a transfer, not an
/// approval. It exists to be read: wallets show it, and a hook (an NFT-gated pool, a perk) can ask `balanceOf`.
/// What it unlocks in the DAO's Shares is decided by the lock, not by owning the NFT, so the badge is a receipt rather
/// than a key that could be traded or lost.
///
/// ERC-721 (read side) and ERC-5192 (soulbound), kept small on purpose.
contract MilestoneBadge {
    string public constant name = "Milestone";
    string public constant symbol = "MILESTONE";

    address public immutable minter;
    uint256 public totalSupply;

    struct Meta {
        bytes32 checkHash;
        uint16 tranche;
        uint96 unlocked;
    }

    mapping(uint256 id => address) private _owner;
    mapping(address holder => uint256) public balanceOf;
    mapping(uint256 id => Meta) public meta;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Locked(uint256 indexed id);

    error NotMinter();
    error Soulbound();
    error NoSuchBadge();

    constructor(address minter_) {
        minter = minter_;
    }

    function mint(address to, bytes32 checkHash, uint16 tranche, uint96 unlockedAmount) external returns (uint256 id) {
        if (msg.sender != minter) revert NotMinter();
        id = ++totalSupply;
        _owner[id] = to;
        unchecked {
            ++balanceOf[to];
        }
        meta[id] = Meta(checkHash, tranche, unlockedAmount);
        emit Transfer(address(0), to, id);
        emit Locked(id);
    }

    function ownerOf(uint256 id) public view returns (address holder) {
        holder = _owner[id];
        if (holder == address(0)) revert NoSuchBadge();
    }

    /// @notice ERC-5192: every badge is locked to its owner.
    function locked(uint256 id) external view returns (bool) {
        ownerOf(id);
        return true;
    }

    function tokenURI(uint256 id) external view returns (string memory) {
        ownerOf(id);
        Meta memory m = meta[id];
        string memory json = string.concat(
            '{"name":"Milestone ',
            Strings.toString(uint256(m.tranche) + 1),
            '","description":"The holder reached a milestone, and the Shares it covers were unlocked.",',
            '"attributes":[{"trait_type":"Check","value":"',
            Strings.toHexString(uint256(m.checkHash), 32),
            '"},{"trait_type":"Unlocked","value":"',
            Strings.toString(uint256(m.unlocked)),
            '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ---- nothing moves --------------------------------------------------------------------------

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function getApproved(uint256 id) external view returns (address) {
        ownerOf(id);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    /// @dev ERC-165: ERC-721, ERC-721 Metadata, ERC-5192.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f
            || interfaceId == 0xb45a3c0e;
    }
}
