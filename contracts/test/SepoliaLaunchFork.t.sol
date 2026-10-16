// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {MilestoneLock} from "../src/MilestoneLock.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {Call, Moloch, Shares, Summoner, newSummoner} from "../src/majeur/MolochPatched.sol";
import {IPermit2Approve, IExecutor, IAuction, AuctionParams} from "./helpers/LaunchMocks.sol";

/// @dev Same field order as `DaoLaunchKit.Params` (the kit is compiled with solc 0.8.26 and is deployed from its artifact).
struct ForkKitParams {
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

interface IForkKit {
    function launch(ForkKitParams calldata p) external returns (address dao, address executor, address auction);
    function predictExecutor(address launcher, bytes32 salt) external view returns (address);
}

interface IUsdc {
    function balanceOf(address who) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice The whole story on REAL Sepolia contracts: our patched summoner and launch kit (deployed here) driving Uniswap's
/// auction factory, Permit2 and Circle's USDC as they are on the chain. A launch, two bidders who clear the sale, the raise
/// settling into the DAO, a milestone panel that refuses the team and asks a bond in real USDC, and the founder's first
/// tranche unlocking on a reviewed claim.
///
/// Fork-only. Run: `forge test --match-contract SepoliaLaunchForkTest --fork-url $SEPOLIA_RPC_URL`. Without a Sepolia
/// fork every test here skips with that reason, so the local suite stays offline.
contract SepoliaLaunchForkTest is Test {
    uint256 internal constant Q96 = 1 << 96;
    address internal constant CCA_FACTORY = 0x000000001F26a0044BaA66024e7b6599c61963F8;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// @dev Circle's USDC on Sepolia (6 decimals).
    address internal constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    /// @dev A price of one USDC for one Share: 1e-12 raw USDC per raw Share, as a Q96 number, on a 1% tick.
    uint256 internal constant TICK = 792281625142643;
    uint256 internal constant FLOOR = TICK * 100;
    uint128 internal constant SALE = 400e18;
    bytes32 internal constant CHECK_ONE = keccak256("alpha shipped");
    bytes32 internal constant CHECK_TWO = keccak256("first customers");
    bytes32 internal constant PROJECT = bytes32("founders");
    uint128 internal constant BOND = 25e6;

    address internal founder = makeAddr("founder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal manager = makeAddr("manager");
    address internal reviewer = makeAddr("reviewer");
    address internal reviewer2 = makeAddr("reviewer2");

    IForkKit internal kit;
    Moloch internal dao;
    Shares internal shares;
    IExecutor internal executor;
    IAuction internal auction;
    uint64 internal startBlock;
    uint64 internal endBlock;
    uint64 internal claimBlock;

    function setUp() public {
        if (block.chainid != 11155111 || CCA_FACTORY.code.length == 0 || USDC.code.length == 0) {
            vm.skip(
                true,
                "needs a Sepolia fork: forge test --match-contract SepoliaLaunchForkTest --fork-url $SEPOLIA_RPC_URL"
            );
        }
        (bool ok,) = address(vm).call(abi.encodeWithSignature("getCode(string)", "DaoLaunchKit.sol:DaoLaunchKit"));
        if (!ok) {
            if (vm.envOr("REQUIRE_CONTRACT_ARTIFACTS", false)) revert("the kit artifact was not compiled");
            vm.skip(
                true, "needs the kit artifact: run with --match-contract over the whole project, not a filtered path"
            );
        }
        Summoner summoner = newSummoner();
        kit = IForkKit(
            vm.deployCode(
                "DaoLaunchKit.sol:DaoLaunchKit",
                abi.encode(address(summoner), CCA_FACTORY, _sharesImplementation(summoner))
            )
        );
    }

    /// @dev Every DAO this summoner makes clones one Shares implementation: the proxy's runtime code is nine bytes of prefix,
    /// the implementation's address, then the tail. Read it off a DAO made for the purpose.
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

    function _config(address executor_) internal view returns (bytes memory) {
        return abi.encode(
            AuctionParams({
                currency: USDC,
                tokensRecipient: executor_,
                fundsRecipient: executor_,
                startBlock: startBlock,
                endBlock: endBlock,
                claimBlock: claimBlock,
                tickSpacing: TICK,
                validationHook: address(0),
                floorPrice: FLOOR,
                requiredCurrencyRaised: 500e6,
                auctionStepsData: abi.encodePacked(uint24(5_000_000), uint40(2))
            })
        );
    }

    function _launch() internal {
        startBlock = uint64(block.number + 20);
        endBlock = startBlock + 2;
        claimBlock = endBlock + 3;
        bytes32 salt = bytes32("nebula-sepolia");
        address predicted = kit.predictExecutor(founder, salt);

        ForkKitParams memory p;
        p.name = "Nebula";
        p.symbol = "NEB";
        p.uri = "";
        p.proposalThreshold = 10e18;
        p.salt = salt;
        p.team = new address[](1);
        p.team[0] = founder;
        p.teamShares = new uint256[](1);
        p.teamShares[0] = 600e18;
        // 40% of the founder's Shares unlock with the first milestone, 40% with the second; 20% were never locked.
        p.milestoneChecks = new bytes32[](2);
        p.milestoneChecks[0] = CHECK_ONE;
        p.milestoneChecks[1] = CHECK_TWO;
        p.milestoneBps = new uint16[](2);
        p.milestoneBps[0] = 4000;
        p.milestoneBps[1] = 4000;
        // The launch names the panel that judges the milestones, with a 25 USDC bond each.
        p.reviewers = new address[](2);
        p.reviewers[0] = reviewer;
        p.reviewers[1] = reviewer2;
        p.reviewQuorum = 1;
        p.reviewerBond = BOND;
        p.bondToken = USDC;
        p.panelCurrency = USDC;
        p.panelExpires = uint64(block.timestamp + 730 days);
        p.daoShares = 0;
        p.saleSupply = SALE;
        p.auctionConfig = _config(predicted);
        p.auctionSalt = salt;
        p.governanceStartBlock = claimBlock;

        vm.prank(founder);
        uint256 gasBefore = gasleft();
        (address d, address e, address a) = kit.launch(p);
        uint256 used = gasBefore - gasleft();
        emit log_named_uint("gas the one launch transaction uses", used);
        // Ethereum caps one transaction at 2^24 gas (EIP-7825): a launch that needs more could not be sent at all.
        assertLt(used, 16_777_216, "the launch must fit in one transaction");
        assertEq(e, predicted, "the executor lands where the client computed it");
        dao = Moloch(payable(d));
        shares = dao.shares();
        executor = IExecutor(e);
        auction = IAuction(a);
        vm.roll(startBlock);
    }

    function _bid(address bidder, uint128 amount, uint256 maxPrice, uint256 prevTick) internal returns (uint256 id) {
        deal(USDC, bidder, amount);
        vm.startPrank(bidder);
        IUsdc(USDC).approve(PERMIT2, amount);
        IPermit2Approve(PERMIT2).approve(USDC, address(auction), uint160(amount), type(uint48).max);
        id = auction.submitBid(maxPrice, amount, bidder, prevTick, "");
        vm.stopPrank();
    }

    /// @dev Alice 720 and Carol 240 USDC at 2 per Share, Bob 320 at 4: clears at 2, raises 800, sells every Share.
    function _raise() internal {
        uint256 aliceBid = _bid(alice, 720e6, 2 * FLOOR, FLOOR);
        uint256 carolBid = _bid(carol, 240e6, 2 * FLOOR, FLOOR);
        uint256 bobBid = _bid(bob, 320e6, 4 * FLOOR, 2 * FLOOR);
        vm.roll(endBlock + 1);
        auction.checkpoint();
        executor.executeGraduation(address(auction));
        vm.roll(endBlock + 2);
        vm.prank(bob);
        auction.exitBid(bobBid);
        vm.prank(alice);
        auction.exitPartiallyFilledBid(aliceBid, startBlock, 0);
        vm.prank(carol);
        auction.exitPartiallyFilledBid(carolBid, startBlock, 0);
        vm.roll(claimBlock);
        vm.prank(alice);
        auction.claimTokens(aliceBid);
        vm.prank(bob);
        auction.claimTokens(bobBid);
        vm.prank(carol);
        auction.claimTokens(carolBid);
        vm.roll(block.number + 1);
    }

    function test_the_launch_the_sale_and_the_raise_work_on_the_real_auction_and_usdc() public {
        _launch();
        // The sale tranche sits in the real auction, funded by the kit's executor.
        assertEq(shares.balanceOf(address(auction)), SALE);
        assertEq(auction.token(), address(shares));
        _raise();

        // The raise reached the DAO, less whatever the real factory's protocol fee takes. The founder touched none of it.
        uint256 raised = IUsdc(USDC).balanceOf(address(dao));
        emit log_named_decimal_uint("USDC the DAO received", raised, 6);
        assertGt(raised, 700e6, "about 800 USDC raised at the clearing price of 2");
        assertLe(raised, 800e6);
        assertEq(IUsdc(USDC).balanceOf(founder), 0);
        assertEq(IUsdc(USDC).balanceOf(address(executor)), 0, "the executor held nothing back");

        // The backers hold the DAO's own Shares at the clearing price (to the rounding a 6-decimal currency forces on a
        // Q96 price: a hair under the round number, never over).
        assertApproxEqRel(shares.balanceOf(alice), 180e18, 1e9);
        assertApproxEqRel(shares.balanceOf(bob), 160e18, 1e9);
        assertApproxEqRel(shares.balanceOf(carol), 60e18, 1e9);
        assertLe(shares.balanceOf(alice) + shares.balanceOf(bob) + shares.balanceOf(carol), uint256(SALE));
        assertEq(shares.totalSupply(), 1000e18);

        // A backer is not locked in: Bob exits at the treasury's value per Share, in real USDC.
        address[] memory assets = new address[](1);
        assets[0] = USDC;
        uint256 before = IUsdc(USDC).balanceOf(bob);
        uint256 bobShares = shares.balanceOf(bob);
        vm.prank(bob);
        dao.ragequit(assets, bobShares, 0);
        assertApproxEqRel(IUsdc(USDC).balanceOf(bob) - before, raised * 160 / 1000, 1e12);
    }

    function test_the_milestone_panel_refuses_the_team_and_asks_a_bond_in_real_usdc() public {
        _launch();
        _raise();
        MilestoneLock lock = MilestoneLock(shares.lockGuard());
        assertEq(lock.lockedOf(founder), 480e18, "80% of the founder's 600 are held back until milestones");

        // The panel was named in the launch, with its bond; the founder is a locked team member, so the contract also
        // refuses them on any panel the DAO makes later.
        TreasuryMandateFactory factory = TreasuryMandateFactory(_factory());
        address[] memory withFounder = new address[](2);
        withFounder[0] = reviewer;
        withFounder[1] = founder;
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidMandate.selector);
        factory.create(USDC, 0, 0, 10, 10, uint64(block.timestamp + 90 days), withFounder, 1, BOND, USDC);

        TreasuryMandate mandate = TreasuryMandate(factory.milestoneMandate(address(dao)));
        assertTrue(address(mandate) != address(0), "the launch named the milestone panel");
        VerifierSet verifiers = mandate.verifiers();
        assertEq(address(verifiers.bondToken()), USDC);
        assertEq(verifiers.minBond(), BOND);
        ClaimStake claims = mandate.claims();
        // A friendlier panel the DAO makes afterwards cannot unlock anything: only the one the backers saw counts.
        address[] memory friendly = new address[](1);
        friendly[0] = reviewer2;
        vm.prank(address(dao));
        TreasuryMandate later = factory.create(USDC, 0, 0, 10, 10, uint64(block.timestamp + 90 days), friendly, 1, 0, address(0));
        vm.startPrank(address(dao));
        later.approveProject(bytes32("later"), manager, 0, 2, uint64(block.timestamp + 60 days), CHECK_ONE);
        mandate.approveProject(PROJECT, manager, 0, 0, uint64(block.timestamp + 60 days), CHECK_ONE);
        vm.stopPrank();

        // The founder files the first milestone, the manager takes it on.
        bytes32 claim = bytes32("alpha");
        vm.startPrank(founder);
        claims.submitClaim(claim, 0, 0, keccak256("evidence"));
        claims.setCheck(claim, CHECK_ONE);
        vm.stopPrank();
        vm.prank(manager);
        mandate.fundMilestone(PROJECT, claim, founder);

        // The reviewer cannot judge until the bond is in, and the bond is real USDC, from their own wallet.
        vm.prank(reviewer);
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.BondTooLow.selector, 0, uint256(BOND)));
        verifiers.attest(claim, true);
        deal(USDC, reviewer, BOND);
        vm.startPrank(reviewer);
        IUsdc(USDC).approve(address(verifiers), BOND);
        verifiers.bond(BOND);
        vm.stopPrank();
        assertEq(IUsdc(USDC).balanceOf(address(verifiers)), BOND, "the bond is held by the panel");
        vm.prank(reviewer);
        verifiers.attest(claim, true);

