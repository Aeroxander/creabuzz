// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFactory} from "../src/SecondaryMarketFactory.sol";
import {TestQuoteToken} from "../src/TestQuoteToken.sol";
import {Moloch, Shares} from "../src/majeur/MolochPatched.sol";
import {ContributorKitV2} from "../src/ContributorKitV2.sol";
import {ContributorKitV2Base} from "./ContributorKitV2.t.sol";

/// @dev The token on its own: metadata, the per-call cap, open minting, no privileges, plain transfers.
contract TestQuoteTokenTest is Test {
    TestQuoteToken internal token;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    function setUp() public {
        token = new TestQuoteToken();
    }

    function test_metadata_says_it_is_free_and_worth_nothing() public view {
        assertEq(token.name(), "Creaton test token (free, worth nothing)");
        assertEq(token.symbol(), "tTEST");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 0, "nothing exists until someone mints");
    }

    function test_anyone_can_mint_to_any_address() public {
        vm.prank(ALICE);
        token.mint(ALICE, 5e18);
        vm.prank(ALICE);
        token.mint(BOB, 7e18);
        vm.prank(address(0xCAFE));
        token.mint(BOB, 1e18);
        assertEq(token.balanceOf(ALICE), 5e18);
        assertEq(token.balanceOf(BOB), 8e18);
        assertEq(token.totalSupply(), 13e18);
    }

    function test_one_call_is_capped_and_the_cap_is_exact() public {
        uint256 cap = token.MAX_MINT();
        assertEq(cap, 10_000e18);
        token.mint(ALICE, cap);
        assertEq(token.balanceOf(ALICE), cap, "exactly the cap is allowed");
        vm.expectRevert(abi.encodeWithSelector(TestQuoteToken.MintTooLarge.selector, cap + 1, cap));
        token.mint(ALICE, cap + 1);
        // The cap is per call, not per person: a second call mints again.
        token.mint(ALICE, cap);
        assertEq(token.balanceOf(ALICE), 2 * cap);
        assertEq(token.totalSupply(), 2 * cap);
    }

    function testFuzz_a_mint_above_the_cap_always_reverts(uint256 amount) public {
        amount = bound(amount, token.MAX_MINT() + 1, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TestQuoteToken.MintTooLarge.selector, amount, token.MAX_MINT()));
        token.mint(ALICE, amount);
        assertEq(token.totalSupply(), 0);
    }

    function test_minting_to_the_zero_address_is_refused() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        token.mint(address(0), 1e18);
    }

    function test_there_is_no_owner_and_no_other_privilege() public {
        // None of the usual privileged entry points exist: each call finds no function and reverts.
        bytes4[7] memory selectors = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("burn(uint256)")),
            bytes4(keccak256("pause()")),
            bytes4(keccak256("setBlocklist(address,bool)")),
            bytes4(keccak256("hasRole(bytes32,address)")),
            bytes4(keccak256("burnFrom(address,uint256)"))
        ];
        for (uint256 i; i < selectors.length; ++i) {
            (bool ok,) = address(token).call(abi.encodePacked(selectors[i], new bytes(96)));
            assertFalse(ok, "an unexpected entry point exists");
        }
    }

    function test_transfers_and_allowances_move_exactly_what_was_asked() public {
        token.mint(ALICE, 100e18);
        vm.prank(ALICE);
        assertTrue(token.transfer(BOB, 30e18));
        assertEq(token.balanceOf(ALICE), 70e18);
        assertEq(token.balanceOf(BOB), 30e18);
        vm.prank(ALICE);
        token.approve(address(this), 20e18);
        assertTrue(token.transferFrom(ALICE, BOB, 20e18));
        assertEq(token.balanceOf(ALICE), 50e18);
        assertEq(token.balanceOf(BOB), 50e18);
        assertEq(token.allowance(ALICE, address(this)), 0);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, BOB, 50e18, 51e18));
        token.transfer(ALICE, 51e18);
        assertEq(token.totalSupply(), 100e18, "moving tokens never changes the supply");
    }

    function test_it_fits_the_size_limits() public view {
        assertLe(vm.getCode("src/TestQuoteToken.sol:TestQuoteToken").length, 49_152, "creation over EIP-3860");
        assertLe(address(token).code.length, 24_576, "runtime over EIP-170");
    }
}

