// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ActivationVoting} from "../src/ActivationVoting.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolDeployer, BackingPoolFactory} from "../src/BackingPoolFactory.sol";
import {ContributorKit} from "../src/ContributorKit.sol";
import {ContributorKitV2} from "../src/ContributorKitV2.sol";
import {ContributorKitV3} from "../src/ContributorKitV3.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFactory} from "../src/SecondaryMarketFactory.sol";
import {Moloch, Shares, Summoner} from "../src/majeur/MolochPatched.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {PoolQuote} from "./helpers/BackingPoolFixture.sol";

/// @dev The auction, as far as these tests drive it (it pins another compiler, so it is not imported).
interface IRoundAuctionLike {
    function submitBid(uint256 maxPrice, uint128 amount, address owner, uint256 prevTickPrice, bytes calldata hookData)
        external
        payable
        returns (uint256);
    function exitBid(uint256 bidId) external;
    function claimTokens(uint256 bidId) external;
    function endBlock() external view returns (uint64);
    function claimBlock() external view returns (uint64);
    function floorPrice() external view returns (uint256);
    function tickSpacing() external view returns (uint256);
    function totalSupply() external view returns (uint128);
    function fundsRecipient() external view returns (address);
    function tokensRecipient() external view returns (address);
    function currency() external view returns (address);
    function token() external view returns (address);
}

/// @dev The auction's mock fee controller, as far as these tests drive it.
interface IFeeControllerLike {
    function setProtocolFeeAmount(uint256 amount) external;
    function setProtocolFeeRecipient(address recipient) external;
}

/// @dev Stands at Arbitrum's system address (100): the chain's own block number, which is not `block.number` there.
contract ArbSysStub {
    uint256 public number;

    function set(uint256 number_) external {
        number = number_;
    }

    function arbBlockNumber() external view returns (uint256) {
        return number;
    }
}

/// @dev Stands at Permit2's address for bids: the one call the auction makes to pull a bid.
contract Permit2Stub {
    function transferFrom(address from, address to, uint160 amount, address token) external {
        require(IERC20(token).transferFrom(from, to, amount), "pull");
    }
}

