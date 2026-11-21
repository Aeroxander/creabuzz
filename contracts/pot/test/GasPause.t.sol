// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {PauseBase} from "./helpers/PauseBase.sol";
import {Launcher} from "../src/Launcher.sol";

/// @notice What the pause's hooks cost the three existing calls that carry them (`join`, `draw`, `announceTask`) and the launch.
/// The baseline is ABSOLUTE: the gas of the same scenarios on the build at 1fed95002 (measured by `Gas.t.sol`, `GasTasks.t.sol`
/// and a launch probe before any edit), recorded below as constants. With the switch off a call may cost at most 2,500 more
/// (one cold read of `pauseGate`); with the switch on at most 25,000 more. Every other call (`leave`, `leaveTeam`, ...) carries no
/// new instruction at all, which the switch-off suite checks by comparing it with the old figures too.
/// Each suite builds its scenario in `setUp` and measures in the test, exactly as `Gas.t.sol` and `GasTasks.t.sol` do: a
/// scenario built inside the measured transaction would leave storage slots dirty and make every write cheaper than in the
/// old figures.
abstract contract GasMeasure is StackBase {
    uint256 internal constant JOIN_BASE = 147_527;
    uint256 internal constant DRAW_BASE = 101_762;
    uint256 internal constant ANNOUNCE_BASE = 219_566;
    uint256 internal constant LEAVE_QUARTER_BASE = 134_516;
    uint256 internal constant LEAVE_TEAM_BASE = 131_467;
    uint256 internal constant LAUNCH_BASE = 898_735;
    uint256 internal constant OFF_EXTRA = 2500;
    uint256 internal constant ON_EXTRA = 25_000;

    /// @dev Make every contract a call touches cold, as in a fresh transaction (`Gas.t.sol` does the same).
    function _cold() internal virtual {
        vm.cool(address(t));
        vm.cool(address(shares));
        vm.cool(address(team));
        vm.cool(address(usd));
        vm.cool(address(v));
    }

    /// @dev The set `GasTasks.t.sol` makes cold.
    function _coldTasks() internal virtual {
        vm.cool(address(t));
        vm.cool(address(_book()));
        vm.cool(address(usd));
        vm.cool(address(shares));
    }

    /// @dev The scenario of `Gas.t.sol`.
    function _gasScenario() internal {
        _join(alice, 50_000e6);
        _join(bob, 20_000e6);
        _revenue(carol, 5000e6);
        vm.prank(founder);
        t.grantTeam(dave, 1_000_000e18);
        _active(14 * uint256(UNIT));
        v.claim(0);
        vm.warp(block.timestamp + 2 days);
    }

    function _measureJoin() internal returns (uint256 used) {
        usd.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usd.approve(address(t), 100e6);
        _cold();
        uint256 g = gasleft();
        t.join(100e6, 0, stranger);
        used = g - gasleft();
        vm.stopPrank();
    }

    function _measureDraw() internal returns (uint256 used) {
        t.settle();
        uint256 box = t.box();
        vm.startPrank(founder);
        _cold();
        uint256 g = gasleft();
        t.draw(founder, box);
        used = g - gasleft();
        vm.stopPrank();
    }

    function _measureAnnounce() internal returns (uint256 used) {
        vm.startPrank(founder);
        _coldTasks();
        uint256 g = gasleft();
        t.announceTask(keccak256("a task"), makeAddr("worker"), 1000e6, 100);
        used = g - gasleft();
        vm.stopPrank();
    }

    function _measureLeave() internal returns (uint256 used) {
        uint256 n = shares.balanceOf(alice);
        vm.startPrank(alice);
        _cold();
        uint256 g = gasleft();
        t.leave(n / 4, 0, alice);
        used = g - gasleft();
        vm.stopPrank();
    }

    function _measureLeaveTeam() internal returns (uint256 used) {
        uint256 n = team.balanceOf(dave) / 2;
        vm.startPrank(dave);
        _cold();
        uint256 g = gasleft();
        t.leaveTeam(n, 0, dave);
        used = g - gasleft();
        vm.stopPrank();
    }

    function _measureLaunch(Launcher l) internal returns (uint256 used) {
        bytes32 h = l.settingsHash();
        vm.cool(address(l));
        vm.prank(alice);
        uint256 g = gasleft();
        l.launch("gas-probe", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        used = g - gasleft();
    }
}

/// @dev The scenario of `Gas.t.sol` (join, draw, take-outs), switch off.
contract GasPauseOffTest is GasMeasure {
    function setUp() public override {
        super.setUp();
        _gasScenario();
    }

    function test_gas_switchOff_join() public {
        uint256 used = _measureJoin();
        emit log_named_uint("join, switch off, gas (old build: 147,527)", used);
        assertLe(used, JOIN_BASE + OFF_EXTRA);
    }

    function test_gas_switchOff_draw() public {
        uint256 used = _measureDraw();
        emit log_named_uint("draw, switch off, gas (old build: 101,762)", used);
        assertLe(used, DRAW_BASE + OFF_EXTRA);
    }

    function test_gas_switchOff_leaveCarriesNoNewInstruction() public {
        uint256 used = _measureLeave();
        emit log_named_uint("leave a quarter, switch off, gas (old build: 134,516)", used);
        // no instruction of `leave` changed; the dispatcher's selector search moves by tens of gas when a function is added
        assertLe(used, LEAVE_QUARTER_BASE + 100, "leave costs what it did, to within the dispatcher");
    }

    function test_gas_switchOff_leaveTeamCarriesNoNewInstruction() public {
        uint256 used = _measureLeaveTeam();
        emit log_named_uint("leave Team Shares, switch off, gas (old build: 131,467)", used);
        assertLe(used, LEAVE_TEAM_BASE + 100, "leaveTeam costs what it did, to within the dispatcher");
    }
}

/// @dev The scenario of `GasTasks.t.sol` (two backers), switch off: announce and launch.
contract GasPauseOffTasksTest is GasMeasure {
    function setUp() public override {
        super.setUp();
        _join(alice, 50_000e6);
        _join(bob, 20_000e6);
    }

    function test_gas_switchOff_announce() public {
        uint256 used = _measureAnnounce();
        emit log_named_uint("announce, switch off, gas (old build: 219,566)", used);
        assertLe(used, ANNOUNCE_BASE + OFF_EXTRA);
    }

    function test_gas_switchOff_launch() public {
        uint256 used = _measureLaunch(launcher);
        emit log_named_uint("launch, switch off, gas (old build: 898,735)", used);
        assertLe(used, LAUNCH_BASE + 5000);
    }
}

abstract contract GasOn is PauseBase, GasMeasure {
    function setUp() public virtual override(PauseBase, StackBase) {
        PauseBase.setUp();
    }

    function _cold() internal override {
        super._cold();
        vm.cool(address(pause));
        vm.cool(address(pauseImpl));
    }

    function _coldTasks() internal override {
        super._coldTasks();
        vm.cool(address(pause));
        vm.cool(address(pauseImpl));
    }
}

contract GasPauseOnTest is GasOn {
    function setUp() public override {
        super.setUp();
        _gasScenario();
    }

    function test_gas_switchOn_join_nothingParked() public {
        uint256 used = _measureJoin();
        emit log_named_uint("join, switch on, nothing parked, gas", used);
        assertLe(used, JOIN_BASE + ON_EXTRA);
    }

    function test_gas_switchOn_draw_nothingParked() public {
        uint256 used = _measureDraw();
        emit log_named_uint("draw, switch on, nothing parked, gas", used);
        assertLe(used, DRAW_BASE + ON_EXTRA);
    }

    function test_gas_park_unpark_poke() public {
        uint256 n = shares.balanceOf(alice) / 3;
        vm.startPrank(alice);
        shares.approve(address(pause), n);
        vm.cool(address(pause));
        vm.cool(address(pauseImpl));
        vm.cool(address(shares));
        uint256 g = gasleft();
        pause.park(n);
        emit log_named_uint("park (first, arms the clock), gas", g - gasleft());
        g = gasleft();
        pause.unpark(n / 2);
        emit log_named_uint("unpark half, gas", g - gasleft());
        vm.stopPrank();
        g = gasleft();
        pause.poke();
        emit log_named_uint("poke, gas", g - gasleft());
    }
}

/// @dev The scenario of `Gas.t.sol` with a third of the Shares parked (the line reached, the warning day running).
contract GasPauseOnArmedTest is GasOn {
    function setUp() public override {
        super.setUp();
        _gasScenario();
        _parkToLine(alice);
    }

    function test_gas_switchOn_join_lineReached() public {
        // the join lifts B and clears the clock: a write
        uint256 used = _measureJoin();
        emit log_named_uint("join, switch on, line reached (clears the clock), gas", used);
        assertLe(used, JOIN_BASE + ON_EXTRA);
        assertEq(pause.armedAt(), 0);
    }

    function test_gas_switchOn_draw_lineReachedNotYetAPause() public {
        uint256 used = _measureDraw();
        emit log_named_uint("draw, switch on, line reached within the warning day, gas", used);
        assertLe(used, DRAW_BASE + ON_EXTRA);
    }
}

contract GasPauseOnTasksTest is GasOn {
    function setUp() public override {
        super.setUp();
        _join(alice, 50_000e6);
        _join(bob, 20_000e6);
    }

    function test_gas_switchOn_announce_nothingParked() public {
        uint256 used = _measureAnnounce();
        emit log_named_uint("announce, switch on, nothing parked, gas", used);
        assertLe(used, ANNOUNCE_BASE + ON_EXTRA);
    }

    function test_gas_switchOn_launch() public {
        uint256 used = _measureLaunch(launcher);
        emit log_named_uint("launch, switch on (clone, initialize, bind), gas", used);
        assertLe(used, LAUNCH_BASE + 150_000);
    }
}
