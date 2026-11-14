// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Shares, Summoner} from "./majeur/MolochPatched.sol";
import {ISecondaryPolicy} from "./interfaces/ISecondaryPolicy.sol";
import {IMarketShareToken, SecondaryMarket} from "./SecondaryMarket.sol";

/// @notice What the factory reads from a candidate DAO. Addresses, not named types, so no DAO surface
/// is imported into the listing flow.
interface IProvenanceMoloch {
    function shares() external view returns (address);
    function votingWeight() external view returns (address);
}

/// @notice What the factory reads from a candidate DAO's voting policy: which shared mandate factory it
/// was born from (a policy whose real `mandateFactory` is the pinned one).
interface IProvenancePolicy {
    function mandateFactory() external view returns (address);
}

/// @title SecondaryMarketFactory
/// @notice The one creator of every `SecondaryMarket`. The kit deploys this factory at birth with the
/// summoner it will use, and only that kit can open markets. Every market for a DAO is predicted with
/// CREATE2 before the token exists, so the DAO can install the market as its Shares' birth
/// `transferExempt` endpoint in the very transaction that makes the token, and the factory's `create`
/// afterwards verifies the whole binding against live state — not against a set of mutually consistent
/// untrusted getters:
///
/// - the "DAO" must be a clone whose runtime bytecode is byte-for-byte the pinned summoner's Moloch
///   implementation's proxy (any such clone may only ever be initialized by that summoner, whose
///   authority is baked into the implementation it came from, so no fake DAO can pass);
/// - its Shares must be exactly the Shares clone the DAO deploys at its own init (the knit bytecode,
///   deployed by the DAO itself at its own birth salt), and the token's `DAO` must be the DAO;
/// - its policy must be the one the DAO was born with, must name this DAO as its own, must name the
///   predicted market as its one market, and must come from the summoner's actual pinned mandate factory;
/// - the quote must be real code; the lot size is checked inside its market; and everything is frozen
///   by the market's own immutable constructor arguments only after all of the above revert first.
///
/// There is no upgrade path, no admin, and no second market per DAO: `marketOf` is written exactly once.
/// The factory holds nothing, owns nothing, and after `create` has no power over what it made.
contract SecondaryMarketFactory {
    /// @notice The exact kit that is allowed to list: set explicitly at construction (the deployer
    /// predicts the kit's address first, so this is a fixed anchor with no deployer rights attached).
    address public immutable authorizedKit;
    /// @notice The pinned summoner every DAO listed through this factory came from.
    Summoner public immutable summoner;
    /// @notice The Moloch implementation this summoner clones; a listed DAO's runtime must be its proxy.
    address public immutable molochImplementation;
    /// @notice The exact runtime bytecode of that proxy, hashed at construction to compare against a
    /// candidate DAO's own code.
    bytes32 public immutable daoRuntimeHash;
    /// @notice The Shares implementation every DAO of the pinned summoner clones (made by its Moloch
    /// implementation's own CREATE2), so a candidate token can be checked against its birth prediction.
    address public immutable sharesImplementation;
    /// @notice Each listed DAO's one market, written once at creation. `mandateFactory.daos` maps
    /// mandates, not DAOs — this is the actual registry.
    mapping(address => address) public marketOf;

    event MarketCreated(
        address indexed dao,
        address indexed market,
        address indexed sharesToken,
        ISecondaryPolicy policy,
        IERC20 quote,
        uint256 lotSize
    );

    error InvalidSetup();
    error NotAuthorizedKit();
    error AlreadyListed(address dao);
    error UnprovenDao();
    error UnprovenShares();
    error UnprovenPolicy();
    error UnprovenQuote();

    constructor(Summoner pinnedSummoner, address authorizedKit_) {
        if (address(pinnedSummoner).code.length == 0) revert InvalidSetup();
        // The trusted kit is an explicit, nonzero fixture the deployer chooses before deploying this
        // factory: the deployer predicts the kit's own address first, so nothing mutable binds them,
        // no deployer right survives, and one EIP-3860-small factory + one big kit stay two separate
        // deployments with the launch as atomic as ever.
        if (authorizedKit_ == address(0)) revert InvalidSetup();
        authorizedKit = authorizedKit_;
        summoner = pinnedSummoner;
        molochImplementation = address(pinnedSummoner.getImplementation());
        daoRuntimeHash = _proxyHash(molochImplementation);
        sharesImplementation = _create2(
            molochImplementation, bytes32(bytes20(molochImplementation)), keccak256(type(Shares).creationCode)
        );
        if (molochImplementation.code.length == 0 || sharesImplementation.code.length == 0) revert InvalidSetup();
        if (address(pinnedSummoner.mandateFactory()).code.length == 0) revert InvalidSetup();
    }

    /// @notice The address a market for these exact bindings will get: a CREATE2 by this factory whose
    /// salt covers all five of them, so a different argument is a different market, once, per set. The
    /// kit calls this before anything exists, to install the address as the Shares' birth exemption.
    function predict(address dao, address sharesToken, address policy, address quote, uint256 lotSize)
        public
        view
        returns (address)
    {
        return _create2(
            address(this),
            _salt(dao, sharesToken, policy, quote, lotSize),
            _initcodeHash(dao, sharesToken, policy, quote, lotSize)
        );
    }

    function _salt(address dao, address sharesToken, address policy, address quote, uint256 lotSize)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(dao, sharesToken, policy, quote, lotSize));
    }

    function _initcodeHash(address dao, address sharesToken, address policy, address quote, uint256 lotSize)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(type(SecondaryMarket).creationCode, abi.encode(dao, sharesToken, policy, quote, lotSize))
        );
    }

    /// @notice Create the one market for `dao`, after every binding is proved against the pinned
    /// summoner and read back from live state. Only `authorizedKit` may call.
    function create(address dao, address sharesToken, ISecondaryPolicy policy, IERC20 quote, uint256 lotSize)
        external
        returns (SecondaryMarket market)
    {
        if (msg.sender != authorizedKit) revert NotAuthorizedKit();
        if (marketOf[dao] != address(0)) revert AlreadyListed(dao);
        _prove(dao, sharesToken, policy, quote, lotSize);
        market = new SecondaryMarket{salt: _salt(dao, sharesToken, address(policy), address(quote), lotSize)}(
            dao, sharesToken, policy, quote, lotSize
        );
        // The market's constructor already refuses a token whose archive exemption is not itself; this
        // read-back makes the kit's install-anywhere assumption stand on live state.
        if (IMarketShareToken(sharesToken).transferExempt() != address(market)) revert UnprovenShares();
        marketOf[dao] = address(market);
        emit MarketCreated(dao, address(market), sharesToken, policy, quote, lotSize);
    }

    // ---- provenance -----------------------------------------------------------------------------------------------

    /// @dev Every listed fact checked from live state, against the pinned values, or the whole creation
    /// reverts. The DAO's runtime-bytecode pin settles provenance by itself: only the pinned summoner
    /// ever initializes such clones, including their Shares clones, never the caller's tricks.
    function _prove(address dao, address sharesToken, ISecondaryPolicy policy, IERC20 quote, uint256 lotSize)
        private
        view
    {
        // Exact-type checks first: code, bounds; then pins that depend on the full argument set.
        if (_codeHash(dao) != daoRuntimeHash) revert UnprovenDao();
        if (address(quote).code.length == 0) revert UnprovenQuote();
        if (lotSize == 0 || lotSize > type(uint128).max) revert InvalidSetup();
        if (IProvenanceMoloch(dao).shares() != sharesToken) revert UnprovenShares();
        if (IProvenanceMoloch(dao).votingWeight() != address(policy)) revert UnprovenPolicy();
        if (sharesToken != _predictedShares(dao)) revert UnprovenShares();
        if (IMarketShareToken(sharesToken).DAO() != dao) revert UnprovenShares();
        if (address(policy.dao()) != dao) revert UnprovenPolicy();
        if (address(policy.market()) != predict(dao, sharesToken, address(policy), address(quote), lotSize)) {
            revert UnprovenPolicy();
        }
        if (address(IProvenancePolicy(address(policy)).mandateFactory()) != address(summoner.mandateFactory())) {
            revert UnprovenPolicy();
        }
    }

    /// @dev A candidate token must be exactly the Shares clone the DAO deploys in its own init: the
    /// minimal proxy of the pinned Shares implementation, made by the DAO with CREATE2 and the DAO's
    /// own address as salt.
    function _predictedShares(address dao) private view returns (address) {
        bytes memory proxy = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73", sharesImplementation, hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        return _create2(dao, bytes32(bytes20(dao)), keccak256(proxy));
    }

    /// @notice The exact runtime bytecode of that proxy, hashed at construction to compare against a
    /// candidate DAO's own code. Two leading PUSH0s are part of the summoner's own clone layout, not a
    /// guess: the same bytes make the shares and policy clones, whose provenance the checks below pin.
    function _proxyHash(address implementation) private pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(hex"5f5f365f5f37365f73", bytes20(implementation), hex"5af43d5f5f3e6029573d5ffd5b3d5ff3")
        );
    }

    function _create2(address deployer, bytes32 salt, bytes32 initcodeHash) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initcodeHash)))));
    }

    function _codeHash(address a) private view returns (bytes32 h) {
        assembly ("memory-safe") {
            h := extcodehash(a)
        }
    }
}
