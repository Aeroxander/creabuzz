// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../../src/Treasury.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {HolderPause} from "../../src/HolderPause.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";

/// @notice Drives one project that has a holder pause from six actors: joins (the Treasury pokes the pause itself), leaves,
/// parking (a fraction, or up to the line), un-parking, `poke`, time with check-ins (and the odd lapse), the team's draw and
/// the announcement of a task. It checks inside the steps what needs a before and an after: that park, un-park and poke move
/// no dollar of the Treasury's, and that the two gated calls refuse exactly while `paused()` says so. The first rule a step
/// broke is kept in `violation`, so the invariant file can state each rule once.
contract PauseHandler is Test {
    uint256 internal constant N_ACTORS = 6;

    QuoteToken internal usd;
    Treasury internal t;
    ShareToken internal shares;
    HolderPause internal pause;
    address internal founder;

    address[] internal actors;
    string public violation;
    uint256 public steps;
    uint256 public pausedSeen; // steps that began while paused
    uint256 public armedSeen; // steps that began armed
    uint256 public refusals; // gated calls refused for the pause
    uint256 public allowed; // gated calls that went through

    constructor(QuoteToken usd_, Treasury t_, ShareToken shares_, HolderPause pause_, address founder_) {
        (usd, t, shares, pause, founder) = (usd_, t_, shares_, pause_, founder_);
        for (uint256 i; i < N_ACTORS; ++i) {
            actors.push(makeAddr(string.concat("pause-actor-", vm.toString(i))));
        }
    }

    function actorsList() external view returns (address[] memory) {
        return actors;
    }

    function _who(uint256 seed) internal view returns (address) {
        return actors[seed % N_ACTORS];
    }

    function _fail(string memory why) internal {
        if (bytes(violation).length == 0) violation = why;
    }

    function _begin() internal {
        ++steps;
        if (pause.paused()) ++pausedSeen;
        if (pause.armedAt() != 0) ++armedSeen;
    }

    /// @dev The dollars and every bucket of the Treasury, to compare before and after a step that must not move any.
    function _money() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                usd.balanceOf(address(t)),
                t.pot(),
                t.box(),
                t.arriving(),
                t.feesOwed(),
                t.locked(),
                t.notesOwed(),
                usd.balanceOf(address(pause))
            )
        );
    }

    // ----------------------------------------------------------------------------------------------- steps

    function join(uint256 seed, uint256 amount) external {
        _begin();
        address a = _who(seed);
        amount = bound(amount, 1e6, 30_000e6);
        usd.mint(a, amount);
        vm.startPrank(a);
        usd.approve(address(t), amount);
        try t.join(amount, 0, a) {} catch {}
        vm.stopPrank();
    }

    function leave(uint256 seed, uint256 pct) external {
        _begin();
        address a = _who(seed);
        uint256 bal = shares.balanceOf(a);
        if (bal == 0) return;
        uint256 n = bal * bound(pct, 1, 100) / 100;
        vm.prank(a);
        try t.leave(n, 0, a) {} catch {}
    }

    function park(uint256 seed, uint256 pct) external {
        _begin();
        address a = _who(seed);
        uint256 bal = shares.balanceOf(a);
        if (bal == 0) return;
        uint256 n = bal * bound(pct, 1, 100) / 100;
        bytes32 m = _money();
        vm.startPrank(a);
        shares.approve(address(pause), n);
        try pause.park(n) {} catch {}
        vm.stopPrank();
        if (_money() != m) _fail("park moved dollars");
    }

    /// @dev Park up to the line (or everything the actor has): the line is reached often enough for the pause to be tested.
    function parkToLine(uint256 seed) external {
        _begin();
        address a = _who(seed);
        uint256 need = pause.line();
        uint256 have = pause.parkedTotal();
        if (have >= need) return;
        uint256 n = need - have;
        uint256 bal = shares.balanceOf(a);
        if (n > bal) n = bal;
        if (n == 0) return;
        bytes32 m = _money();
        vm.startPrank(a);
        shares.approve(address(pause), n);
        try pause.park(n) {} catch {}
        vm.stopPrank();
        if (_money() != m) _fail("parkToLine moved dollars");
    }

    function unpark(uint256 seed, uint256 pct) external {
        _begin();
        address a = _who(seed);
        uint256 mine = pause.parkedOf(a);
        if (mine == 0) return;
        uint256 n = mine * bound(pct, 1, 100) / 100;
        if (n == 0) n = 1;
        bytes32 m = _money();
        vm.prank(a);
        try pause.unpark(n) {}
        catch {
            _fail("unpark reverted for a holder who parked that much");
        }
        if (_money() != m) _fail("unpark moved dollars");
    }

    function poke() external {
        _begin();
        bytes32 m = _money();
        pause.poke();
        if (_money() != m) _fail("poke moved dollars");
    }

    /// @dev Time passes; the runner usually checks in (so the project stays active) and now and then does not (a lapse).
    function warp(uint256 secs, uint256 lapse) external {
        _begin();
        secs = bound(secs, 1 minutes, 6 days);
        vm.warp(block.timestamp + secs);
        if (lapse % 11 != 0) {
            vm.prank(founder);
            try t.checkIn(bytes32(0)) {} catch {}
        }
    }

    function draw(uint256 amount) external {
        _begin();
        bool paused_ = pause.paused();
        t.settle();
        uint256 box = t.box();
        if (box == 0) return;
        amount = bound(amount, 1, box);
        vm.prank(founder);
        try t.draw(founder, amount) {
            ++allowed;
            if (paused_) _fail("a draw went through while paused");
        } catch (bytes memory err) {
            if (_selector(err) == Treasury.Paused.selector) {
                ++refusals;
                if (!paused_) _fail("a draw was refused for a pause that was not on");
            } else if (paused_) {
                // refused for another reason while paused is fine only when it is not the pause's doing; the test cannot tell,
                // so only the two exact rules above are asserted
            }
        }
    }

    function announce(uint256 what) external {
        _begin();
        bool paused_ = pause.paused();
        vm.prank(founder);
        try t.announceTask(bytes32(what), address(0), 10e6, 10) {
            ++allowed;
            if (paused_) _fail("a task was announced while paused");
        } catch (bytes memory err) {
            if (_selector(err) == Treasury.Paused.selector) {
                ++refusals;
                if (!paused_) _fail("an announcement was refused for a pause that was not on");
            }
        }
    }

    function _selector(bytes memory err) internal pure returns (bytes4 s) {
        if (err.length < 4) return bytes4(0);
        assembly {
            s := mload(add(err, 0x20))
        }
    }
}
