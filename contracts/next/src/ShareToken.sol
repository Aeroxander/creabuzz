// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ShareToken
/// @notice A project's Shares: a plain ERC-20 with a fixed supply of 1,000,000,000 (18 decimals). No lock, no
/// call-backs on transfer, no owner, no pause, no mint after birth. A holder may burn their own Shares, or Shares that
/// someone approved them to burn (the treasury's "hand back" uses that).
/// @dev One copy per project, created as a minimal clone by the Launcher, which names the birth recipients in the same
/// transaction. `initialize` works once; the implementation behind the clones is locked in its constructor.
contract ShareToken {
    /// @notice The fixed number of Shares ever minted, in the smallest unit (1,000,000,000 with 18 decimals).
    uint256 public constant SUPPLY = 1_000_000_000e18;
    /// @notice Shares have 18 decimals.
    uint8 public constant decimals = 18;

    /// @notice The project's name for its Shares.
    string public name;
    /// @notice The short ticker of the Shares.
    string public symbol;
    /// @notice Shares in existence (falls only when a holder burns).
    uint256 public totalSupply;
    /// @notice Shares held by an address.
    mapping(address => uint256) public balanceOf;
    /// @notice How many Shares `spender` may move or burn for `owner`.
    mapping(address => mapping(address => uint256)) public allowance;
    bool private _born;

    /// @notice Shares moved. A mint comes from the zero address and a burn goes to it.
    event Transfer(address indexed from, address indexed to, uint256 value);
    /// @notice An allowance was set.
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice `initialize` was already called, or the amounts do not add up to the fixed supply.
    error BadBirth();
    /// @notice The sender holds or is allowed fewer Shares than the amount.
    error InsufficientBalance();
    /// @notice Shares cannot go to the zero address; use `burn`.
    error ZeroRecipient();

    constructor() {
        _born = true; // the copy the clones point at can never be initialised
    }

    /// @notice Mint the whole supply, once, to the named recipients. The Launcher calls it in the same transaction that
    /// creates the clone, so nobody can get in first.
    /// @param name_ The project's name for its Shares.
    /// @param symbol_ The short ticker.
    /// @param to Birth recipients.
    /// @param amounts Shares for each recipient; they must add up to exactly `SUPPLY`.
    function initialize(
        string calldata name_,
        string calldata symbol_,
        address[] calldata to,
        uint256[] calldata amounts
    ) external {
        if (_born || to.length != amounts.length) revert BadBirth();
        _born = true;
        (name, symbol) = (name_, symbol_);
        uint256 sum;
        for (uint256 i; i < to.length; ++i) {
            if (to[i] == address(0)) revert ZeroRecipient();
            balanceOf[to[i]] += amounts[i];
            sum += amounts[i];
            emit Transfer(address(0), to[i], amounts[i]);
        }
        if (sum != SUPPLY) revert BadBirth();
        totalSupply = SUPPLY;
    }

    /// @notice Move your Shares.
    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    /// @notice Allow `spender` to move or burn up to `value` of your Shares.
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    /// @notice Move Shares you were allowed to move. An allowance of the maximum number never goes down.
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        _spendAllowance(from, value);
        _move(from, to, value);
        return true;
    }

    /// @notice Destroy some of your own Shares.
    function burn(uint256 value) external {
        _burn(msg.sender, value);
    }

    /// @notice Destroy Shares you were allowed to burn.
    function burnFrom(address from, uint256 value) external {
        _spendAllowance(from, value);
        _burn(from, value);
    }

    function _spendAllowance(address from, uint256 value) private {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed == type(uint256).max) return;
        if (allowed < value) revert InsufficientBalance();
        allowance[from][msg.sender] = allowed - value;
    }

    function _move(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroRecipient();
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _burn(address from, uint256 value) private {
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }
}
