// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./StackBase.sol";
import {HolderPause} from "../../src/HolderPause.sol";
import {Launcher} from "../../src/Launcher.sol";
import {Parts} from "../../src/Parts.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";

/// @notice The real stack with the holder pause switched on (the Launcher is bound to a real `HolderPause` implementation
/// before any launch, as the deploy script does it), and the small actions the pause tests share. The default project
/// is born with a pause (`pause`); `_launch` makes more.
abstract contract PauseBase is StackBase {
    HolderPause internal pause;
    HolderPause internal pauseImpl;
    /// @dev The test's own copy of the block time, in storage. `vm.warp(block.timestamp + x)` and later reads of
    /// `block.timestamp` inside one test function are unreliable under the optimizer (it treats the opcode as constant within
    /// the transaction and caches it across the cheatcode call), so every test moves and reads time through this variable.
    uint256 internal clock;

    function setUp() public virtual override {
        vm.warp(T0);
        clock = T0;
        usd = new QuoteToken();
        parts = new Parts();
        launcher = new Launcher(admin, _platform(UNIT), parts);
        pauseImpl = new HolderPause();
        launcher.bindPause(address(pauseImpl));
        _use(_launch(founder, "p1", 1000, POOL));
        pause = HolderPause(t.pauseGate());
    }

    /// @dev Warning period of the default project in seconds.
    function _day() internal view returns (uint256) {
        return pause.day();
    }

    /// @dev Park `n` of `who`'s Shares (approving first).
    function _park(address who, uint256 n) internal {
        vm.startPrank(who);
        shares.approve(address(pause), n);
        pause.park(n);
        vm.stopPrank();
    }

    function _unpark(address who, uint256 n) internal {
        vm.prank(who);
        pause.unpark(n);
    }

    /// @dev Park the fewest Shares of `who` that reach the line now.
    function _parkToLine(address who) internal {
        uint256 need = pause.line();
        uint256 have = pause.parkedOf(who);
        if (need > have) _park(who, need - have);
    }

    /// @dev A project with `alice` holding every backer Share (a pot of about `gross` dollars after the fee).
    function _aliceBacks(uint256 gross) internal returns (uint256 n) {
        n = _join(alice, gross);
    }

    /// @dev Move time forward by `secs`.
    function _warp(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
    }

    /// @dev Move time to the absolute second `ts` (never backwards).
    function _warpTo(uint256 ts) internal {
        require(ts >= clock, "time only moves forward");
        clock = ts;
        vm.warp(ts);
    }

    /// @dev Move time to `ts`, a time unit at a time with a check-in before the window closes, so the project stays active.
    function _warpAlive(uint256 ts) internal {
        while (clock + 6 days < ts) {
            _warp(6 days);
            _checkIn();
        }
        _warpTo(ts);
        _checkIn();
    }

    /// @dev Wait `secs`, keeping the project active with check-ins (the runner is a person here).
    function _wait(uint256 secs) internal {
        _warpAlive(clock + secs);
    }

    /// @dev Let one day pass keeping the project active.
    function _oneDay() internal {
        _warp(_day());
        _checkIn();
    }
}
