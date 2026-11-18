// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IQuoteHook} from "./QuoteToken.sol";

/// @notice An account that the quote token calls back around a transfer. When armed, the call-back makes one call into
/// a target (normally the Treasury, from inside a transfer the Treasury started) and records whether it went through.
contract HookAttacker is IQuoteHook {
    address public target;
    bytes public payload;
    bool public armed;
    bool public fired;
    bool public firedOk;
    bool public onlyAfter;

    function arm(address target_, bytes calldata payload_, bool onlyAfter_) external {
        (target, payload, armed, onlyAfter, fired, firedOk) = (target_, payload_, true, onlyAfter_, false, false);
    }

    function onQuoteTransfer(address, address, uint256, bool after_) external {
        if (!armed || (onlyAfter && !after_)) return;
        armed = false;
        fired = true;
        (firedOk,) = target.call(payload);
    }

    /// @notice Make a call as this account (so this account is the Treasury's caller).
    function act(address to, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = to.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
