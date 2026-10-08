// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A plain ERC-20 currency and a Permit2 stand-in that import nothing, so a test can use them beside
/// contracts that need different compiler versions (the auction graph is pinned to 0.8.26, the patched DAO
/// needs 0.8.30). Behaviour mirrors the mocks in `LaunchLifecycle.t.sol`.
contract LaunchCurrency {
    error InsufficientBalance(address from, uint256 balance, uint256 amount);
    error InsufficientAllowance(address from, address spender, uint256 allowance, uint256 amount);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(from, msg.sender, allowed, amount);
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(from, balance, amount);
        balanceOf[from] = balance - amount;
        balanceOf[to] += amount;
    }
}

contract LaunchPermit2 {
    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
    }

    mapping(address owner => mapping(address token => mapping(address spender => PackedAllowance))) public allowance;

    error AllowanceExpired(uint48 expiration);
    error InsufficientAllowance(uint160 maxAmount);
    error TokenTransferFailed();

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] = PackedAllowance({amount: amount, expiration: expiration});
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        PackedAllowance storage allowed = allowance[from][token][msg.sender];
        if (block.timestamp > allowed.expiration) revert AllowanceExpired(allowed.expiration);
        if (allowed.amount != type(uint160).max) {
            if (amount > allowed.amount) revert InsufficientAllowance(allowed.amount);
            allowed.amount -= amount;
        }
        if (!LaunchCurrency(token).transferFrom(from, to, amount)) revert TokenTransferFailed();
    }
}
