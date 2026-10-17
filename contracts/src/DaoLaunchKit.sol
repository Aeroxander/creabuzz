// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GraduationExecutor} from "./GraduationExecutor.sol";
import {MilestoneChallenge} from "./MilestoneChallenge.sol";
import {MilestoneLockFactory} from "./MilestoneLockFactory.sol";

/// @dev The one `Call` shape Majeur's `Summoner.summon` takes for its initialization calls.
struct KitCall {
    address target;
    uint256 value;
    bytes data;
}

interface IKitSummoner {
    function summon(
        string calldata orgName,
        string calldata orgSymbol,
        string calldata orgURI,
        uint16 quorumBps,
        bool ragequittable,
        address renderer,
        bytes32 salt,
        address[] calldata initHolders,
        uint256[] calldata initShares,
        KitCall[] calldata initCalls
    ) external payable returns (address dao);
    function getImplementation() external view returns (address);
    function mandateFactory() external view returns (address);
    function policyImplementation() external view returns (address);
}

interface IKitDao {
    function shares() external view returns (address);
    function votingWeight() external view returns (address);
}

interface IKitPolicy {
    function mandateFactory() external view returns (address);
    function setGovernanceStart(uint64 startBlock) external;
}

interface IKitAuction {
    function claimBlock() external view returns (uint64);
}

interface IKitMandateFactory {
    function createMilestonePanel(
        address currency,
        uint64 expires,
        address[] calldata reviewers,
        uint256 quorum,
        uint128 reviewerBond,
        address bondToken
    ) external returns (address mandate);
    function milestoneMandate(address dao) external view returns (address);
}

interface IKitLockFactory {
    function createPanelLock(
        bytes32 salt,
        address dao,
        address[] calldata team,
        uint256[] calldata totals,
        bytes32[] calldata checks,
        uint16[] calldata bps
    ) external returns (address lock);
    function createChallengeLock(
        bytes32 salt,
        address dao,
        address[] calldata team,
        uint256[] calldata totals,
        bytes32[] calldata checks,
        uint16[] calldata bps,
        MilestoneChallenge.Terms calldata terms
    ) external returns (address lock);
}

interface IKitErc20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IKitAuctionFactory {
    function create(address token, uint256 amount, bytes calldata configData, bytes32 salt)
        external
        returns (address auction);
}

interface IKitSetThreshold {
    function setProposalThreshold(uint96 v) external;
}

interface IKitLockable {
    function setLockGuard(address guard) external;
}

