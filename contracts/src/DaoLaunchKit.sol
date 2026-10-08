// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GraduationExecutor} from "./GraduationExecutor.sol";
import {ShareVesting} from "./ShareVesting.sol";

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
}

interface IKitDao {
    function shares() external view returns (address);
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

/// @title DaoLaunchKit
/// @notice One transaction that launches a project into a DAO it does not control: the founder's wallet never
/// holds the supply, the raise, or a payee role.
///
/// In a single call it
///  1. deploys a `ShareVesting` vault per team member (their allocation votes through a delegate but cannot be
///     ragequit until it vests: otherwise a founder could withdraw their percentage of the raise on day one);
///  2. deploys a `GraduationExecutor` it will run (it is the executor's launcher);
///  3. summons the DAO with the vaults, the executor and (for an allocation the DAO keeps itself) this kit as its only
///     initial holders, so the sale tranche is minted straight to the executor;
///  4. points the vaults at the DAO's Shares and the executor's payee at the DAO;
///  5. creates the auction on the canonical factory, binds the executor to it, and has the executor fund it.
///
/// Atomic: any failure reverts all of it, so there is no half-configured launch to recover. Every address it creates
/// is CREATE2 from `salt`, so a client can compute the executor (which the auction config must name as both
/// recipients) before sending.
///
/// The kit trusts nothing it is given beyond arithmetic: the auction config it is handed must name the predicted
/// executor as both recipients or `bindAuction` reverts; the DAO is born with default governance (14-day TTL and
/// 1-day timelock) plus the founder-chosen proposal threshold.
contract DaoLaunchKit {
    /// @notice Most vaults one launch may create.
    uint256 public constant MAX_TEAM = 16;

    IKitSummoner public immutable summoner;
    IKitAuctionFactory public immutable factory;

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
        uint64 vestCliff;
        uint64 vestDuration;
        /// Shares the DAO holds itself from the start: treasury, liquidity, milestones, community. They never vote
        /// (they are outside voting supply) and never count toward a member's ragequit share.
        uint256 daoShares;
        /// Shares minted to the executor for the auction.
        uint128 saleSupply;
        /// `abi.encode(AuctionParameters)` with the PREDICTED executor as tokensRecipient and fundsRecipient.
        bytes auctionConfig;
        bytes32 auctionSalt;
    }

    /// @notice Everything a client needs to follow the launch, in one event.
    event Launched(
        address indexed dao,
        address indexed launcher,
        address shares,
        address executor,
        address auction,
        address[] vaults,
        uint128 saleSupply
    );

    error EmptyLaunch();
    error TeamMismatch();
    error TooManyTeam();

    constructor(IKitSummoner summoner_, IKitAuctionFactory factory_) {
        require(address(summoner_).code.length != 0 && address(factory_).code.length != 0, "kit: no code");
        summoner = summoner_;
        factory = factory_;
    }

    /// @notice The executor's address for a launch `salt`, before anything is sent. The auction config must name it.
    function predictExecutor(bytes32 salt) public view returns (address) {
        return _create2(_executorSalt(salt), keccak256(_executorInitcode()));
    }

    /// @notice The vault address for team member `index` of a launch `salt`.
    function predictVault(bytes32 salt, uint256 index, address beneficiary, uint64 start, uint64 cliff, uint64 duration)
        external
        view
        returns (address)
    {
        return _create2(_vaultSalt(salt, index), keccak256(_vaultInitcode(beneficiary, start, cliff, duration)));
    }

    /// @notice The DAO address the summon will produce, given the launch's holders.
    function predictDao(bytes32 salt, address[] calldata holders, uint256[] calldata amounts)
        external
        view
        returns (address)
    {
        return _predictDao(salt, holders, amounts);
    }

