// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Treasury} from "../../src/Treasury.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {Vester} from "../../src/Vester.sol";
import {Pair} from "../../src/Pair.sol";
import {Parts} from "../../src/Parts.sol";
import {Launcher} from "../../src/Launcher.sol";
import {TaskBook} from "../../src/TaskBook.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";

/// @notice The handles of one launched project.
struct Proj {
    bytes32 key;
    Treasury t;
    ShareToken shares;
    ShareToken team;
    Vester v;
}

/// @notice Launches projects through the real Launcher (clones of the real Treasury, Vester and tokens) and gives the tests
/// the small actions every file needs. The default project is `t`, `shares`, `team`, `v`; `_launch` makes more.
abstract contract StackBase is Test {
    uint256 internal constant U = 1e6; // one dollar
    uint256 internal constant S = 1e18; // one Share
    uint32 internal constant UNIT = 7 days;
    uint256 internal constant DAY = 1 days;
    uint256 internal constant POOL = 10_000_000e18;
    uint256 internal constant T0 = 1_700_000_000;

    QuoteToken internal usd;
    Parts internal parts;
    Launcher internal launcher;
    Treasury internal t;
    ShareToken internal shares;
    ShareToken internal team;
    Vester internal v;
    bytes32 internal key;

    address internal admin = makeAddr("admin");
    address internal founder = makeAddr("founder");
    address internal platform = makeAddr("platform");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        vm.warp(T0);
        usd = new QuoteToken();
        parts = new Parts();
        launcher = new Launcher(admin, _platform(UNIT), parts);
        _use(_launch(founder, "p1", 1000, POOL));
    }

    function _platform(uint32 unit_) internal view returns (Launcher.Platform memory) {
        return
            Launcher.Platform({
                quote: IERC20(address(usd)), platform: platform, feeBps: 200, unit: unit_, agentUsd: 25e6
            });
    }

    /// @dev Launch a project as `who` through the Launcher.
    function _launch(address who, bytes32 id, uint32 rate, uint256 pool) internal returns (Proj memory p) {
        bytes32 h = launcher.settingsHash();
        vm.prank(who);
        (address sh, address tm, address tr, address vs) =
            launcher.launch(id, "Project", "PRJ", Launcher.Terms({ratePpm: rate, teamPool: pool}), h);
        p = Proj({
            key: launcher.keyOf(who, id), t: Treasury(tr), shares: ShareToken(sh), team: ShareToken(tm), v: Vester(vs)
        });
    }

    /// @dev Make a launched project the default one.
    function _use(Proj memory p) internal {
        (key, t, shares, team, v) = (p.key, p.t, p.shares, p.team, p.v);
    }

    /// @dev Pay `amount` into the project from `who` (minting the dollars first) and return the Shares.
    function _join(address who, uint256 amount) internal returns (uint256 n) {
        return _joinIn(t, who, amount);
    }

    function _joinIn(Treasury tr, address who, uint256 amount) internal returns (uint256 n) {
        usd.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(tr), amount);
        n = tr.join(amount, 0, who);
        vm.stopPrank();
    }

    function _leave(address who, uint256 n) internal returns (uint256 cash) {
        vm.prank(who);
        cash = t.leave(n, 0, who);
    }

    function _revenue(address who, uint256 amount) internal {
        usd.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(t), amount);
        t.addRevenue(amount);
        vm.stopPrank();
    }

    /// @dev The runner checks in (whoever the runner is: a person or a Pair, which checks in through either signer).
    function _checkIn() internal {
        vm.prank(t.runner());
        t.checkIn(bytes32(0));
    }

    /// @dev Let `secs` of active time pass, a time unit at a time with a check-in before the window closes.
    function _active(uint256 secs) internal {
        uint256 left = secs;
        while (left > 0) {
            uint256 step = left > UNIT ? UNIT : left;
            vm.warp(block.timestamp + step);
            left -= step;
            _checkIn();
        }
    }

    /// @dev The runner (a person) grants Team Shares.
    function _grant(address member, uint256 amount) internal returns (uint256 id) {
        vm.prank(t.runner());
        id = t.grantTeam(member, amount);
    }

    /// @dev Offer the seat to the Pair of (founder, second), and have the second signer make it.
    function _makePair(address second) internal returns (Pair pair) {
        address predicted = launcher.pairAddress(key, founder, second);
        vm.prank(founder);
        t.handOver(predicted, false);
        vm.prank(second);
        pair = Pair(launcher.makePair(key, founder));
        assertEq(address(pair), predicted);
    }

    /// @dev The default project's task book.
    function _book() internal view returns (TaskBook) {
        return TaskBook(address(t.tasks()));
    }

    /// @dev Propose a call to the Treasury from `a` and confirm it from `b`.
    function _both(Pair pair, address a, address b, bytes memory data) internal {
        _bothTo(pair, a, b, address(t), data);
    }

    function _bothTo(Pair pair, address a, address b, address target, bytes memory data) internal {
        uint256 n = pair.nonce();
        vm.prank(a);
        pair.propose(target, data);
        vm.prank(b);
        pair.confirm(target, data, n);
    }

    /// @dev Everything the contract holds is accounted for, and nothing is owed that is not held.
    function _assertConserved() internal view {
        uint256 accounted = t.pot() + t.box() + t.arriving() + t.feesOwed() + t.locked() + t.notesOwed();
        assertGe(usd.balanceOf(address(t)), accounted, "owes more than it holds");
    }
}