/// @title DaoLaunchKit
/// @notice One transaction that launches a project into a DAO it does not control: the founder's wallet never
/// holds the raise or a payee role.
///
/// In a single call it
///  1. deploys a `GraduationExecutor` it will run (it is the executor's launcher);
///  2. mints the team's Shares straight to the team (they vote from the first block) and, when the launch names
///     milestones, deploys a `MilestoneLock` that holds part of those Shares back: the locked part cannot be sold or
///     ragequit until a reviewed milestone unlocks it (and mints the founder a soulbound badge);
///  3. summons the DAO with the team, the executor and (for an allocation the DAO keeps itself) this kit as its only
///     initial holders, and, in the DAO's own initialization, points its Shares at the lock, so there is never a
///     moment when the founders' Shares are free, and names the panel that judges the milestones (reviewers, how many
///     must agree, their bond), so it is part of the terms the backers see before they buy and no later vote can swap
///     it for a friendlier one;
///  4. points the executor's payee at the DAO;
///  5. creates the auction on the canonical factory, binds the executor to it, and has the executor fund it.
///
/// Atomic: any failure reverts all of it, so there is no half-configured launch to recover. Every address it creates
/// is CREATE2 from the launcher's address and `salt`, so a client can compute the executor (which the auction config
/// must name as both recipients) before sending, and nobody else can use the same salt to take those addresses first.
///
/// The kit trusts nothing it is given beyond arithmetic: the auction config it is handed must name the predicted
/// executor as both recipients or `bindAuction` reverts, and the Shares address it predicts for the lock must be the
/// one the DAO really made or the whole launch reverts. The DAO is born with default governance (14-day TTL and
/// 1-day timelock) plus the founder-chosen proposal threshold.
contract DaoLaunchKit {
    /// @notice Most team members one launch may name.
    uint256 public constant MAX_TEAM = 16;

    IKitSummoner public immutable summoner;
    IKitAuctionFactory public immutable factory;
    /// @notice The Shares implementation the summoner's DAOs clone: the DAO's Shares address is computed from it, so
    /// the lock can be pointed at them in the DAO's own initialization.
    address public immutable sharesImplementation;
    /// @notice The work budget factory of the summoner's DAOs, where the milestone panel is named.
    IKitMandateFactory public immutable mandateFactory;
    /// @notice Makes the milestone locks (deployed by this kit's constructor, which has the room the kit's own code lacks).
    IKitLockFactory public immutable lockFactory;

    /// @notice How a challenge lock lets milestones through (see `MilestoneChallenge.Terms`; its earliest block is the
    /// sale's claim block, which the kit fills in).
    struct ChallengeTerms {
        uint64 window;
        uint64 votePeriod;
        uint64 clawback;
        uint16 minRejectBps;
        address bondToken;
        uint128 bond;
        uint128 deposit;
    }

    struct Params {
        string name;
        string symbol;
        string uri;
        /// Shares needed to open a proposal (zero lets any holder open one).
        uint96 proposalThreshold;
        /// Mixes into every CREATE2 address this launch creates. Reuse reverts.
        bytes32 salt;
        address[] team;
        uint256[] teamShares;
        /// The acceptance check of each milestone, in order; they unlock `milestoneBps` of every team member's
        /// Shares. Empty means the team's Shares are not locked.
        bytes32[] milestoneChecks;
        /// The part of each team member's Shares each milestone unlocks (they add up to at most 10,000; the rest is
        /// not locked at all).
        uint16[] milestoneBps;
        /// The panel that judges the milestones: who, how many must agree, and the bond each posts before judging (zero
        /// for none, with `bondToken` zero too). Required when there are milestones, and refused when there are none.
        /// None may be a team member whose Shares the lock holds back.
        address[] reviewers;
        uint256 reviewQuorum;
        uint128 reviewerBond;
        address bondToken;
        /// What the panel's claims are paid and staked in (the sale currency), and when its mandate ends (unix seconds):
        /// it must outlast the last milestone, because nothing can be unlocked once it has ended.
        address panelCurrency;
        uint64 panelExpires;
        /// Shares the DAO holds itself from the start: treasury, liquidity, milestones, community. They never vote
        /// (they are outside voting supply) and never count toward a member's ragequit share.
        uint256 daoShares;
        /// Shares minted to the executor for the auction.
        uint128 saleSupply;
        /// `abi.encode(AuctionParameters)` with the PREDICTED executor as tokensRecipient and fundsRecipient.
        bytes auctionConfig;
        bytes32 auctionSalt;
        /// The first block at which the DAO can open a proposal: the sale's claim block, which the kit checks against the
        /// auction. Until then the only electorate is the team, so nothing it passes can run before buyers can hold
        /// Shares and leave.
        uint64 governanceStartBlock;
    }

    /// @notice Everything a client needs to follow the launch, in one event.
    event Launched(
        address indexed dao,
        address indexed launcher,
        address shares,
        address executor,
        address auction,
        address lock,
        uint128 saleSupply
    );

    error EmptyLaunch();
    error TeamMismatch();
    error TooManyTeam();
    /// @notice Milestones need a panel to judge them, and a panel needs milestones to judge.
    error PanelMismatch();

    constructor(IKitSummoner summoner_, IKitAuctionFactory factory_, address sharesImplementation_) {
        require(
            address(summoner_).code.length != 0 && address(factory_).code.length != 0
                && sharesImplementation_.code.length != 0,
            "kit: no code"
        );
        summoner = summoner_;
        factory = factory_;
        sharesImplementation = sharesImplementation_;
        mandateFactory = IKitMandateFactory(summoner_.mandateFactory());
        require(address(mandateFactory).code.length != 0, "kit: no mandate factory");
        lockFactory = IKitLockFactory(address(new MilestoneLockFactory()));
    }

    /// @notice The executor's address for `launcher`'s launch `salt`, before anything is sent. The auction config must
    /// name it. The launcher is part of the address, so another wallet reusing a salt gets different addresses and
    /// cannot block this launch by deploying first.
    function predictExecutor(address launcher, bytes32 salt) public view returns (address) {
        return _create2(_executorSalt(launcher, salt), keccak256(_executorInitcode()));
    }

    /// @notice The DAO address the summon will produce, given the launch's holders.
    function predictDao(bytes32 salt, address[] calldata holders, uint256[] calldata amounts)
        external
        view
        returns (address)
    {
        return _predictDao(salt, holders, amounts);
    }

    /// @notice Launch with a panel that judges the milestones (`p.reviewers` and friends).
    function launch(Params calldata p) external returns (address dao, address executor, address auction) {
        ChallengeTerms memory none;
        return _launch(p, none, false);
    }

    /// @notice Launch with milestones that unlock unless holders object (`MilestoneChallenge`): no panel, so `p.reviewers`
    /// and the rest of the panel fields must be empty. Needs milestones.
    function launchChallenged(Params calldata p, ChallengeTerms calldata c)
        external
        returns (address dao, address executor, address auction)
    {
        return _launch(p, c, true);
    }

    function _launch(Params calldata p, ChallengeTerms memory c, bool challenged)
        private
        returns (address dao, address executor, address auction)
    {
        if (p.saleSupply == 0) revert EmptyLaunch();
        if (p.team.length != p.teamShares.length) revert TeamMismatch();
        if (p.team.length > MAX_TEAM) revert TooManyTeam();

        // 1 and 2. The executor, and the holders the DAO is born with: the team (directly, so they vote at once),
        //    the executor, and this kit for the length of the call when the DAO keeps an allocation of its own.
        uint256 n = p.team.length;
        uint256 slots = n + (p.daoShares == 0 ? 1 : 2);
        address[] memory holders = new address[](slots);
        uint256[] memory amounts = new uint256[](slots);
        for (uint256 i; i < n; ++i) {
            holders[i] = p.team[i];
            amounts[i] = p.teamShares[i];
        }
        GraduationExecutor exec =
            new GraduationExecutor{salt: _executorSalt(msg.sender, p.salt)}(address(this), 0, 30 days);
        executor = address(exec);
        holders[n] = executor;
        amounts[n] = p.saleSupply;
        // The DAO's own allocation is minted to this kit for the length of the call (the DAO's address is not known
        // until the summon) and passed on the moment the DAO exists.
        if (p.daoShares != 0) {
            holders[n + 1] = address(this);
            amounts[n + 1] = p.daoShares;
        }
        address predictedDao = _predictDao(p.salt, holders, amounts);
        address predictedShares = _predictShares(predictedDao);

        // 3. The milestone lock, if the launch has milestones, and the DAO. The DAO points its own Shares at the lock
        //    while it is being born (its initialization calls run as the DAO), so the team's Shares are never free.
        address lock;
        if (n != 0 && p.milestoneChecks.length != 0) {
            lock = challenged
                ? lockFactory.createChallengeLock(
                    _lockSalt(msg.sender, p.salt),
                    predictedDao,
                    p.team,
                    p.teamShares,
                    p.milestoneChecks,
                    p.milestoneBps,
                    MilestoneChallenge.Terms(
                        c.window,
                        c.votePeriod,
                        c.clawback,
                        c.minRejectBps,
                        p.governanceStartBlock,
                        c.bondToken,
                        c.bond,
                        c.deposit
                    )
                )
                : lockFactory.createPanelLock(
                    _lockSalt(msg.sender, p.salt), predictedDao, p.team, p.teamShares, p.milestoneChecks, p.milestoneBps
                );
        }
        // Milestones and their panel go together, and a challenged launch has milestones and no panel.
        if (challenged) {
            if (lock == address(0) || p.reviewers.length != 0) revert PanelMismatch();
        } else if ((lock != address(0)) != (p.reviewers.length != 0)) {
            revert PanelMismatch();
        }
        // The lock, and then the panel (its reviewers are checked against the lock in the mandate's constructor).
        uint256 calls = 1 + (p.proposalThreshold == 0 ? 0 : 1) + (lock == address(0) ? 0 : (challenged ? 1 : 2));
        KitCall[] memory initCalls = new KitCall[](calls);
        uint256 next;
        // Governance opens when the buyers can hold their Shares. The DAO's voting policy is a clone made in its own
        // initialization, so its address is predicted the way the Shares' is.
        address predictedPolicy = _predictClone(predictedDao, summoner.policyImplementation());
        initCalls[next++] =
            KitCall(predictedPolicy, 0, abi.encodeCall(IKitPolicy.setGovernanceStart, (p.governanceStartBlock)));
        if (p.proposalThreshold != 0) {
            initCalls[next++] =
                KitCall(predictedDao, 0, abi.encodeCall(IKitSetThreshold.setProposalThreshold, (p.proposalThreshold)));
        }
        if (lock != address(0)) {
            initCalls[next++] = KitCall(predictedShares, 0, abi.encodeCall(IKitLockable.setLockGuard, (lock)));
            if (!challenged) {
                initCalls[next++] = KitCall(
                    address(mandateFactory),
                    0,
                    abi.encodeCall(
                        IKitMandateFactory.createMilestonePanel,
                        (p.panelCurrency, p.panelExpires, p.reviewers, p.reviewQuorum, p.reviewerBond, p.bondToken)
                    )
                );
            }
        }
        dao = summoner.summon(p.name, p.symbol, p.uri, 500, true, address(0), p.salt, holders, amounts, initCalls);
        // Fail closed: the addresses the lock and the guard were built on must be the ones that exist.
        require(dao == predictedDao, "kit: dao address");
        address shares = IKitDao(dao).shares();
        require(shares == predictedShares, "kit: shares address");
        // The factory the panel was named in is the one this DAO's own voting policy uses, or the lock would not honour it.
        require(IKitDao(dao).votingWeight() == predictedPolicy, "kit: policy address");
        require(IKitPolicy(IKitDao(dao).votingWeight()).mandateFactory() == address(mandateFactory), "kit: mandate factory");
        if (lock != address(0) && !challenged) {
            require(mandateFactory.milestoneMandate(dao) != address(0), "kit: milestone panel");
        }

        if (p.daoShares != 0) require(IKitErc20(shares).transfer(dao, p.daoShares), "kit: dao allocation");

        // 4. The payee.
        exec.retargetTreasury(dao);

        // 5. The auction: created, bound and funded in the same call.
        auction = factory.create(shares, p.saleSupply, p.auctionConfig, p.auctionSalt);
        exec.bindAuction(auction);
        exec.fundAuction(auction, p.saleSupply);
        // Fail closed: the block governance opens at is the block the buyers can claim from.
        require(IKitAuction(auction).claimBlock() == p.governanceStartBlock, "kit: governance start");

        emit Launched(dao, msg.sender, shares, executor, auction, lock, p.saleSupply);
    }

    // ---- address prediction ------------------------------------------------------------------

    function _executorSalt(address launcher, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(launcher, salt, "executor"));
    }

    function _lockSalt(address launcher, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(launcher, salt, "lock"));
    }

    function _executorInitcode() private view returns (bytes memory) {
        return
            abi.encodePacked(
                type(GraduationExecutor).creationCode, abi.encode(address(this), uint16(0), uint64(30 days))
            );
    }

    function _create2(bytes32 salt, bytes32 initcodeHash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initcodeHash)))));
    }

    /// @dev The DAO makes its Shares as a minimal-proxy clone of the Shares implementation, with CREATE2 from the DAO and
    /// a salt that is the DAO's own address; the same proxy code the summoner's DAOs use.
    function _predictShares(address dao) private view returns (address) {
        return _predictClone(dao, sharesImplementation);
    }

    /// @dev Any of the DAO's own clones (Shares, voting policy): the same proxy code, made with CREATE2 by the DAO.
    function _predictClone(address dao, address implementation) private pure returns (address) {
        bytes memory creationCode = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73", implementation, hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), dao, bytes32(bytes20(dao)), keccak256(creationCode))))
            )
        );
    }

    /// @dev Mirrors the Summoner's clone address: `keccak256(abi.encode(holders, shares, salt))` against the
    /// minimal-proxy initcode of its Moloch implementation (the same prediction `OrgBinding` makes).
    function _predictDao(bytes32 salt, address[] memory holders, uint256[] memory amounts)
        private
        view
        returns (address)
    {
        bytes32 create2Salt = keccak256(abi.encode(holders, amounts, salt));
        bytes memory creationCode = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73",
            summoner.getImplementation(),
            hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(summoner), create2Salt, keccak256(creationCode)))
                )
            )
        );
    }
}
