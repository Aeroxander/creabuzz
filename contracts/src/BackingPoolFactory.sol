// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Summoner} from "./majeur/MolochPatched.sol";
import {BackingPool} from "./BackingPool.sol";

/// @notice What the factory reads from a candidate DAO.
interface IBackingMoloch {
    function votingWeight() external view returns (address);
}

/// @title BackingPoolFactory
/// @notice Opens the one `BackingPool` a project can have (docs/v3-review/BACKING-POOL.md), with terms
/// fixed here at deployment so a founder chooses nothing. One call, no vote: a pool needs no power
/// over the DAO (it mints no Shares and moves none), so nothing has to be authorised by the DAO first.
///
/// Who may open a project's pool: the founder the DAO's own voting policy recorded at birth
/// (`ContributorKitV2` and later), the DAO itself (a vote, the only way for a project made by the
/// legacy kit, whose policy records no founder), or the one kit this factory was deployed for, which
/// opens the pool in the same transaction that makes the project. The DAO must be a clone the pinned
/// summoner made: its runtime bytecode is compared with that summoner's proxy, as
/// `SecondaryMarketFactory` does.
///
/// No owner, no admin, no upgrade: the terms, the quote token and the kit are immutable, and after
/// `open` the factory has no power over the pool it made.
contract BackingPoolFactory {
    /// @notice The summoner every project opened here came from.
    Summoner public immutable summoner;
    /// @notice The runtime bytecode hash of that summoner's DAO clones.
    bytes32 public immutable daoRuntimeHash;
    /// @notice What every pool of this factory is bought and paid out in.
    IERC20 public immutable quote;
    /// @notice The kit that may open a pool for a project it is making; zero for none.
    address public immutable authorizedKit;
    /// @notice Each project's one pool.
    mapping(address => address) public poolOf;
    /// @notice Every pool, in the order opened.
    address[] public pools;

    BackingPool.Params private _terms;

    /// @notice A project's pool was opened.
    event PoolOpened(address indexed dao, address indexed pool, address indexed founder, address openedBy);

    error InvalidSetup();
    error UnprovenDao();
    error AlreadyOpen(address pool);
    error NotAllowed();

    /// @param pinnedSummoner The summoner whose DAOs may open pools here.
    /// @param quote_ The quote token of every pool.
    /// @param terms_ The terms every pool gets. A pool's own constructor is what checks them, so bad terms make
    /// `open` revert and nothing else: the deploy script checks them before it deploys.
    /// @param authorizedKit_ The kit that may open pools for projects it makes, or zero.
    constructor(Summoner pinnedSummoner, IERC20 quote_, BackingPool.Params memory terms_, address authorizedKit_) {
        if (address(pinnedSummoner).code.length == 0 || address(quote_).code.length == 0) revert InvalidSetup();
        address implementation = pinnedSummoner.getImplementation();
        if (implementation.code.length == 0) revert InvalidSetup();
        summoner = pinnedSummoner;
        daoRuntimeHash = keccak256(
            abi.encodePacked(hex"5f5f365f5f37365f73", bytes20(implementation), hex"5af43d5f5f3e6029573d5ffd5b3d5ff3")
        );
        quote = quote_;
        authorizedKit = authorizedKit_;
        _terms = terms_;
    }

    /// @notice The terms every pool of this factory gets.
    function terms() external view returns (BackingPool.Params memory) {
        return _terms;
    }

    /// @notice How many pools this factory has opened.
    function poolCount() external view returns (uint256) {
        return pools.length;
    }

    /// @notice The founder a DAO's voting policy recorded at birth, or zero when it recorded none.
    function founderOf(address dao) public view returns (address founder) {
        address policy = IBackingMoloch(dao).votingWeight();
        (bool ok, bytes memory data) = policy.staticcall(abi.encodeWithSignature("secondaryConfiguration()"));
        if (ok && data.length == 6 * 32) (, founder,,,,) = abi.decode(data, (address, address, uint256, uint64, uint64, uint64));
    }

    /// @notice Open `dao`'s pool. Callable by the project's recorded founder, by the DAO, or by the
    /// authorised kit; once per project.
    /// @return pool The new pool.
    function open(address dao) external returns (BackingPool pool) {
        bytes32 codeHash;
        assembly ("memory-safe") {
            codeHash := extcodehash(dao)
        }
        if (codeHash != daoRuntimeHash) revert UnprovenDao();
        if (poolOf[dao] != address(0)) revert AlreadyOpen(poolOf[dao]);
        address founder = founderOf(dao);
        if (msg.sender != dao && msg.sender != founder && (authorizedKit == address(0) || msg.sender != authorizedKit))
        {
            revert NotAllowed();
        }
        pool = new BackingPool(dao, founder, quote, _terms);
        poolOf[dao] = address(pool);
        pools.push(address(pool));
        emit PoolOpened(dao, address(pool), founder, msg.sender);
    }
}
