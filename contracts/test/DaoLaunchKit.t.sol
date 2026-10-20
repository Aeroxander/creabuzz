// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {MilestoneLock} from "../src/MilestoneLock.sol";
import {MilestoneChallenge} from "../src/MilestoneChallenge.sol";
import {MilestoneLockFactory} from "../src/MilestoneLockFactory.sol";
import {MilestoneChallengeFactory} from "../src/MilestoneChallengeFactory.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {Call, Loot, Moloch, Shares, Summoner, newSummoner} from "../src/majeur/MolochPatched.sol";
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
    bytes32[] milestoneChecks;
    uint16[] milestoneBps;
    address[] reviewers;
    uint256 reviewQuorum;
    uint128 reviewerBond;
    address bondToken;
    address panelCurrency;
    uint64 panelExpires;
    uint256 daoShares;
    uint128 saleSupply;
    bytes auctionConfig;
    bytes32 auctionSalt;
    uint64 governanceStartBlock;
}

/// @dev Same field order as `DaoLaunchKit.ChallengeTerms`.
struct KitChallengeTerms {
    uint64 window;
    uint64 votePeriod;
    uint64 clawback;
    uint16 minRejectBps;
    address bondToken;
    uint128 bond;
    uint128 deposit;
}

interface IKit {
    function launch(KitParams calldata p) external returns (address dao, address executor, address auction);
    function launchChallenged(KitParams calldata p, KitChallengeTerms calldata c)
        external
        returns (address dao, address executor, address auction);
    function lockFactory() external view returns (address);
    function challengeFactory() external view returns (address);
    function predictExecutor(address launcher, bytes32 salt) external view returns (address);
    function sharesImplementation() external view returns (address);
    function mandateFactory() external view returns (address);
}

