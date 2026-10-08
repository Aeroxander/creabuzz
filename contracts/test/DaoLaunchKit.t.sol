// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ShareVesting} from "../src/ShareVesting.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";
import {Moloch, Shares, Summoner, newSummoner} from "../src/majeur/MolochPatched.sol";
import {
    LaunchCurrency,
    LaunchPermit2,
    IPermit2Approve,
    IExecutor,
    IAuction,
    AuctionParams
} from "./helpers/LaunchMocks.sol";

/// @dev Same field order as `DaoLaunchKit.Params` (the kit is compiled with solc 0.8.26 and cannot be imported
/// beside the patched DAO, so the test drives it through this mirror and deploys it from its artifact).
struct KitParams {
    string name;
    string symbol;
    string uri;
    uint96 proposalThreshold;
    bytes32 salt;
    address[] team;
    uint256[] teamShares;
    uint64 vestCliff;
    uint64 vestDuration;
    uint256 daoShares;
    uint128 saleSupply;
    bytes auctionConfig;
    bytes32 auctionSalt;
}

interface IKit {
    function launch(KitParams calldata p) external returns (address dao, address executor, address auction);
    function predictExecutor(bytes32 salt) external view returns (address);
}

/// @notice The one-transaction launch against the real auction factory and the real patched DAO.
contract DaoLaunchKitTest is Test {
    uint256 internal constant Q96 = 1 << 96;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint128 internal constant SALE = 400e18;
    uint64 internal constant START_BLOCK = 100;
    uint64 internal constant END_BLOCK = 102;
    uint64 internal constant CLAIM_BLOCK = 105;

    address internal founder = makeAddr("founder");
    address internal cofounder = makeAddr("cofounder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    LaunchCurrency internal currency;
    IKit internal kit;

    function setUp() public {
        vm.etch(PERMIT2, address(new LaunchPermit2()).code);
        currency = new LaunchCurrency();
    }

    function _needArtifacts() internal {
        string[3] memory keys = [
            "ContinuousClearingAuctionFactory.sol:ContinuousClearingAuctionFactory",
            "DaoLaunchKit.sol:DaoLaunchKit",
            "ContinuousClearingAuction.sol:ContinuousClearingAuction"
        ];
        for (uint256 i; i < keys.length; ++i) {
            (bool ok,) = address(vm).call(abi.encodeWithSignature("getCode(string)", keys[i]));
            if (ok) continue;
            if (vm.envOr("REQUIRE_CONTRACT_ARTIFACTS", false)) revert("a launch artifact was not compiled");
            vm.skip(true, "needs the auction and kit artifacts: run the whole suite (`forge test`), not a filtered run");
        }
        // No protocol fee controller: the raise is not taxed in this test.
        address factory = vm.deployCode(
            "ContinuousClearingAuctionFactory.sol:ContinuousClearingAuctionFactory", abi.encode(address(0))
        );
        Summoner summoner = newSummoner();
        kit = IKit(vm.deployCode("DaoLaunchKit.sol:DaoLaunchKit", abi.encode(address(summoner), factory)));
    }

    function _config(address executor) internal view returns (bytes memory) {
        return abi.encode(
            AuctionParams({
                currency: address(currency),
                tokensRecipient: executor,
                fundsRecipient: executor,
                startBlock: START_BLOCK,
                endBlock: END_BLOCK,
                claimBlock: CLAIM_BLOCK,
                tickSpacing: Q96,
                validationHook: address(0),
                floorPrice: Q96,
                requiredCurrencyRaised: 500e18,
                auctionStepsData: abi.encodePacked(uint24(5_000_000), uint40(2))
            })
        );
    }

    function _params(bytes32 salt, address executor) internal view returns (KitParams memory p) {
        p.name = "Nebula";
        p.symbol = "NEB";
        p.uri = "";
        p.proposalThreshold = 10e18;
        p.salt = salt;
        p.team = new address[](2);
        p.team[0] = founder;
        p.team[1] = cofounder;
        p.teamShares = new uint256[](2);
        p.teamShares[0] = 225e18;
        p.teamShares[1] = 75e18;
        p.vestCliff = 180 days;
        p.vestDuration = 4 * 365 days;
        p.daoShares = 300e18; // treasury, milestones, community: the DAO's own, outside voting and outside exits
        p.saleSupply = SALE;
        p.auctionConfig = _config(executor);
        p.auctionSalt = salt;
    }

    function _launch(bytes32 salt) internal returns (Moloch dao, IExecutor executor, IAuction auction) {
        address predicted = kit.predictExecutor(salt);
        vm.prank(founder);
        (address d, address e, address a) = kit.launch(_params(salt, predicted));
        assertEq(e, predicted, "the executor lands where the client computed it");
        return (Moloch(payable(d)), IExecutor(e), IAuction(a));
    }

    function test_one_transaction_creates_a_dao_that_no_one_holds_but_vaults_and_the_auction() public {
        _needArtifacts();
        (Moloch dao, IExecutor executor, IAuction auction) = _launch(bytes32("nebula"));
        Shares shares = dao.shares();
        AllocationVoting policy = AllocationVoting(dao.votingWeight());

        // The supply: the team's two vaults, the DAO's own allocation, and the auction. No wallet holds a Share.
        assertEq(shares.totalSupply(), 1000e18);
        assertEq(shares.balanceOf(address(dao)), 300e18, "the DAO keeps its own allocation");
        assertEq(shares.balanceOf(address(auction)), SALE, "the sale tranche sits in the auction");
        assertEq(shares.balanceOf(address(executor)), 0, "and the executor passed it all on");
        assertEq(shares.balanceOf(founder), 0);
        assertEq(shares.balanceOf(cofounder), 0);
        assertEq(shares.balanceOf(address(kit)), 0);

        // The executor serves exactly this auction and pays the DAO; the kit, not a wallet, launched it.
        assertEq(executor.launcher(), address(kit));
        assertEq(executor.treasury(), address(dao));
        assertTrue(executor.treasuryRetargeted());
        assertEq(executor.boundAuction(), address(auction));
        assertEq(auction.tokensRecipient(), address(executor));
        assertEq(auction.fundsRecipient(), address(executor));
        assertEq(auction.token(), address(shares));

        // The DAO governs itself from birth, with the founder-chosen threshold.
        assertEq(dao.proposalThreshold(), 10e18);
        assertEq(dao.proposalTTL(), 14 days);
        assertEq(dao.timelockDelay(), 1 days);

        // Each vault holds its member's allocation and hands its voting to that member.
        // (The vault addresses are in the Launched event; here, find them through the policy's holders.)
        assertEq(policy.totalCapacity(), 1000e18);
    }

    function test_the_daos_own_allocation_never_votes_and_never_dilutes_an_exit() public {
        _needArtifacts();
        (Moloch dao, IExecutor executor, IAuction auction) = _launch(bytes32("own"));
        Shares shares = dao.shares();
        AllocationVoting policy = AllocationVoting(dao.votingWeight());
        vm.roll(START_BLOCK);
        uint256 aliceBid = _bid(address(auction), alice, 720e18, 2 * Q96, Q96);
        address carol = makeAddr("carol");
        uint256 carolBid = _bid(address(auction), carol, 240e18, 2 * Q96, Q96);
        uint256 bobBid = _bid(address(auction), bob, 320e18, 4 * Q96, 2 * Q96);
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
        vm.roll(block.number + 1);
        // Voting supply leaves out the DAO's own 300: 1000 total, 700 that could ever vote.
        vm.prank(alice);
        dao.castVote(1, 1, 180e18);
        (uint96 votingSupply,,,,,,,,,) = dao.proposalVotingRules(1);
        assertEq(votingSupply, 700e18);
        assertEq(policy.weightFor(bytes32(uint256(1)), address(dao), uint48(block.number - 1)), 0);
        // And her exit divides the treasury by the 700 that are members' Shares, not by 1000.
        address[] memory assets = new address[](1);
        assets[0] = address(currency);
        uint256 before_ = currency.balanceOf(alice);
        vm.prank(alice);
        dao.ragequit(assets, 180e18, 0);
        assertEq(currency.balanceOf(alice) - before_, uint256(800e18) * 180e18 / 700e18);
        assertEq(shares.balanceOf(address(dao)), 300e18, "the DAO's allocation is untouched");
    }

    function test_the_whole_launch_ends_with_the_raise_in_the_dao_and_votes_in_the_backers_hands() public {
        _needArtifacts();
        (Moloch dao, IExecutor executor, IAuction auction) = _launch(bytes32("nebula"));
        Shares shares = dao.shares();
        vm.roll(START_BLOCK);
        address carol = makeAddr("carol");
        uint256 aliceBid = _bid(address(auction), alice, 720e18, 2 * Q96, Q96);
        _bid(address(auction), carol, 240e18, 2 * Q96, Q96);
        uint256 bobBid = _bid(address(auction), bob, 320e18, 4 * Q96, 2 * Q96);
        vm.roll(END_BLOCK + 1);
        auction.checkpoint();
        executor.executeGraduation(address(auction));
        assertEq(currency.balanceOf(address(dao)), 800e18, "the raise is the DAO's");
        assertEq(currency.balanceOf(founder), 0);
        vm.roll(END_BLOCK + 2);
        vm.prank(bob);
        auction.exitBid(bobBid);
        vm.prank(alice);
        auction.exitPartiallyFilledBid(aliceBid, START_BLOCK, 0);
        vm.roll(CLAIM_BLOCK);
        vm.prank(alice);
        auction.claimTokens(aliceBid);
        vm.prank(bob);
        auction.claimTokens(bobBid);
        assertEq(shares.balanceOf(alice), 180e18);
        assertEq(shares.balanceOf(bob), 160e18);
        vm.roll(block.number + 1);

        // Bob can open and vote on a proposal (his 160 clear the 10 Share threshold) and exit at the DAO's value.
        bytes memory data = abi.encodeCall(Moloch.setQuorumBps, (uint16(1000)));
        uint256 id = dao.proposalId(0, address(dao), 0, data, bytes32("n"));
        vm.prank(bob);
        dao.castVote(id, 1, 160e18);
        assertEq(dao.createdAt(id), uint64(block.timestamp));
        address[] memory assets = new address[](1);
        assets[0] = address(currency);
        uint256 beforeExit = currency.balanceOf(alice); // already holds the 360 her bid was refunded
        vm.prank(alice);
        dao.ragequit(assets, 180e18, 0);
        assertEq(currency.balanceOf(alice) - beforeExit, uint256(800e18) * 180e18 / 700e18, "800 over the 700 member Shares, times her 180");
    }

    function test_a_launch_cannot_be_repeated_and_a_wrong_auction_config_reverts_everything() public {
        _needArtifacts();
        _launch(bytes32("nebula"));
        address predicted = kit.predictExecutor(bytes32("nebula"));
        vm.prank(founder);
        vm.expectRevert(); // CREATE2 collision: the salt is spent
        kit.launch(_params(bytes32("nebula"), predicted));

        // An auction config that names some other address as the recipients cannot be bound: the whole call reverts.
        bytes32 salt = bytes32("wrong recipients");
        KitParams memory p = _params(salt, makeAddr("not the executor"));
        vm.prank(founder);
        vm.expectRevert();
        kit.launch(p);
    }

    function test_the_inputs_are_checked() public {
        _needArtifacts();
        bytes32 salt = bytes32("bad inputs");
        KitParams memory p = _params(salt, kit.predictExecutor(salt));
        p.saleSupply = 0;
        vm.expectRevert();
        kit.launch(p);
        p = _params(salt, kit.predictExecutor(salt));
        p.teamShares = new uint256[](1);
        vm.expectRevert();
        kit.launch(p);
    }

    function _bid(address auction, address bidder, uint128 amount, uint256 maxPrice, uint256 prevTick)
        internal
        returns (uint256 id)
    {
        currency.mint(bidder, amount);
        vm.startPrank(bidder);
        currency.approve(PERMIT2, amount);
        IPermit2Approve(PERMIT2).approve(address(currency), auction, uint160(amount), type(uint48).max);
        id = IAuction(auction).submitBid(maxPrice, amount, bidder, prevTick, "");
        vm.stopPrank();
    }
}
