// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title CreateToken
/// @notice $CREATE (N6, docs/v3-review/CREATE-TOKEN.md): the platform's work token. It is staked to judge cases in the
/// court, posted as a bond where a work budget or a remix asks for one, and paid to the people who do that work. It is
/// not the Shares of any DAO and carries no claim on any treasury: there is no leaving, no payout for holding and no
/// buyback.
///
/// The whole supply is minted once, to `holder`, in the constructor. There is no owner, no further minting, no pause
/// and no blocklist. Vote checkpoints are kept from the first transfer (ERC20Votes), so platform votes on the court's
/// settings can count holders later without moving the token.
contract CreateToken is ERC20, ERC20Permit, ERC20Votes {
    /// @notice Every $CREATE there will ever be.
    uint256 public constant SUPPLY = 1_000_000_000e18;

    error InvalidSetup();

    constructor(string memory name_, string memory symbol_, address holder) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (holder == address(0)) revert InvalidSetup();
        _mint(holder, SUPPLY);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