/// @notice The one-transaction launch against the real auction factory and the real patched DAO.
contract DaoLaunchKitTest is Test {
    uint256 internal constant Q96 = 1 << 96;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint128 internal constant SALE = 600e18; // 60% of the 1000, the least a launch may sell (D75)
    uint64 internal constant START_BLOCK = 100;
    uint64 internal constant END_BLOCK = 102;
    uint64 internal constant CLAIM_BLOCK = 105;

    address internal founder = makeAddr("founder");
    address internal cofounder = makeAddr("cofounder");
    address internal alice = makeAddr("alice");
    address internal judgeOne = makeAddr("judge one");
    address internal judgeTwo = makeAddr("judge two");
    address internal judgeThree = makeAddr("judge three");
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
        kit = IKit(
            vm.deployCode(
                "DaoLaunchKit.sol:DaoLaunchKit",
                abi.encode(
                    address(summoner), factory, _sharesImplementation(summoner), new MilestoneLockFactory(), new MilestoneChallengeFactory()
                )
            )
        );
    }

    /// @dev Every DAO this summoner makes clones one Shares implementation. The proxy's runtime code is nine bytes of
    /// prefix, the implementation's address, then the tail: read it off a DAO made for the purpose.
    function _sharesImplementation(Summoner summoner) internal returns (address implementation) {
        address[] memory holders = new address[](1);
        holders[0] = address(0xBEEF);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1e18;
        Moloch probe = summoner.summon(
            "Probe", "PRB", "", 500, true, address(0), bytes32("probe"), holders, amounts, new Call[](0)
        );
        bytes memory code = address(probe.shares()).code;
        for (uint256 i; i < 20; ++i) {
            implementation = address(uint160(implementation) << 8 | uint160(uint8(code[9 + i])));
        }
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
                requiredCurrencyRaised: 600e18, // the whole tranche at the floor: it sells out or refunds (D74)
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
        // Half of each founder's Shares unlock with the first milestone, half with the second: all of them are locked
        // (D75).
        p.milestoneChecks = new bytes32[](2);
        p.milestoneChecks[0] = keccak256("alpha shipped");
        p.milestoneChecks[1] = keccak256("first customers");
        p.milestoneBps = new uint16[](2);
        p.milestoneBps[0] = 5000;
        p.milestoneBps[1] = 5000;
        // Three outside reviewers judge the milestones, two must agree, and nobody posts a bond in this fixture.
        p.reviewers = new address[](3);
        p.reviewers[0] = judgeOne;
        p.reviewers[1] = judgeTwo;
        p.reviewers[2] = judgeThree;
        p.reviewQuorum = 2;
        p.panelCurrency = address(currency);
        p.panelExpires = uint64(block.timestamp + 730 days);
        p.daoShares = 100e18; // the DAO's own reserve (at most 20%), outside voting and outside exits
        p.saleSupply = SALE;
        p.auctionConfig = _config(executor);
        p.auctionSalt = salt;
        p.governanceStartBlock = CLAIM_BLOCK;
    }

    function _launch(bytes32 salt) internal returns (Moloch dao, IExecutor executor, IAuction auction) {
        address predicted = kit.predictExecutor(founder, salt);
        vm.prank(founder);
        (address d, address e, address a) = kit.launch(_params(salt, predicted));
        assertEq(e, predicted, "the executor lands where the client computed it");
        return (Moloch(payable(d)), IExecutor(e), IAuction(a));
    }

    function test_one_transaction_creates_a_dao_whose_founders_vote_but_cannot_yet_sell_or_ragequit() public {
        _needArtifacts();
        (Moloch dao, IExecutor executor, IAuction auction) = _launch(bytes32("nebula"));
        Shares shares = dao.shares();
        AllocationVoting policy = AllocationVoting(dao.votingWeight());

        // The supply: the team (directly, in their own wallets), the DAO's own allocation, and the auction.
        assertEq(shares.totalSupply(), 1000e18);
        assertEq(shares.balanceOf(founder), 225e18);
        assertEq(shares.balanceOf(cofounder), 75e18);
        assertEq(shares.balanceOf(address(dao)), 100e18, "the DAO keeps its own allocation");
        assertEq(shares.balanceOf(address(auction)), SALE, "the sale tranche sits in the auction");
        assertEq(shares.balanceOf(address(executor)), 0, "and the executor passed it all on");
        assertEq(shares.balanceOf(address(kit)), 0);

        // New Shares only as pay for reviewed work, at most 10% a year (D76): a passed vote cannot mint, and Loot is closed.
        assertTrue(shares.awardsOnly());
        assertEq(shares.issuanceCapBps(), 1000);
        vm.prank(address(dao));
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        shares.mintFromMoloch(founder, 1);
        Loot loot = dao.loot();
        vm.prank(address(dao));
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        loot.mintFromMoloch(founder, 1);

        // Shares cannot be sent between wallets, except to and from the auction, and lifting that takes 30 days' notice
        // (D77).
        assertTrue(shares.transfersLocked());
        assertEq(shares.transferExempt(), address(auction));
        assertTrue(shares.unlockNoticeRequired());

        // The founders vote with all of it from the first block.
        assertEq(shares.getVotes(founder), 225e18);
        assertEq(policy.totalCapacity(), 1000e18);

        // The DAO was born pointing its Shares at a lock: every founder Share is held until a milestone (D75).
        MilestoneLock lock = MilestoneLock(shares.lockGuard());
        assertTrue(address(lock) != address(0), "the lock was set in the DAO's own initialization");
        assertEq(lock.dao(), address(dao));
        assertEq(lock.lockedOf(founder), 225e18);
        assertEq(lock.lockedOf(cofounder), 75e18);
        assertEq(lock.totalLocked(), 300e18);
        assertEq(lock.lockedOf(alice), 0, "nobody else is held");
        // Nothing moves between wallets while transfers are locked (D77), and none of it can leave yet.
        vm.prank(founder);
        vm.expectRevert(bytes4(keccak256("Locked()")));
        shares.transfer(alice, 1);
        address[] memory assets = new address[](1);
        assets[0] = address(currency);
        vm.prank(founder);
        vm.expectRevert(Shares.LockedShares.selector);
        dao.ragequit(assets, 1, 0);

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
    }

    function test_a_team_needs_milestones_and_a_launch_with_no_team_locks_nothing() public {
        _needArtifacts();
        bytes32 salt = bytes32("free");
        KitParams memory p = _params(salt, kit.predictExecutor(founder, salt));
        p.milestoneChecks = new bytes32[](0);
        p.milestoneBps = new uint16[](0);
        p.reviewers = new address[](0); // no milestones, so no panel to judge them
        // A team whose Shares no milestone holds back is refused (D75): they would be a claim on the raise from day one.
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSignature("UnfairTerms(uint8)", uint8(4)));
        kit.launch(p);
        // With no team there is nothing to lock: the sale and the DAO's reserve only.
        p.team = new address[](0);
        p.teamShares = new uint256[](0);
        vm.prank(founder);
        (address d,,) = kit.launch(p);
        Shares shares = Moloch(payable(d)).shares();
        assertEq(shares.lockGuard(), address(0));
        assertEq(shares.balanceOf(founder), 0);
        // "No lock" was chosen at birth and is final: a vote cannot install a guard that could refuse every exit (D73).
        assertTrue(shares.lockGuardSet());
        vm.prank(d);
        vm.expectRevert(Shares.LockGuardSet.selector);
        shares.setLockGuard(address(this));
    }

    function test_the_launch_names_the_milestone_panel_and_no_vote_can_take_the_lock_off() public {
        _needArtifacts();
        (Moloch dao,,) = _launch(bytes32("panel"));
        Shares shares = dao.shares();
        AllocationVoting policy = AllocationVoting(dao.votingWeight());
        TreasuryMandateFactory factory = policy.mandateFactory();
        assertEq(kit.mandateFactory(), address(factory), "the kit names the factory the DAO's own policy uses");

        // The panel exists from the first block, made by the DAO, and the factory remembers it as the DAO's panel.
        TreasuryMandate panel = TreasuryMandate(factory.milestoneMandate(address(dao)));
        assertTrue(address(panel) != address(0));
        assertEq(factory.daos(address(panel)), address(dao));
        assertEq(panel.dao(), address(dao));
        assertEq(address(panel.currency()), address(currency));
        assertEq(panel.budget(), 0, "it moves no money");
        assertEq(panel.expiresAt(), uint64(block.timestamp + 730 days));
        VerifierSet judges = panel.verifiers();
        assertEq(judges.quorum(), 2);
        (bool one,,,) = judges.verifiers(judgeOne);
        (bool two,,,) = judges.verifiers(judgeTwo);
        (bool three,,,) = judges.verifiers(judgeThree);
        assertTrue(one && two && three, "all three were accepted at birth");
        (bool theFounder,,,) = judges.verifiers(founder);
        assertFalse(theFounder);

        // The DAO cannot take the lock off, or swap it, or name another panel: a vote only governs what the team is
        // not bound by.
        address lock = shares.lockGuard();
        vm.prank(address(dao));
        vm.expectRevert(Shares.LockGuardSet.selector);
        shares.setLockGuard(address(0));
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandateFactory.PanelAlreadyNamed.selector);
        factory.createMilestonePanel(address(currency), uint64(block.timestamp + 365 days), p_reviewers(), 1, 0, address(0));
        assertEq(shares.lockGuard(), lock);
    }

    function p_reviewers() internal view returns (address[] memory r) {
        r = new address[](1);
        r[0] = judgeOne;
    }

    function test_a_team_member_cannot_be_named_to_judge_the_teams_milestones_so_the_launch_fails() public {
        _needArtifacts();
        bytes32 salt = bytes32("friendly");
        KitParams memory p = _params(salt, kit.predictExecutor(founder, salt));
        p.reviewers[2] = cofounder; // a founder whose Shares the lock holds back
        vm.prank(founder);
        vm.expectRevert();
        kit.launch(p);
    }

    function test_milestones_and_their_panel_go_together() public {
        _needArtifacts();
        bytes32 salt = bytes32("mismatch");
        // Milestones with nobody to judge them.
        KitParams memory p = _params(salt, kit.predictExecutor(founder, salt));
        p.reviewers = new address[](0);
        vm.prank(founder);
        vm.expectRevert(bytes4(keccak256("PanelMismatch()")));
        kit.launch(p);
        // A panel with nothing to judge.
        p = _params(salt, kit.predictExecutor(founder, salt));
        p.milestoneChecks = new bytes32[](0);
        p.milestoneBps = new uint16[](0);
        vm.prank(founder);
        vm.expectRevert(bytes4(keccak256("PanelMismatch()")));
        kit.launch(p);
    }

    function test_a_kit_that_misjudges_the_shares_address_reverts_the_whole_launch() public {
        _needArtifacts();
        // Same kit, but told the wrong Shares implementation: it would point a lock at an address that is not the DAO's
        // Shares, so it refuses.
        IKit wrong = IKit(
            vm.deployCode(
                "DaoLaunchKit.sol:DaoLaunchKit",
                abi.encode(
                    address(newSummoner()),
                    vm.deployCode(
                        "ContinuousClearingAuctionFactory.sol:ContinuousClearingAuctionFactory", abi.encode(address(0))
                    ),
                    address(currency),
                    kit.lockFactory(),
                    kit.challengeFactory()
                )
            )
        );
        bytes32 salt = bytes32("wrong impl");
        KitParams memory p = _params(salt, wrong.predictExecutor(founder, salt));
        vm.prank(founder);
        vm.expectRevert(bytes("kit: shares address"));
        wrong.launch(p);
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
        // Voting supply leaves out the DAO's own 100 (1000 total, 900 that could ever vote) and, since ES-3, the Shares
        // still waiting in the auction for Bob and Carol to claim them.
        uint256 waiting = shares.balanceOf(address(auction));
        assertGt(waiting, 0);
        vm.prank(alice);
        dao.castVote(1, 1, 180e18);
        (uint96 votingSupply,,,,,,,,,) = dao.proposalVotingRules(1);
        assertEq(votingSupply, 900e18 - waiting);
        assertEq(policy.weightFor(bytes32(uint256(1)), address(dao), uint48(block.number - 1)), 0);
        // And her exit divides the treasury by the members' Shares that can leave: 900 less the team's 300 still locked
        // (D72), not by 1000 or 900.
        address[] memory assets = new address[](1);
        assets[0] = address(currency);
        uint256 before_ = currency.balanceOf(alice);
        vm.prank(alice);
        dao.ragequit(assets, 180e18, 0);
        assertEq(currency.balanceOf(alice) - before_, uint256(1200e18) * 180e18 / 600e18);
        assertEq(shares.balanceOf(address(dao)), 100e18, "the DAO's allocation is untouched");
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
        assertEq(currency.balanceOf(address(dao)), 1200e18, "the raise is the DAO's: the 600 on sale at 2");
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
        assertEq(shares.balanceOf(alice), 330e18, "440 left after Bob's 160, shared with Carol 720:240");
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
        uint256 beforeExit = currency.balanceOf(alice); // already holds the 60 her bid was refunded
        vm.prank(alice);
        dao.ragequit(assets, 180e18, 0);
        assertEq(
            currency.balanceOf(alice) - beforeExit,
            uint256(1200e18) * 180e18 / 600e18,
            "1200 over the 600 member Shares that can leave (900 less the team's 300 still locked, D72), times her 180"
        );
    }

    /// ES-3: Shares a buyer has not claimed yet sit in the auction, where nobody can vote them. They must not raise the
    /// bar every proposal has to clear: the launch keeps the auction out of the DAO's voting supply from the start, so a
    /// proposal's electorate is the Shares that can actually vote, and a buyer's Shares count as soon as they are claimed.
    function test_shares_waiting_in_the_auction_never_raise_the_bar_a_proposal_must_clear() public {
        _needArtifacts();
        (Moloch dao, IExecutor executor, IAuction auction) = _launch(bytes32("unclaimed"));
        Shares shares = dao.shares();
        AllocationVoting policy = AllocationVoting(dao.votingWeight());
        assertTrue(policy.isExcluded(address(auction)), "the auction is outside the voting supply from birth");

        vm.roll(START_BLOCK);
        uint256 aliceBid = _bid(address(auction), alice, 1040e18, 2 * Q96, Q96); // with Bob's 320, more than the 600 on sale at 2
        uint256 bobBid = _bid(address(auction), bob, 320e18, 4 * Q96, 2 * Q96);
        vm.roll(END_BLOCK + 1);
        auction.checkpoint();
        executor.executeGraduation(address(auction));
        vm.roll(END_BLOCK + 2);
        vm.prank(bob);
        auction.exitBid(bobBid);
        vm.prank(alice);
        auction.exitPartiallyFilledBid(aliceBid, START_BLOCK, 0);
        vm.roll(CLAIM_BLOCK);
        vm.prank(bob);
        auction.claimTokens(bobBid); // Alice has not claimed: her Shares are still in the auction
        uint256 waiting = shares.balanceOf(address(auction));
        assertGt(waiting, 0, "some Shares are still waiting to be claimed");
        vm.roll(vm.getBlockNumber() + 1);

        bytes memory data = abi.encodeCall(Moloch.setQuorumBps, (uint16(1000)));
        uint256 id = dao.proposalId(0, address(dao), 0, data, bytes32("es3"));
        vm.prank(bob);
        dao.castVote(id, 1, 1);
        uint48 snap = dao.snapshotBlock(id);
        (uint96 votingSupply,,,,,,,,,) = policy.proposals(id);
        uint256 canVote = shares.getPastTotalSupply(snap) - shares.balanceOf(address(dao)) - waiting;
        assertEq(votingSupply, canVote, "the electorate is what can vote, not what waits in the auction");

        // Once Alice claims, her Shares count for the next proposal.
        vm.prank(alice);
        auction.claimTokens(aliceBid);
        vm.roll(vm.getBlockNumber() + 1);
        uint256 id2 = dao.proposalId(0, address(dao), 0, data, bytes32("es3-2"));
        vm.prank(bob);
        dao.castVote(id2, 1, 1);
        (uint96 votingSupply2,,,,,,,,,) = policy.proposals(id2);
        assertEq(votingSupply2, canVote + waiting - shares.balanceOf(address(auction)));
    }

    /// The team votes with its Shares from the first block, and a proposal's electorate is fixed when it opens. A
    /// treasury drain opened and passed while the sale is still running would have an electorate with no buyers in it,
    /// and run the moment the raise lands, leaving the backers nothing to exit with. So the DAO does not open for
    /// proposals until the buyers can claim.
    function test_no_proposal_can_open_during_the_sale_so_a_drain_cannot_be_prepared_before_the_buyers_arrive() public {
        _needArtifacts();
        (Moloch dao, IExecutor executor, IAuction auction) = _launch(bytes32("sale-boundary"));
        AllocationVoting policy = AllocationVoting(dao.votingWeight());
        assertEq(policy.governanceStartBlock(), CLAIM_BLOCK, "governance opens when the buyers can claim");
        vm.roll(block.number + 1);

        bytes memory drain = abi.encodeWithSignature("transfer(address,uint256)", founder, uint256(1200e18));
        bytes32 nonce = bytes32("drain");
        uint256 id = dao.proposalId(0, address(currency), 0, drain, nonce);
        // The team cannot open it, vote it in or open it by intent while the sale runs.
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(AllocationVoting.GovernanceNotOpen.selector, CLAIM_BLOCK));
        dao.castVote(id, 1, 225e18);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(AllocationVoting.GovernanceNotOpen.selector, CLAIM_BLOCK));
        dao.openProposalWithAction(0, address(currency), 0, drain, nonce);

        // The sale runs and ends; the raise lands in the DAO. Still nothing can be opened.
        vm.roll(START_BLOCK);
        address carol = makeAddr("carol");
        uint256 aliceBid = _bid(address(auction), alice, 720e18, 2 * Q96, Q96);
        _bid(address(auction), carol, 240e18, 2 * Q96, Q96);
        uint256 bobBid = _bid(address(auction), bob, 320e18, 4 * Q96, 2 * Q96);
        vm.roll(END_BLOCK + 1);
        auction.checkpoint();
        executor.executeGraduation(address(auction));
        assertEq(currency.balanceOf(address(dao)), 1200e18);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(AllocationVoting.GovernanceNotOpen.selector, CLAIM_BLOCK));
        dao.castVote(id, 1, 225e18);
        vm.expectRevert();
        dao.executeByVotes(0, address(currency), 0, drain, nonce);

        // Once the buyers can claim, the DAO opens. A drain opened at that moment still takes the review, the hold and the
        // execution delay, and a buyer who claims in that time leaves with their share of the raise first.
        vm.roll(END_BLOCK + 2);
        vm.prank(bob);
        auction.exitBid(bobBid);
        vm.prank(alice);
        auction.exitPartiallyFilledBid(aliceBid, START_BLOCK, 0);
        vm.roll(CLAIM_BLOCK);
        vm.prank(founder);
        dao.castVote(id, 1, 225e18);
        vm.prank(cofounder);
        dao.castVote(id, 1, 75e18);
        vm.expectRevert();
        dao.queue(id); // not yet: the review has not passed
        vm.prank(alice);
        auction.claimTokens(aliceBid);
        vm.roll(block.number + 1);
        address[] memory assets = new address[](1);
        assets[0] = address(currency);
        uint256 before_ = currency.balanceOf(alice);
        vm.prank(alice);
        dao.ragequit(assets, 180e18, 0);
        // 900 member Shares less the team's 300 still locked (D72).
        assertEq(currency.balanceOf(alice) - before_, uint256(1200e18) * 180e18 / 600e18);
    }

    function test_governance_can_only_be_held_closed_once_and_only_into_the_future() public {
        _needArtifacts();
        (Moloch dao,,) = _launch(bytes32("once"));
        AllocationVoting policy = AllocationVoting(dao.votingWeight());
        vm.prank(address(dao));
        vm.expectRevert(AllocationVoting.InvalidLane.selector); // already set
        policy.setGovernanceStart(uint64(block.number + 1000));
        vm.prank(founder);
        vm.expectRevert(AllocationVoting.Unauthorized.selector);
        policy.setGovernanceStart(uint64(block.number + 1000));
        // A launch whose claim block is not in the future cannot be made: the DAO would be born unable to close.
        bytes32 salt = bytes32("past");
        KitParams memory p = _params(salt, kit.predictExecutor(founder, salt));
        p.governanceStartBlock = uint64(block.number);
        vm.prank(founder);
        vm.expectRevert();
        kit.launch(p);
        // And the block the DAO opens at has to be the auction's own claim block.
        salt = bytes32("mismatch");
        p = _params(salt, kit.predictExecutor(founder, salt));
        p.governanceStartBlock = CLAIM_BLOCK + 1;
        vm.prank(founder);
        vm.expectRevert(bytes("kit: governance start"));
        kit.launch(p);
    }

    function test_a_launch_cannot_be_repeated_and_a_wrong_auction_config_reverts_everything() public {
        _needArtifacts();
        _launch(bytes32("nebula"));
        address predicted = kit.predictExecutor(founder, bytes32("nebula"));
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

    function test_another_wallet_cannot_use_a_salt_to_take_the_founders_addresses() public {
        _needArtifacts();
        bytes32 salt = bytes32("nebula");
        address stranger = makeAddr("stranger");
        // The same salt, from a different wallet, predicts different addresses.
        assertTrue(kit.predictExecutor(stranger, salt) != kit.predictExecutor(founder, salt));
        // The stranger launches first with the salt they saw the founder use.
        KitParams memory theirs = _params(salt, kit.predictExecutor(stranger, salt));
        vm.prank(stranger);
        kit.launch(theirs);
        // The founder's launch with that salt is untouched: it lands where the founder computed it.
        (Moloch dao, IExecutor executor,) = _launch(salt);
        assertEq(address(executor), kit.predictExecutor(founder, salt));
        assertEq(executor.treasury(), address(dao), "the founder's executor pays the founder's DAO");
    }

    /// D74 and D75: the kit refuses a launch whose terms are outside the limits, each at its edge.
    function test_unfair_terms_are_refused_at_the_edge_of_each_limit() public {
        _needArtifacts();
        bytes32 salt = bytes32("unfair");
        address executor = kit.predictExecutor(founder, salt);
        KitParams memory p;

        // The sale must be at least 60% of all Shares: 600 of 1001 is not.
        p = _params(salt, executor);
        p.daoShares = 101e18;
        _refused(p, 1);
        // The team at most 35%: 375 of 1025 is 36.6% (the sale, 650, is 63.4%).
        p = _params(salt, executor);
        p.saleSupply = 650e18;
        p.daoShares = 0;
        p.teamShares[0] = 300e18;
        _refused(p, 2);
        // The DAO's reserve at most 20%: 210 of 1000 is over (sale 700, team 90).
        p = _params(salt, executor);
        p.saleSupply = 700e18;
        p.daoShares = 210e18;
        p.teamShares[0] = 60e18;
        p.teamShares[1] = 30e18;
        _refused(p, 3);
        // Every team Share behind 2 to 8 milestones, none above half.
        p = _params(salt, executor);
        p.milestoneBps[1] = 4900; // 99% locked
        _refused(p, 4);
        p = _params(salt, executor);
        p.milestoneBps[0] = 5100;
        p.milestoneBps[1] = 4900; // one milestone holds more than half
        _refused(p, 4);
        p = _params(salt, executor);
        p.milestoneChecks = new bytes32[](1);
        p.milestoneChecks[0] = keccak256("everything");
        p.milestoneBps = new uint16[](1);
        p.milestoneBps[0] = 10_000; // one milestone only
        _refused(p, 4);
        // A team seat cannot be the DAO, the executor, the auction or the kit (D72's exit would count it twice).
        p = _params(salt, executor);
        p.team[1] = executor;
        _refused(p, 5);
        p = _params(salt, executor);
        p.team[1] = address(kit);
        _refused(p, 5);
        // The target must be the whole tranche at the floor: 599 of 600 is not.
        p = _params(salt, executor);
        AuctionParams memory a = abi.decode(p.auctionConfig, (AuctionParams));
        a.requiredCurrencyRaised = 599e18;
        p.auctionConfig = abi.encode(a);
        _refused(p, 6);
        // And the fixture itself, at the edges, launches.
        p = _params(salt, executor);
        vm.prank(founder);
        kit.launch(p);
    }

    function _refused(KitParams memory p, uint8 rule) internal {
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSignature("UnfairTerms(uint8)", rule));
        kit.launch(p);
    }

    function test_the_inputs_are_checked() public {
        _needArtifacts();
        bytes32 salt = bytes32("bad inputs");
        KitParams memory p = _params(salt, kit.predictExecutor(founder, salt));
        p.saleSupply = 0;
        vm.expectRevert();
        kit.launch(p);
        p = _params(salt, kit.predictExecutor(founder, salt));
        p.teamShares = new uint256[](1);
        vm.expectRevert();
        kit.launch(p);
    }

    /// A contract larger than 24,576 bytes cannot be deployed on a real chain, though the test EVM allows it, so the launch
    /// kit and the factories it deploys are held to the limit here. (A first version of the factory was 592 bytes over and
    /// only a real chain refused it.)
    function test_the_kit_and_its_factories_fit_on_a_real_chain() public {
        _needArtifacts();
        assertLe(address(kit).code.length, 24_576, "the kit");
        assertLe(kit.lockFactory().code.length, 24_576, "the panel lock factory");
        assertLe(kit.challengeFactory().code.length, 24_576, "the challenge lock factory");
        // The kit's creation code is limited too (EIP-3860); the factories are deployed beside it.
        assertLe(vm.getCode("DaoLaunchKit.sol:DaoLaunchKit").length, 49_152 - 64 * 5, "the kit's creation code");
    }

    // ---- milestones that unlock unless holders object -------------------------------------------------

    function _challengeTerms() internal view returns (KitChallengeTerms memory c) {
        c = KitChallengeTerms({
            window: 7 days,
            votePeriod: 5 days,
            clawback: 30 days,
            minRejectBps: 300,
            bondToken: address(currency),
            bond: 10e18,
            deposit: 1e18
        });
    }

    /// @dev The same launch as `_params`, with no panel: its milestones go to the holders instead.
    function _challengeParams(bytes32 salt, address executor) internal view returns (KitParams memory p) {
        p = _params(salt, executor);
        p.reviewers = new address[](0);
        p.reviewQuorum = 0;
        p.panelCurrency = address(0);
        p.panelExpires = 0;
    }

    function _launchChallenged(bytes32 salt) internal returns (Moloch dao, IExecutor executor, IAuction auction) {
        address predicted = kit.predictExecutor(founder, salt);
        vm.prank(founder);
        (address d, address e, address a) = kit.launchChallenged(_challengeParams(salt, predicted), _challengeTerms());
        assertEq(e, predicted);
        return (Moloch(payable(d)), IExecutor(e), IAuction(a));
    }

    function test_a_challenged_launch_locks_the_team_behind_the_holders_and_names_no_panel() public {
        _needArtifacts();
        (Moloch dao,,) = _launchChallenged(bytes32("challenged"));
        Shares shares = dao.shares();
        MilestoneChallenge lock = MilestoneChallenge(shares.lockGuard());
        assertTrue(address(lock) != address(0));
        assertEq(lock.dao(), address(dao));
        assertEq(lock.lockedOf(founder), 225e18);
        assertEq(lock.lockedOf(cofounder), 75e18);
        assertEq(lock.window(), 7 days);
        assertEq(lock.votePeriod(), 5 days);
        assertEq(lock.clawback(), 30 days);
        assertEq(lock.minRejectBps(), 300);
        assertEq(lock.bond(), 10e18);
        assertEq(lock.deposit(), 1e18);
        assertEq(lock.bondToken(), address(currency));
        assertEq(lock.earliestBlock(), CLAIM_BLOCK, "milestones wait for the buyers, like governance");

        // It came from the kit's own factory, which says so, and there is no panel to name.
        MilestoneChallengeFactory factory = MilestoneChallengeFactory(kit.challengeFactory());
        assertEq(factory.createdBy(address(lock)), address(kit));
        assertEq(TreasuryMandateFactory(kit.mandateFactory()).milestoneMandate(address(dao)), address(0));

        // The lock holds the team's Shares as firmly as the panel's does: none can leave before a milestone.
        _refusedAsLocked(dao, founder);
        // Nobody can take it off or swap it.
        vm.prank(address(dao));
        vm.expectRevert(Shares.LockGuardSet.selector);
        shares.setLockGuard(address(0));
    }

    function test_a_challenged_launch_has_milestones_and_no_panel() public {
        _needArtifacts();
        bytes32 salt = bytes32("challenged-mismatch");
        // A panel named as well.
        KitParams memory p = _params(salt, kit.predictExecutor(founder, salt));
        vm.prank(founder);
        vm.expectRevert(bytes4(keccak256("PanelMismatch()")));
        kit.launchChallenged(p, _challengeTerms());
        // No milestones to hand to the holders.
        p = _challengeParams(salt, kit.predictExecutor(founder, salt));
        p.milestoneChecks = new bytes32[](0);
        p.milestoneBps = new uint16[](0);
        vm.prank(founder);
        vm.expectRevert(bytes4(keccak256("PanelMismatch()")));
        kit.launchChallenged(p, _challengeTerms());
        // Terms the lock refuses fail the whole launch.
        p = _challengeParams(salt, kit.predictExecutor(founder, salt));
        KitChallengeTerms memory bad = _challengeTerms();
        bad.window = 1 hours;
        vm.prank(founder);
        vm.expectRevert(MilestoneChallenge.BadTerms.selector);
        kit.launchChallenged(p, bad);
    }

    function test_the_panel_and_the_challenge_locks_of_one_launcher_never_share_an_address() public {
        _needArtifacts();
        (Moloch panelDao,,) = _launch(bytes32("kind-a"));
        (Moloch challengeDao,,) = _launchChallenged(bytes32("kind-b"));
        assertTrue(panelDao.shares().lockGuard() != challengeDao.shares().lockGuard());
        assertEq(MilestoneLockFactory(kit.lockFactory()).createdBy(panelDao.shares().lockGuard()), address(kit));
        assertEq(MilestoneChallengeFactory(kit.challengeFactory()).createdBy(challengeDao.shares().lockGuard()), address(kit));
    }

    /// The whole path on the real kit, DAO and auction: the sale settles, the founder publishes a milestone, a backer
    /// objects and the backers hold it up, the founder tries again with a longer window, nobody objects, and it unlocks.
    function test_a_milestone_the_backers_reject_is_tried_again_and_unlocks_when_nobody_objects() public {
        _needArtifacts();
        (Moloch dao, IExecutor executor, IAuction auction) = _launchChallenged(bytes32("journey"));
        Shares shares = dao.shares();
        MilestoneChallenge lock = MilestoneChallenge(shares.lockGuard());
        vm.roll(START_BLOCK);
        uint256 aliceBid = _bid(address(auction), alice, 1040e18, 2 * Q96, Q96); // with Bob's 320, more than the 600 on sale at 2
        uint256 bobBid = _bid(address(auction), bob, 320e18, 4 * Q96, 2 * Q96);
        vm.roll(END_BLOCK + 1);
        auction.checkpoint();
        executor.executeGraduation(address(auction));
        vm.roll(END_BLOCK + 2);
        vm.prank(bob);
        auction.exitBid(bobBid);
        vm.prank(alice);
        auction.exitPartiallyFilledBid(aliceBid, START_BLOCK, 0);

        // Before the buyers can claim, nothing can be published.
        currency.mint(founder, 100e18);
        vm.prank(founder);
        currency.approve(address(lock), type(uint256).max);
        vm.prank(founder);
        vm.expectRevert(MilestoneChallenge.TooEarly.selector);
        lock.submit(0, bytes32("evidence"));

        vm.roll(CLAIM_BLOCK);
        vm.prank(alice);
        auction.claimTokens(aliceBid);
        vm.prank(bob);
        auction.claimTokens(bobBid);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(shares.balanceOf(bob), 160e18);

        // The founder publishes the first milestone (half of the team's Shares: a 21-day window) and bob objects.
        vm.prank(founder);
        lock.submit(0, bytes32("evidence"));
        currency.mint(bob, 1e18);
        vm.prank(bob);
        currency.approve(address(lock), type(uint256).max);
        vm.prank(bob);
        lock.object(0);
        vm.prank(alice);
        lock.vote(0, true);
        vm.warp(vm.getBlockTimestamp() + 21 days);
        lock.resolve(0);
        (MilestoneChallenge.Phase phase,, uint8 attempts,,,,,) = lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.None));
        assertEq(attempts, 1);
        assertEq(currency.balanceOf(bob), 1e18 + 5e18, "the deposit back, and half the founder's bond");
        assertEq(currency.balanceOf(address(dao)), 1200e18 + 5e18, "the raise, and the other half of the bond");
        assertEq(lock.lockedOf(founder), 225e18);

        // The second attempt waits twice as long. Nobody objects, anyone finishes it, and the team's first half is free.
        vm.prank(founder);
        lock.submit(0, bytes32("better evidence"));
        vm.warp(vm.getBlockTimestamp() + 42 days);
        lock.finish(0);
        assertEq(lock.lockedOf(founder), 112.5e18);
        assertEq(lock.lockedOf(cofounder), 37.5e18);
        _leaveWith(dao, founder, 112.5e18); // the half that just unlocked
        _refusedAsLocked(dao, founder);
        // The bond comes back once the month of clawback is over.
        vm.warp(vm.getBlockTimestamp() + 30 days);
        uint256 before_ = currency.balanceOf(founder);
        lock.releaseBond(0);
        assertEq(currency.balanceOf(founder), before_ + 10e18);
    }

    /// @dev With transfers locked (D77), what is free is shown by leaving with it.
    function _leaveWith(Moloch dao, address who, uint256 amount) internal {
        address[] memory assets = new address[](1);
        assets[0] = address(currency);
        vm.prank(who);
        dao.ragequit(assets, amount, 0);
    }

    function _refusedAsLocked(Moloch dao, address who) internal {
        address[] memory assets = new address[](1);
        assets[0] = address(currency);
        vm.prank(who);
        vm.expectRevert(Shares.LockedShares.selector);
        dao.ragequit(assets, 1, 0);
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