/// @dev The market and the kit take this token as the quote: a real V2 launch, a real listing vote, a first round
/// that sells, clears and pays out, all in the free-mint token.
contract TestQuoteTokenMarketTest is ContributorKitV2Base {
    TestQuoteToken internal tTest;

    /// @dev The trial's own schedule: starts at birth, no cliff, 180 days, a small lot.
    uint256 internal constant TRIAL_LOT = 1e16;

    function setUp() public override {
        super.setUp();
        tTest = new TestQuoteToken();
    }

    function _trialParams(bytes32 salt) internal returns (ContributorKitV2.LaunchParams memory p) {
        p = _params(salt);
        p.saleStart = 0;
        p.saleCliff = 0;
        p.saleDuration = 180 days;
        p.quote = address(tTest);
        p.lotSize = TRIAL_LOT;
    }

    function test_a_launch_with_the_free_token_binds_it_as_the_quote() public {
        ContributorKitV2.LaunchParams memory p = _trialParams("tt-launch");
        (address expectedDao,,, address expectedMarket) =
            kit.predictLaunch(FOUNDER, p.base.founderShares, p.base.salt, p.quote, p.lotSize);
        (Moloch dao,,, SecondaryMarket market) = _launchV2(p);
        assertEq(address(dao), expectedDao);
        assertEq(address(market), expectedMarket);
        assertEq(address(market.quote()), address(tTest), "the market is paid in the free test token");
        assertEq(market.lotSize(), TRIAL_LOT);
    }

    function test_a_first_round_sells_clears_and_pays_in_the_free_token() public {
        (Moloch dao,,, SecondaryMarket market) = _launchV2(_trialParams("tt-round"));
        Shares tokens = Shares(address(dao.shares()));
        vm.roll(block.number + 2);
        vm.warp(vm.getBlockTimestamp() + 1);

        // The project publishes its listing through a real vote, with the real review and delay.
        bytes memory data = abi.encodeCall(SecondaryMarket.configureListing, (true, 100e18, 400e18, 3));
        bytes32 nonce = bytes32("list-it");
        vm.prank(FOUNDER);
        uint256 pid = dao.openProposalWithAction(0, address(market), 0, data, nonce);
        vm.prank(FOUNDER);
        dao.castVote(pid, 1, 200e18);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        dao.queue(pid);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        dao.executeByVotes(0, address(market), 0, data, nonce);
        uint256 round = market.openRound();

        // The founder offers 2 lots (0.02 Share, well inside what three days of the schedule unlocked).
        vm.startPrank(FOUNDER);
        tokens.approve(address(market), 2 * TRIAL_LOT);
        market.sell(round, 2, 0);
        vm.stopPrank();

        // Anyone mints themselves test money, with no permission, and bids at the top step.
        uint256 top = market.priceAt(round, 3);
        uint256 escrow = 2 * top;
        vm.startPrank(BUYER);
        tTest.mint(BUYER, escrow);
        tTest.approve(address(market), escrow);
        market.bid(round, 2, 3);
        vm.stopPrank();
        assertEq(tTest.balanceOf(address(market)), escrow, "the bid is held in the free token");

        vm.warp(vm.getBlockTimestamp() + 3 days);
        market.settle(round);
        market.claimShares(round, BUYER);
        market.claimQuote(round, FOUNDER);
        market.claimQuote(round, BUYER);

        // One buyer and one seller at the floor: the lowest grid level clears, the buyer is refunded the rest.
        uint256 clearing = market.priceAt(round, 0);
        assertEq(tokens.balanceOf(BUYER), 2 * TRIAL_LOT, "the buyer holds the Shares bought");
        assertEq(tTest.balanceOf(FOUNDER), 2 * clearing, "the seller was paid in the free token");
        assertEq(tTest.balanceOf(BUYER), escrow - 2 * clearing, "the buyer got back what the price left over");
        assertEq(tTest.balanceOf(address(market)), 0, "the market keeps no test money");
    }
}
