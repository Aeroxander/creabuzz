// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ActivationVoting} from "./ActivationVoting.sol";
import {ContributorKit} from "./ContributorKit.sol";
import {ISecondaryPolicy} from "./interfaces/ISecondaryPolicy.sol";
import {SecondaryMarket} from "./SecondaryMarket.sol";
import {SecondaryMarketFactory} from "./SecondaryMarketFactory.sol";
import {Call, Moloch, Shares, Summoner} from "./majeur/MolochPatched.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "./TreasuryMandate.sol";

/// @title ContributorKitV2
/// @notice The creation-version `ContributorKit`: one transaction that makes a contributor project
/// ready for work the way the legacy kit does — a DAO, the caller as its only holder, a first work
/// budget (Shares only) and up to eight first projects in it, its Shares locked against transfers
/// with the 30-day unlock notice — plus a creation-bound per-DAO secondary market and the founder's
/// transfer-only sale schedule. Nothing the legacy kit does is re-decided here; this contract only
/// adds the secondary creation (docs/v3-review/SECONDARY-LISTING-SPEC.md).
///
/// What is added, all inside the DAO's own birth block and read back afterwards:
/// - the Shares lock is announced with the predicted market as its one `transferExempt` endpoint —
///   an immutable custody fact set at the token's birth, so the market is the one wallet the lock
///   lets Shares reach and no operator power is ever stored for it. A seller still has to approve
///   the market for the exact Shares an order escrows: the market pulls them with `transferFrom`;
/// - the DAO's policy (the `ActivationVoting` variant, cloned from the summoner's pinned
///   implementation) is configured once with the market and the founder sale schedule. The schedule
///   describes SALE ELIGIBILITY ONLY: it is not conventional financial vesting, not a withdrawal
///   lock, and not evidence of product readiness, and direct exits (burns) stay always allowed;
/// - the DAO binds that policy as its Shares' sale ceiling (`Shares.setSalePolicy`) once, before the
///   final "no lock guard" decision, so no later vote can add a sale guard or replace this one;
/// - the kit binds the market factory made for it before it existed (deployed separately, with
///   this kit's address authorised and the same pinned summoner): the factory is the only caller
///   that can ever open this DAO's markets. The market's terms start disabled: opening trading
///   is a later DAO decision, never an automatic sequel of token creation or deposit readiness;
/// - every address is a prediction: the DAO, its Shares clone, its policy clone and the market are
///   all CREATE2 addresses computed here against the exact current initcode of their pinned
///   implementations, and any missing code or wrong prediction reverts the whole launch.
///
/// A market for a DAO is one, ever; after `launch` returns the kit holds nothing and keeps no role.
/// The legacy `ContributorKit.launch` is still callable on this contract (it is inherited, same
/// immutables, same summoner serves both flows) and its terms are the legacy ones, but the DAO it
/// makes is not byte-for-byte a legacy DAO: the summoner clones the `ActivationVoting` policy, which
/// stays unconfigured and then counts votes like the legacy policy. That flow binds no market and
/// sets no sale policy, and its final zero lock guard permanently seals such a DAO's ability to ever
/// add one: no market, no founder schedule, no later fix. A DAO with a market is made only by
/// `ContributorKitV2.launch`; use the legacy entry point on this address only to make that sealed kind.
contract ContributorKitV2 is ContributorKit {
    /// @notice The one market factory this kit made from its summoner: only this kit's calls can
    /// open markets through it, and it is the only provenance check a market keeps.
    SecondaryMarketFactory public immutable marketFactory;
    /// @notice The voting policy implementation every DAO of this summoner clones. This kit requires
    /// it to be the `ActivationVoting` variant (version 1), so a launch can configure the founder
    /// sale schedule; on a legacy summoner this kit cannot even be constructed.
    address public immutable policyImplementation;

    /// @notice The legacy terms plus the sale schedule and market terms.
    struct LaunchParams {
        ContributorKit.Params base;
        /// @notice When the founder sale schedule starts measuring. `0` means "at birth": the
        /// launch resolves it to its own block once, for the policy and the read-back both. An
        /// explicit past clock is refused. Sale eligibility only: no money is withdrawn and
        /// nothing becomes deliverable.
        uint64 saleStart;
        /// @notice How long after `saleStart` none of the original grant may be sold yet.
        uint64 saleCliff;
        /// @notice How long after the cliff the rest of the original grant unlocks, linearly.
        uint64 saleDuration;
        /// @notice What buyers pay in: one exact-transfer ERC-20 the market validates itself.
        address quote;
        /// @notice Whole Shares base units per market lot; every order is a whole number of lots.
        uint256 lotSize;
    }

    /// @notice A contributor project was launched with its secondary market.
    event ContributorProjectLaunchedV2(
        address indexed founder,
        address indexed dao,
        address indexed market,
        address budget,
        address policy,
        address quote,
        uint256 lotSize
    );

    /// @dev Mirrors `SecondaryMarket.MAX_LOT_SIZE` (inclusive, a `uint128`) and the market factory's own
    /// bound: the market revalidates its bound in its constructor anyway, and the kit's readback ties
    /// `p.lotSize` to the market's stored one. One bound everywhere, so a lot the kit accepts is a lot
    /// the factory accepts.
    uint256 private constant MAX_LOT_SIZE_BOUND = type(uint128).max;

    /// @dev Everything the read-back checks, in one place.
    struct Predictions {
        address dao;
        address shares;
        address policy;
        address market;
        address budget;
    }

    constructor(Summoner summoner_, SecondaryMarketFactory factory_) ContributorKit(summoner_) {
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

    /// @notice The caller's project made in one transaction, with its secondary market bound. Any
    /// wrong prediction or missing piece of the intended setup reverts the whole launch.
    function launch(ContributorKitV2.LaunchParams calldata p)
        external
        returns (address dao, address budget, address policy)
    {
        ContributorKit.Params calldata base = p.base;
        if (
            base.founderShares == 0 || base.founderShares > type(uint96).max || base.shareBudget == 0
                || base.shareCap == 0 || base.shareCap > base.shareBudget || base.reviewers.length == 0
                || base.quorum == 0 || base.quorum > base.reviewers.length || base.predictedBudget == address(0)
                || base.currency.code.length == 0 || bytes(base.name).length == 0 || bytes(base.symbol).length == 0
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
        emit ContributorProjectLaunchedV2(msg.sender, dao, made.market, budget, policy, p.quote, p.lotSize);
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
        LaunchParams calldata p,
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
            marketAddr != made.market || founderAddr != msg.sender || grant != base.founderShares
                || start != saleStart || cliff != p.saleCliff || duration != p.saleDuration
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
