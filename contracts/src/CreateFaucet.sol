// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title CreateFaucet
/// @notice Test networks only: hands out test $CREATE so people can stake, judge and post bonds (N6). Each wallet can take
/// `PER_DAY` once a day until the faucet runs dry. No owner, no refill rule, no way to take the tokens back out.
contract CreateFaucet {
    using SafeERC20 for IERC20;

    /// @notice What one wallet gets per day.
    uint256 public constant PER_DAY = 1_000e18;

    IERC20 public immutable token;
    /// @notice When each wallet last took some (unix seconds); zero if never.
    mapping(address => uint64) public lastDrip;

    error InvalidSetup();
    error TooSoon(uint64 nextAt);
    error Empty();

    event Dripped(address indexed to, uint256 amount);

    constructor(IERC20 token_) {
        if (address(token_).code.length == 0) revert InvalidSetup();
        token = token_;
    }

    /// @notice Take today's test $CREATE.
    function drip() external {
        uint64 last = lastDrip[msg.sender];
        if (last != 0 && block.timestamp < uint256(last) + 1 days) revert TooSoon(last + 1 days);
        if (token.balanceOf(address(this)) < PER_DAY) revert Empty();
        lastDrip[msg.sender] = uint64(block.timestamp);
        token.safeTransfer(msg.sender, PER_DAY);
        emit Dripped(msg.sender, PER_DAY);
    }
}