    function launch(Params calldata p) external returns (address dao, address executor, address auction) {
        if (p.saleSupply == 0) revert EmptyLaunch();
        if (p.team.length != p.teamShares.length) revert TeamMismatch();
        if (p.team.length > MAX_TEAM) revert TooManyTeam();

        // 1 and 2. Vaults and the executor, each at a deterministic address.
        uint256 n = p.team.length;
        uint256 slots = n + (p.daoShares == 0 ? 1 : 2);
        address[] memory holders = new address[](slots);
        uint256[] memory amounts = new uint256[](slots);
        ShareVesting[] memory vaults = new ShareVesting[](n);
        address[] memory vaultAddresses = new address[](n);
        for (uint256 i; i < n; ++i) {
            vaults[i] = new ShareVesting{salt: _vaultSalt(p.salt, i)}(
                p.team[i], uint64(block.timestamp), p.vestCliff, p.vestDuration
            );
            vaultAddresses[i] = address(vaults[i]);
            holders[i] = vaultAddresses[i];
            amounts[i] = p.teamShares[i];
        }
        GraduationExecutor exec = new GraduationExecutor{salt: _executorSalt(p.salt)}(address(this), 0, 30 days);
        executor = address(exec);
        holders[n] = executor;
        amounts[n] = p.saleSupply;
        // The DAO's own allocation is minted to this kit for the length of the call (the DAO's address is not known
        // until the summon) and passed on the moment the DAO exists.
        if (p.daoShares != 0) {
            holders[n + 1] = address(this);
            amounts[n + 1] = p.daoShares;
        }

        // 3. The DAO. Its only initial holders are contracts this call just made, so nobody but the vaults
        //    and the executor holds a Share until the auction sells them.
        KitCall[] memory calls = new KitCall[](p.proposalThreshold == 0 ? 0 : 1);
        if (p.proposalThreshold != 0) {
            calls[0] = KitCall(
                _predictDao(p.salt, holders, amounts), 0, abi.encodeCall(IKitSetThreshold.setProposalThreshold, (p.proposalThreshold))
            );
        }
        dao = summoner.summon(p.name, p.symbol, p.uri, 500, true, address(0), p.salt, holders, amounts, calls);
        address shares = IKitDao(dao).shares();

        if (p.daoShares != 0) require(IKitErc20(shares).transfer(dao, p.daoShares), "kit: dao allocation");

        // 4. Wire the vaults and the payee.
        for (uint256 i; i < n; ++i) {
            vaults[i].init(shares);
        }
        exec.retargetTreasury(dao);

        // 5. The auction: created, bound and funded in the same call.
        auction = factory.create(shares, p.saleSupply, p.auctionConfig, p.auctionSalt);
        exec.bindAuction(auction);
        exec.fundAuction(auction, p.saleSupply);

        emit Launched(dao, msg.sender, shares, executor, auction, vaultAddresses, p.saleSupply);
    }

    // ---- address prediction ------------------------------------------------------------------

    function _executorSalt(bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(salt, "executor"));
    }

    function _vaultSalt(bytes32 salt, uint256 index) private pure returns (bytes32) {
        return keccak256(abi.encode(salt, "vault", index));
    }

    function _executorInitcode() private view returns (bytes memory) {
        return abi.encodePacked(type(GraduationExecutor).creationCode, abi.encode(address(this), uint16(0), uint64(30 days)));
    }

    function _vaultInitcode(address beneficiary, uint64 start, uint64 cliff, uint64 duration)
        private
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(type(ShareVesting).creationCode, abi.encode(beneficiary, start, cliff, duration));
    }

    function _create2(bytes32 salt, bytes32 initcodeHash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initcodeHash)))));
    }

    /// @dev Mirrors the Summoner's clone address: `keccak256(abi.encode(holders, shares, salt))` against the
    /// minimal-proxy initcode of its Moloch implementation (the same prediction `OrgBinding` makes).
    function _predictDao(bytes32 salt, address[] memory holders, uint256[] memory amounts) private view returns (address) {
        bytes32 create2Salt = keccak256(abi.encode(holders, amounts, salt));
        bytes memory creationCode = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73", summoner.getImplementation(), hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
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
