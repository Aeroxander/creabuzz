// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Test} from "forge-std/Test.sol";
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {Shares} from "../src/majeur/MolochPatched.sol";

/// @dev The issuance rule's surface, read through an interface so these tests compile (and fail) before it exists.
interface IIssuance {
    function setIssuanceRule(uint16 capBps) external;
    function awardsOnly() external view returns (bool);
    function issuanceCapBps() external view returns (uint16);
    function issuedThisYear() external view returns (uint128);
    function yearBase() external view returns (uint128);
}

/// @dev Stands in for the DAO, so a test can say when an award is under way (the real DAO says so only inside
/// `awardContribution`) and act as the DAO toward its Shares.
contract StandInDao {
    bool public awarding;
    bool public leaving;
    Shares public shares;

    /// @dev Not in the constructor: the Shares call back into their DAO, which needs code by then.
    function start(address[] memory holders, uint256[] memory amounts) external {
        shares = new Shares();
        shares.init(holders, amounts);
    }

    function setAwarding(bool on) external {
        awarding = on;
    }

    function act(bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = address(shares).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    function name(uint256) external pure returns (string memory) {
        return "Stand-in";
    }

    function symbol(uint256) external pure returns (string memory) {
        return "SI";
    }

    function onOwnershipChanged(address, address, uint256) external {}
    function onVotingDelegateChanged(address, address) external {}
    function onSharesChanged(address) external {}
}

/// @dev A lock that holds back a fixed amount, as a team's milestones do.
contract HeldBack {
    uint256 public totalLocked;
    address public holder;

    constructor(address holder_, uint256 amount) {
        holder = holder_;
        totalLocked = amount;
    }

    function lockedOf(address who) external view returns (uint256) {
        return who == holder ? totalLocked : 0;
    }
}

/// D76 (docs/v3-review/TOKENOMICS-CONTRACT-CHANGES.md §4): once the rule is on, new Shares come only from an award, at
/// most a fixed share a year of the Shares that count when someone leaves; a reserve the DAO holds is spent first.
contract IssuanceRuleTest is Test {
    address internal constant BACKER = address(0xBAC);
    address internal constant TEAM = address(0x7EA);
    address internal constant WORKER = address(0x3011);
    uint16 internal constant NO_CAP = type(uint16).max;

    StandInDao internal dao;
    Shares internal shares;

    function setUp() public {
        vm.warp(10 days);
        address[] memory holders = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (holders[0], amounts[0]) = (BACKER, 65e18);
        (holders[1], amounts[1]) = (TEAM, 35e18);
        dao = new StandInDao();
        dao.start(holders, amounts);
        shares = dao.shares();
    }

    function _rule(uint16 capBps) internal {
        dao.act(abi.encodeCall(IIssuance.setIssuanceRule, (capBps)));
    }

    function _award(address to, uint256 amount) internal {
        dao.setAwarding(true);
        dao.act(abi.encodeCall(Shares.mintFromMoloch, (to, amount)));
        dao.setAwarding(false);
    }

    function test_without_the_rule_the_dao_mints_as_before() public {
        dao.act(abi.encodeCall(Shares.mintFromMoloch, (WORKER, 50e18)));
        assertEq(shares.balanceOf(WORKER), 50e18);
    }

    function test_with_the_rule_a_passed_vote_cannot_mint() public {
        _rule(1000);
        assertTrue(IIssuance(address(shares)).awardsOnly());
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        dao.act(abi.encodeCall(Shares.mintFromMoloch, (WORKER, 1)));
    }

    function test_an_award_mints_up_to_the_years_allowance_and_no_further() public {
        _rule(1000);
        _award(WORKER, 6e18);
        _award(WORKER, 4e18);
        assertEq(shares.balanceOf(WORKER), 10e18, "10% of the 100 that count");
        assertEq(IIssuance(address(shares)).issuedThisYear(), 10e18);
        dao.setAwarding(true);
        vm.expectRevert();
        dao.act(abi.encodeCall(Shares.mintFromMoloch, (WORKER, 1)));
    }

    function test_the_allowance_is_measured_against_the_shares_that_can_leave() public {
        HeldBack lock = new HeldBack(TEAM, 35e18);
        dao.act(abi.encodeCall(Shares.setLockGuard, (address(lock))));
        _rule(1000);
        // 100 outside the DAO, 35 still locked: 10% of the 65 that can leave is 6.5.
        _award(WORKER, 6.5e18);
        assertEq(IIssuance(address(shares)).yearBase(), 65e18);
        dao.setAwarding(true);
        vm.expectRevert();
        dao.act(abi.encodeCall(Shares.mintFromMoloch, (WORKER, 1)));
    }

    function test_a_new_year_starts_a_new_allowance_on_a_new_base() public {
        _rule(1000);
        _award(WORKER, 10e18);
        vm.warp(vm.getBlockTimestamp() + 365 days);
        _award(WORKER, 11e18); // 10% of the 110 that count now
        assertEq(shares.balanceOf(WORKER), 21e18);
        assertEq(IIssuance(address(shares)).yearBase(), 110e18);
    }

    function test_an_award_is_paid_from_the_daos_own_holding_first_and_counts_the_same() public {
        dao.act(abi.encodeCall(Shares.mintFromMoloch, (address(dao), 4e18))); // a reserve, before the rule
        _rule(1000);
        uint256 supply = shares.totalSupply();
        _award(WORKER, 7e18);
        assertEq(shares.balanceOf(address(dao)), 0, "the reserve went first");
        assertEq(shares.balanceOf(WORKER), 7e18);
        assertEq(shares.totalSupply(), supply + 3e18, "only the rest was minted");
        assertEq(IIssuance(address(shares)).issuedThisYear(), 7e18, "both count");
    }

    function test_outside_an_award_the_dao_cannot_hand_out_its_own_shares() public {
        dao.act(abi.encodeCall(Shares.mintFromMoloch, (address(dao), 4e18)));
        _rule(1000);
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        dao.act(abi.encodeCall(Shares.transfer, (WORKER, 1e18)));
        assertEq(shares.balanceOf(address(dao)), 4e18);
    }

    function test_the_cap_can_be_lowered_never_raised_and_the_rule_never_turned_off() public {
        _rule(1000);
        _rule(500);
        assertEq(IIssuance(address(shares)).issuanceCapBps(), 500);
        vm.expectRevert();
        _rule(501);
        _rule(0);
        assertTrue(IIssuance(address(shares)).awardsOnly());
        dao.setAwarding(true);
        vm.expectRevert();
        dao.act(abi.encodeCall(Shares.mintFromMoloch, (WORKER, 1)));
    }

    function test_a_cap_above_everything_is_refused_but_no_cap_is_allowed_for_contributor_projects() public {
        vm.expectRevert();
        _rule(10_001);
        _rule(NO_CAP);
        _award(WORKER, 1000e18);
        assertEq(shares.balanceOf(WORKER), 1000e18, "awards only, no yearly limit");
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        dao.act(abi.encodeCall(Shares.mintFromMoloch, (WORKER, 1)));
        _rule(1000); // a contributor project can adopt a limit later
        assertEq(IIssuance(address(shares)).issuanceCapBps(), 1000);
    }
}

/// The rule on a real DAO: Loot cannot be minted once it is on (no Loot ever exists in a kit's DAO).
contract IssuanceRuleOnARealDaoTest is VotingFixture {
    function test_loot_cannot_be_minted_once_the_rule_is_on() public {
        vm.prank(address(dao));
        IIssuance(address(shares)).setIssuanceRule(1000);
        vm.prank(address(dao));
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        loot.mintFromMoloch(CAROL, 1e18);
        vm.prank(address(dao));
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        shares.mintFromMoloch(CAROL, 1e18);
    }
}
