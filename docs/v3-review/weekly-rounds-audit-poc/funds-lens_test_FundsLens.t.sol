// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {WeeklyRounds} from "../src/WeeklyRounds.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";
import {Payouts, PayoutsFactory} from "../src/Payouts.sol";

/// A token anyone can deploy: its "balance" at the DAO is whatever it says, and its transfer pulls the rounds
/// contract's payouts out of the module mid-ragequit.
contract PullToken {
    Payouts public module;
    address public rounds;

    constructor(Payouts m, address r) {
        module = m;
        rounds = r;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 1e18;
    }

    function transfer(address, uint256) external returns (bool) {
        if (module.owed(rounds) != 0) module.withdraw(rounds);
        return true;
    }
}

contract FundsLensTest is VotingFixture {
    address internal constant BEN = address(0xBE4);
    address internal constant MAL = address(0xBAD);
    uint256 internal constant USD = 1e6;
    uint16 internal constant NO_CAP = type(uint16).max;

    MandateCurrency internal usd;
    WeeklyRounds internal rounds;

    function setUp() public override {
        super.setUp();
        usd = new MandateCurrency();
        usd.mint(address(dao), 200 * USD);
        rounds = new WeeklyRounds(IERC20(address(usd)), 1e4);
        vm.startPrank(address(dao));
        shares.setIssuanceRule(NO_CAP);
        shares.lockTransfersWithNotice(address(0));
        shares.setLockGuard(address(0));
        shares.announceExitExchange(address(rounds));
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
        shares.activateExitExchange();
        address[2] memory buyers = [BEN, MAL];
        for (uint256 i; i < buyers.length; ++i) {
            usd.mint(buyers[i], 1_000 * USD);
            vm.prank(buyers[i]);
            usd.approve(address(rounds), type(uint256).max);
        }
    }

    function _payouts() internal returns (Payouts module) {
        PayoutsFactory factory = ledger.mandateFactory().payoutsFactory();
        module = factory.create(address(dao), IERC20(address(usd)), 5_000);
        vm.prank(address(dao));
        dao.setPayouts(address(module));
    }

    function _payout(Payouts module, uint256 amount) internal {
        usd.mint(address(dao), amount);
        vm.prank(address(dao));
        usd.approve(address(module), amount);
        vm.prank(address(dao));
        module.declare(amount);
    }

    function test_leaver_steals_escrowed_payouts_and_strands_a_refund() public {
        Payouts module = _payouts();
        uint256 id = rounds.open(address(dao));
        vm.prank(ALICE);
        shares.approve(address(rounds), 50e18);
        vm.prank(ALICE);
        rounds.sell(id, 50e18, 0);
        vm.prank(BEN);
        rounds.bid(id, 20e18, 100); // escrow 40, pays 20 at the floor, 20 comes back
        vm.prank(MAL);
        rounds.bid(id, 1e18, 0); // escrow 1
        // 20 USDC over 200 units: 5 of it is credited to the 50 Shares Alice has in escrow.
        _payout(module, 20 * USD);
        assertApproxEqAbs(module.owed(address(rounds)), 5 * USD, 1);
        (,,, uint64 closesAt,,,,,,,,,,,,,,) = rounds.rounds(id);
        vm.warp(closesAt);
        (uint256 step,,) = rounds.clearingStep(id);
        rounds.settle(id, step);
        assertEq(step, 0);

        PullToken pull = new PullToken(module, address(rounds));
        address[] memory leaveWith = new address[](2);
        (leaveWith[0], leaveWith[1]) = address(usd) < address(pull)
            ? (address(usd), address(pull))
            : (address(pull), address(usd));
        uint256 malBefore = usd.balanceOf(MAL);
        vm.prank(MAL);
        rounds.claimAndLeave(id, leaveWith);
        // 1 unit of 200 leaves with ~1 USDC; Mal gets 6 (his 1 + Alice's 5 payouts).
        emit log_named_uint("mal received (USD 6dp)", usd.balanceOf(MAL) - malBefore);
        emit log_named_uint("rounds usdc after mal", usd.balanceOf(address(rounds)));

        uint256 aliceBefore = usd.balanceOf(ALICE);
        rounds.claim(id, ALICE); // 21 sold at 1.00 + 5 payouts, paid out of Ben's escrow
        emit log_named_uint("alice received", usd.balanceOf(ALICE) - aliceBefore);
        emit log_named_uint("rounds usdc after alice", usd.balanceOf(address(rounds)));
        vm.expectRevert();
        rounds.claim(id, BEN); // needs 20 refund + 20 Shares: short by 5
        vm.prank(BEN);
        address[] memory u = new address[](1);
        u[0] = address(usd);
        vm.expectRevert();
        rounds.claimAndLeave(id, u);
    }

    /// The DAO clears the exchange (immediate, one vote) after settling: a seller who sold part can no longer collect
    /// the money from the part that sold without leaving with the part that did not.
    function test_cleared_exchange_ties_sale_money_to_leaving() public {
        uint256 id = rounds.open(address(dao));
        vm.prank(ALICE);
        shares.approve(address(rounds), 50e18);
        vm.prank(ALICE);
        rounds.sell(id, 50e18, 0);
        vm.prank(BEN);
        rounds.bid(id, 20e18, 0);
        (,,, uint64 closesAt,,,,,,,,,,,,,,) = rounds.rounds(id);
        vm.warp(closesAt);
        (uint256 step,,) = rounds.clearingStep(id);
        rounds.settle(id, step);
        vm.prank(address(dao));
        shares.clearExitExchange();
        vm.expectRevert();
        rounds.claim(id, ALICE);
        vm.expectRevert();
        rounds.claim(id, BEN);
    }
}
