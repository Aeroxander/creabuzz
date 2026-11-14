// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ContributorKit} from "../src/ContributorKit.sol";
import {ContributorKitV2} from "../src/ContributorKitV2.sol";
import {ActivationVoting} from "../src/ActivationVoting.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFactory} from "../src/SecondaryMarketFactory.sol";
import {ISecondaryPolicy} from "../src/interfaces/ISecondaryPolicy.sol";
import {Locked, Call, Moloch, Shares, Summoner, newSummoner} from "../src/majeur/MolochPatched.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @dev A forged "policy" that answers the version getter with another number: building this kit
/// over it must refuse at construction.
/// @dev A forged "policy" that answers the version getter with another number (and fakes enough of
/// the summoner wiring to get past the base kit's provenance reads): building this kit over it
/// must refuse at the version check with its own typed error.
contract FakeV3Policy {
    TreasuryMandateFactory immutable factory;

    constructor() {
        factory = new TreasuryMandateFactory();
    }

    function mandateFactory() external view returns (address) {
        return address(factory);
    }

    function SECONDARY_POLICY_VERSION() external pure returns (uint8) {
        return 3;
    }
}

/// @dev A forged "policy" that fakes the version getter and nothing else: faking the getter alone
/// must never be enough, the launch must refuse this too.
contract DecoyGetterV1Policy {
    function SECONDARY_POLICY_VERSION() external pure returns (uint8) {
        return 1;
    }
}

