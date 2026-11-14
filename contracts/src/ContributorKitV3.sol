// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ActivationVoting} from "./ActivationVoting.sol";
import {BackingPool} from "./BackingPool.sol";
import {BackingPoolFactory} from "./BackingPoolFactory.sol";
import {ContributorKit} from "./ContributorKit.sol";
import {ContributorKitV2} from "./ContributorKitV2.sol";
import {ISecondaryPolicy} from "./interfaces/ISecondaryPolicy.sol";
import {SecondaryMarket} from "./SecondaryMarket.sol";
import {SecondaryMarketFactory} from "./SecondaryMarketFactory.sol";
import {Call, Moloch, Shares, Summoner} from "./majeur/MolochPatched.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "./TreasuryMandate.sol";

/// @title ContributorKitV3
/// @notice `ContributorKitV2`'s launch plus one step: the project's backing pool is opened in the same
/// transaction that makes the project, so backing is live at birth (docs/v3-review/BACKING-POOL.md).
///
/// `ContributorKitV2` is deployed and stays byte-for-byte what it is, so this kit does not change it or
/// inherit from it: `launchWithPool` below is that kit's `launch`, statement for statement (the same
/// setup calls in the same order, the same predictions, the same read-back), followed by the call to the
/// pool factory and a read-back of the pool. It takes the same `ContributorKitV2.LaunchParams`. Nothing
/// about the DAO, its Shares, its budget, its market (trading there still starts disabled) or the
/// founder's sale schedule differs from a V2 launch, and the pool gets no power over the DAO: it mints
/// no Shares and moves none. `test/ContributorKitV3.t.sol` launches the same terms through both kits and
/// compares what was born.
///
/// This kit needs its own `SecondaryMarketFactory` (a market factory serves exactly one kit) and the
/// `BackingPoolFactory` deployed for its address. A project that should start without a pool is launched
/// with `ContributorKitV2`; its founder opens the pool later with one call to `BackingPoolFactory.open`.
contract ContributorKitV3 is ContributorKit {
    /// @notice The one market factory this kit made from its summoner: only this kit's calls can
    /// open markets through it, and it is the only provenance check a market keeps.
    SecondaryMarketFactory public immutable marketFactory;
    /// @notice The voting policy implementation every DAO of this summoner clones. This kit requires
    /// it to be the `ActivationVoting` variant (version 1), so a launch can configure the founder
    /// sale schedule; on a legacy summoner this kit cannot even be constructed.
    address public immutable policyImplementation;

    /// @notice The factory this kit opens pools through. It was deployed for exactly this kit's address.
    BackingPoolFactory public immutable poolFactory;

    /// @notice A contributor project was launched with its secondary market.
    event ContributorProjectLaunchedV3(
        address indexed founder,
        address indexed dao,
        address indexed market,
        address budget,
        address policy,
        address quote,
        uint256 lotSize,
        address pool
    );

    /// @dev Mirrors `SecondaryMarket.MAX_LOT_SIZE` (inclusive, a `uint128`) and the market factory's own
    /// bound: the market revalidates its bound in its constructor anyway, and the kit's readback ties
    /// `p.lotSize` to the market's stored one. One bound everywhere, so a lot the kit accepts is a lot
    /// the factory accepts.
    uint256 private constant MAX_LOT_SIZE_BOUND = type(uint128).max;

    /// @notice The most reviewers a launch through this kit may name. The launch is one transaction and some
    /// chains cap a transaction at 2**24 gas (EIP-7825): the V2 launch alone takes 10.8 million, the pool 4
    /// million more, and each reviewer about 31,000 (a `ContributorKitV2` launch has no such cap and is
    /// unchanged). With 8 first projects, 8 reviewers and the longest name and symbol the launch still leaves
    /// more than 5% of the cap (`test_gas_the_largest_launch_fits_one_transaction`).
    uint256 public constant MAX_REVIEWERS = 8;
    /// @notice The longest project name and symbol (in bytes) a launch through this kit takes: both are stored by
    /// the DAO and its Shares, at about 800 gas a byte.
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 12;

    /// @dev Everything the read-back checks, in one place.
    struct Predictions {
        address dao;
        address shares;
        address policy;
        address market;
        address budget;
    }

    constructor(Summoner summoner_, SecondaryMarketFactory factory_, BackingPoolFactory poolFactory_)
        ContributorKit(summoner_)
    {
        // The pool factory, like the market factory, was deployed first and for exactly this address,
        // on the same summoner.
        if (
            address(poolFactory_).code.length == 0 || poolFactory_.authorizedKit() != address(this)
                || address(poolFactory_.summoner()) != address(summoner_)
        ) revert InvalidTerms();
        poolFactory = poolFactory_;
        // The factory is deployed separately, before this kit, authorised for exactly the address
        // this kit will land on (the deployer predicts it first — EIP-3860 keeps both creation
        // payloads under the limit only that way). A separate, authorised, immutable-first factory
        // is equivalent in authority to one born here: no new role, no mutable binding, no upgrade
        // path — the kit keeps hold of nothing after a launch.
        if (
            address(factory_).code.length == 0 || factory_.authorizedKit() != address(this)
                || address(factory_.summoner()) != address(summoner)
        ) revert InvalidTerms();
        policyImplementation = summoner_.policyImplementation();
        // Only the variant: a legacy `AllocationVoting` summoner has no secondary version to report
        // and this call reverts, so a launch can never silently fall back to legacy maturity and
        // legitimacy. A clone that answers the getter without being the real policy is caught at
        // launch, against live state, by the same read-back.
        if (ActivationVoting(policyImplementation).SECONDARY_POLICY_VERSION() != 1) revert InvalidTerms();
        // And it must pin exactly what this kit pins.
        if (factory_.molochImplementation() != molochImplementation) revert InvalidTerms();
        if (factory_.sharesImplementation() != sharesImplementation) revert InvalidTerms();
        marketFactory = factory_;
    }

    /// @notice Predictions for a caller's own project, before anything is sent: the DAO, its Shares
    /// clone, its policy clone, and the market those exact bindings will get (the market itself
    /// does not exist until after the DAO that owns it does).
    function predictLaunch(address founder, uint256 founderShares, bytes32 salt, address quote, uint256 lotSize)
        public
        view
        returns (address dao, address sharesToken, address policy, address market)
    {
        dao = predictDao(founder, founderShares, salt);
        sharesToken = _predictShares(dao);
        policy = _predictPolicy(dao);
        market = marketFactory.predict(dao, sharesToken, policy, quote, lotSize);
    }

    /// @notice The caller's project made in one transaction, with its secondary market bound and its
    /// backing pool open. Any
    /// wrong prediction or missing piece of the intended setup reverts the whole launch.
    /// @return dao The project's DAO.
    /// @return budget Its first work budget.
    /// @return policy Its voting policy.
    /// @return pool Its backing pool, open.
    function launchWithPool(ContributorKitV2.LaunchParams calldata p)
        external
        returns (address dao, address budget, address policy, address pool)
    {
        ContributorKit.Params calldata base = p.base;
        if (
            base.founderShares == 0 || base.founderShares > type(uint96).max || base.shareBudget == 0
                || base.shareCap == 0 || base.shareCap > base.shareBudget || base.reviewers.length == 0
                || base.quorum == 0 || base.quorum > base.reviewers.length || base.predictedBudget == address(0)
                || base.currency.code.length == 0 || bytes(base.name).length == 0 || bytes(base.symbol).length == 0
                || base.reviewers.length > MAX_REVIEWERS || bytes(base.name).length > MAX_NAME_BYTES
                || bytes(base.symbol).length > MAX_SYMBOL_BYTES
        ) revert InvalidTerms();
        _checkProjects(base);
        // D79, as the legacy kit: the founder starts with at most a third of the first budget, and
        // does not sit on its panel judging everyone else's claims.
        if (base.founderShares > uint256(base.shareBudget) / 3) revert InvalidTerms();
        for (uint256 i; i < base.reviewers.length; ++i) {
            if (base.reviewers[i] == msg.sender) revert InvalidTerms();
        }
        // Market terms: a real quote, a whole-lot size, and a schedule a policy can serve. The
        // founder sale start is either `0` — an "at birth" marker that this one launch resolves to
        // its own block (a deployment built in one transaction is still one transaction in the
        // mined block) — or an explicit future clock; an explicit past clock is refused. The
        // schedule stays a whole length that never runs off the uint64 clock.
        if (
            p.quote == address(0) || p.quote.code.length == 0 || p.lotSize == 0 || p.lotSize > MAX_LOT_SIZE_BOUND
                || p.saleDuration == 0 || p.saleCliff > p.saleDuration
                || (p.saleStart != 0 && p.saleStart < block.timestamp)
        ) revert InvalidTerms();
        uint64 saleStart = p.saleStart == 0 ? uint64(block.timestamp) : p.saleStart;
        if (uint256(saleStart) + p.saleCliff + p.saleDuration > type(uint64).max) revert InvalidTerms();

        (address predicted, address predictedShares,, address predictedMarket) =
            predictLaunch(msg.sender, base.founderShares, base.salt, p.quote, p.lotSize);
        policy = _predictPolicy(predicted);
        uint96 threshold = thresholdFor(base.founderShares);

        uint256 count = base.projects.length;
        Call[] memory setup = new Call[](8 + count);
        setup[0] = Call(predicted, 0, abi.encodeCall(Moloch.setProposalThreshold, (threshold)));
        setup[1] = Call(
            address(budgetFactory),
            0,
            abi.encodeCall(
                TreasuryMandateFactory.create,
                (
                    base.currency,
                    0,
                    0,
                    base.shareBudget,
                    base.shareCap,
                    base.budgetExpires,
                    base.reviewers,
                    base.quorum,
                    0,
                    address(0)
                )
            )
        );
        uint256 next;
        for (uint256 i; i < count; ++i) {
            ContributorKit.FirstProject calldata project = base.projects[i];
            setup[2 + i] = Call(
                p.base.predictedBudget,
                0,
                abi.encodeCall(
                    TreasuryMandate.approveProject,
                    (project.id, project.manager, 0, project.shares, project.expires, project.check)
                )
            );
        }
        next = 2 + count;
        setup[next++] = Call(predicted, 0, abi.encodeCall(Moloch.setTransfersLocked, (true, true)));
        // Lifting the transfer lock later takes effect only 30 days after a vote announces it (D77),
        // and the one exempt endpoint is the market to come: the immutable custody fact of birth.
        setup[next++] = Call(predictedShares, 0, abi.encodeCall(Shares.lockTransfersWithNotice, (predictedMarket)));
        // The founder schedule goes to the policy first (sale eligibility only: it is not financial
        // vesting and not a withdrawal lock), then the Shares bind it, sealed for good by the final
        // zero guard that follows — so no later vote can add a sale guard or replace this one.
        setup[next++] = Call(
            policy,
            0,
            abi.encodeCall(
                ActivationVoting.configureSecondary,
                (predictedMarket, msg.sender, base.founderShares, saleStart, p.saleCliff, p.saleDuration)
            )
        );
        setup[next++] = Call(predictedShares, 0, abi.encodeCall(Shares.setSalePolicy, (policy)));
        setup[next++] = Call(predictedShares, 0, abi.encodeCall(Shares.setLockGuard, (address(0))));
        // Shares only from reviewed awards, with no yearly limit (D79): a vote the founder carries
        // cannot mint more.
        setup[next] = Call(predictedShares, 0, abi.encodeCall(Shares.setIssuanceRule, (type(uint16).max)));

        address[] memory holders = new address[](1);
        holders[0] = msg.sender;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = base.founderShares;
        dao = address(
            summoner.summon(
                base.name,
                base.symbol,
                "",
                QUORUM_BPS,
                true,
                address(0),
                keccak256(abi.encode(msg.sender, base.salt)),
                holders,
                amounts,
                setup
            )
        );
        budget = p.base.predictedBudget;

        // The market exists now, under the factory's own live-state proof of every binding; only
        // this kit can ever call `create`.
        marketFactory.create(dao, predictedShares, ISecondaryPolicy(policy), IERC20(p.quote), p.lotSize);

        Predictions memory made = Predictions({
            dao: predicted, shares: predictedShares, policy: policy, market: predictedMarket, budget: budget
        });
        _verify(made, threshold, base, p, saleStart);

        // The one added step: the pool, opened by this kit for the founder the policy just recorded, and
        // read back like everything else.
        BackingPool opened = poolFactory.open(dao);
        pool = address(opened);
        if (poolFactory.poolOf(dao) != pool || opened.dao() != dao || opened.founder() != msg.sender) {
            revert SetupNotApplied();
        }
        emit ContributorProjectLaunchedV3(msg.sender, dao, made.market, budget, policy, p.quote, p.lotSize, pool);
    }

    // ------------------------------------------------------------------
    // Predictions
    // ------------------------------------------------------------------

    /// @dev The DAO's policy clone: the minimal proxy of the summoner's variant policy, made by the
    /// DAO with CREATE2 and the DAO's own address as salt (`Moloch.init`), exactly as its Shares are.
    function _predictPolicy(address dao) internal view returns (address) {
        bytes memory proxy = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73", policyImplementation, hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        return _create2(dao, bytes32(bytes20(dao)), keccak256(proxy));
    }

    // ------------------------------------------------------------------
    // The read-back
    // ------------------------------------------------------------------

    /// @dev Everything that should exist reads to exactly what was asked, or the whole launch
    /// reverts: a call to no code "succeeds" quietly, so every check is a real call on real state.
    function _verify(
        Predictions memory made,
        uint96 threshold,
        ContributorKit.Params calldata base,
        ContributorKitV2.LaunchParams calldata p,
        uint64 saleStart
    ) private view {
        Moloch live = Moloch(payable(made.dao));
        if (
            made.dao != predictDao(msg.sender, base.founderShares, base.salt) || live.proposalThreshold() != threshold
                || live.proposalTTL() != PROPOSAL_TTL || live.timelockDelay() != TIMELOCK
                || live.votingWeight() != made.policy || address(live.shares()) != made.shares
        ) revert SetupNotApplied();

        // The policy: the variant bound to this DAO, naming this market and this exact schedule.
        if (ActivationVoting(made.policy).dao() != made.dao) revert SetupNotApplied();
        if (ISecondaryPolicy(made.policy).market() != made.market) revert SetupNotApplied();
        (address marketAddr, address founderAddr, uint256 grant, uint64 start, uint64 cliff, uint64 duration) =
            _readSecondaryConfiguration(made.policy);
        if (
            marketAddr != made.market || founderAddr != msg.sender || grant != base.founderShares || start != saleStart
                || cliff != p.saleCliff || duration != p.saleDuration
        ) revert SetupNotApplied();

        // The market: made through this kit's factory, for the right DAO, token, policy and terms,
        // and starting disabled (opening trading is a later DAO decision, never automatic).
        address market = marketFactory.marketOf(made.dao);
        if (
            market != made.market || market.code.length == 0
                || marketFactory.predict(made.dao, made.shares, address(made.policy), p.quote, p.lotSize) != market
                || marketFactory.authorizedKit() != address(this)
                || address(marketFactory.summoner()) != address(summoner)
        ) revert SetupNotApplied();
        SecondaryMarket bound = SecondaryMarket(market);
        if (
            bound.dao() != made.dao || bound.factory() != address(marketFactory) || bound.sharesToken() != made.shares
                || bound.policy() != ISecondaryPolicy(made.policy) || bound.quote() != IERC20(p.quote)
                || bound.lotSize() != p.lotSize || listingEnabled(bound)
        ) revert SetupNotApplied();

        // The budget: the same factory instance the summoner pins (the policy's provenance check
        // against it has already passed inside `create`).
        if (budgetFactory.daos(made.budget) != made.dao) revert SetupNotApplied();
        if (Summoner(summoner).mandateFactory() != address(budgetFactory)) revert SetupNotApplied();

        // The Shares: locked with the market as the one exempt endpoint, the sale policy bound and
        // sealed by the final zero guard, awards only — and at birth the founder may sell nothing.
        Shares tokens = Shares(made.shares);
        (uint256 eligible, uint8 version) = tokens.saleEligibleOf(msg.sender);
        if (
            tokens.DAO() != made.dao || !tokens.transfersLocked() || !tokens.unlockNoticeRequired()
                || tokens.transferExempt() != made.market || tokens.lockGuard() != address(0) || !tokens.lockGuardSet()
                || tokens.salePolicy() != made.policy || !tokens.salePolicyChosen() || version != 1 || eligible != 0
                || !tokens.awardsOnly() || tokens.issuanceCapBps() != NO_CAP
        ) revert SetupNotApplied();

        // The first projects, as the legacy kit reads them back.
        for (uint256 i; i < base.projects.length; ++i) {
            (address manager,,,,, uint128 shareBudget,) = TreasuryMandate(made.budget).projects(base.projects[i].id);
            if (manager != base.projects[i].manager || shareBudget != base.projects[i].shares) {
                revert SetupNotApplied();
            }
        }
    }

    /// @dev The frozen schedule read back from the policy, without betting on any helper staying
    /// where it is: a missing or changed reader reverts the launch loudly, never quietly skips it.
    function _readSecondaryConfiguration(address policy)
        private
        view
        returns (address market, address founder, uint256 grant, uint64 start, uint64 cliff, uint64 duration)
    {
        (bool ok, bytes memory data) = policy.staticcall(abi.encodeWithSignature("secondaryConfiguration()"));
        if (!ok || data.length != 6 * 32) revert SetupNotApplied();
        (market, founder, grant, start, cliff, duration) =
            abi.decode(data, (address, address, uint256, uint64, uint64, uint64));
    }

    /// @dev Whether the market's listing has been turned on (public trading is always a project
    /// decision, taken after creation, through the DAO's own governance).
    function listingEnabled(SecondaryMarket market) private view returns (bool) {
        (bool enabled,,,) = market.listing();
        return enabled;
    }
}
