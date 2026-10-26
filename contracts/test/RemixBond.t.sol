// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreateCourt} from "../src/CreateCourt.sol";
import {CreateToken} from "../src/CreateToken.sol";
import {IArbitrator} from "../src/OpenBounty.sol";
import {RemixBond} from "../src/RemixBond.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice A remix's bond to its parent (N12), against a real court: posted for a term, forfeited to the parent's DAO
/// only on an upheld case, returned after the term otherwise.
contract RemixBondTest is Test {
    address internal constant FOUNDER = address(0xF0);
    address internal constant PARENT_DAO = address(0xDA0);
    address internal constant CRITIC = address(0xC1);
    address internal constant JUROR = address(0x1D6E);
    bytes32 internal constant REMIX = keccak256("37001:remix");
    bytes32 internal constant PARENT = keccak256("37001:parent");
    string internal constant TERMS = "Credit us on your page.";

    CreateToken internal create;
    MandateCurrency internal usd;
    CreateCourt internal court;
    RemixBond internal bonds;

    function setUp() public {
        vm.warp(10 days);
        create = new CreateToken("Test CREATE", "tCREATE", address(this));
        usd = new MandateCurrency();
        court = new CreateCourt(IERC20(address(create)), IERC20(address(usd)), 100e18, 1e6);
        bonds = new RemixBond(IERC20(address(create)), IArbitrator(address(court)));
        create.transfer(FOUNDER, 5_000e18);
        create.transfer(JUROR, 300e18);
        usd.mint(CRITIC, 100e6);
        vm.prank(FOUNDER);
        create.approve(address(bonds), type(uint256).max);
        vm.prank(CRITIC);
        usd.approve(address(bonds), type(uint256).max);
        vm.startPrank(JUROR);
        create.approve(address(court), type(uint256).max);
        court.stake(300e18);
        vm.stopPrank();
    }

    function _post(uint64 term) internal returns (uint256) {
        vm.prank(FOUNDER);
        return bonds.post(REMIX, PARENT, PARENT_DAO, TERMS, 1_000e18, term);
    }

    function _state(uint256 id) internal view returns (uint8 state) {
        (,,, state,,,,,) = bonds.bonds(id);
    }

    function _judge(uint256 dispute, uint8 choice) internal {
        vm.warp(block.timestamp + court.EVIDENCE());
        court.draw(dispute);
        bytes32 salt = keccak256("s");
        vm.prank(JUROR);
        court.commit(dispute, keccak256(abi.encode(choice, salt, JUROR, dispute, uint256(0))));
        court.passPeriod(dispute);
        vm.prank(JUROR);
        court.reveal(dispute, choice, salt);
        court.passPeriod(dispute);
        vm.warp(block.timestamp + court.APPEAL());
        court.execute(dispute);
    }

    function test_a_bond_is_held_for_its_term_then_returned_to_whoever_posted_it() public {
        uint256 id = _post(90 days);
        assertEq(create.balanceOf(address(bonds)), 1_000e18);
        (,, uint64 releasesAt,,,,,, bytes32 termsHash) = bonds.bonds(id);
        assertEq(termsHash, keccak256(bytes(TERMS)));
        vm.warp(releasesAt - 1);
        vm.expectRevert(abi.encodeWithSelector(RemixBond.NotDue.selector, id, releasesAt));
        bonds.release(id);
        vm.warp(releasesAt);
        vm.prank(CRITIC);
        vm.expectRevert(abi.encodeWithSelector(RemixBond.TermOver.selector, id));
        bonds.openCase(id);
        bonds.release(id); // anyone; it goes back to the founder
        assertEq(create.balanceOf(FOUNDER), 5_000e18);
        vm.expectRevert(abi.encodeWithSelector(RemixBond.NotHeld.selector, id));
        bonds.release(id);
    }

    function test_an_upheld_case_makes_the_bond_the_parents() public {
        uint256 id = _post(90 days);
        _post(90 days); // another bond held here: a second payment could only come out of it
        vm.prank(CRITIC);
        uint256 dispute = bonds.openCase(id);
        assertEq(usd.balanceOf(CRITIC), 97e6, "the critic paid the court's fee");
        vm.prank(CRITIC);
        vm.expectRevert(abi.encodeWithSelector(RemixBond.CaseOpen.selector, id));
        bonds.openCase(id);
        vm.warp(block.timestamp + 200 days);
        vm.expectRevert(abi.encodeWithSelector(RemixBond.CaseOpen.selector, id));
        bonds.release(id);
        _judge(dispute, 1);
        assertEq(_state(id), 2);
        bonds.payParent(id);
        assertEq(create.balanceOf(PARENT_DAO), 1_000e18);
        vm.expectRevert(abi.encodeWithSelector(RemixBond.NotForfeited.selector, id));
        bonds.payParent(id);
    }

    function test_any_other_ruling_leaves_the_bond_held_and_another_case_can_follow() public {
        uint256 id = _post(90 days);
        vm.prank(CRITIC);
        uint256 dispute = bonds.openCase(id);
        _judge(dispute, 2);
        assertEq(_state(id), 1);
        vm.expectRevert(abi.encodeWithSelector(RemixBond.NotForfeited.selector, id));
        bonds.payParent(id);
        vm.prank(CRITIC);
        bonds.openCase(id);
    }

    function test_only_the_court_rules_and_terms_are_bounded() public {
        uint256 id = _post(90 days);
        vm.prank(CRITIC);
        uint256 dispute = bonds.openCase(id);
        vm.prank(CRITIC);
        vm.expectRevert(RemixBond.NotCourt.selector);
        bonds.rule(dispute, 1);
        vm.prank(address(court));
        vm.expectRevert(abi.encodeWithSelector(RemixBond.UnknownCase.selector, 99));
        bonds.rule(99, 1);
        vm.prank(FOUNDER);
        vm.expectRevert(RemixBond.BadTerm.selector);
        bonds.post(REMIX, PARENT, PARENT_DAO, TERMS, 1e18, 30 days - 1);
        vm.prank(FOUNDER);
        vm.expectRevert(RemixBond.BadTerm.selector);
        bonds.post(REMIX, PARENT, PARENT_DAO, TERMS, 1e18, 731 days);
        vm.prank(FOUNDER);
        vm.expectRevert(RemixBond.NothingToBond.selector);
        bonds.post(REMIX, PARENT, address(0), TERMS, 1e18, 30 days);
    }
}