/// @notice The pool on real projects: opened at birth by `ContributorKitV3`, opened later by the founder of a
/// `ContributorKitV2` project in one call, and what the factory refuses. Every DAO here is a real one from a
/// real summoner.
contract ContributorKitV3Test is Test {
    address internal constant FOUNDER = address(0xF0);
    address internal constant R1 = address(0xA1);
    address internal constant R2 = address(0xA2);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant CHECK = keccak256("docs merged and reviewed");
    bytes32 internal constant PROJECT = bytes32("docs");
    bytes32 internal constant REF = keccak256("record event: milestone 1");
    uint256 internal constant MAX_INITCODE = 49_152;
    uint256 internal constant MAX_RUNTIME = 24_576;

    Summoner internal summoner;
    TreasuryMandateFactory internal mandateFactory;
    PoolQuote internal quote;
    /// @dev The deployed pair as it is today, and the new set beside it on the same summoner.
    SecondaryMarketFactory internal marketFactoryV2;
    ContributorKitV2 internal kitV2;
    SecondaryMarketFactory internal marketFactoryV3;
    BackingPoolFactory internal poolFactory;
    ContributorKitV3 internal kit;

    event PoolOpened(address indexed dao, address indexed pool, address indexed founder, address openedBy);

    function terms() internal pure returns (BackingPool.Params memory p) {
        p.virtualQuote = 25_000e18;
        p.virtualUnits = 1_000_000_000e18;
        p.projectBps = 1000;
        p.feeBps = 100;
        p.trancheBps = 2500;
        p.objectionWindow = 7 days;
        p.resolveWindow = 7 days;
        p.claimInterval = 28 days;
        p.abandonAfter = 180 days;
        p.voteSeasoning = 30 days;
        p.voteAfter = 90 days;
        p.earlyWindow = 1 days;
        p.earlyCap = 1_000e18;
    }

    /// @dev The real auction factory, from its compiled artifact (it pins another compiler, so it cannot be
    /// imported here), with no protocol fee.
    address internal auctionFactory;

    function noRound() internal pure returns (BackingPoolFactory.RoundSettings memory r) {}

    function rounds() internal view returns (BackingPoolFactory.RoundSettings memory r) {
        r.auctionFactory = auctionFactory;
        r.blocks = 50_000;
        r.supply = 100_000_000e18;
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1_000);
        auctionFactory = vm.deployCode(
            "ContinuousClearingAuctionFactory.sol:ContinuousClearingAuctionFactory", abi.encode(address(0))
        );
        mandateFactory = new TreasuryMandateFactory();
        ActivationVoting policy = new ActivationVoting(mandateFactory);
        summoner = new Summoner(address(policy));
        quote = new PoolQuote();
        // The pair already deployed.
        address predictedV2 = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        marketFactoryV2 = new SecondaryMarketFactory(summoner, predictedV2);
        kitV2 = new ContributorKitV2(summoner, marketFactoryV2);
        // The new set, as the deploy script makes it: both factories first, authorised for the kit's address.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        marketFactoryV3 = new SecondaryMarketFactory(summoner, predicted);
        poolFactory = new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), predicted, rounds());
        kit = new ContributorKitV3(summoner, marketFactoryV3, poolFactory);
        assertEq(address(kit), predicted);
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? ALICE : BOB;
            quote.mint(who, 1_000_000e18);
        }
    }

    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function _params(bytes32 salt) internal returns (ContributorKitV2.LaunchParams memory p) {
        address[] memory reviewers = new address[](2);
        reviewers[0] = R1;
        reviewers[1] = R2;
        p.base.name = "Docs Commons";
        p.base.symbol = "DOCS";
        p.base.founderShares = 200e18;
        p.base.salt = salt;
        p.base.currency = address(quote);
        p.base.shareBudget = 600e18;
        p.base.shareCap = 40e18;
        p.base.budgetExpires = _now() + 90 days;
        p.base.reviewers = reviewers;
        p.base.quorum = 2;
        p.base.predictedBudget = vm.computeCreateAddress(address(mandateFactory), vm.getNonce(address(mandateFactory)));
        p.base.projects = new ContributorKit.FirstProject[](1);
        p.base.projects[0] = ContributorKit.FirstProject({
            id: PROJECT, manager: FOUNDER, shares: 40e18, expires: _now() + 90 days, check: CHECK
        });
        p.saleStart = 0;
        p.saleCliff = 180 days;
        p.saleDuration = 180 days;
        p.quote = address(quote);
        p.lotSize = 1e18;
    }

    function _launchWithPool(bytes32 salt) internal returns (Moloch dao, BackingPool pool) {
        ContributorKitV2.LaunchParams memory p = _params(salt);
        vm.prank(FOUNDER);
        (address d,,, address made) = kit.launchWithPool(p);
        dao = Moloch(payable(d));
        pool = BackingPool(made);
    }

    function _launchV2(bytes32 salt) internal returns (Moloch dao) {
        ContributorKitV2.LaunchParams memory p = _params(salt);
        vm.prank(FOUNDER);
        (address d,,) = kitV2.launch(p);
        dao = Moloch(payable(d));
    }

    function _buy(BackingPool pool, address who, uint256 amount) internal returns (uint256 units) {
        vm.startPrank(who);
        quote.approve(address(pool), type(uint256).max);
        units = pool.buy(amount, 0, type(uint256).max);
        vm.stopPrank();
    }

    // ---- live at birth --------------------------------------------------------------------------------------------

    function test_one_transaction_makes_the_project_with_its_pool_open() public {
        ContributorKitV2.LaunchParams memory p = _params("one");
        vm.prank(FOUNDER);
        (address dao, address budget, address policy, address made) = kit.launchWithPool(p);
        BackingPool pool = BackingPool(made);

        assertEq(poolFactory.poolOf(dao), made);
        assertEq(poolFactory.poolCount(), 1);
        assertEq(poolFactory.pools(0), made);
        assertEq(pool.dao(), dao);
        assertEq(pool.founder(), FOUNDER);
        assertEq(address(pool.quote()), address(quote));
        assertEq(pool.factory(), address(poolFactory.poolDeployer()));
        assertEq(pool.openedAt(), _now());
        assertEq(pool.projectBps(), 1000);
        assertEq(pool.earlyCap(), 1_000e18);
        assertEq(poolFactory.founderOf(dao), FOUNDER);
        assertEq(TreasuryMandateFactory(mandateFactory).daos(budget), dao);
        assertEq(Moloch(payable(dao)).votingWeight(), policy);

        // Backing works in the block the project was born in.
        uint256 units = _buy(pool, ALICE, 500e18);
        assertGt(units, 0);
        assertEq(pool.balanceOf(ALICE), units);
    }

    /// @dev `launchWithPool` is the V2 launch plus the pool: the same terms through both kits give DAOs that
    /// read the same, setting by setting.
    function test_a_v3_project_is_a_v2_project_with_a_pool() public {
        // Two salts: the summoner is shared, so the same founder, grant and salt would be the same DAO.
        (Moloch a,) = _launchWithPool("through v3");
        Moloch b = _launchV2("through v2");
        assertTrue(address(a) != address(b));
        assertEq(address(a).codehash, address(b).codehash);
        assertEq(a.proposalThreshold(), b.proposalThreshold());
        assertEq(a.proposalTTL(), b.proposalTTL());
        assertEq(a.timelockDelay(), b.timelockDelay());
        assertEq(a.quorumBps(), b.quorumBps());
        assertEq(a.ragequittable(), b.ragequittable());
        Shares sa = a.shares();
        Shares sb = b.shares();
        assertEq(sa.totalSupply(), sb.totalSupply());
        assertEq(sa.balanceOf(FOUNDER), sb.balanceOf(FOUNDER));
        assertEq(sa.transfersLocked(), sb.transfersLocked());
        assertEq(sa.unlockNoticeRequired(), sb.unlockNoticeRequired());
        assertEq(sa.lockGuardSet(), sb.lockGuardSet());
        assertEq(sa.lockGuard(), sb.lockGuard());
        assertEq(sa.awardsOnly(), sb.awardsOnly());
        assertEq(sa.issuanceCapBps(), sb.issuanceCapBps());
        assertEq(sa.salePolicyChosen(), sb.salePolicyChosen());
        assertEq(sa.salePolicy(), a.votingWeight());
        assertEq(sb.salePolicy(), b.votingWeight());
        // Each has its own market, from its own kit's factory, as the Shares' one exempt endpoint, not listed.
        SecondaryMarket ma = SecondaryMarket(marketFactoryV3.marketOf(address(a)));
        SecondaryMarket mb = SecondaryMarket(marketFactoryV2.marketOf(address(b)));
        assertEq(sa.transferExempt(), address(ma));
        assertEq(sb.transferExempt(), address(mb));
        assertEq(ma.lotSize(), mb.lotSize());
        (bool listedA,,,) = ma.listing();
        (bool listedB,,,) = mb.listing();
        assertFalse(listedA);
        assertFalse(listedB);
        (, address founderA, uint256 grantA, uint64 startA, uint64 cliffA, uint64 durationA) =
            ActivationVoting(a.votingWeight()).secondaryConfiguration();
        (, address founderB, uint256 grantB, uint64 startB, uint64 cliffB, uint64 durationB) =
            ActivationVoting(b.votingWeight()).secondaryConfiguration();
        assertEq(founderA, founderB);
        assertEq(grantA, grantB);
        assertEq(startA, startB);
        assertEq(cliffA, cliffB);
        assertEq(durationA, durationB);
        // The only difference: one has a pool.
        assertTrue(poolFactory.poolOf(address(a)) != address(0));
        assertEq(poolFactory.poolOf(address(b)), address(0));
    }

    function test_the_pool_has_no_power_over_the_dao_and_units_are_not_votes() public {
        (Moloch dao, BackingPool pool) = _launchWithPool("votes");
        Shares shares = dao.shares();
        uint256 supply = shares.totalSupply();
        vm.warp(_now() + 1 days);
        _buy(pool, ALICE, 500_000e18);
        vm.roll(block.number + 1);
        assertEq(shares.totalSupply(), supply, "no Shares were minted");
        assertEq(shares.balanceOf(ALICE), 0);
        assertEq(shares.getVotes(ALICE), 0);
        assertEq(shares.balanceOf(address(pool)), 0);
        assertEq(shares.getVotes(FOUNDER), supply, "the founder still holds every vote");
        // And the pool cannot mint or move them.
        vm.prank(address(pool));
        vm.expectRevert();
        shares.mintFromMoloch(ALICE, 1e18);
    }

    function test_a_released_tranche_and_the_fees_land_in_the_dao_treasury() public {
        (Moloch dao, BackingPool pool) = _launchWithPool("treasury");
        vm.warp(_now() + 1 days);
        _buy(pool, ALICE, 100_000e18);
        uint256 escrow = pool.escrow();
        vm.warp(pool.nextClaimAt());
        vm.prank(FOUNDER);
        pool.postMilestone(REF);
        vm.warp(_now() + 7 days);
        pool.resolveMilestone();
        assertEq(quote.balanceOf(address(dao)), escrow / 4 + pool.feesTaken());
        // The DAO itself (a passed decision) can post the next one.
        vm.warp(pool.nextClaimAt());
        vm.prank(address(dao));
        assertEq(pool.postMilestone(keccak256("two")), 2);
    }

    // ---- opening later, for a project that exists ------------------------------------------------------------------

    function test_the_founder_of_a_v2_project_opens_its_pool_in_one_call() public {
        Moloch dao = _launchV2("later");
        assertEq(poolFactory.poolOf(address(dao)), address(0));
        assertEq(poolFactory.founderOf(address(dao)), FOUNDER);
        vm.expectEmit(true, false, true, false, address(poolFactory));
        emit PoolOpened(address(dao), address(0), FOUNDER, FOUNDER);
        vm.prank(FOUNDER);
        BackingPool pool = poolFactory.open(address(dao));
        assertEq(poolFactory.poolOf(address(dao)), address(pool));
        assertEq(pool.founder(), FOUNDER);
        assertEq(pool.dao(), address(dao));
        assertGt(_buy(pool, ALICE, 500e18), 0);
    }

    function test_a_project_has_one_pool_ever() public {
        (Moloch dao, BackingPool pool) = _launchWithPool("once");
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(BackingPoolFactory.AlreadyOpen.selector, address(pool)));
        poolFactory.open(address(dao));
        vm.prank(address(dao));
        vm.expectRevert(abi.encodeWithSelector(BackingPoolFactory.AlreadyOpen.selector, address(pool)));
        poolFactory.open(address(dao));
    }

    function test_a_stranger_cannot_open_a_projects_pool() public {
        Moloch dao = _launchV2("stranger");
        vm.prank(ALICE);
        vm.expectRevert(BackingPoolFactory.NotAllowed.selector);
        poolFactory.open(address(dao));
        // The other kit is a stranger too.
        vm.prank(address(kitV2));
        vm.expectRevert(BackingPoolFactory.NotAllowed.selector);
        poolFactory.open(address(dao));
    }

    function test_the_dao_can_open_its_own_pool() public {
        Moloch dao = _launchV2("dao opens");
        vm.prank(address(dao));
        BackingPool pool = poolFactory.open(address(dao));
        assertEq(pool.founder(), FOUNDER);
    }

    /// @dev A project made by the legacy launch has no founder on record: only its DAO can open the pool, and
    /// only its DAO can post milestones.
    function test_a_legacy_project_opens_its_pool_by_a_decision_of_the_dao() public {
        ContributorKitV2.LaunchParams memory p = _params("legacy");
        vm.prank(FOUNDER);
        (address dao,) = kitV2.launch(p.base);
        assertEq(poolFactory.founderOf(dao), address(0));
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPoolFactory.NotAllowed.selector);
        poolFactory.open(dao);
        vm.prank(dao);
        BackingPool pool = poolFactory.open(dao);
        assertEq(pool.founder(), address(0));
        vm.warp(pool.nextClaimAt());
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPool.NotClaimant.selector);
        pool.postMilestone(REF);
        vm.prank(dao);
        pool.postMilestone(REF);
    }

    function test_only_a_dao_of_the_pinned_summoner_gets_a_pool() public {
        vm.expectRevert(BackingPoolFactory.UnprovenDao.selector);
        poolFactory.open(address(0xDEAD));
        vm.expectRevert(BackingPoolFactory.UnprovenDao.selector);
        poolFactory.open(address(quote));
        // A real DAO, from another summoner.
        TreasuryMandateFactory otherMandates = new TreasuryMandateFactory();
        Summoner other = new Summoner(address(new ActivationVoting(otherMandates)));
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        SecondaryMarketFactory otherMarkets = new SecondaryMarketFactory(other, predicted);
        ContributorKitV2 otherKit = new ContributorKitV2(other, otherMarkets);
        ContributorKitV2.LaunchParams memory p = _params("other");
        p.base.predictedBudget = vm.computeCreateAddress(address(otherMandates), vm.getNonce(address(otherMandates)));
        vm.prank(FOUNDER);
        (address dao,,) = otherKit.launch(p);
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPoolFactory.UnprovenDao.selector);
        poolFactory.open(dao);
    }

    // ---- construction ---------------------------------------------------------------------------------------------

    function test_the_factory_reads_back_what_it_was_made_with() public view {
        assertEq(address(poolFactory.summoner()), address(summoner));
        assertEq(address(poolFactory.quote()), address(quote));
        assertEq(poolFactory.authorizedKit(), address(kit));
        assertEq(address(kit.poolFactory()), address(poolFactory));
        assertEq(address(kit.marketFactory()), address(marketFactoryV3));
        BackingPool.Params memory t = poolFactory.terms();
        assertEq(t.virtualQuote, 25_000e18);
        assertEq(t.virtualUnits, 1_000_000_000e18);
        assertEq(t.projectBps, 1000);
        assertEq(t.feeBps, 100);
        assertEq(t.trancheBps, 2500);
        assertEq(t.objectionWindow, 7 days);
        assertEq(t.resolveWindow, 7 days);
        assertEq(t.claimInterval, 28 days);
        assertEq(t.abandonAfter, 180 days);
        assertEq(t.voteSeasoning, 30 days);
        assertEq(t.voteAfter, 90 days);
        assertEq(t.earlyWindow, 1 days);
        assertEq(t.earlyCap, 1_000e18);
    }

    function test_the_factory_refuses_a_summoner_or_quote_without_code() public {
        vm.expectRevert(BackingPoolFactory.InvalidSetup.selector);
        new BackingPoolFactory(Summoner(address(0x1234)), IERC20(address(quote)), terms(), address(0), noRound());
        vm.expectRevert(BackingPoolFactory.InvalidSetup.selector);
        new BackingPoolFactory(summoner, IERC20(address(0x1234)), terms(), address(0), noRound());
    }

    function test_a_factory_without_a_kit_still_serves_founders() public {
        BackingPoolFactory plain =
            new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0), noRound());
        Moloch dao = _launchV2("plain");
        vm.prank(address(0));
        vm.expectRevert(BackingPoolFactory.NotAllowed.selector);
        plain.open(address(dao));
        vm.prank(FOUNDER);
        plain.open(address(dao));
    }

    function test_a_factory_with_bad_terms_opens_nothing() public {
        BackingPool.Params memory bad = terms();
        bad.trancheBps = 0;
        BackingPoolFactory broken = new BackingPoolFactory(summoner, IERC20(address(quote)), bad, address(0), noRound());
        Moloch dao = _launchV2("bad terms");
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPool.InvalidParams.selector);
        broken.open(address(dao));
    }

    function test_the_kit_refuses_a_pool_factory_made_for_another_kit_or_summoner() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        SecondaryMarketFactory markets = new SecondaryMarketFactory(summoner, predicted);
        BackingPoolFactory elsewhere =
            new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0xBEEF), noRound());
        vm.expectRevert(ContributorKit.InvalidTerms.selector);
        new ContributorKitV3(summoner, markets, elsewhere);

        vm.expectRevert(ContributorKit.InvalidTerms.selector);
        new ContributorKitV3(summoner, marketFactoryV3, BackingPoolFactory(address(0x1234)));

        Summoner other = new Summoner(address(new ActivationVoting(new TreasuryMandateFactory())));
        predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        markets = new SecondaryMarketFactory(summoner, predicted);
        BackingPoolFactory wrongSummoner =
            new BackingPoolFactory(other, IERC20(address(quote)), terms(), predicted, noRound());
        vm.expectRevert(ContributorKit.InvalidTerms.selector);
        new ContributorKitV3(summoner, markets, wrongSummoner);
    }

    function test_a_launch_with_a_wrong_budget_prediction_makes_nothing() public {
        ContributorKitV2.LaunchParams memory p = _params("wrong");
        p.base.predictedBudget = address(0xB0D6E7);
        vm.prank(FOUNDER);
        vm.expectRevert();
        kit.launchWithPool(p);
        assertEq(poolFactory.poolCount(), 0);
    }

    /// @dev Foundry's test VM does not refuse an oversized `new`, so the byte counts are the evidence.
    function test_everything_new_fits_the_real_size_limits() public view {
        bytes memory kitCreation = abi.encodePacked(
            vm.getCode("src/ContributorKitV3.sol:ContributorKitV3"),
            abi.encode(summoner, address(marketFactoryV3), address(poolFactory))
        );
        bytes memory factoryCreation = abi.encodePacked(
            vm.getCode("src/BackingPoolFactory.sol:BackingPoolFactory"),
            abi.encode(summoner, address(quote), terms(), address(kit), rounds())
        );
        bytes memory poolCreation = abi.encodePacked(
            vm.getCode("src/BackingPool.sol:BackingPool"),
            abi.encode(address(1), FOUNDER, address(quote), terms(), uint256(100_000_000e18))
        );
        assertLe(kitCreation.length, MAX_INITCODE, "kit creation over EIP-3860");
        assertLe(factoryCreation.length, MAX_INITCODE, "pool factory creation over EIP-3860");
        assertLe(poolCreation.length, MAX_INITCODE, "pool creation over EIP-3860");
        assertLe(address(kit).code.length, MAX_RUNTIME, "kit runtime over EIP-170");
        assertLe(address(poolFactory).code.length, MAX_RUNTIME, "pool factory runtime over EIP-170");
        assertLe(address(poolFactory.poolDeployer()).code.length, MAX_RUNTIME, "pool deployer runtime over EIP-170");
        assertLe(
            vm.getDeployedCode("src/BackingClaim.sol:BackingClaim").length,
            MAX_RUNTIME,
            "claim token runtime over EIP-170"
        );
        assertLe(vm.getDeployedCode("src/BackingPool.sol:BackingPool").length, MAX_RUNTIME, "pool runtime over EIP-170");
    }

    /// @dev Gas for each step, on a real project. `forge test --match-test test_gas_for_every_step --isolate -vv`
    /// prints the table in docs/v3-review/BACKING-POOL.md: `--isolate` runs every call as its own transaction, so
    /// storage is cold and written as it would be on a chain (without it the figures are far too low). The numbers
    /// are the whole transaction, the 21,000 base cost included.
    function test_gas_for_every_step() public {
        ContributorKitV2.LaunchParams memory p = _params("gas");
        vm.prank(FOUNDER);
        (address d,,, address made) = kit.launchWithPool(p);
        emit log_named_uint("create: launchWithPool (project + market + pool)", vm.lastCallGas().gasTotalUsed);
        BackingPool pool = BackingPool(made);

        ContributorKitV2.LaunchParams memory q = _params("gas v2");
        vm.prank(FOUNDER);
        (address d2,,) = kitV2.launch(q);
        emit log_named_uint("(for comparison) ContributorKitV2.launch", vm.lastCallGas().gasTotalUsed);
        vm.prank(FOUNDER);
        poolFactory.open(d2);
        emit log_named_uint("create: BackingPoolFactory.open (existing project)", vm.lastCallGas().gasTotalUsed);

        vm.warp(_now() + 1 days);
        vm.prank(ALICE);
        quote.approve(made, type(uint256).max);
        vm.prank(BOB);
        quote.approve(made, type(uint256).max);
        vm.prank(ALICE);
        uint256 units = pool.buy(10_000e18, 0, type(uint256).max);
        emit log_named_uint("buy (first ever, first for the wallet)", vm.lastCallGas().gasTotalUsed);
        vm.prank(BOB);
        pool.buy(10_000e18, 0, type(uint256).max);
        emit log_named_uint("buy (first for the wallet)", vm.lastCallGas().gasTotalUsed);
        vm.prank(ALICE);
        pool.buy(10_000e18, 0, type(uint256).max);
        emit log_named_uint("buy (again)", vm.lastCallGas().gasTotalUsed);
        vm.prank(ALICE);
        pool.sell(units / 2, 0, type(uint256).max);
        emit log_named_uint("sell (part)", vm.lastCallGas().gasTotalUsed);

        vm.warp(pool.nextClaimAt());
        vm.prank(FOUNDER);
        pool.postMilestone(REF);
        emit log_named_uint("claim milestone: postMilestone", vm.lastCallGas().gasTotalUsed);
        vm.prank(BOB);
        pool.leave(0, type(uint256).max);
        emit log_named_uint("leave (at a milestone)", vm.lastCallGas().gasTotalUsed);
        vm.warp(_now() + 7 days);
        (bool wasReleased,) = pool.resolveMilestone();
        emit log_named_uint("release: resolveMilestone (pays the treasury)", vm.lastCallGas().gasTotalUsed);
        assertTrue(wasReleased);

        vm.prank(BOB);
        pool.buy(10_000e18, 0, type(uint256).max);
        vm.warp(pool.abandonableAt());
        uint256 bobs = pool.balanceOf(BOB);
        vm.prank(BOB);
        pool.sell(bobs, 0, type(uint256).max);
        emit log_named_uint("refund: sell (all) that also writes the abandonment", vm.lastCallGas().gasTotalUsed);
        uint256 rest = pool.balanceOf(ALICE);
        vm.prank(ALICE);
        pool.sell(rest, 0, type(uint256).max);
        emit log_named_uint("refund: sell (all, once abandoned)", vm.lastCallGas().gasTotalUsed);
        assertEq(Moloch(payable(d)).votingWeight() != address(0), true);
    }

    /// @dev Finding F7a and F2: the heaviest launch the kit accepts, as its own transaction: the most first
    /// projects, the most reviewers, and the longest name and symbol. Some chains cap a transaction at 2**24 gas
    /// (EIP-7825); the launch has to fit with room.
    function _heaviestLaunch() internal returns (ContributorKitV2.LaunchParams memory p) {
        p = _params("eight");
        p.base.projects = new ContributorKit.FirstProject[](8);
        for (uint256 i; i < 8; ++i) {
            p.base.projects[i] = ContributorKit.FirstProject({
                id: bytes32(uint256(0x1000 + i)),
                manager: address(uint160(0x5000 + i)),
                shares: 40e18,
                expires: _now() + 90 days,
                check: keccak256(abi.encode("check", i))
            });
        }
        address[] memory reviewers = new address[](kit.MAX_REVIEWERS());
        for (uint256 i; i < reviewers.length; ++i) {
            reviewers[i] = address(uint160(0xA000 + i));
        }
        p.base.reviewers = reviewers;
        p.base.quorum = 5;
        p.base.name = _filled(kit.MAX_NAME_BYTES());
        p.base.symbol = _filled(kit.MAX_SYMBOL_BYTES());
    }

    function _filled(uint256 length) internal pure returns (string memory) {
        bytes memory b = new bytes(length);
        for (uint256 i; i < length; ++i) {
            b[i] = "x";
        }
        return string(b);
    }

    function test_gas_the_largest_launch_fits_one_transaction() public {
        ContributorKitV2.LaunchParams memory p = _heaviestLaunch();
        vm.prank(FOUNDER);
        (address dao,,, address pool) = kit.launchWithPool(p);
        uint256 used = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("create: launchWithPool, 8 first projects, 8 reviewers, longest name and symbol", used);
        assertEq(poolFactory.poolOf(dao), pool);
        // Under the cap with at least 5% to spare. (The gas limit the transaction has to carry is a little above
        // what it uses, about half a percent more, measured by searching for the least limit that succeeds.)
        assertLt(used, uint256(1 << 24) * 95 / 100);
    }

    /// @dev The caps are the ones the gas figure above holds for, and nothing but this kit has them.
    function test_a_launch_beyond_the_caps_is_refused_and_v2_is_unchanged() public {
        ContributorKitV2.LaunchParams memory p = _params("caps");
        address[] memory reviewers = new address[](9);
        for (uint256 i; i < 9; ++i) {
            reviewers[i] = address(uint160(0xA000 + i));
        }
        p.base.reviewers = reviewers;
        p.base.quorum = 2;
        vm.prank(FOUNDER);
        vm.expectRevert(ContributorKit.InvalidTerms.selector);
        kit.launchWithPool(p);

        p = _params("caps name");
        p.base.name = _filled(65);
        vm.prank(FOUNDER);
        vm.expectRevert(ContributorKit.InvalidTerms.selector);
        kit.launchWithPool(p);

        p = _params("caps symbol");
        p.base.symbol = _filled(13);
        vm.prank(FOUNDER);
        vm.expectRevert(ContributorKit.InvalidTerms.selector);
        kit.launchWithPool(p);

        // The kit it repeats takes all three: V2 has no such caps.
        p = _params("caps v2");
        p.base.reviewers = reviewers;
        p.base.quorum = 2;
        p.base.name = _filled(65);
        p.base.symbol = _filled(13);
        vm.prank(FOUNDER);
        kitV2.launch(p);
    }

    // ---- opening with a round --------------------------------------------------------------------------------------

    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    event RoundOpened(
        address indexed dao,
        address indexed pool,
        address indexed auction,
        address claimToken,
        uint128 supply,
        uint128 minimumRaise,
        uint64 startBlock,
        uint64 endBlock
    );

    function _bid(address auction, address who, uint128 amount) internal returns (uint256 id) {
        if (PERMIT2.code.length == 0) vm.etch(PERMIT2, address(new Permit2Stub()).code);
        uint256 floor = IRoundAuctionLike(auction).floorPrice();
        vm.startPrank(who);
        quote.approve(PERMIT2, amount);
        id = IRoundAuctionLike(auction).submitBid(floor * 100, amount, who, floor, "");
        vm.stopPrank();
    }

    function test_the_factory_reads_back_its_round_settings() public view {
        assertEq(address(poolFactory.auctionFactory()), auctionFactory);
        assertEq(poolFactory.roundBlocks(), 50_000);
        assertEq(poolFactory.roundSupply(), 100_000_000e18);
        // The floor is the price an "open now" curve starts at, to within the auction's price step.
        uint256 opening = (uint256(25_000e18) << 96) / 1_000_000_000e18;
        assertEq(poolFactory.roundTickSpacingX96(), opening / 100);
        assertEq(poolFactory.roundFloorPriceX96(), opening / 100 * 100);
        // The whole supply at the floor.
        assertEq(poolFactory.defaultMinimumRaise(), 2_500e18);
        assertEq(poolFactory.poolDeployer().owner(), address(poolFactory));
    }

    function test_the_founder_opens_a_pool_behind_a_round_in_one_call_choosing_nothing() public {
        Moloch dao = _launchV2("round");
        vm.recordLogs();
        vm.prank(FOUNDER);
        (BackingPool pool, address auction) = poolFactory.openWithRound(address(dao), 0);

        assertEq(poolFactory.poolOf(address(dao)), address(pool));
        assertEq(uint8(pool.roundState()), uint8(BackingPool.RoundState.Waiting));
        assertEq(pool.auction(), auction);
        assertEq(pool.founder(), FOUNDER);
        assertEq(pool.dao(), address(dao));
        assertEq(pool.minimumRaise(), 2_500e18);
        assertEq(pool.roundSupply(), 100_000_000e18);
        IRoundAuctionLike a = IRoundAuctionLike(auction);
        assertEq(a.endBlock(), block.number + 50_000);
        assertEq(a.claimBlock(), block.number + 50_000);
        assertEq(a.floorPrice(), poolFactory.roundFloorPriceX96());
        assertEq(a.tickSpacing(), poolFactory.roundTickSpacingX96());
        assertEq(a.totalSupply(), 100_000_000e18);
        assertEq(a.fundsRecipient(), address(pool));
        assertEq(a.tokensRecipient(), address(pool));
        assertEq(a.currency(), address(quote));
        assertEq(a.token(), address(pool.claimToken()));
        assertEq(pool.claimToken().balanceOf(auction), 100_000_000e18);
        BackingPool.RoundView memory r = pool.snapshot(ALICE).round;
        assertEq(uint8(r.state), uint8(BackingPool.RoundState.Waiting));
        assertEq(r.auction, auction);
        assertEq(r.endBlock, block.number + 50_000);
        assertEq(r.minimumRaise, 2_500e18);
        assertEq(r.clearingPriceX96, a.floorPrice());

        // Bids can be placed in the block the round was opened in; buying on the curve cannot.
        _bid(auction, ALICE, 1_000e18);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.RoundNotLive.selector);
        pool.buy(1e18, 0, type(uint256).max);
    }

    function test_the_founder_may_set_the_minimum_and_nothing_else() public {
        Moloch dao = _launchV2("minimum");
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(BackingPoolFactory.MinimumTooLow.selector, uint128(10_000)));
        poolFactory.openWithRound(address(dao), 9_999);
        vm.prank(FOUNDER);
        (BackingPool pool,) = poolFactory.openWithRound(address(dao), 40_000e18);
        assertEq(pool.minimumRaise(), 40_000e18);
    }

    function test_a_round_is_opened_by_the_same_people_as_a_pool_and_once() public {
        Moloch dao = _launchV2("round auth");
        vm.prank(ALICE);
        vm.expectRevert(BackingPoolFactory.NotAllowed.selector);
        poolFactory.openWithRound(address(dao), 0);
        vm.expectRevert(BackingPoolFactory.UnprovenDao.selector);
        poolFactory.openWithRound(address(quote), 0);
        vm.prank(address(dao));
        (BackingPool pool,) = poolFactory.openWithRound(address(dao), 0);
        // Waiting counts as open: no second pool, of either kind.
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(BackingPoolFactory.AlreadyOpen.selector, address(pool)));
        poolFactory.openWithRound(address(dao), 0);
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(BackingPoolFactory.AlreadyOpen.selector, address(pool)));
        poolFactory.open(address(dao));
        // Nobody but the factory's deployer binds a round.
        vm.prank(address(poolFactory));
        vm.expectRevert(BackingPool.NotFactory.selector);
        pool.bindRound(address(1), 1);
        BackingPoolDeployer deployer = poolFactory.poolDeployer();
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPoolDeployer.NotOwner.selector);
        deployer.bindRound(pool, address(1), 1);
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPoolDeployer.NotOwner.selector);
        deployer.deploy(address(dao), FOUNDER, IERC20(address(quote)), terms(), 0);
    }

    function test_a_factory_without_rounds_refuses_to_open_one() public {
        BackingPoolFactory plain =
            new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0), noRound());
        Moloch dao = _launchV2("no rounds");
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPoolFactory.RoundsOff.selector);
        plain.openWithRound(address(dao), 0);
    }

    function test_the_factory_refuses_round_settings_the_auction_would_refuse() public {
        BackingPoolFactory.RoundSettings memory r = rounds();
        r.blocks = 30_000; // does not divide 10,000,000
        vm.expectRevert(BackingPoolFactory.InvalidSetup.selector);
        new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0), r);
        r = rounds();
        r.blocks = 0;
        vm.expectRevert(BackingPoolFactory.InvalidSetup.selector);
        new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0), r);
        r = rounds();
        r.supply = 500_000_000e18 + 1; // over half the curve
        vm.expectRevert(BackingPoolFactory.InvalidSetup.selector);
        new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0), r);
        r = rounds();
        r.auctionFactory = address(0x1234); // no code
        vm.expectRevert(BackingPoolFactory.InvalidSetup.selector);
        new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0), r);
        r = rounds();
        r.supply = 1e18 - 1; // under one whole claim token
        vm.expectRevert(BackingPoolFactory.InvalidSetup.selector);
        new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0), r);
    }

    /// @dev The whole path on a real project and the real auction factory: open with a round, bid, settle,
    /// collect, redeem, and trade; the fee reaches the DAO.
    function test_a_round_on_a_real_project_goes_live_and_its_buyers_hold_units() public {
        Moloch dao = _launchV2("round live");
        vm.prank(FOUNDER);
        (BackingPool pool, address auction) = poolFactory.openWithRound(address(dao), 0);
        uint256 a = _bid(auction, ALICE, 4_000e18);
        vm.roll(block.number + 20_000);
        uint256 b = _bid(auction, BOB, 6_000e18);
        vm.roll(IRoundAuctionLike(auction).endBlock());
        vm.warp(_now() + 7 days);

        assertTrue(pool.seedFromAuction());
        assertEq(uint8(pool.roundState()), uint8(BackingPool.RoundState.Live));
        assertEq(quote.balanceOf(address(pool)), pool.reserve() + pool.escrow() + pool.treasuryOwed());
        assertApproxEqAbs(pool.roundReceived(), 10_000e18, 1e9);
        BackingPool.Snapshot memory s = pool.snapshot(ALICE);
        assertEq(s.round.openingPrice, pool.price());
        assertEq(s.round.clearingPriceX96, pool.clearingPriceX96());
        assertEq(s.round.unitsSold, pool.totalSupply());

        IRoundAuctionLike(auction).exitBid(a);
        IRoundAuctionLike(auction).claimTokens(a);
        IRoundAuctionLike(auction).exitBid(b);
        IRoundAuctionLike(auction).claimTokens(b);
        uint256 tokens = pool.claimToken().balanceOf(ALICE);
        assertEq(pool.snapshot(ALICE).round.holderClaimTokens, tokens);
        vm.prank(ALICE);
        pool.redeem(tokens);
        assertEq(pool.balanceOf(ALICE), tokens);
        // The curve is open to everyone now.
        _buy(pool, BOB, 500e18);
        vm.prank(ALICE);
        pool.sell(tokens / 2, 0, type(uint256).max);
        pool.payTreasury();
        assertEq(quote.balanceOf(address(dao)), pool.feesTaken());
        assertEq(quote.balanceOf(address(pool)), pool.reserve() + pool.escrow());
    }

    /// @dev A round that fails closes its pool, and only then may the project open another, of either kind.
    function test_after_a_failed_round_the_project_may_open_again() public {
        Moloch dao = _launchV2("round failed");
        vm.prank(FOUNDER);
        (BackingPool pool, address auction) = poolFactory.openWithRound(address(dao), 0);
        uint256 a = _bid(auction, ALICE, 1_000e18);
        vm.roll(IRoundAuctionLike(auction).endBlock());
        uint256 before = quote.balanceOf(ALICE);
        assertFalse(pool.seedFromAuction());
        IRoundAuctionLike(auction).exitBid(a);
        assertEq(quote.balanceOf(ALICE) - before, 1_000e18, "refunded in full by the auction");

        vm.prank(ALICE);
        vm.expectRevert(BackingPoolFactory.NotAllowed.selector);
        poolFactory.open(address(dao));
        vm.prank(FOUNDER);
        (BackingPool second,) = poolFactory.openWithRound(address(dao), 0);
        assertTrue(address(second) != address(pool));
        assertEq(poolFactory.poolOf(address(dao)), address(second));
        assertEq(poolFactory.poolCount(), 2);
        // And a third time only if the second fails too.
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(BackingPoolFactory.AlreadyOpen.selector, address(second)));
        poolFactory.open(address(dao));
    }

    /// @dev A protocol fee that takes the raise closes the pool the same way a missed minimum does, and the project
    /// may open another: the factory counts a pool whose round failed as never opened.
    function test_after_a_round_whose_raise_a_protocol_fee_took_the_project_may_open_again() public {
        address controller = vm.deployCode("MockProtocolFeeController.sol:MockProtocolFeeController");
        IFeeControllerLike(controller).setProtocolFeeRecipient(address(0xFEE));
        BackingPoolFactory.RoundSettings memory r = rounds();
        r.auctionFactory = vm.deployCode(
            "ContinuousClearingAuctionFactory.sol:ContinuousClearingAuctionFactory", abi.encode(controller)
        );
        BackingPoolFactory feeFactory = new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0), r);
        Moloch dao = _launchV2("fee round");
        vm.prank(FOUNDER);
        (BackingPool pool, address auction) = feeFactory.openWithRound(address(dao), 0);
        _bid(auction, ALICE, 4_000e18);
        IFeeControllerLike(controller).setProtocolFeeAmount(type(uint128).max);
        vm.roll(IRoundAuctionLike(auction).endBlock());
        assertFalse(pool.seedFromAuction());
        assertEq(uint8(pool.roundState()), uint8(BackingPool.RoundState.Failed));
        assertEq(quote.balanceOf(address(pool)), 0);

        vm.prank(FOUNDER);
        (BackingPool second,) = feeFactory.openWithRound(address(dao), 0);
        assertTrue(address(second) != address(pool));
        assertEq(feeFactory.poolOf(address(dao)), address(second));
    }

    /// @dev On Arbitrum and its Orbit chains the auction counts blocks with ArbSys (`block.number` there is the parent
    /// chain's). The factory and the pool use the same clock, so the round's blocks are the auction's own: it
    /// takes bids from the first block, and the pool refuses to settle until the auction says it is over.
    function test_a_round_counts_blocks_on_the_auctions_own_clock() public {
        uint256 arbBlock = 400_000_000;
        vm.etch(address(100), address(new ArbSysStub()).code);
        ArbSysStub(address(100)).set(arbBlock);
        // Everything below is made after ArbSys exists, as on the chain (each of these reads it once, at creation).
        BackingPoolFactory arbFactory =
            new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0), rounds());
        Moloch dao = _launchV2("arbitrum");
        vm.prank(FOUNDER);
        (BackingPool pool, address auction) = arbFactory.openWithRound(address(dao), 0);
        assertEq(IRoundAuctionLike(auction).endBlock(), arbBlock + 50_000, "the round runs on the chain's clock");
        assertEq(pool.roundInfo(address(0)).endBlock, arbBlock + 50_000);

        // Bids are taken (they were refused when the round was counted on `block.number`)...
        uint256 id = _bid(auction, ALICE, 4_000e18);
        // ...and the pool does not settle before the auction's end, whatever `block.number` says.
        vm.roll(arbBlock + 60_000);
        ArbSysStub(address(100)).set(arbBlock + 50_000 - 1);
        vm.expectRevert(abi.encodeWithSelector(BackingPool.RoundNotOver.selector, arbBlock + 50_000));
        pool.seedFromAuction();
        vm.roll(1_000);
        ArbSysStub(address(100)).set(arbBlock + 50_000);
        assertTrue(pool.seedFromAuction());
        IRoundAuctionLike(auction).exitBid(id);
        IRoundAuctionLike(auction).claimTokens(id);
        uint256 tokens = pool.claimToken().balanceOf(ALICE);
        vm.prank(ALICE);
        pool.redeem(tokens);
        assertEq(pool.balanceOf(ALICE), tokens);
    }

    /// @dev Opening with a round as its own transaction, and what a launch plus a round would cost in one.
    function test_gas_opening_with_a_round() public {
        Moloch dao = _launchV2("round gas");
        vm.prank(FOUNDER);
        (BackingPool pool, address auction) = poolFactory.openWithRound(address(dao), 0);
        uint256 used = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("create: BackingPoolFactory.openWithRound (pool + claim token + auction)", used);
        assertLt(used, uint256(1 << 24) * 90 / 100);
        uint256 a = _bid(auction, ALICE, 4_000e18);
        emit log_named_uint("bid in the round (the auction's own submitBid)", vm.lastCallGas().gasTotalUsed);
        vm.roll(IRoundAuctionLike(auction).endBlock());
        pool.seedFromAuction();
        emit log_named_uint("settle the round: seedFromAuction (goes live)", vm.lastCallGas().gasTotalUsed);
        IRoundAuctionLike(auction).exitBid(a);
        IRoundAuctionLike(auction).claimTokens(a);
        uint256 tokens = pool.claimToken().balanceOf(ALICE);
        vm.prank(ALICE);
        pool.redeem(tokens);
        emit log_named_uint("redeem claim tokens for units", vm.lastCallGas().gasTotalUsed);
    }
}