/// @dev Shared harness: a real kit, made from a real variant summoner, launched with a real work
/// budget, cloned policy and market, all read back against live state `FounderSaleEligibilityTest`
/// (FounderSaleEligibility.t.sol) imports this harness for the token-side guard tests.
abstract contract ContributorKitV2Base is Test {
    address internal constant FOUNDER = address(0xF0);
    address internal constant R1 = address(0xA1);
    address internal constant R2 = address(0xA2);
    address internal constant DAVE = address(0xDA7E);
    address internal constant BUYER = address(0xB4E5);
    bytes32 internal constant CHECK = keccak256("docs merged and reviewed");
    bytes32 internal constant PROJECT = bytes32("docs");

    /// @notice Development sale schedule (not production terms): 180 days of nothing, then the
    /// whole grant linearly over 180 days.
    uint64 internal constant CLIFF = 180 days;
    uint64 internal constant DURATION = 180 days;
    uint256 internal constant LOT_SIZE = 1e18;
    uint64 internal constant SALE_START = 10 days;
    uint64 internal constant CLIFF_END = uint64(uint256(10 days) + 180 days);
    uint64 internal constant MATURITY = 8 days;

    /// @dev The clock just after the launch, without a local `block.timestamp` the 0.8.37
    /// optimizer may cache stale across a warp.
    function now64AfterLaunch() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    /// @dev The wall clock, read through the cheat code so no optimizer can cache a stale block
    /// timestamp across a `vm.warp` (the 0.8.37 known-bug class).
    function now64() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    /// @dev The EIP-3860 ceiling: the live node (an echoed fixture below, and every real chain)
    /// refuses creation bytecodes longer than this, constructor arguments included.
    uint256 internal constant MAX_INITCODE = 49_152;
    /// @dev The EIP-170 runtime ceiling every deployed contract must fit.
    uint256 internal constant MAX_RUNTIME = 24_576;

    /// @dev The kit's landing address, captured at the moment the factory is authorised for it
    /// (the deployer's "next available" CREATE slot before the factory deploy, plus the slot the
    /// factory itself takes).
    address internal predictedKit;

    /// @dev The two-step public deployment of the pair, as any deployer runs it: predict the kit's
    /// next CREATE address from the deployer's nonce (the factory takes the nonce below it), deploy
    /// the factory authorised for exactly that address, then deploy the kit over it — the kit lands
    /// inside its own prediction.
    function predictAndAuthoriseKit() internal returns (address) {
        predictedKit = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        return predictedKit;
    }

    SecondaryMarketFactory internal marketFactory;

    /// @dev Deployment guard rails, measured from the real artifacts: the kit and the factory both
    /// stay inside EIP-3860 with their constructor arguments included, and every piece this launch
    /// deploys (or clones) stays inside EIP-170. Foundry's own test VM does not refuse an oversized
    /// `new`, so a successful deployment is not evidence — the byte counts are.
    function test_the_whole_pair_fits_the_real_size_limits() public {
        bytes memory kitCreation = vm.getCode("src/ContributorKitV2.sol:ContributorKitV2");
        bytes memory kitRuntime = vm.getDeployedCode("src/ContributorKitV2.sol:ContributorKitV2");
        bytes memory factoryCreation = vm.getCode("src/SecondaryMarketFactory.sol:SecondaryMarketFactory");
        bytes memory factoryRuntime = vm.getDeployedCode("src/SecondaryMarketFactory.sol:SecondaryMarketFactory");
        bytes memory kitFull = abi.encodePacked(kitCreation, abi.encode(summoner, address(marketFactory)));
        bytes memory factoryFull = abi.encodePacked(factoryCreation, abi.encode(summoner, predictedKit));
        assertLe(kitFull.length, MAX_INITCODE, "kit creation bytecode (with constructor args) over EIP-3860");
        assertLe(factoryFull.length, MAX_INITCODE, "factory creation bytecode (with constructor args) over EIP-3860");
        assertLe(kitRuntime.length, MAX_RUNTIME, "kit runtime over EIP-170");
        assertLe(factoryRuntime.length, MAX_RUNTIME, "factory runtime over EIP-170");
        bytes memory sharesRuntime = vm.getDeployedCode("src/majeur/MolochPatched.sol:Shares");
        bytes memory molochRuntime = vm.getDeployedCode("src/majeur/MolochPatched.sol:Moloch");
        bytes memory marketRuntime = vm.getDeployedCode("src/SecondaryMarket.sol:SecondaryMarket");
        bytes memory policyRuntime = vm.getDeployedCode("src/ActivationVoting.sol:ActivationVoting");
        assertLe(sharesRuntime.length, MAX_RUNTIME, "Shares runtime over EIP-170");
        assertLe(molochRuntime.length, MAX_RUNTIME, "Moloch runtime over EIP-170");
        assertLe(marketRuntime.length, MAX_RUNTIME, "market runtime over EIP-170");
        assertLe(policyRuntime.length, MAX_RUNTIME, "policy runtime over EIP-170");
    }

    Summoner internal summoner;
    ContributorKitV2 internal kit;
    TreasuryMandateFactory internal mandateFactory;
    MandateCurrency internal quote;

    function setUp() public virtual {
        vm.warp(SALE_START);
        TreasuryMandateFactory factory = new TreasuryMandateFactory();
        ActivationVoting policy = new ActivationVoting(factory);
        summoner = new Summoner(address(policy));
        // The deployment order: the factory goes first and takes the deployer's next nonce, so the
        // kit's own prediction is that nonce plus one; the kit lands exactly there.
        marketFactory = new SecondaryMarketFactory(summoner, predictAndAuthoriseKit());
        kit = new ContributorKitV2(summoner, marketFactory);
        mandateFactory = factory;
        quote = new MandateCurrency();
    }

    function _reviewers() internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = R1;
        r[1] = R2;
    }

    /// @dev Where the budget factory's next budget will land, as the app predicts from its nonce.
    function nextBudget() internal returns (address) {
        return nextBudgetOf(mandateFactory);
    }

    function nextBudgetOf(TreasuryMandateFactory factory) internal returns (address) {
        return vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
    }

    function _firstProject() internal view returns (ContributorKit.FirstProject memory) {
        return ContributorKit.FirstProject({
            id: PROJECT, manager: FOUNDER, shares: 40e18, expires: now64() + 90 days, check: CHECK
        });
    }

    function baseParams(bytes32 salt) internal returns (ContributorKit.Params memory base) {
        base.name = "Docs Commons";
        base.symbol = "DOCS";
        base.founderShares = 200e18;
        base.salt = salt;
        base.currency = address(quote);
        base.shareBudget = 600e18;
        base.shareCap = 40e18;
        base.budgetExpires = now64() + 90 days;
        base.reviewers = _reviewers();
        base.quorum = 2;
        base.predictedBudget = nextBudget();
        base.projects = new ContributorKit.FirstProject[](1);
        base.projects[0] = _firstProject();
    }

    function _params(bytes32 salt) internal returns (ContributorKitV2.LaunchParams memory p) {
        p.base = baseParams(salt);
        p.saleStart = now64();
        p.saleCliff = CLIFF;
        p.saleDuration = DURATION;
        p.quote = address(quote);
        p.lotSize = LOT_SIZE;
    }

    /// @dev Launch, and hand back typed handles to everything that was born.
    function _launch(ContributorKitV2.LaunchParams memory p)
        internal
        returns (Moloch dao, TreasuryMandate budget, address policy, SecondaryMarket market)
    {
        vm.prank(FOUNDER);
        (address d, address b, address pol) = kit.launch(p);
        dao = Moloch(payable(d));
        budget = TreasuryMandate(b);
        policy = pol;
        market = SecondaryMarket(SecondaryMarketFactory(kit.marketFactory()).marketOf(d));
    }

    /// @dev Launch and remember the born policy's typed handle for schedule reads.
    function _launchV2(ContributorKitV2.LaunchParams memory p)
        internal
        returns (Moloch dao, TreasuryMandate budget, ActivationVoting variant, SecondaryMarket market)
    {
        address policy;
        (dao, budget, policy, market) = _launch(p);
        variant = ActivationVoting(policy);
    }

    /// @dev One reviewed award, the legacy kit's own day-one path: a real claim through the real
    /// budget and panel, then the DAO's award decision mints through the policy hook.
    function _award(Moloch dao, TreasuryMandate budget, bytes32 claimId, address recipient, uint96 amount) internal {
        ClaimStake claims = budget.claims();
        VerifierSet panel = budget.verifiers();
        vm.startPrank(recipient);
        claims.submitClaim(claimId, 0, 0, keccak256("the docs"));
        claims.setCheck(claimId, CHECK);
        vm.stopPrank();
        vm.prank(FOUNDER);
        budget.fundMilestone(PROJECT, claimId, recipient);
        vm.prank(R1);
        panel.attest(claimId, true);
        vm.prank(R2);
        panel.attest(claimId, true);
        claims.settle(claimId);
        vm.warp(now64() + 7 days);
        vm.prank(recipient);
        claims.payout(claimId);
        vm.prank(address(dao));
        dao.awardContribution(address(budget), claimId, amount, false);
    }

    /// @dev Trading is born disabled; a project decision (its DAO standing in for the executed vote)
    /// turns it on and freezes the grid: levels 0..3 at 100, 200, 300, 400 quote per lot.
    function _enableListing(Moloch dao, SecondaryMarket market) internal {
        vm.prank(address(dao));
        market.configureListing(true, 100e18, 400e18, 3);
    }

    /// @dev Grant vested to date under the fixture schedule, from the frozen start the policy holds.
    function vestedAt(uint64 t, ActivationVoting variant) internal returns (uint256 grant, uint256 vested) {
        (, address founder, uint256 g, uint64 start, uint64 cliff, uint64 duration) = variant.secondaryConfiguration();
        founder;
        grant = g;
        vested = t < start + cliff ? 0 : g * (uint256(t) - start - cliff) / duration;
    }

    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    /// @dev The launched DAO's runtime must be exactly the pinned summoner's proxy.
    function daoRuntimeHash() internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                hex"5f",
                hex"5f365f5f37365f73",
                bytes20(address(kit.molochImplementation())),
                hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
            )
        );
    }

    function _runtimeHash(address a) internal view returns (bytes32 h) {
        assembly ("memory-safe") {
            let n := extcodesize(a)
            if n {
                extcodecopy(a, 0x00, 0, n)
                h := keccak256(0x00, n)
            }
        }
    }
}

