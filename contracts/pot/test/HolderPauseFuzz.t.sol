// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {IShares} from "../src/Interfaces.sol";
import {HolderPause} from "../src/HolderPause.sol";

/// @notice A plain share token for the pause's property tests: free minting and burning (the Treasury's join and leave), and
/// the transfer calls the pause makes.
contract MiniShares {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
        totalSupply += v;
    }

    function burn(address from, uint256 v) external {
        balanceOf[from] -= v;
        totalSupply -= v;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        allowance[from][msg.sender] -= v;
        balanceOf[from] -= v;
        balanceOf[to] += v;
        return true;
    }
}

/// @notice Properties of the pause's rule over any supply and any parked amount, and a random walk of joins (mint then poke, as
/// the Treasury does), leaves (burn, no call), park, un-park and time: a clock is armed only over a reached line, and a pause
/// begins only after a full day of a line that was seen reached without a break.
contract HolderPauseFuzzTest is Test {
    MiniShares internal s;
    HolderPause internal p;
    address[3] internal who = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    uint256 internal clock;
    uint256 internal constant DAY = 240; // unit 1,680 seconds

    function setUp() public {
        vm.warp(1_700_000_000);
        clock = 1_700_000_000;
        s = new MiniShares();
        p = HolderPause(Clones.clone(address(new HolderPause())));
        p.initialize(IShares(address(s)), 1680);
        assertEq(p.day(), DAY);
    }

    function _park(address a, uint256 n) internal {
        vm.startPrank(a);
        s.approve(address(p), n);
        p.park(n);
        vm.stopPrank();
    }

    function _warp(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
    }

    function testFuzz_theLineIsReachedExactlyWhenThreeTimesParkedPassesTheSupply(uint256 supply, uint256 k) public {
        supply = bound(supply, 1, 1e30);
        k = bound(k, 1, supply);
        s.mint(who[0], supply);
        _park(who[0], k);
        bool reached = 3 * k >= supply;
        assertEq(p.armedAt() != 0, reached, "armed exactly over a reached line");
        assertEq(p.line(), (supply + 2) / 3, "the line is a third, rounded up");
        assertEq(reached, k >= p.line(), "reached is parked at or over the line");
        (uint256 parked, uint256 b, uint256 lineShares, uint64 armed,, bool isPaused) = p.state();
        assertEq(parked, k);
        assertEq(b, supply);
        assertEq(lineShares, p.line());
        assertEq(armed != 0, reached);
        assertFalse(isPaused, "never paused in the second it is armed");
    }

    function testFuzz_pausedExactlyAfterAFullDayOfALineThatStaysReached(uint256 supply, uint256 dt) public {
        supply = bound(supply, 3, 1e30);
        dt = bound(dt, 0, 3 * DAY);
        s.mint(who[0], supply);
        _park(who[0], (supply + 2) / 3); // exactly the line
        _warp(dt);
        assertEq(p.paused(), dt >= DAY, "paused only once a full day has passed");
        assertEq(p.pausesFrom(), p.armedAt() + DAY);
    }

    /// @dev The random walk. The three holders mint (a join, with the pause poked afterwards), burn (a leave: nothing is
    /// called), park, un-park and let time pass. After every step: an armed clock has the line reached; a pause implies a
    /// reached line and a full day since the arming; and what the contract says is parked is the sum of the holders'.
    function testFuzz_aRandomWalkKeepsTheClockHonest(uint256 seed) public {
        uint256 x = uint256(keccak256(abi.encode(seed)));
        s.mint(who[0], 1000e18);
        s.mint(who[1], 1000e18);
        p.poke();
        for (uint256 i; i < 80; ++i) {
            x = uint256(keccak256(abi.encode(x, i)));
            address a = who[x % 3];
            uint256 kind = (x >> 8) % 7;
            uint256 r = (x >> 32) % 1e24;
            uint64 armedBefore = p.armedAt();
            if (kind == 0) {
                s.mint(a, 1 + r);
                p.poke(); // the Treasury pokes after the mint
            } else if (kind == 1) {
                uint256 bal = s.balanceOf(a);
                if (bal != 0) s.burn(a, 1 + r % bal); // a leave: B falls and the pause is not called
            } else if (kind == 2 || kind == 3) {
                uint256 bal = s.balanceOf(a);
                if (bal != 0) _park(a, 1 + r % bal);
            } else if (kind == 4) {
                uint256 mine = p.parkedOf(a);
                if (mine != 0) {
                    vm.prank(a);
                    p.unpark(1 + r % mine);
                }
            } else if (kind == 5) {
                _warp(1 + r % (2 * DAY));
            } else {
                p.poke();
            }
            uint256 b = s.totalSupply();
            uint256 k = p.parkedTotal();
            uint64 armed = p.armedAt();
            if (armed != 0) {
                assertGe(k * 3, b, "armed over a line that is not reached");
                assertGt(b, 0);
            }
            if (p.paused()) {
                assertGe(k * 3, b, "paused under the line");
                assertGe(clock, uint256(armed) + DAY, "paused before a full day");
            }
            // a clock that was armed before the step and is armed after it is the same clock unless the line was lost in between
            if (armedBefore != 0 && armed != 0 && armed != armedBefore) {
                // the only way a clock changes while staying armed is a break the step itself saw (cleared, then armed again)
                assertGe(armed, armedBefore);
            }
            uint256 sum;
            for (uint256 j; j < 3; ++j) {
                sum += p.parkedOf(who[j]);
            }
            assertEq(sum, k, "the parked total is the sum of what holders parked");
            assertEq(s.balanceOf(address(p)), k, "custody holds exactly what is parked");
        }
    }
}
