// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {IQuoteHook} from "./mocks/QuoteToken.sol";

/// @notice A contract the dollar calls back around a transfer, which uses the call-back to re-enter the Treasury.
contract Reenterer is IQuoteHook {
    address public target;
    bytes public data;
    bool public fired;
    bool public ok;

    function set(address target_, bytes calldata data_) external {
        (target, data, fired, ok) = (target_, data_, false, false);
    }

    function onQuoteTransfer(address, address, uint256, bool) external {
        if (fired) return;
        fired = true;
        (ok,) = target.call(data);
    }
}

contract ReentrancyTest is PotBase {
    /// @dev The dollar calls the pay-and-call receiver in the middle of a payout. The call-back is the Treasury's own entry,
    /// and the dollars it names are real (a donation), so only the lock stands between the payout and a join inside it.
    function test_theDollarCannotReachThePayAndCallEntryDuringAPayout() public {
        uint256 n = _join(alice, 100e6);
        usd.mint(carol, 50e6);
        vm.prank(carol);
        usd.transfer(address(t), 50e6); // unaccounted dollars a re-entrant join could claim
        usd.armCallback(alice, address(t), abi.encodeCall(Treasury.onTransferReceived, (alice, alice, 50e6, abi.encode(uint256(0), alice))));
        _leave(alice, n);
        assertTrue(usd.callbackFired(), "the token did call back during the payout");
        assertFalse(usd.callbackOk(), "and the Treasury refused it");
        assertEq(shares.balanceOf(alice), 0, "no Shares were minted inside the leave");
        assertEq(t.unaccounted(), 50e6);
        _assertConserved();
    }

    function test_theDollarCannotCallSettleOrCollectFeesDuringAPayout() public {
        uint256 n = _join(alice, 100e6);
        usd.armCallback(alice, address(t), abi.encodeCall(Treasury.settle, ()));
        _leave(alice, n);
        assertTrue(usd.callbackFired());
        assertFalse(usd.callbackOk());
        usd.armCallback(platform, address(t), abi.encodeCall(Treasury.collectFees, ()));
        _join(bob, 100e6);
        t.collectFees();
        assertTrue(usd.callbackFired());
        assertFalse(usd.callbackOk());
    }

    function test_aHookedPayerCannotReenterJoinOrRevenueWhilePulling() public {
        Reenterer r = new Reenterer();
        usd.mint(address(r), 300e6);
        r.set(address(t), abi.encodeCall(Treasury.settle, ()));
        usd.setHooked(address(r), true);
        vm.startPrank(address(r));
        usd.approve(address(t), 300e6);
        t.join(100e6, 0, address(r));
        assertTrue(r.fired());
        assertFalse(r.ok(), "join holds the lock while it pulls");
        r.set(address(t), abi.encodeCall(Treasury.settle, ()));
        t.addRevenue(100e6);
        assertTrue(r.fired());
        assertFalse(r.ok(), "so does addRevenue");
        vm.stopPrank();
        _assertConserved();
    }
}
