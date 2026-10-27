// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {Call} from "../src/majeur/MolochPatched.sol";
import {Payouts, PayoutsFactory} from "../src/Payouts.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice A module that names some other DAO.
contract OtherDaosModule {
    function dao() external pure returns (address) {
        return address(0xBEEF);
    }
}

/// @notice Payouts (N10) on a real summoned DAO: Alice holds 100 Shares and Bob 100 Loot, so each is half of what counts.
contract PayoutsTest is VotingFixture {
    address internal constant DORA = address(0xD0A);
    MandateCurrency internal usd;
    PayoutsFactory internal factory;
    Payouts internal payouts;

    function setUp() public override {
        super.setUp();
        usd = new MandateCurrency();
        factory = new PayoutsFactory();
        // Contributor projects choose "no lock" at creation, for good.
        vm.prank(address(dao));
        shares.setLockGuard(address(0));
        address predicted = factory.predict(address(dao), IERC20(address(usd)), 5_000);
        // One vote makes the module and names it, as the app's decision does.
        Call[] memory calls = new Call[](2);
        calls[0] =
            Call(address(factory), 0, abi.encodeCall(factory.create, (address(dao), IERC20(address(usd)), 5_000)));
        calls[1] = Call(address(dao), 0, abi.encodeCall(dao.setPayouts, (predicted)));
        vm.prank(address(dao));
        dao.batchCalls(calls);
        payouts = Payouts(predicted);
        assertEq(dao.payouts(), predicted);
    }

    function _revenue(uint256 amount) internal {
        usd.mint(address(payouts), amount);
        payouts.distribute();
    }

    function test_revenue_is_split_between_holders_by_units_and_the_treasury() public {
        _revenue(100e6);
        assertEq(usd.balanceOf(address(dao)), 50e6, "half to the treasury");
        assertApproxEqAbs(payouts.owed(ALICE), 25e6, 1);
        assertApproxEqAbs(payouts.owed(BOB), 25e6, 1);
        payouts.withdraw(ALICE); // anyone may send it; it goes to Alice
        assertApproxEqAbs(usd.balanceOf(ALICE), 25e6, 1);
        vm.expectRevert(abi.encodeWithSelector(Payouts.NothingOwed.selector, ALICE));
        payouts.withdraw(ALICE);
        vm.expectRevert(Payouts.NothingNew.selector);
        payouts.distribute();
    }

    function test_units_count_from_when_they_are_held_and_credit_stays_with_the_seller() public {
        _revenue(100e6);
        vm.prank(ALICE);
        shares.transfer(DORA, 50e18);
        _revenue(100e6);
        assertApproxEqAbs(payouts.owed(ALICE), 25e6 + 12.5e6, 1);
        assertApproxEqAbs(payouts.owed(DORA), 12.5e6, 1, "nothing from before she held them");
        assertApproxEqAbs(payouts.owed(BOB), 50e6, 1);
    }

    function test_leaving_keeps_what_was_credited_and_cannot_be_paid_it_twice() public {
        _revenue(100e6);
        uint256 treasury = usd.balanceOf(address(dao));
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        vm.prank(BOB);
        dao.ragequit(tokens, 0, 100e18);
        // Bob's leaving took half of the treasury's 50; the 25 credited to him was never in it.
        assertEq(usd.balanceOf(BOB), treasury / 2);
        assertApproxEqAbs(payouts.owed(BOB), 25e6, 1);
        payouts.withdraw(BOB);
        assertApproxEqAbs(usd.balanceOf(BOB), treasury / 2 + 25e6, 1);
        _revenue(100e6);
        assertEq(payouts.owed(BOB), 0, "he no longer counts");
        assertApproxEqAbs(payouts.owed(ALICE), 25e6 + 50e6, 1);
    }

    function test_new_units_from_an_award_start_counting_then() public {
        _revenue(100e6);
        vm.prank(address(dao));
        shares.mintFromMoloch(DORA, 200e18);
        _revenue(100e6);
        assertApproxEqAbs(payouts.owed(DORA), 25e6, 1);
        assertApproxEqAbs(payouts.owed(ALICE), 25e6 + 12.5e6, 1);
    }

    function test_the_dao_votes_a_payout_from_its_treasury_and_its_own_holding_never_counts() public {
        usd.mint(address(dao), 80e6);
        vm.prank(address(dao));
        shares.mintFromMoloch(address(dao), 300e18); // held by the DAO: not counted
        Call[] memory calls = new Call[](2);
        calls[0] = Call(address(usd), 0, abi.encodeCall(IERC20.approve, (address(payouts), 80e6)));
        calls[1] = Call(address(payouts), 0, abi.encodeCall(payouts.declare, (80e6)));
        vm.prank(address(dao));
        dao.batchCalls(calls);
        assertEq(usd.balanceOf(address(dao)), 0);
        assertApproxEqAbs(payouts.owed(ALICE), 40e6, 1);
        assertApproxEqAbs(payouts.owed(BOB), 40e6, 1);
        assertEq(payouts.owed(address(dao)), 0);
        // Even with the treasury's approval in place, only the DAO declares.
        usd.mint(address(dao), 1);
        vm.prank(address(dao));
        usd.approve(address(payouts), 1);
        vm.prank(ALICE);
        vm.expectRevert(Payouts.OnlyDao.selector);
        payouts.declare(1);
    }

    function test_the_module_is_named_once_and_pays_nothing_before_it_is_named() public {
        vm.prank(address(dao));
        vm.expectRevert();
        dao.setPayouts(address(0xBEEF));
        vm.prank(ALICE);
        vm.expectRevert();
        dao.setPayouts(address(0xBEEF));
        Payouts loose = new Payouts(address(dao), IERC20(address(usd)), 5_000);
        usd.mint(address(loose), 1e6);
        vm.expectRevert(Payouts.NotNamed.selector);
        loose.distribute();
        vm.prank(address(0xBAD));
        vm.expectRevert(Payouts.OnlyDao.selector);
        payouts.ownershipChanged(false, ALICE, DORA, 1);
    }

    function test_a_dao_names_only_a_module_for_itself() public {
        // The module is already named here: clear it to check the rule on a DAO's first naming.
        address other = address(new OtherDaosModule());
        vm.store(address(dao), bytes32(uint256(_payoutsSlot())), bytes32(0));
        assertEq(dao.payouts(), address(0));
        vm.prank(address(dao));
        vm.expectRevert();
        dao.setPayouts(other);
        vm.prank(address(dao));
        vm.expectRevert();
        dao.setPayouts(address(0));
        vm.prank(address(dao));
        dao.setPayouts(address(payouts));
        assertEq(dao.payouts(), address(payouts));
    }

    function test_a_dao_that_could_still_add_a_lock_is_refused() public {
        vm.mockCall(address(shares), abi.encodeWithSignature("lockGuardSet()"), abi.encode(false));
        vm.expectRevert(Payouts.InvalidSetup.selector);
        new Payouts(address(dao), IERC20(address(usd)), 5_000);
    }

    function test_making_the_module_early_cannot_make_the_vote_fail() public {
        address predicted = factory.predict(address(dao), IERC20(address(usd)), 2_500);
        vm.prank(address(0xBAD));
        Payouts early = factory.create(address(dao), IERC20(address(usd)), 2_500);
        assertEq(address(early), predicted);
        // The DAO's vote makes it again: it gets the same module back instead of a failed batch.
        vm.prank(address(dao));
        assertEq(address(factory.create(address(dao), IERC20(address(usd)), 2_500)), predicted);
    }

    /// @dev Where the DAO keeps `payouts`, found by reading it back.
    function _payoutsSlot() internal view returns (uint256 slot) {
        bytes32 want = bytes32(uint256(uint160(address(payouts))));
        for (slot = 0; slot < 64; ++slot) {
            if (vm.load(address(dao), bytes32(slot)) == want) return slot;
        }
        revert("payouts slot not found");
    }

    function test_the_split_changes_only_after_its_notice() public {
        vm.prank(address(dao));
        payouts.announceSplit(10_000);
        uint64 at = uint64(block.timestamp) + payouts.SPLIT_NOTICE();
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(Payouts.SplitNotDue.selector, at));
        payouts.applySplit();
        vm.warp(at);
        payouts.applySplit();
        assertEq(payouts.splitBps(), 10_000);
        _revenue(100e6);
        assertApproxEqAbs(payouts.owed(ALICE), 50e6, 1);
        vm.expectRevert(abi.encodeWithSelector(Payouts.SplitNotDue.selector, payouts.SPLIT_NOTICE()));
        payouts.applySplit();
    }

    function test_nobody_counting_refuses_a_payout() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        // Half a unit left counting: less than the whole unit a payout needs.
        vm.prank(ALICE);
        dao.ragequit(tokens, 99.5e18, 0);
        vm.prank(BOB);
        dao.ragequit(tokens, 0, 100e18);
        usd.mint(address(payouts), 10e6);
        vm.expectRevert(abi.encodeWithSelector(Payouts.NobodyCounting.selector, 0.5e18));
        payouts.distribute();
    }

    function testFuzz_holders_are_owed_no_more_than_was_set_aside(uint64[3] memory revenue, uint96 moved) public {
        uint256 total;
        for (uint256 i; i < 3; ++i) {
            uint256 r = bound(revenue[i], 1, 1e15);
            _revenue(r);
            total += r;
            if (i == 0) {
                vm.prank(ALICE);
                shares.transfer(DORA, bound(moved, 1, 100e18));
            }
        }
        uint256 owedAll = payouts.owed(ALICE) + payouts.owed(BOB) + payouts.owed(DORA);
        assertLe(owedAll, payouts.reserved());
        assertGe(usd.balanceOf(address(payouts)), payouts.reserved());
        assertEq(usd.balanceOf(address(payouts)) + usd.balanceOf(address(dao)), total);
        address[3] memory holders = [ALICE, BOB, DORA];
        for (uint256 i; i < 3; ++i) {
            if (payouts.owed(holders[i]) > 0) payouts.withdraw(holders[i]);
        }
        assertGe(usd.balanceOf(address(payouts)), payouts.reserved(), "every withdrawal was covered");
    }
}
