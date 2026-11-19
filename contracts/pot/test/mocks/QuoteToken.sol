// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice A call-back an address can ask the quote token to make (like an ERC-777 hook).
interface IQuoteHook {
    /// @notice Called by the token around a transfer to or from a hooked address. `after_` is false before balances
    /// change and true after.
    function onQuoteTransfer(address from, address to, uint256 amount, bool after_) external;
}

/// @notice The dollar token for tests: 6 decimals, free minting, and switches that make it behave like the awkward
/// tokens the Treasury must survive: a fee kept on transfer, a fee charged to the sender on top, `false` instead of a
/// revert, and call-backs around a transfer.
contract QuoteToken {
    string public constant name = "Test Dollar";
    string public constant symbol = "tUSD";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Fee kept from every transfer, in ten-thousandths; the receiver gets less than the amount.
    uint256 public feeBps;
    /// @notice Extra fee charged to the sender on top of the amount, in ten-thousandths.
    uint256 public senderFeeBps;
    /// @notice Return false (and move nothing) instead of reverting when a transfer cannot be made.
    bool public falseOnFail;
    /// @notice Return false and move nothing on every transfer, as a broken token might.
    bool public alwaysFalse;
    /// @notice Addresses that are called back around a transfer.
    mapping(address => bool) public hooked;
    /// @notice Addresses the token refuses to send to or from (a frozen address, as a real stablecoin can have).
    mapping(address => bool) public blocked;
    /// @notice A blocked address makes a transfer return false (and move nothing) instead of reverting, as some tokens do.
    bool public blockedReturnsFalse;

    /// @notice One armed call-back: when dollars are sent to `callbackOn`, the token calls `callbackTarget` with `callbackData`
    /// (a stand-in for a token that calls back into a contract that is in the middle of a call) and records how it went.
    address public callbackOn;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackFired;
    bool public callbackOk;
    bytes public callbackRet;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setFees(uint256 recipientFeeBps, uint256 senderFee) external {
        (feeBps, senderFeeBps) = (recipientFeeBps, senderFee);
    }

    function setFalse(bool onFail, bool always) external {
        (falseOnFail, alwaysFalse) = (onFail, always);
    }

    function setHooked(address who, bool on) external {
        hooked[who] = on;
    }

    function armCallback(address on, address target, bytes calldata data) external {
        (callbackOn, callbackTarget, callbackData, callbackFired) = (on, target, data, false);
    }

    function setBlocked(address who, bool on) external {
        blocked[who] = on;
    }

    function setBlockedReturnsFalse(bool on) external {
        blockedReturnsFalse = on;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (alwaysFalse) return false;
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) {
                if (falseOnFail) return false;
                revert("allowance");
            }
            allowance[from][msg.sender] = allowed - value;
        }
        return _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) private returns (bool) {
        if (alwaysFalse) return false;
        if (blocked[from] || blocked[to]) {
            if (blockedReturnsFalse) return false;
            revert("blocked");
        }
        uint256 extra = value * senderFeeBps / 10_000;
        if (balanceOf[from] < value + extra) {
            if (falseOnFail) return false;
            revert("balance");
        }
        if (hooked[from]) IQuoteHook(from).onQuoteTransfer(from, to, value, false);
        uint256 kept = value * feeBps / 10_000;
        balanceOf[from] -= value + extra;
        balanceOf[to] += value - kept;
        totalSupply -= kept + extra;
        emit Transfer(from, to, value - kept);
        if (callbackOn != address(0) && to == callbackOn && !callbackFired) {
            callbackFired = true;
            (callbackOk, callbackRet) = callbackTarget.call(callbackData);
        }
        if (hooked[to]) IQuoteHook(to).onQuoteTransfer(from, to, value, true);
        return true;
    }
}