contract ContributorKitV2Test is ContributorKitV2Base {
    /// @dev The launch binds every prediction exactly, and everything reads back from live state:
    /// the DAO, its Shares clone, its policy clone and the market are the predicted addresses.
    function test_launch_binds_the_exact_predictions_and_reads_back() public {
        ContributorKitV2.LaunchParams memory p = _params("v2");
        (address expectedDao, address expectedShares, address expectedPolicy, address expectedMarket) =
            kit.predictLaunch(FOUNDER, p.base.founderShares, p.base.salt, p.quote, p.lotSize);
        assertEq(
            SecondaryMarketFactory(kit.marketFactory()).marketOf(expectedDao), address(0), "no market before the launch"
        );

        uint256 gasBefore = gasleft();
        (Moloch dao, TreasuryMandate budget, ActivationVoting variant, SecondaryMarket market) = _launchV2(p);
        uint256 gasUsed = gasBefore - gasleft();

        assertTrue(gasUsed < 25_000_000, "a launch must fit comfortably inside a block");
        assertEq(address(dao), expectedDao, "the DAO is the address predicted before anything existed");
        assertEq(address(variant), expectedPolicy, "the policy is the predicted clone");
        assertEq(address(dao.shares()), expectedShares, "the token is the predicted clone");
        assertEq(SecondaryMarketFactory(kit.marketFactory()).marketOf(address(dao)), expectedMarket);
        assertEq(address(market), expectedMarket, "the market is the predicted address");

        // The DAO: the threshold and the safe defaults, read back.
        assertEq(dao.proposalThreshold(), 2e18);
        assertEq(dao.proposalTTL(), 14 days);
        assertEq(dao.timelockDelay(), 1 days);
        // And the launched DAO runs exactly the pinned summoner's proxy, as the factory pinned it.
        assertEq(_runtimeHash(address(dao)), daoRuntimeHash());

        // The budget: the same mandate factory instance the summoner and the policy are bound to,
        // with the first project read back from it.
        assertEq(kit.budgetFactory().daos(address(budget)), address(dao), "the budget is the DAO's own");
        assertEq(address(kit.budgetFactory()), address(mandateFactory));
        assertEq(address(variant.mandateFactory()), address(mandateFactory));
        (address manager,,,,, uint128 shareBudget,) = budget.projects(PROJECT);
        assertEq(manager, FOUNDER);
        assertEq(shareBudget, 40e18);

        // The market: made by this kit's factory, for the right token, policy and terms — and
        // starting disabled, because opening trading is a later project decision.
        assertTrue(address(market).code.length != 0);
        assertEq(market.dao(), address(dao));
        assertEq(market.factory(), address(kit.marketFactory()));
        assertEq(SecondaryMarketFactory(kit.marketFactory()).authorizedKit(), address(kit));
        assertEq(market.sharesToken(), expectedShares);
        assertEq(address(market.policy()), address(variant));
        assertEq(address(market.quote()), address(quote));
        assertEq(market.lotSize(), LOT_SIZE);
        (bool enabled,,,) = market.listing();
        assertFalse(enabled, "nothing at creation says the market is open");

        // The token: locked with the market as the one exempt custody endpoint, the sale policy
        // bound once and sealed by the final zero guard, awards only, founder fully inside the cliff.
        Shares tokens = dao.shares();
        assertTrue(tokens.transfersLocked() && tokens.unlockNoticeRequired());
        assertEq(tokens.transferExempt(), address(market));
        assertEq(tokens.lockGuard(), address(0));
        assertTrue(tokens.lockGuardSet());
        assertEq(tokens.salePolicy(), address(variant));
        assertTrue(tokens.salePolicyChosen(), "the choice is made and final");
        (uint256 eligible, uint8 version) = tokens.saleEligibleOf(FOUNDER);
        assertEq(version, uint8(1), "the founder schedule is what the read counts");
        assertEq(eligible, 0, "the founder may sell nothing at birth");
        assertTrue(tokens.awardsOnly());
        assertEq(tokens.issuanceCapBps(), tokens.NO_CAP());

        // The policy: the frozen exact schedule around the founder's whole starting grant.
        (address marketAddr, address founderAddr, uint256 grant, uint64 start, uint64 cliff, uint64 duration) =
            variant.secondaryConfiguration();
        assertEq(marketAddr, address(market));
        assertEq(founderAddr, FOUNDER);
        assertEq(grant, 200e18);
        assertEq(start, p.saleStart);
        assertEq(cliff, CLIFF);
        assertEq(duration, DURATION);
        assertEq(variant.lockedAt(now64()), 200e18, "the whole grant is inside the cliff");
    }

    /// @dev The primary development candidate, exactly: the start marker `0` (at birth), no cliff,
    /// 180 linear days. The policy stores the resolved launch clock, never the marker; at birth
    /// the founder may sell nothing, and one full day later exactly one linear day's worth frees —
    /// carried only through the market endpoint, with one more unit refused.
    /// @dev The real deployment order lands the kit exactly on the address its factory authorised
    /// (the prediction was captured at the factory's own deployment, not re-derived later).
    function test_the_kit_lands_on_the_address_its_factory_was_born_for() public {
        assertEq(address(kit), predictedKit, "the kit landed on the address captured at predict time");
        assertEq(address(marketFactory.authorizedKit()), address(kit), "the factory was born for this kit");
    }

    function test_the_primary_candidate_launches_at_birth_with_no_cliff() public {
        ContributorKitV2.LaunchParams memory p = _params("primary");
        p.saleStart = 0;
        p.saleCliff = 0;
        p.saleDuration = 180 days;
        uint64 launchClock = now64();
        (Moloch dao, , ActivationVoting variant, ) = _launchV2(p);
        Shares tokens = dao.shares();
        assertEq(variant.saleCapacity(FOUNDER), 0, "at birth, the whole grant is inside the schedule");
        (, address founderAddr, uint256 grant, uint64 start, uint64 cliff, uint64 duration) =
            variant.secondaryConfiguration();
        assertEq(founderAddr, FOUNDER);
        assertEq(grant, 200e18);
        assertEq(start, launchClock, "the zero marker resolved to the launch block, once");
        assertEq(cliff, 0);
        assertEq(duration, 180 days);

        vm.warp(uint256(launchClock) + 1 days);
        uint256 oneDay = 1 days; // runtime value, so a literal-division never becomes a rational
        uint256 daySlice = 200e18 * oneDay / uint256(p.saleDuration);
        assertEq(variant.saleCapacity(FOUNDER), daySlice, "one linear day the next day");
        SecondaryMarket market = SecondaryMarket(kit.marketFactory().marketOf(address(dao)));
        vm.prank(FOUNDER);
        tokens.approve(address(market), type(uint256).max);
        vm.prank(address(market));
        tokens.transferFrom(FOUNDER, address(market), daySlice);
        vm.prank(address(market));
        vm.expectRevert(Shares.LockedShares.selector);
        tokens.transferFrom(FOUNDER, address(market), 1);
    }

    /// @dev Another budget made first by someone else means the kit's predicted budget is stale:
    /// the whole launch reverts, and nothing was left behind.
    function test_a_false_budget_prediction_reverts_the_whole_launch() public {
        ContributorKitV2.LaunchParams memory p = _params("raced");
        (address expectedDao,,,) = kit.predictLaunch(FOUNDER, p.base.founderShares, p.base.salt, p.quote, p.lotSize);
        // Another DAO makes the budget first: the prediction now names that one.
        ContributorKit otherKit = new ContributorKit(summoner);
        ContributorKit.Params memory other = baseParams(bytes32("rival"));
        other.predictedBudget = nextBudget();
        other.projects = new ContributorKit.FirstProject[](0);
        vm.prank(DAVE);
        (address otherDao,) = otherKit.launch(other);
        vm.prank(otherDao);
        mandateFactory.create(address(quote), 0, 0, 1e18, 1e18, now64() + 1 days, _reviewers(), 1, 0, address(0));
        vm.prank(FOUNDER);
        vm.expectRevert();
        kit.launch(p);
        assertFalse(address(expectedDao).code.length != 0, "no DAO was left behind");
        assertEq(SecondaryMarketFactory(kit.marketFactory()).marketOf(expectedDao), address(0), "no market either");
        // A fresh prediction goes through.
        p.base.predictedBudget = nextBudget();
        _launch(p);
    }

    /// @dev This kit exists only over the variant policy: a legacy summoner, a policy whose version
    /// is not 1, and a forger that fakes the version getter alone all refuse at construction —
    /// while the legacy kit still builds and runs the old flow over the real legacy wiring.
    function test_legacy_and_forged_policies_cannot_build_this_kit() public {
        // A fake version that is not 1, caught with its own typed refusal. Its factory (built by
        // the forger's summoner wiring and authorised directly for the tester here) gets its full
        // base provenance chain through, so the revert really is the version check.
        Summoner fakeV3 = new Summoner(address(new FakeV3Policy()));
        SecondaryMarketFactory fakeV3Factory = new SecondaryMarketFactory(fakeV3, address(this));
        vm.expectRevert(ContributorKit.InvalidTerms.selector);
        new ContributorKitV2(fakeV3, fakeV3Factory);
        // A forger that fakes the getter alone and a plain legacy summoner both refuse, observed
        // through the two-step deployment path (each probe is constructed over a factory that was
        // authorised for exactly the probe's predicted address, as a real deployer would).
        assertTrue(_probeFor(new Summoner(address(new DecoyGetterV1Policy()))).builtAddress() == address(0));
        Summoner legacySummoner = newSummoner();
        assertTrue(_probeFor(legacySummoner).builtAddress() == address(0));
        // The legacy kit still builds over it: the old flow is untouched.
        assertTrue(address(new ContributorKit(legacySummoner)) != address(0));
    }

    /// @dev Deploy the probe (its own constructor runs the real two-step deployment path).
    function _probeFor(Summoner s) internal returns (KitDeployProbe p) {
        p = new KitDeployProbe(s);
        assertTrue(address(p).code.length != 0);
    }

    /// @dev Inside the cliff, the founder cannot send Shares to anyone, cannot route a market
    /// deposit through the exempt endpoint (the token guard refuses — the exempt endpoint does not
    /// bypass founder sale eligibility), and cannot offer onto the open market either.
    function test_before_the_cliff_transfers_and_market_deposits_are_refused() public {
        (Moloch dao,, ActivationVoting variant, SecondaryMarket market) = _launchV2(_params("locked"));
        Shares tokens = dao.shares();

        vm.warp(20 days);
        assertEq(variant.saleCapacity(FOUNDER), 0, "inside the cliff, nothing is eligible");
        // A plain wallet-to-wallet transfer is locked by the birth lock (D77) regardless.
        vm.prank(FOUNDER);
        vm.expectRevert(Locked.selector);
        tokens.transfer(R1, 1e18);
        // An exempt endpoint does not open the schedule: routing into the market passes the wallet
        // lock (the endpoint is the market) but still ends at the sale ceiling, exactly the way the
        // market moves offers (it is the spenditure caller through `transferFrom`).
        vm.prank(FOUNDER);
        tokens.approve(address(market), type(uint256).max);
        vm.prank(address(market));
        vm.expectRevert(Shares.LockedShares.selector);
        tokens.transferFrom(FOUNDER, address(market), 1e18);
        // Even with trading turned on, the market's own capacity read refuses the founder.
        _enableListing(dao, market);
        vm.prank(address(dao));
        uint256 roundId = market.openRound();
        vm.prank(FOUNDER);
        vm.expectRevert(SecondaryMarket.NoCapacity.selector);
        market.sell(roundId, 1, 0);
        assertEq(tokens.balanceOf(FOUNDER), 200e18, "nothing moved");
    }

    /// @dev After the cliff, exactly the vested share is sellable inside the whole-time schedule; a
    /// buyer gains the purchase with no inherited seller history; and the founder's proceeds claim
    /// is exactly the frozen uniform price.
    function test_after_the_cliff_only_the_vested_share_sells_and_buys_are_fresh() public {
        (Moloch dao,, ActivationVoting variant, SecondaryMarket market) = _launchV2(_params("open"));
        Shares tokens = dao.shares();
        quote.mint(BUYER, 100_000e18);

        _enableListing(dao, market);
        // Day 280 = 90 days past the cliff: vested exactly 100 of the 200 grant.
        vm.warp(uint256(CLIFF_END) + 90 days);
        uint64 sellingDay = now64();
        assertEq(sellingDay, uint64(CLIFF_END + 90 days), "the selling clock");
        vm.prank(FOUNDER);
        tokens.approve(address(market), type(uint256).max);
        assertEq(variant.saleCapacity(FOUNDER), 100e18, "the schedule releases exactly the elapsed part");
        vm.prank(address(dao));
        uint256 roundId = market.openRound();
        vm.prank(FOUNDER);
        market.sell(roundId, 100, 0);
        vm.prank(BUYER);
        quote.approve(address(market), type(uint256).max);
        vm.prank(BUYER);
        market.bid(roundId, 100, 0); // both sides clear at the frozen floor: 100 quote per lot
        vm.warp(uint256(sellingDay) + 3 days + 2);
        sellingDay = now64(); // after bidding, inside the settle window
        market.settle(roundId);
        vm.prank(BUYER);
        market.claimShares(roundId, BUYER);
        assertEq(tokens.balanceOf(BUYER), 100e18, "the buyer holds what they bought, fresh");
        assertEq(tokens.balanceOf(FOUNDER), 100e18);
        vm.prank(FOUNDER);
        market.claimQuote(roundId, FOUNDER);
        assertEq(quote.balanceOf(FOUNDER), 10_000e18, "100 lots at the frozen floor level");
        // The buyer's purchase is fresh and their escrow association is empty.
        assertEq(ISecondaryPolicy(address(variant)).saleCapacity(BUYER), 100e18);
        assertEq(ISecondaryPolicy(address(variant)).escrowedBalance(BUYER), 0);
        // And from that clock, the founder keeps exactly the day-slice of the schedule that remains.
        (, uint256 vestedAtOpen) = vestedAt(uint64(CLIFF_END + 90 days), variant);
        assertEq(vestedAtOpen, 100e18, "the schedule read at the sale's own clock, not the settle's");
        uint64 atSettle = now64();
        (, uint256 vested) = vestedAt(atSettle, variant);
        assertApproxEqAbs(variant.saleCapacity(FOUNDER), vested - 100e18, 1e14, "only the schedule moves, never sales");
    }

    /// @dev Selling frees nothing beyond the eligible amount measured at the move, and afterwards
    /// the schedule alone continues, freeing exactly one more day's worth — no more.
    function test_selling_frees_nothing_and_the_schedule_alone_continues() public {
        (Moloch dao,, ActivationVoting variant, SecondaryMarket market) = _launchV2(_params("clock"));
        Shares tokens = dao.shares();
        quote.mint(BUYER, 100_000e18);
        vm.prank(FOUNDER);
        tokens.approve(address(market), type(uint256).max);

        vm.warp(uint256(CLIFF_END) + 90 days);
        uint64 sellingDay = now64();
        assertEq(sellingDay, uint64(CLIFF_END + 90 days), "the selling clock");
        _enableListing(dao, market);
        vm.prank(FOUNDER);
        tokens.approve(address(market), type(uint256).max);
        vm.prank(address(dao));
        uint256 roundId = market.openRound();
        vm.prank(FOUNDER);
        market.sell(roundId, 100, 0);
        // The sale moved exactly what the schedule allowed, and nothing became free again on the
        // same clock: the remaining schedule-bound ceiling is zero.
        assertEq(variant.saleCapacity(FOUNDER), 0, "the sold units do not re-release");
        vm.prank(BUYER);
        quote.approve(address(market), type(uint256).max);
        vm.prank(BUYER);
        market.bid(roundId, 100, 3);
        vm.warp(uint256(sellingDay) + 3 days + 2);
        sellingDay = now64();
        market.settle(roundId);
        vm.prank(BUYER);
        market.claimShares(roundId, BUYER);

        // One day later, the schedule frees exactly one more day's worth, and the token ceiling
        // agrees: moving it passes, one more unit is refused.
        vm.warp(uint256(sellingDay) + 3 days);
        uint64 nextDay = now64();
        assertEq(nextDay, uint64(sellingDay + 3 days), "the later day clock");
        (, uint256 vested) = vestedAt(nextDay, variant);
        assertEq(variant.saleCapacity(FOUNDER), vested - 100e18, "sch only");
        vm.prank(address(market));
        tokens.transferFrom(FOUNDER, address(market), vested - 100e18);
        vm.prank(address(market));
        vm.expectRevert(Shares.LockedShares.selector);
        tokens.transferFrom(FOUNDER, address(market), 1);
    }

    /// @dev Awards to others are acquired fresh and are unrestricted; the founder's locked grant
    /// does not extend to anyone and their units never re-lock.
    function test_awards_get_their_own_fresh_unrestricted_treatment() public {
        (Moloch dao, TreasuryMandate budget, ActivationVoting variant, SecondaryMarket market) =
            _launchV2(_params("fresh"));
        Shares tokens = dao.shares();
        vm.warp(uint256(SALE_START) + 8 days);
        uint64 awardDay = now64();
        assertEq(awardDay, uint64(SALE_START + 8 days), "the award clock");
        _award(dao, budget, keccak256("award-1"), DAVE, 40e18);
        assertEq(tokens.balanceOf(DAVE), 40e18, "the award minted");
        assertEq(variant.saleCapacity(DAVE), 40e18, "an award is inside no founder schedule");
        assertEq(variant.lockedAt(now64()), 200e18, "and it did not touch the founder schedule");

        _enableListing(dao, market);
        vm.prank(DAVE);
        tokens.approve(address(market), type(uint256).max);
        vm.prank(address(dao));
        uint256 roundId = market.openRound();
        vm.prank(DAVE);
        market.sell(roundId, 2, 0);
        assertEq(tokens.balanceOf(DAVE), 38e18, "2 lots escrowed into the round");
    }

    /// @dev Self-transfers require the general wallet unlock and free nothing; a general unlock
    /// must not, and does not, bypass the founder sale guard.
    function test_a_general_unlock_never_bypasses_the_founder_sale_guard() public {
        (Moloch dao,, ActivationVoting variant, SecondaryMarket market) = _launchV2(_params("unlock"));
        Shares tokens = dao.shares();
        assertEq(tokens.transferExempt(), address(market), "the market endpoint stays what it was");

        // While locked, not even a self-move passes: D77's wallet lock governs every move.
        vm.prank(FOUNDER);
        vm.expectRevert(Locked.selector);
        tokens.transfer(FOUNDER, 1e18);

        vm.prank(address(dao));
        tokens.announceTransferUnlock();
        vm.warp(uint64(SALE_START + 31 days));
        vm.prank(address(dao));
        tokens.setTransfersLocked(false);
        assertFalse(tokens.transfersLocked());

        vm.prank(FOUNDER);
        tokens.transfer(FOUNDER, 200e18);
        assertEq(variant.capacity(FOUNDER), 200e18, "a self-move changed nothing");
        assertEq(variant.saleCapacity(FOUNDER), 0, "and it freed nothing either");
        // Third-party moves remain inside the founder schedule: the whole balance is still locked.
        vm.prank(FOUNDER);
        vm.expectRevert(Shares.LockedShares.selector);
        tokens.transfer(BUYER, 1);
    }

    /// @dev Leaving is always allowed: a burn takes Shares out as a direct exit, and the schedule
    /// follows it down exactly once — no re-growth later, no double counting.
    function test_ragequit_always_works_and_the_burn_drops_the_locked_grant_once() public {
        (Moloch dao,, ActivationVoting variant,) = _launchV2(_params("leave"));
        Shares tokens = dao.shares();

        vm.warp(20 days);
        address[] memory quoteTokens = new address[](1);
        quoteTokens[0] = address(quote);
        vm.prank(FOUNDER);
        dao.ragequit(quoteTokens, 50e18, 0);
        assertEq(tokens.balanceOf(FOUNDER), 150e18, "the direct exit worked while everything was locked");
        assertEq(variant.lockedAt(now64()), 150e18, "the schedule shrank by what it actually held");
        assertEq(variant.saleCapacity(FOUNDER), 0, "what remains locked still rules");

        // Still inside the cliff the schedule only ever holds the net grant: no time has vested.
        vm.warp(uint256(31 days));
        (, uint256 vested31) = vestedAt(uint64(31 days), variant);
        assertEq(vested31, 0e18, "still inside the cliff");
        assertEq(variant.lockedAt(uint64(31 days)), 150e18, "the remaining locked is exact");
    }

    /// @dev A legacy kit's DAO — whose birth choice is "no lock guard", final — can never grow a
    /// sale guard; a V2 DAO's one cannot be replaced, declined again, or pointed anywhere but its
    /// own policy; and no non-DAO caller can do anything.
    function test_the_sale_guard_cannot_be_added_to_a_sealed_legacy_dao_or_replaced() public {
        (Moloch dao,,, SecondaryMarket market) = _launchV2(_params("sealed"));
        Shares tokens = dao.shares();
        address boundPolicy = tokens.salePolicy();
        // The birth-time final zero guard seals first: the DAO cannot even restate its own choice
        // (the one-shot refusal is what a declined-but-unsealed DAO hits; see the decline test).
        vm.prank(address(dao));
        vm.expectRevert(Shares.LockGuardSet.selector);
        tokens.setSalePolicy(boundPolicy);
        vm.prank(address(dao));
        vm.expectRevert(Shares.LockGuardSet.selector);
        tokens.setSalePolicy(address(0));
        vm.prank(address(dao));
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        tokens.setSalePolicy(address(market)); // an arbitrary admin module is refused, not just sealed
        vm.prank(FOUNDER);
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        tokens.setSalePolicy(boundPolicy);

        // The legacy kit, over the real legacy wiring: launched the old way, with the old final
        // zero guard — the added capability can never install there.
        Summoner legacySummoner = newSummoner();
        ContributorKit legacy = new ContributorKit(legacySummoner);
        ContributorKit.Params memory base = baseParams(bytes32("legacy"));
        base.currency = address(quote);
        base.predictedBudget = nextBudgetOf(legacy.budgetFactory());
        base.projects = new ContributorKit.FirstProject[](0);
        vm.prank(FOUNDER);
        (address legacyDao,) = legacy.launch(base);
        Shares legacyTokens = Shares(Moloch(payable(legacyDao)).shares());
        assertTrue(legacyTokens.lockGuardSet());
        assertEq(legacyTokens.lockGuard(), address(0));
        address legacyWeight = Moloch(payable(legacyDao)).votingWeight();
        vm.prank(address(legacyDao));
        vm.expectRevert(Shares.LockGuardSet.selector);
        legacyTokens.setSalePolicy(legacyWeight);
        vm.prank(address(legacyDao));
        vm.expectRevert(Shares.LockGuardSet.selector);
        legacyTokens.setLockGuard(address(this));
    }

    /// @dev The legacy entry point is inherited by this kit and never configures the secondary
    /// policy, so the born DAO runs the variant policy UNCONFIGURED. That must behave exactly like
    /// legacy: a reviewed award followed at once by a ragequit (partial, then full)
    /// never reverts (this launch keeps share transfers closed, so exit is the path that matters), and the receiver's units are plain raw balance (no pending ledger).
    function test_legacy_launch_over_the_variant_summoner_lets_an_award_holder_exit() public {
        ContributorKit.Params memory base = baseParams(bytes32("legacy-on-v2"));
        vm.prank(FOUNDER);
        (address daoAddr, address budgetAddr) = kit.launch(base);
        Moloch dao = Moloch(payable(daoAddr));
        Shares tokens = dao.shares();
        ActivationVoting variant = ActivationVoting(dao.votingWeight());
        assertFalse(variant.isConfigured(), "the legacy launch never configures the secondary");

        _award(dao, TreasuryMandate(budgetAddr), keccak256("legacy-award"), DAVE, 40e18);
        assertEq(tokens.balanceOf(DAVE), 40e18);

        address[] memory exitTokens = new address[](1);
        exitTokens[0] = address(0);
        vm.prank(DAVE);
        dao.ragequit(exitTokens, 10e18, 0); // inside the maturity window: partial exit
        assertEq(tokens.balanceOf(DAVE), 30e18);

        vm.prank(DAVE);
        dao.ragequit(exitTokens, 30e18, 0); // the rest leaves too
        assertEq(tokens.balanceOf(DAVE), 0);
        assertEq(tokens.balanceOf(FOUNDER), 200e18, "the founder's bootstrap is untouched");
    }

    /// @dev The legacy entry point on THIS contract makes a sealed, market-less DAO: no market, no
    /// sale policy, closed transfers, and no later vote can add any of them (the final zero guard).
    /// An award still lands as plain raw balance, a ragequit works, and a wallet-to-wallet transfer
    /// stays refused. Only `ContributorKitV2.launch` makes a DAO with a market.
    function test_legacy_launch_over_the_variant_summoner_makes_a_sealed_marketless_dao() public {
        ContributorKit.Params memory base = baseParams(bytes32("legacy-sealed"));
        vm.prank(FOUNDER);
        (address daoAddr, address budgetAddr) = kit.launch(base);
        Moloch dao = Moloch(payable(daoAddr));
        Shares tokens = dao.shares();

        assertEq(kit.marketFactory().marketOf(daoAddr), address(0), "no market was ever made for it");
        assertEq(tokens.salePolicy(), address(0), "no sale policy is bound");
        assertTrue(tokens.lockGuardSet(), "the zero lock guard is final");
        assertEq(tokens.transferExempt(), address(0), "no market endpoint is exempt from the lock");
        assertTrue(tokens.transfersLocked());

        // No vote, however carried, can add a market's sale ceiling afterwards.
        address weight = dao.votingWeight();
        vm.prank(daoAddr);
        vm.expectRevert(Shares.LockGuardSet.selector);
        tokens.setSalePolicy(weight);

        // An award lands, and the holder cannot send it to another wallet (transfers are closed)...
        _award(dao, TreasuryMandate(budgetAddr), keccak256("legacy-sealed-award"), DAVE, 40e18);
        assertEq(tokens.balanceOf(DAVE), 40e18);
        vm.prank(DAVE);
        vm.expectRevert(Locked.selector);
        tokens.transfer(R1, 1e18);
        vm.prank(FOUNDER);
        vm.expectRevert(Locked.selector);
        tokens.transfer(R1, 1e18);

        // ...but leaving by ragequit works.
        address[] memory exitTokens = new address[](1);
        exitTokens[0] = address(0);
        vm.prank(DAVE);
        dao.ragequit(exitTokens, 40e18, 0);
        assertEq(tokens.balanceOf(DAVE), 0);
    }

    /// @dev A real exit exchange is announced, waits out its 30 days and goes live; it cannot pull a seller's
    /// escrow from the market (no allowance exists), and clearing it afterwards does not strand the seller:
    /// the market returns the seller's own escrow regardless of anything downstream.
    function test_clearing_a_live_exit_exchange_still_returns_a_sellers_own_escrow() public {
        (Moloch dao, TreasuryMandate budget, ActivationVoting variant, SecondaryMarket market) =
            _launchV2(_params("exchange"));
        Shares tokens = dao.shares();
        vm.warp(SALE_START + 8 days);
        address exchange = address(0xE8C4A);
        vm.prank(address(dao));
        tokens.announceExitExchange(exchange);
        vm.warp(block.timestamp + tokens.UNLOCK_NOTICE());
        tokens.activateExitExchange();
        assertEq(tokens.exitExchange(), exchange, "the exchange is live before the round");
        _award(dao, budget, keccak256("escrow-award"), DAVE, 40e18);
        _enableListing(dao, market);
        vm.prank(DAVE);
        tokens.approve(address(market), type(uint256).max);
        vm.prank(address(dao));
        uint256 roundId = market.openRound();
        vm.prank(DAVE);
        market.sell(roundId, 2, 0);
        assertEq(tokens.balanceOf(DAVE), 38e18);
        assertEq(variant.escrowedBalance(DAVE), 2e18, "the market holds the escrow for the round");

        // The exchange passes the lock as a transferFrom caller, but the market never approved it.
        assertEq(tokens.allowance(address(market), exchange), 0, "the market grants no allowance");
        vm.prank(exchange);
        vm.expectRevert();
        tokens.transferFrom(address(market), exchange, 1);
        assertEq(tokens.balanceOf(address(market)), 2e18, "the escrow is out of the exchange's reach");

        vm.prank(address(dao));
        tokens.clearExitExchange();
        assertEq(tokens.exitExchange(), address(0), "the live exchange was really cleared");
        assertEq(tokens.transferExempt(), address(market), "the market endpoint is the birth fact, unattached");

        vm.prank(DAVE);
        market.cancelSell(roundId);
        assertEq(tokens.balanceOf(DAVE), 40e18, "the seller's own escrow went back to the seller");
        assertEq(variant.escrowedBalance(DAVE), 0, "and the escrow books closed with it");
    }

    /// @dev Bootstrap governance works at birth, and units acquired later do not become voting
    /// weight until their maturity epochs pass (the schedule never bootstraps a newholder).
    function test_bootstrap_governs_at_birth_and_a_later_award_matures_separately() public {
        (Moloch dao, TreasuryMandate budget, ActivationVoting variant,) = _launchV2(_params("vote"));
        // The proposals' snapshots read the previous block, so step off the birth block first.
        vm.roll(vm.getBlockNumber() + 1);

        vm.prank(FOUNDER);
        dao.openProposal(1);
        vm.prank(FOUNDER);
        dao.castVote(1, 1, 200e18);
        (uint96 yes,,,) = dao.proposalSupport(1);
        assertEq(yes, 200e18, "bootstrap voting is fully eligible at birth");
        assertEq(
            variant.getPastCapacity(FOUNDER, dao.snapshotBlock(1)), 200e18, "the founder's grant is eligible at birth"
        );

        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(SALE_START + 8 days);
        _award(dao, budget, keccak256("mature-award"), DAVE, 40e18);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(DAVE);
        dao.openProposal(2);
        uint48 snapshot2 = dao.snapshotBlock(2);
        assertEq(variant.capacity(DAVE), 40e18, "the holding is real");
        assertEq(variant.getPastCapacity(DAVE, snapshot2), 0, "freshly acquired units are not voters yet");
        uint64 matureAt = now64() + MATURITY + 1; // the award settled at its own clock; date from it
        vm.warp(uint256(matureAt));
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(DAVE);
        dao.openProposal(3);
        assertEq(variant.getPastCapacity(DAVE, dao.snapshotBlock(3)), 40e18, "matured units count for their holder");
    }

    function min(uint256 a, uint256 b, uint256 c) private pure returns (uint256 m_) {
        uint256 first = a < b ? a : b;
        m_ = first < c ? first : c;
    }
}

/// @dev Runs the real two-step deployment once from inside its own constructor, where its landing
/// address is `address(this)`: the factory first (authorised for this probe's own address), then
/// the kit over it. The harness only reads whether it built; every refusal inside is swallowed.
contract KitDeployProbe {
    ContributorKitV2 internal built;

    constructor(Summoner summoner_) {
        try new SecondaryMarketFactory(summoner_, address(this)) returns (SecondaryMarketFactory f) {
            try new ContributorKitV2(summoner_, f) returns (ContributorKitV2 k) {
                built = k;
            } catch {}
        } catch {}
    }

    function builtAddress() external view returns (address) {
        return address(built);
    }
}
