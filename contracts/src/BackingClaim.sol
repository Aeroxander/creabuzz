// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title BackingClaim
/// @notice What a backing pool's opening round sells (docs/v3-review/BACKING-POOL.md): a plain ERC-20 whose
/// whole supply is created once, for the pool that deploys it, and handed to the round's auction. A bidder
/// collects claim tokens from the auction and the pool turns them into backing units one for one, burning
/// them. Nothing else can create or destroy them, and they carry no right but that exchange.
contract BackingClaim {
    string public constant name = "Backing round claim";
    string public constant symbol = "CLAIM";
    uint8 public constant decimals = 18;

    /// @notice The pool that made this token: the only address that can burn it.
    address public immutable pool;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error NotPool();

    /// @param supply The whole supply, minted to the deploying pool.
    constructor(uint256 supply) {
        pool = msg.sender;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    /// @notice Let `spender` move up to `amount` of the caller's tokens.
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @notice Move `amount` of the caller's tokens to `to`.
    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    /// @notice Move `amount` of `from`'s tokens to `to`, within the caller's allowance.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    /// @notice Destroy `amount` of `from`'s tokens. Only the pool, when it gives `from` the units for them.
    function burn(address from, uint256 amount) external {
        if (msg.sender != pool) revert NotPool();
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function _move(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
