// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArbitrator, OpenBounty} from "../src/OpenBounty.sol";
import {CreateCourt} from "../src/CreateCourt.sol";
import {CreateToken} from "../src/CreateToken.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice Appeals on bounties on posts (N7): when a claimant can appeal, what refunds wait for, and what each ruling
/// does, against a real court.
contract OpenBountyAppealTest is Test {
    uint256 internal constant SEAT = 100e18;
    uint256 internal constant FEE = 1e6;
    address internal constant BEN = address(0xBE11);
    address internal constant CARA = address(0xCA2A);
    address internal constant DEV = address(0xDE7);
    address internal constant EVE = address(0xE7E);
    address internal constant JUROR = address(0x1D6E);
    bytes32 internal constant POST = keccak256("ben's post");

    MandateCurrency internal usd;
    CreateToken internal create;
    CreateCourt internal court;
    OpenBounty internal bounty;
    uint64 internal deadline;

    function setUp() public {
        vm.warp(100 days);
        usd = new MandateCurrency();
        create = new CreateToken("Test CREATE", "tCREATE", address(this));
        court = new CreateCourt(IERC20(address(create)), IERC20(address(usd)), SEAT, FEE);
        bounty = new OpenBounty(IERC20(address(usd)), IArbitrator(address(court)));
        address[4] memory people = [BEN, CARA, DEV, EVE];
        for (uint256 i; i < people.length; ++i) {
            usd.mint(people[i], 1_000e6);
            vm.prank(people[i]);
            usd.approve(address(bounty), type(uint256).max);
        }
        create.transfer(JUROR, 300e18);
        vm.startPrank(JUROR);
        create.approve(address(court), type(uint256).max);
        court.stake(300e18);
        vm.stopPrank();
        deadline = uint64(block.timestamp + 30 days);
    }

    /// @dev Ben puts 100 behind the post, Cara 50; Dev files a claim nobody backs.
    function _unbackedClaim() internal returns (uint256 id) {
        vm.prank(BEN);
        id = bounty.open(POST, "A painted bike lane on Elm Street.", deadline, 100e6);
        vm.prank(CARA);
        bounty.fund(id, 50e6);
        vm.prank(DEV);
        bounty.fileClaim(id, "https://example.com/lane");
    }

    function _appeal(uint256 id, address who) internal returns (uint256 dispute) {
        vm.prank(who);
        dispute = bounty.appeal(id);
    }

    function _state(uint256 id) internal view returns (uint8 state) {
        (, state,,) = bounty.appeals(id);
    }

    /// @dev The lone juror holds every seat and votes `choice`; the case is then executed.
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

    // ---- when an appeal can be made ------------------------------------------------------------------------------

    function test_a_claimant_appeals_from_the_deadline_until_the_window_closes_and_refunds_wait_for_it() public {
        uint256 id = _unbackedClaim();
        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.NotAppealTime.selector, id));
        _appeal(id, DEV);
        vm.warp(deadline);
        assertFalse(bounty.refundsOpen(id), "claimants get the appeal window first");
        vm.warp(deadline + bounty.APPEAL_WINDOW() - 1);
        assertFalse(bounty.refundsOpen(id));
        vm.warp(deadline + bounty.APPEAL_WINDOW());
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.NotAppealTime.selector, id));
        _appeal(id, DEV);
        assertTrue(bounty.refundsOpen(id));
    }

    function test_only_a_claimant_appeals_once_and_pays_the_court() public {
        uint256 id = _unbackedClaim();
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.NoOpenClaim.selector, id));
        _appeal(id, EVE);
        vm.prank(DEV);
        usd.approve(address(bounty), type(uint256).max);
        uint256 before = usd.balanceOf(DEV);
        uint256 dispute = _appeal(id, DEV);
        assertEq(usd.balanceOf(DEV), before - 3 * FEE);
        assertEq(usd.balanceOf(address(court)), 3 * FEE);
        assertEq(bounty.held(id), 150e6, "the fee never touches the pot");
        assertEq(bounty.bountyOfDispute(dispute), id);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.AlreadyAppealed.selector, id));
        _appeal(id, DEV);
        vm.prank(DEV);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.AppealOpen.selector, id));
        bounty.withdrawClaim(id);
    }

    function test_with_no_claim_there_is_nobody_to_wait_for() public {
        vm.prank(BEN);
        uint256 id = bounty.open(POST, "words", deadline, 10e6);
        vm.warp(deadline - 1);
        assertFalse(bounty.refundsOpen(id));
        vm.warp(deadline);
        assertTrue(bounty.refundsOpen(id));
    }

    function test_no_court_means_no_appeals_and_refunds_at_the_deadline() public {
        OpenBounty plain = new OpenBounty(IERC20(address(usd)), IArbitrator(address(0)));
        vm.prank(BEN);
        usd.approve(address(plain), type(uint256).max);
        vm.prank(BEN);
        uint256 id = plain.open(POST, "words", deadline, 10e6);
        vm.prank(DEV);
        plain.fileClaim(id, "evidence");
        vm.warp(deadline);
        assertTrue(plain.refundsOpen(id));
        vm.prank(DEV);
        vm.expectRevert(OpenBounty.NoCourt.selector);
        plain.appeal(id);
    }

    function test_a_run_that_ends_after_the_deadline_opens_its_own_window() public {
        uint256 id = _unbackedClaim();
        vm.prank(BEN);
        bounty.back(id, 1); // 100 of 150: a majority, the run starts
        vm.warp(deadline + 1 days);
        vm.prank(DEV);
        usd.approve(address(bounty), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.RunOn.selector, id));
        _appeal(id, DEV);
        vm.prank(BEN);
        bounty.unback(id); // the run ends a day after the deadline
        uint64 ended = uint64(block.timestamp);
        vm.warp(ended + bounty.APPEAL_WINDOW() - 1);
        assertFalse(bounty.refundsOpen(id));
        _appeal(id, DEV);
    }

    // ---- what each ruling does -----------------------------------------------------------------------------------

    function test_an_upheld_claim_is_paid_the_whole_pot_and_refunds_stay_shut() public {
        uint256 id = _unbackedClaim();
        vm.warp(deadline);
        vm.prank(DEV);
        usd.approve(address(bounty), type(uint256).max);
        uint256 dispute = _appeal(id, DEV);
        vm.warp(block.timestamp + 40 days); // past refundsFrom: an open appeal still holds the money
        assertFalse(bounty.refundsOpen(id));
        _judge(dispute, 1);
        assertEq(_state(id), 2);
        assertFalse(bounty.refundsOpen(id));
        uint256 before = usd.balanceOf(DEV);
        bounty.pay(id);
        assertEq(usd.balanceOf(DEV), before + 150e6);
        assertEq(bounty.held(id), 0);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.AlreadyPaid.selector, id));
        bounty.refund(id, BEN);
    }

    function test_an_upheld_claim_nobody_pays_in_time_goes_back_to_the_funders() public {
        uint256 id = _unbackedClaim();
        vm.warp(deadline);
        vm.prank(DEV);
        usd.approve(address(bounty), type(uint256).max);
        _judge(_appeal(id, DEV), 1);
        (,,, uint64 ruledAt) = bounty.appeals(id);
        uint64 until = ruledAt + bounty.PAY_GRACE();
        vm.warp(until);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.PayTooLate.selector, id, until));
        bounty.pay(id);
        assertTrue(bounty.refundsOpen(id));
        bounty.refund(id, BEN);
        assertEq(bounty.held(id), 50e6);
    }

    function test_a_refused_appeal_opens_refunds_at_once() public {
        uint256 id = _unbackedClaim();
        vm.warp(deadline);
        vm.prank(DEV);
        usd.approve(address(bounty), type(uint256).max);
        uint256 dispute = _appeal(id, DEV);
        assertFalse(bounty.refundsOpen(id));
        _judge(dispute, 2);
        assertEq(_state(id), 3);
        assertTrue(bounty.refundsOpen(id));
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.NoRun.selector, id));
        bounty.pay(id);
        bounty.refund(id, BEN);
        bounty.refund(id, CARA);
        assertEq(bounty.held(id), 0);
    }

    function test_a_court_that_cannot_rule_leaves_the_bounty_as_it_was() public {
        uint256 id = _unbackedClaim();
        vm.prank(JUROR);
        court.unstake(300e18); // no jurors left
        vm.warp(deadline);
        vm.prank(DEV);
        usd.approve(address(bounty), type(uint256).max);
        uint256 dispute = _appeal(id, DEV);
        vm.warp(block.timestamp + court.EVIDENCE() + court.DRAW_TIMEOUT());
        court.timeout(dispute);
        assertEq(_state(id), 3);
        assertTrue(bounty.refundsOpen(id));
    }

    function test_only_the_court_rules_and_only_on_an_open_appeal() public {
        vm.expectRevert(OpenBounty.NotCourt.selector);
        bounty.rule(1, 1);
        vm.prank(address(court));
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.UnknownDispute.selector, 7));
        bounty.rule(7, 1);
    }
}
