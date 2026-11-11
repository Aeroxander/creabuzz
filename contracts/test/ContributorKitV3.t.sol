// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ActivationVoting} from "../src/ActivationVoting.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFactory} from "../src/BackingPoolFactory.sol";
import {ContributorKit} from "../src/ContributorKit.sol";
import {ContributorKitV2} from "../src/ContributorKitV2.sol";
import {ContributorKitV3} from "../src/ContributorKitV3.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFactory} from "../src/SecondaryMarketFactory.sol";
import {Moloch, Shares, Summoner} from "../src/majeur/MolochPatched.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {PoolQuote} from "./helpers/BackingPoolFixture.sol";

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

    function setUp() public {
        vm.warp(1_800_000_000);
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
        poolFactory = new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), predicted);
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
        assertEq(pool.factory(), address(poolFactory));
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
        new BackingPoolFactory(Summoner(address(0x1234)), IERC20(address(quote)), terms(), address(0));
        vm.expectRevert(BackingPoolFactory.InvalidSetup.selector);
        new BackingPoolFactory(summoner, IERC20(address(0x1234)), terms(), address(0));
    }

    function test_a_factory_without_a_kit_still_serves_founders() public {
        BackingPoolFactory plain = new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0));
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
        BackingPoolFactory broken = new BackingPoolFactory(summoner, IERC20(address(quote)), bad, address(0));
        Moloch dao = _launchV2("bad terms");
        vm.prank(FOUNDER);
        vm.expectRevert(BackingPool.InvalidParams.selector);
        broken.open(address(dao));
    }

    function test_the_kit_refuses_a_pool_factory_made_for_another_kit_or_summoner() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        SecondaryMarketFactory markets = new SecondaryMarketFactory(summoner, predicted);
        BackingPoolFactory elsewhere = new BackingPoolFactory(summoner, IERC20(address(quote)), terms(), address(0xBEEF));
        vm.expectRevert(ContributorKit.InvalidTerms.selector);
        new ContributorKitV3(summoner, markets, elsewhere);

        vm.expectRevert(ContributorKit.InvalidTerms.selector);
        new ContributorKitV3(summoner, marketFactoryV3, BackingPoolFactory(address(0x1234)));

        Summoner other = new Summoner(address(new ActivationVoting(new TreasuryMandateFactory())));
        predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        markets = new SecondaryMarketFactory(summoner, predicted);
        BackingPoolFactory wrongSummoner = new BackingPoolFactory(other, IERC20(address(quote)), terms(), predicted);
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
            abi.encode(summoner, address(quote), terms(), address(kit))
        );
        bytes memory poolCreation = abi.encodePacked(
            vm.getCode("src/BackingPool.sol:BackingPool"), abi.encode(address(1), FOUNDER, address(quote), terms())
        );
        assertLe(kitCreation.length, MAX_INITCODE, "kit creation over EIP-3860");
        assertLe(factoryCreation.length, MAX_INITCODE, "pool factory creation over EIP-3860");
        assertLe(poolCreation.length, MAX_INITCODE, "pool creation over EIP-3860");
        assertLe(address(kit).code.length, MAX_RUNTIME, "kit runtime over EIP-170");
        assertLe(address(poolFactory).code.length, MAX_RUNTIME, "pool factory runtime over EIP-170");
        assertLe(
            vm.getDeployedCode("src/BackingPool.sol:BackingPool").length, MAX_RUNTIME, "pool runtime over EIP-170"
        );
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

    /// @dev Finding F7a: the heaviest launch, with the most first projects a launch takes, as its own
    /// transaction. Some chains cap a transaction at 2**24 gas (EIP-7825); the launch has to fit with room.
    function test_gas_the_largest_launch_fits_one_transaction() public {
        ContributorKitV2.LaunchParams memory p = _params("eight");
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
        vm.prank(FOUNDER);
        (address dao,,, address pool) = kit.launchWithPool(p);
        uint256 used = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("create: launchWithPool with 8 first projects", used);
        assertEq(poolFactory.poolOf(dao), pool);
        // Under the cap with at least a tenth of it to spare, measured with or without --isolate.
        assertLt(used, uint256(1 << 24) * 90 / 100);
    }
}
