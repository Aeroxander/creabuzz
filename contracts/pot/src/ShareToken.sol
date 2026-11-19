// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title ShareToken
/// @notice A plain ERC-20 with 18 decimals, used twice per project: once for backer Shares and once for Team Shares.
/// No lock, no call-backs on transfer, no owner, no pause. Only the `controller` (the project's Treasury) mints and
/// burns. There is deliberately no public `burn` or `burnFrom`: Shares are destroyed only by the Treasury, and the
/// Treasury destroys only the caller's own Shares inside `leave` and `leaveTeam` (and the Vester's own forfeited Team
/// Shares). Anyone can still send Shares to another address.
/// @dev One copy per instance, created as a minimal clone; `initialize` works once, and the implementation behind the
/// clones is locked in its constructor.
contract ShareToken {
    /// @notice Shares have 18 decimals.
    uint8 public constant decimals = 18;

    /// @notice The name of the token.
    string public name;
    /// @notice The short ticker.
    string public symbol;
    /// @notice Shares in existence.
    uint256 public totalSupply;
    /// @notice Shares held by an address.
    mapping(address => uint256) public balanceOf;
    /// @notice How many Shares `spender` may move for `owner`.
    mapping(address => mapping(address => uint256)) public allowance;
    /// @notice The one address that may mint and burn.
    address public controller;
    bool private _born;

    /// @notice Shares moved. A mint comes from the zero address and a burn goes to it.
    event Transfer(address indexed from, address indexed to, uint256 value);
    /// @notice An allowance was set.
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice `initialize` was already called, or its input is not usable.
    error BadBirth();
    /// @notice Only the controller may do this.
    error NotController();
    /// @notice The holder or the allowance covers fewer Shares than the amount.
    error InsufficientBalance();
    /// @notice Shares cannot go to the zero address.
    error ZeroRecipient();

    constructor() {
        _born = true; // the copy the clones point at can never be initialised
    }

    /// @notice Set the token up, once. The Launcher calls it in the transaction that creates the clone.
    /// @param name_ The token's name.
    /// @param symbol_ The short ticker.
    /// @param controller_ The Treasury: the only address that may mint and burn.
    /// @param recipient Gets `amount` at birth (the Vester for the Team pool); ignored when `amount` is zero.
    /// @param amount Shares minted at birth; zero for backer Shares.
    function initialize(
        string calldata name_,
        string calldata symbol_,
        address controller_,
        address recipient,
        uint256 amount
    ) external {
        if (_born || controller_ == address(0) || (amount != 0 && recipient == address(0))) {
            revert BadBirth();
        }
        _born = true;
        (name, symbol, controller) = (name_, symbol_, controller_);
        if (amount != 0) _mint(recipient, amount);
    }

    /// @notice Create Shares. Only the controller.
    function mint(address to, uint256 value) external {
        if (msg.sender != controller) revert NotController();
        _mint(to, value);
    }

    /// @notice Destroy `value` of `from`'s Shares. Only the controller.
    function burnFor(address from, uint256 value) external {
        if (msg.sender != controller) revert NotController();
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    /// @notice Move your Shares.
    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    /// @notice Allow `spender` to move up to `value` of your Shares.
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    /// @notice Move Shares you were allowed to move. An allowance of the maximum number never goes down.
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientBalance();
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _mint(address to, uint256 value) private {
        if (to == address(0)) revert ZeroRecipient();
        balanceOf[to] += value;
        totalSupply += value;
        emit Transfer(address(0), to, value);
    }

    function _move(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroRecipient();
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
