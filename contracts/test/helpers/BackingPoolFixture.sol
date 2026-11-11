// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackingPool} from "../../src/BackingPool.sol";

/// @dev A plain 18-decimal token anyone can mint.
contract PoolQuote is ERC20 {
    constructor() ERC20("Pool quote", "PQ") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A token that keeps 1% of every transfer.
contract SkimmingQuote is ERC20 {
    constructor() ERC20("Skimming quote", "SKIM") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 cut = value / 100;
            super._update(from, address(0xdead), cut);
            value -= cut;
        }
        super._update(from, to, value);
    }
}

/// @dev A token that can refuse transfers to one address (a blocklist), switched on and off.
contract BlockingQuote is ERC20 {
    address public blocked;

    constructor() ERC20("Blocking quote", "BLK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who) external {
        blocked = who;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to == address(0) || to != blocked, "blocked");
        super._update(from, to, value);
    }
}

/// @dev A token that calls back into the pool in the middle of every transfer it is asked to make.
contract ReenteringQuote is ERC20 {
    BackingPool public pool;
    bytes public attack;
    bool public reentered;
    bytes public lastRevert;

    constructor() ERC20("Reentering quote", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(BackingPool pool_, bytes calldata attack_) external {
        pool = pool_;
        attack = attack_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(pool) != address(0) && attack.length != 0 && (to == address(pool) || from == address(pool))) {
            bytes memory call_ = attack;
            attack = "";
            (bool ok, bytes memory ret) = address(pool).call(call_);
            reentered = !ok;
            lastRevert = ret;
        }
    }
}

/// @dev Stands in for the DAO where a test needs only "an address with code that receives the tranches".
contract TreasuryStub {}

/// @dev The pool on its own, with the factory's default terms: a treasury stub, a founder, a quote token
/// and a few funded backers.
abstract contract BackingPoolFixture is Test {
    address internal constant FOUNDER = address(0xF0);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA201);
    address internal constant MALLORY = address(0xBAD);
    bytes32 internal constant REF = keccak256("record event: milestone 1");

    PoolQuote internal quote;
    address internal treasury;
    BackingPool internal pool;

    function defaultTerms() internal pure returns (BackingPool.Params memory p) {
        p.virtualQuote = 25_000e18;
        p.virtualUnits = 1_000_000_000e18;
        p.projectBps = 3000;
        p.feeBps = 100;
        p.trancheBps = 2500;
        p.objectionBps = 2000;
        p.objectionWindow = 7 days;
        p.claimInterval = 28 days;
        p.abandonAfter = 180 days;
        p.voteSeasoning = 30 days;
        p.voteAfter = 90 days;
        p.earlyWindow = 1 days;
        p.earlyCap = 1_000e18;
    }

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        quote = new PoolQuote();
        treasury = address(new TreasuryStub());
        pool = new BackingPool(treasury, FOUNDER, IERC20(address(quote)), defaultTerms());
        _fund(ALICE);
        _fund(BOB);
        _fund(CAROL);
        _fund(MALLORY);
    }

    function _fund(address who) internal {
        quote.mint(who, 10_000_000e18);
        vm.prank(who);
        quote.approve(address(pool), type(uint256).max);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _skip(uint256 by) internal {
        vm.warp(vm.getBlockTimestamp() + by);
    }

    /// @dev Past the early window, where the per-wallet cap no longer applies.
    function _pastEarly() internal {
        _skip(1 days);
    }

    function _buy(address who, uint256 amount) internal returns (uint256 units) {
        vm.prank(who);
        units = pool.buy(amount, 0, type(uint256).max);
    }

    function _sell(address who, uint256 units) internal returns (uint256 out) {
        vm.prank(who);
        out = pool.sell(units, 0, type(uint256).max);
    }

    function _sellAll(address who) internal returns (uint256 out) {
        uint256 units = pool.balanceOf(who);
        if (units == 0) return 0;
        return _sell(who, units);
    }

    function _post() internal returns (uint256 id) {
        if (_now() < pool.nextClaimAt()) vm.warp(pool.nextClaimAt());
        vm.prank(FOUNDER);
        id = pool.postMilestone(REF);
    }

    function _status(uint256 id) internal view returns (BackingPool.MilestoneStatus status) {
        (,,, status,,,) = pool.milestones(id);
    }

    /// @dev The pool holds what its books say, to the unit.
    function _assertSolvent() internal view {
        assertEq(
            quote.balanceOf(address(pool)), pool.reserve() + pool.escrow() + pool.treasuryOwed(), "books != balance"
        );
    }
}
