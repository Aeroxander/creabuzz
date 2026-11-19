// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ITreasuryClock} from "../../src/Interfaces.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {Vester} from "../../src/Vester.sol";

/// @notice Stands in for the Treasury so the Vester can be driven by hand: the test sets the active clock and the
/// wind-down, and this contract is the controller of the Team token and the only caller the Vester accepts for grants.
contract MockClock is ITreasuryClock {
    ShareToken public token;
    uint256 public activeNow;
    uint64 public windDownAt;
    uint8 public windDownKind;
    uint32 public unit = 7 days;
    uint256 public Z;
    uint256 public announcedCalls;

    function setToken(ShareToken t) external {
        token = t;
    }

    function setActive(uint256 a) external {
        activeNow = a;
    }

    function windDown(uint8 kind, uint64 when) external {
        (windDownKind, windDownAt) = (kind, when);
    }

    function forfeitAnnounced(uint256 amount) external {
        Z += amount;
        ++announcedCalls;
    }

    function forfeitBurn(uint256 amount) external {
        Z -= amount;
        token.burnFor(msg.sender, amount);
    }

    function burnAfterWindDown(uint256 amount) external {
        token.burnFor(msg.sender, amount);
    }

    function callGrant(Vester v, address member, uint256 amount, bool protected_) external returns (uint256) {
        return v.grant(member, amount, protected_);
    }

    function callAnnounceByRunner(Vester v, uint256 id) external {
        v.announceByRunner(id);
    }

    function callExitAll(Vester v, address member) external {
        v.exitAll(member);
    }
}
