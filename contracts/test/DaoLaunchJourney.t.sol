// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ShareVesting} from "../src/ShareVesting.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";
import {Call, Moloch, Summoner, Shares, newSummoner} from "../src/majeur/MolochPatched.sol";
import {
    LaunchCurrency,
    LaunchPermit2,
    IPermit2Approve,
    IExecutor,
    IAuction,
    AuctionParams
} from "./helpers/LaunchMocks.sol";

/// @notice A raise that settles into the DAO whose own Shares it sells, on the real auction and the real
/// patched DAO: the founder's allocation vests, the raise lands in the DAO treasury, the people who bid
/// hold Shares that vote and can be ragequit. Nothing here pranks the DAO; every authority check is the
/// production one.
contract DaoLaunchJourneyTest is Test {
    uint256 internal constant Q96 = 1 << 96;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint128 internal constant SALE = 400e18;
    uint256 internal constant FOUNDER_SHARES = 600e18;
    uint64 internal constant START_BLOCK = 100;
    uint64 internal constant END_BLOCK = 102;
    uint64 internal constant CLAIM_BLOCK = 105;

    address internal founder = makeAddr("founder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    LaunchCurrency internal currency;
    IExecutor internal executor;
    ShareVesting internal vault;
    Moloch internal dao;
    Shares internal shares;
    AllocationVoting internal policy;
    IAuction internal auction;

    function setUp() public {
        vm.etch(PERMIT2, address(new LaunchPermit2()).code);
        currency = new LaunchCurrency();
    }

    /// @dev The auction graph is pinned to solc 0.8.26 and the DAO needs 0.8.30, so the auction is deployed from its
    /// build artifact. Foundry only compiles it when other tests that import it are in the run (a full `forge test`),
    /// so a path- or contract-filtered run skips here, with that reason, unless REQUIRE_CONTRACT_ARTIFACTS=1 (the
    /// contracts CI lane) demands it, in which case a missing artifact fails.
    function _needAuctionArtifact() internal {
        (bool ok,) = address(vm).call(abi.encodeWithSignature("getCode(string)", "ContinuousClearingAuction.sol:ContinuousClearingAuction"));
        if (ok) return;
        if (vm.envOr("REQUIRE_CONTRACT_ARTIFACTS", false)) revert("the auction artifact was not compiled");
        vm.skip(true, "needs the auction artifact: run the whole suite (`forge test`) rather than a filtered run");
    }

    /// @dev A real CREATE from the founder (so the founder is the executor's launcher), from the build artifact.
    function _deployExecutor(address treasury_) internal returns (IExecutor ex) {
        bytes memory code = bytes.concat(
            vm.getCode("GraduationExecutor.sol:GraduationExecutor"), abi.encode(treasury_, uint16(0), uint64(30 days))
        );
        address deployed;
        vm.prank(founder);
        assembly ("memory-safe") {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        require(deployed != address(0), "executor creation failed");
        ex = IExecutor(deployed);
        assertEq(ex.launcher(), founder, "the wallet that deploys the executor is its launcher");
    }

    // ---- the launch ----------------------------------------------------------------------------

    function _launch() internal {
        _needAuctionArtifact();
        // 1. The founder deploys the executor and a vesting vault before the DAO exists.
        executor = _deployExecutor(founder);
        vm.prank(founder);
        vault = new ShareVesting(founder, uint64(block.timestamp), 180 days, 4 * 365 days);

        // 2. The DAO is summoned with the vault holding the founder's 60% and the executor the 40% sale tranche.
        //    No initCalls: the DAO is born able to govern itself.
        Summoner summoner = newSummoner();
        address[] memory holders = new address[](2);
        holders[0] = address(vault);
        holders[1] = address(executor);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = FOUNDER_SHARES;
        amounts[1] = SALE;
        dao = summoner.summon("Nebula", "NEB", "", 500, true, address(0), bytes32("nebula"), holders, amounts, new Call[](0));
        shares = dao.shares();
        policy = AllocationVoting(dao.votingWeight());

        // 3. The founder wires the pieces. The raise will land in the DAO, never in the founder's wallet.
        vm.startPrank(founder);
        vault.init(address(shares));
        executor.retargetTreasury(address(dao));
        vm.stopPrank();

        // 4. The auction sells the DAO's own Shares; the executor funds it from the tranche minted to it.
        AuctionParams memory params = AuctionParams({
            currency: address(currency),
            tokensRecipient: address(executor),
            fundsRecipient: address(executor),
            startBlock: START_BLOCK,
            endBlock: END_BLOCK,
            claimBlock: CLAIM_BLOCK,
            tickSpacing: Q96,
            validationHook: address(0),
            floorPrice: Q96,
            requiredCurrencyRaised: 500e18,
            auctionStepsData: abi.encodePacked(uint24(5_000_000), uint40(2))
        });
        auction = IAuction(
            vm.deployCode(
                "ContinuousClearingAuction.sol:ContinuousClearingAuction",
                abi.encode(address(shares), SALE, params, address(0))
            )
        );
        vm.startPrank(founder);
        executor.bindAuction(address(auction));
        executor.fundAuction(address(auction), SALE);
        vm.stopPrank();
        vm.roll(START_BLOCK);
    }

    function _bid(address bidder, uint128 amount, uint256 maxPrice, uint256 prevTick) internal returns (uint256 id) {
        currency.mint(bidder, amount);
        vm.startPrank(bidder);
        currency.approve(PERMIT2, amount);
        IPermit2Approve(PERMIT2).approve(address(currency), address(auction), uint160(amount), type(uint48).max);
        id = auction.submitBid(maxPrice, amount, bidder, prevTick, "");
        vm.stopPrank();
    }

    /// @dev Alice 720 and Carol 240 at 2.0, Bob 320 at 4.0: clears at 2.0, raises 800, sells everything.
    function _raise() internal returns (uint256 aliceBid, uint256 bobBid, uint256 carolBid) {
        aliceBid = _bid(alice, 720e18, 2 * Q96, Q96);
        carolBid = _bid(carol, 240e18, 2 * Q96, Q96);
        bobBid = _bid(bob, 320e18, 4 * Q96, 2 * Q96);
        vm.roll(END_BLOCK + 1);
        auction.checkpoint();
        executor.executeGraduation(address(auction));
        vm.roll(END_BLOCK + 2);
        vm.prank(bob);
        auction.exitBid(bobBid);
        vm.prank(alice);
        auction.exitPartiallyFilledBid(aliceBid, START_BLOCK, 0);
        vm.prank(carol);
        auction.exitPartiallyFilledBid(carolBid, START_BLOCK, 0);
        vm.roll(CLAIM_BLOCK);
        vm.prank(alice);
        auction.claimTokens(aliceBid);
        vm.prank(bob);
        auction.claimTokens(bobBid);
        vm.prank(carol);
        auction.claimTokens(carolBid);
        vm.roll(block.number + 1);
    }

    // ---- the journey ---------------------------------------------------------------------------

    function test_the_raise_settles_into_the_dao_and_its_backers_hold_votes_and_an_exit() public {
        _launch();
        (uint256 aliceBid, uint256 bobBid, uint256 carolBid) = _raise();
        assertTrue(aliceBid != bobBid && bobBid != carolBid);

        // The whole raise is in the DAO. The founder's wallet touched none of it.
        assertEq(currency.balanceOf(address(dao)), 800e18, "800 raised at the 2.0 clearing price");
        assertEq(currency.balanceOf(founder), 0);
        assertEq(currency.balanceOf(address(executor)), 0, "no reserve was held back");

        // The backers hold the DAO's own Shares, bought at the clearing price.
        assertEq(shares.balanceOf(alice), 180e18);
        assertEq(shares.balanceOf(bob), 160e18);
        assertEq(shares.balanceOf(carol), 60e18);
        assertEq(shares.balanceOf(address(vault)), FOUNDER_SHARES, "the founder's allocation is locked in the vault");
        assertEq(shares.totalSupply(), 1000e18);

        // The founder cannot ragequit what the vault holds, on day one or any later day before it vests.
        address[] memory assets = new address[](1);
        assets[0] = address(currency);
        vm.prank(founder);
        vm.expectRevert();
        dao.ragequit(assets, 1, 0);

        // The founder (through the vault's delegation) proposes paying 400 of the raise to a wallet of their own.
        // Everything of the vault's backs it; every Share the backers bought opposes it. 600 of 1000 is 60%.
        address payee = makeAddr("founder's other wallet");
        bytes memory pay = abi.encodeCall(LaunchCurrency.transfer, (payee, 400e18));
        bytes32 nonce = bytes32("pay myself");
        uint256 id = dao.proposalId(0, address(currency), 0, pay, nonce);
        vm.prank(founder);
        dao.castVoteFor(address(vault), id, 1, FOUNDER_SHARES);
        vm.prank(alice);
        dao.castVote(id, 0, 180e18);
        vm.prank(bob);
        dao.castVote(id, 0, 160e18);
        vm.prank(carol);
        dao.castVote(id, 0, 60e18);
        vm.warp(block.timestamp + 7 days);
        assertFalse(policy.qualifies(id), "600 for and 400 against is 60%, below the 66% bar");
        vm.expectRevert(Moloch.NotOk.selector);
        dao.executeByVotes(0, address(currency), 0, pay, nonce);
        assertEq(currency.balanceOf(payee), 0);

        // Backers who bought are not locked in: Bob exits at the treasury's value per Share.
        vm.prank(bob);
        dao.ragequit(assets, 160e18, 0);
        assertEq(currency.balanceOf(bob), 128e18, "800 over 1000 Shares is 0.8 per Share: the exit value today");
        assertEq(shares.balanceOf(bob), 0);
    }

    /// @dev What a backer holds, and for how long, starts the moment the Shares reach their wallet (the claim), not when
    /// they bid, and a backer who passes Shares to another wallet does not hand over the time they held them.
    function test_a_backers_holding_starts_at_the_claim_and_cannot_be_passed_on() public {
        _launch();
        _raise();
        uint256 claimedAt = block.timestamp;
        assertEq(policy.heldSince(alice), claimedAt);
        (uint256 balance, uint256 age) = policy.holdingAge(alice);
        assertEq(balance, 180e18);
        assertEq(age, 0, "claimed just now");

        vm.warp(claimedAt + 45 days);
        (, age) = policy.holdingAge(alice);
        assertEq(age, 45 days);

        address fresh = makeAddr("a second wallet");
        vm.prank(alice);
        shares.transfer(fresh, 90e18);
        (balance, age) = policy.holdingAge(fresh);
        assertEq(balance, 90e18);
        assertEq(age, 0, "forty-five days of holding did not travel with the Shares");
        (balance, age) = policy.holdingAge(alice);
        assertEq(balance, 90e18);
        assertEq(age, 45 days, "what Alice kept is as old as it was");
    }

    function test_without_the_vault_a_founder_could_ragequit_the_raise_on_day_one() public {
        // The control: the same raise, but the founder's 60% is simply liquid.
        executor = _deployExecutor(founder);
        Summoner summoner = newSummoner();
        address[] memory holders = new address[](2);
        holders[0] = founder;
        holders[1] = address(executor);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = FOUNDER_SHARES;
        amounts[1] = SALE;
        dao = summoner.summon("Nebula", "NEB", "", 500, true, address(0), bytes32("control"), holders, amounts, new Call[](0));
        shares = dao.shares();
        currency.mint(address(dao), 800e18); // the raise, as it would be after graduation
        address[] memory assets = new address[](1);
        assets[0] = address(currency);
        vm.prank(founder);
        dao.ragequit(assets, FOUNDER_SHARES, 0);
        assertEq(currency.balanceOf(founder), 480e18, "60% of what the backers paid, with no vote and no wait");
    }

    function test_the_vault_releases_on_schedule_and_only_released_shares_can_be_ragequit() public {
        _launch();
        _raise();
        assertEq(vault.releasable(), 0, "nothing before the cliff");
        vm.warp(block.timestamp + 365 days);
        uint256 vestedAfterOneYear = FOUNDER_SHARES * 365 days / (4 * 365 days);
        assertEq(vault.releasable(), vestedAfterOneYear, "a quarter of four years");
        vault.release(); // anyone may call it; the Shares only ever go to the founder
        assertEq(shares.balanceOf(founder), vestedAfterOneYear);
        assertEq(shares.balanceOf(address(vault)), FOUNDER_SHARES - vestedAfterOneYear);
        // Released Shares are ordinary Shares: now they can be ragequit.
        address[] memory assets = new address[](1);
        assets[0] = address(currency);
        vm.prank(founder);
        dao.ragequit(assets, vestedAfterOneYear, 0);
        assertEq(currency.balanceOf(founder), 800e18 * vestedAfterOneYear / 1000e18);
        vm.warp(block.timestamp + 10 * 365 days);
        vault.release();
        assertEq(shares.balanceOf(address(vault)), 0);
    }

    function test_a_failed_raise_leaves_the_dao_whole_and_the_founder_with_nothing_extra() public {
        _launch();
        _bid(alice, 100e18, 2 * Q96, Q96); // far below the 500 required
        vm.roll(END_BLOCK + 1);
        auction.checkpoint();
        vm.expectRevert();
        executor.executeGraduation(address(auction));
        vm.prank(address(dao));
        executor.recoverFailedLaunch(address(auction));
        assertEq(shares.balanceOf(address(dao)), SALE, "the unsold tranche returns to the DAO, not to the founder");
        assertEq(shares.balanceOf(founder), 0);
        vm.prank(alice);
        auction.exitBid(0);
        assertEq(currency.balanceOf(alice), 100e18, "every wei refunded");
    }
}
