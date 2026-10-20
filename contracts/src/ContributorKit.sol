// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AllocationVoting} from "./AllocationVoting.sol";
import {Call, Moloch, Shares, Summoner} from "./majeur/MolochPatched.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "./TreasuryMandate.sol";

/// @title ContributorKit
/// @notice One transaction that makes a contributor project ready for work: a DAO with no sale, the caller as its only
/// holder, its first work budget (Shares only) and, optionally, the first project in it, and its Shares locked against
/// transfers between wallets. Nothing in it can be bought, and the first claim can be filed the same day.
///
/// Why the setup happens at birth and not by vote: until anyone else holds Shares, the founder is the only voter, so the
/// review and waiting periods of the first two decisions protect nobody (about six days, for nothing). Everything after
/// birth (more budgets and projects, every award, lifting the lock) is voted as usual. Written up in
/// docs/v3-review/CONTRIBUTOR-KIT.md.
///
/// The DAO is made by the same patched factory (`Summoner`) as every other DAO here, so its voting policy and work
/// budget factory are the usual ones. The setup runs as the DAO's own initialization calls (the only moment the DAO
/// acts without a vote), and afterwards everything is read back: any difference reverts the whole launch, so there is
/// never a half-made project.
///
/// The work budget factory makes each budget with a plain CREATE, so its address depends on how many it made before,
/// which a contract cannot read. The caller passes the address it predicted from the factory's nonce; if another budget
/// was made first, the read-back fails and nothing is made.
///
/// The kit holds nothing and keeps no role: once `launch` returns, it has no power over the DAO.
contract ContributorKit {
    struct Params {
        string name;
        string symbol;
        /// Whole-unit Shares (18 decimals) minted to the caller, the only holder.
        uint256 founderShares;
        /// Scoped to the caller, so nobody else can take this project's DAO address first.
        bytes32 salt;
        /// The token claims name for an optional deposit. No money is set aside in the budget.
        address currency;
        /// Shares the first budget may cause to be awarded, in all and per project.
        uint128 shareBudget;
        uint128 shareCap;
        uint64 budgetExpires;
        address[] reviewers;
        uint256 quorum;
        /// Where the budget factory's next budget will be: `CREATE(factory, nonce)` read just before sending.
        address predictedBudget;
        /// The first project; leave `projectId` zero for none.
        bytes32 projectId;
        address projectManager;
        uint128 projectShares;
        uint64 projectExpires;
        bytes32 projectCheck;
    }

    /// @notice A contributor project was launched.
    event ContributorProjectLaunched(
        address indexed founder, address indexed dao, address indexed budget, bytes32 salt, bytes32 projectId
    );

    error InvalidTerms();
    /// @notice The DAO did not come out as asked (a wrong budget prediction, most likely: another budget was made first).
    error SetupNotApplied();

    Summoner public immutable summoner;
    TreasuryMandateFactory public immutable budgetFactory;
    address public immutable molochImplementation;
    /// @notice The Shares implementation every DAO of this factory clones (made by the Moloch implementation with
    /// CREATE2), so the kit can point at a DAO's Shares before the DAO exists.
    address public immutable sharesImplementation;

    /// @dev The patched factory's defaults, read back after launch: a decision lives 14 days and waits 1 day.
    uint64 internal constant PROPOSAL_TTL = 14 days;
    uint64 internal constant TIMELOCK = 1 days;
    uint16 internal constant QUORUM_BPS = 500;
    /// @dev `Shares.NO_CAP`: awards only, with no yearly limit.
    uint16 internal constant NO_CAP = type(uint16).max;

    constructor(Summoner summoner_) {
        if (address(summoner_).code.length == 0) revert InvalidTerms();
        summoner = summoner_;
        budgetFactory = TreasuryMandateFactory(summoner_.mandateFactory());
        molochImplementation = summoner_.getImplementation();
        sharesImplementation = _create2(
            molochImplementation, bytes32(bytes20(molochImplementation)), keccak256(type(Shares).creationCode)
        );
        if (sharesImplementation.code.length == 0) revert InvalidTerms();
    }

    /// @notice The caller's DAO address for `founderShares` and `salt`, before anything is sent.
    function predictDao(address founder, uint256 founderShares, bytes32 salt) public view returns (address) {
        (address[] memory holders, uint256[] memory amounts) = _holders(founder, founderShares);
        bytes32 create2Salt = keccak256(abi.encode(holders, amounts, _scopedSalt(founder, salt)));
        bytes memory initcode = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73", molochImplementation, hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(summoner), create2Salt, keccak256(initcode))))
            )
        );
    }

    /// @notice The proposal threshold a DAO with these starting Shares gets: 1%, at least one unit.
    function thresholdFor(uint256 founderShares) public pure returns (uint96) {
        uint256 t = founderShares / 100;
        return uint96(t == 0 ? 1 : t);
    }

    function launch(Params calldata p) external returns (address dao, address budget) {
        if (
            p.founderShares == 0 || p.founderShares > type(uint96).max || p.shareBudget == 0 || p.shareCap == 0
                || p.shareCap > p.shareBudget || p.reviewers.length == 0 || p.quorum == 0
                || p.quorum > p.reviewers.length || p.predictedBudget == address(0) || p.currency.code.length == 0
                || bytes(p.name).length == 0 || bytes(p.symbol).length == 0
        ) revert InvalidTerms();
        bool withProject = p.projectId != bytes32(0);
        if (
            withProject
                && (p.projectManager == address(0)
                    || p.projectShares == 0
                    || p.projectShares > p.shareCap
                    || p.projectCheck == bytes32(0)
                    || p.projectExpires > p.budgetExpires)
        ) revert InvalidTerms();

        // D79: the founder starts with at most a third of the first budget (so once it is awarded they hold at most a
        // quarter), and does not sit on its panel judging everyone else's claims.
        if (p.founderShares > uint256(p.shareBudget) / 3) revert InvalidTerms();
        for (uint256 i; i < p.reviewers.length; ++i) {
            if (p.reviewers[i] == msg.sender) revert InvalidTerms();
        }

        address predicted = predictDao(msg.sender, p.founderShares, p.salt);
        uint96 threshold = thresholdFor(p.founderShares);

        Call[] memory setup = new Call[](withProject ? 7 : 6);
        setup[0] = Call(predicted, 0, abi.encodeCall(Moloch.setProposalThreshold, (threshold)));
        setup[1] = Call(
            address(budgetFactory),
            0,
            abi.encodeCall(
                TreasuryMandateFactory.create,
                (p.currency, 0, 0, p.shareBudget, p.shareCap, p.budgetExpires, p.reviewers, p.quorum, 0, address(0))
            )
        );
        uint256 next = 2;
        if (withProject) {
            setup[next++] = Call(
                p.predictedBudget,
                0,
                abi.encodeCall(
                    TreasuryMandate.approveProject,
                    (p.projectId, p.projectManager, 0, p.projectShares, p.projectExpires, p.projectCheck)
                )
            );
        }
        setup[next++] = Call(predicted, 0, abi.encodeCall(Moloch.setTransfersLocked, (true, true)));
        address predictedShares = _predictShares(predicted);
        // Lifting the transfer lock later takes effect only 30 days after a vote announces it (D77).
        setup[next++] = Call(predictedShares, 0, abi.encodeCall(Shares.lockTransfersWithNotice, (address(0))));
        // No lock guard, decided now and for good: a guard a later vote installed could refuse every exit (D73).
        setup[next++] = Call(predictedShares, 0, abi.encodeCall(Shares.setLockGuard, (address(0))));
        // Shares only from reviewed awards, with no yearly limit (D79): a vote the founder carries cannot mint more.
        setup[next] = Call(predictedShares, 0, abi.encodeCall(Shares.setIssuanceRule, (NO_CAP)));

        (address[] memory holders, uint256[] memory amounts) = _holders(msg.sender, p.founderShares);
        dao = address(
            summoner.summon(
                p.name,
                p.symbol,
                "",
                QUORUM_BPS,
                true,
                address(0),
                _scopedSalt(msg.sender, p.salt),
                holders,
                amounts,
                setup
            )
        );
        budget = p.predictedBudget;

        // Read it all back. A call to an address with no code "succeeds" without doing anything, so a wrong prediction
        // would otherwise leave a DAO with no budget and no project; it reverts instead.
        Moloch made = Moloch(payable(dao));
        address policy = made.votingWeight();
        if (
            dao != predicted || made.proposalThreshold() != threshold || made.proposalTTL() != PROPOSAL_TTL
                || made.timelockDelay() != TIMELOCK || policy == address(0) || AllocationVoting(policy).dao() != dao
                || budgetFactory.daos(budget) != dao || !Shares(address(made.shares())).transfersLocked()
                || address(made.shares()) != predictedShares || !Shares(predictedShares).lockGuardSet()
                || !Shares(predictedShares).awardsOnly() || Shares(predictedShares).issuanceCapBps() != NO_CAP
                || !Shares(predictedShares).unlockNoticeRequired()
        ) revert SetupNotApplied();
        if (withProject) {
            (address manager,,,,, uint128 shareBudget,) = TreasuryMandate(budget).projects(p.projectId);
            if (manager != p.projectManager || shareBudget != p.projectShares) revert SetupNotApplied();
        }
        emit ContributorProjectLaunched(msg.sender, dao, budget, p.salt, p.projectId);
    }

    /// @dev The DAO's Shares clone: the minimal proxy of the Shares implementation, made by the DAO with CREATE2 and
    /// the DAO's own address as salt (`Moloch.init`).
    function _predictShares(address dao) internal view returns (address) {
        bytes memory proxy = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73", sharesImplementation, hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        return _create2(dao, bytes32(bytes20(dao)), keccak256(proxy));
    }

    function _create2(address deployer, bytes32 salt, bytes32 initcodeHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initcodeHash)))));
    }

    function _holders(address founder, uint256 founderShares)
        private
        pure
        returns (address[] memory holders, uint256[] memory amounts)
    {
        holders = new address[](1);
        holders[0] = founder;
        amounts = new uint256[](1);
        amounts[0] = founderShares;
    }

    function _scopedSalt(address founder, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(founder, salt));
    }
}