        claims.settle(claim);
        vm.warp(block.timestamp + 3 days);
        vm.prank(founder);
        claims.payout(claim);

        // The first tranche is freed, and exactly that much: 40% of 600. The rest is still held.
        lock.unlock(founder, 0, address(mandate), claim);
        // (And a claim cannot be used twice, nor taken to the later, friendlier mandate.)
        vm.expectRevert(MilestoneLock.NotThisDaosMandate.selector);
        lock.unlock(founder, 1, address(later), claim);
        assertEq(lock.lockedOf(founder), 240e18);
        vm.prank(founder);
        shares.transfer(alice, 240e18 + 120e18); // the unlocked 240 and the never-locked 120
        vm.prank(founder);
        vm.expectRevert(Shares.LockedShares.selector);
        shares.transfer(alice, 1);

        // A careless approval can be punished: the DAO takes the bond, and it lands in the DAO.
        uint256 treasury = IUsdc(USDC).balanceOf(address(dao));
        vm.prank(address(dao));
        mandate.slashReviewer(reviewer, BOND);
        assertEq(IUsdc(USDC).balanceOf(address(dao)) - treasury, BOND);
    }

    /// @dev The mandate factory the DAO's voting policy names.
    function _factory() internal view returns (address) {
        (bool ok, bytes memory data) =
            address(dao.votingWeight()).staticcall(abi.encodeWithSignature("mandateFactory()"));
        require(ok && data.length == 32, "no mandate factory");
        return abi.decode(data, (address));
    }
}
