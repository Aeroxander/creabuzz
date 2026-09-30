// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Call, Summoner} from "majeur/src/Moloch.sol";

/// @title OrgBinding — onchain record keeper for the NIP-ORG "Opt-in onchain
/// binding" of a community org root to a Moloch-family DAO.
///
/// @notice One call summons a majeur DAO with an initial member set and
/// records the binding under the org root's 32-byte Nostr event id
/// (`bytes32 rootId`). The binding record mirrors the signed kind:37010
/// update the CLI republishes with `content.onchain = {chain, dao, boundAt}`
/// (docs/nips/NIP-ORG.md). Per the NIP-LP rule ("the chain is the ledger;
/// Nostr is the record"): the 37010 event is the coordination record, this
/// contract's event log is the onchain ledger of what was bound, and clients
/// verify one against the other when money is at stake.
///
/// INTEGRATION SURFACE (vendored majeur, gitlink 7d7a36b):
/// - `lib/majeur/src/Moloch.sol` — `Summoner` (CREATE2 factory; deploys the
///   `Moloch` implementation in its constructor; `summon()` clones + `init()`s
///   a DAO, mints `initShares` to `initHolders`, then executes `initCalls`).
/// - `lib/majeur/src/peripheral/SafeSummoner.sol` — NOT used here: its
///   singletons (`SUMMONER`, `MOLOCH_IMPL`, `RENDERER`) are hardcoded to the
///   canonical CREATE2/3 addresses of supported chains, which do not exist on
///   a dev chain. We therefore deploy a fresh `Summoner` in this contract's
///   constructor. The preset governance defaults `summonFast` builds
///   (proposalThreshold = 1% of initial supply, 3-day TTL, 1-day timelock,
///   500 bps quorum, ragequit enabled) are reproduced by the caller via
///   [[SummonParams]].
/// - `lib/majeur/src/peripheral/MolochViewHelper.sol` — offchain read helper
///   for the DAO this contract binds; not needed onchain here.
///
/// DELIBERATE SIMPLIFICATIONS (dev-first, all documented):
/// - `bindDao`/`summonAndBind` are RECORDERS with a first-writer owner: the
///   FIRST caller for a `rootId` becomes its recorded `binderOf`, and from then
///   on only that binder OR the currently recorded DAO (acting through its own
///   governance, so a DAO can re-point itself) may rebind the root
///   (`NotBinder` otherwise). Before this, both functions were permissionless
///   last-write-wins: a stranger could overwrite any org's binding — and the
///   indexer-visible `DaoBound` — with one call. Residual limit, by design: the
///   contract cannot prove the first caller speaks for the org root (that
///   authority lives in the signed 37010 update the CLI verifies), so a
///   front-runner can still claim a root nobody has bound yet; readers must
///   confirm a binding against the signed 37010 head before trusting it.
/// - `initCalls` are pinned empty, so governance knobs stay at the Moloch
///   defaults (`proposalThreshold = 0`, no timelock/TTL changes). The
///   validated defaults `SafeSummoner._buildCalls` assembles (KF#11: a
///   nonzero proposal threshold, TTL > timelock, ...) are the production
///   tightening: pass them as `initCalls` or set them by proposal after
///   summon. Kept out here to keep the wrapper surface minimal.
/// - Re-binding the same `rootId` (by its binder or its DAO, above)
///   overwrites the record and emits a fresh `DaoBound` — matching NIP-33
///   last-write-wins semantics of the 37010 head it mirrors. Indexers must
///   treat the latest event per `rootId` as the live binding.
/// - Transferring `OrgAllowance` ownership to the DAO is orchestrated by the
///   deploy script (current owner calls `setOwner(dao)` after summon). The
///   production path is a governance proposal through the DAO; the atomic
///   tightening would pass the `setOwner` call as a `Summoner.summon`
///   `initCall`, which `Moloch.init` executes from the DAO's own context
///   before returning the dao address.
interface IMolochMetadata {
    function contractURI() external view returns (string memory);
}

contract OrgBinding {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Recorded binding for one org root.
    struct Binding {
        /// Bound majeur DAO (Moloch clone).
        address dao;
        /// Unix seconds when the binding was recorded.
        uint64 boundAt;
    }

    /// @notice Summon parameters, mirroring the tail of
    /// `Summoner.summon` (lib/majeur/src/Moloch.sol). `renderer` is pinned
    /// to `address(0)` (Moloch.init skips zero renderers) and `initCalls`
    /// to empty — a thin wrapper should not take on governance calls.
    struct SummonParams {
        string name;
        string symbol;
        string uri;
        /// Turnout quorum in bps (500 = 5%, the `summonFast` default).
        /// NOTE: `summonFast`'s other preset defaults (nonzero
        /// proposalThreshold, TTL/timelock) ride on `initCalls`, which this
        /// wrapper pins empty — see the contract-level notes.
        uint16 quorumBps;
        /// Exit right: members can ragequit with their treasury share.
        bool ragequittable;
        /// CREATE2 salt (compose with holders+shares by the factory).
        bytes32 salt;
        /// Initial human/agent seat holders (the 37010 root `holders`).
        address[] holders;
        /// Initial shares minted 1:1 (or weighted) onto `holders`.
        uint256[] shares;
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    /// @notice The majeur Summoner factory this contract summons through.
    /// Freshly deployed per OrgBinding (see NatSpec: why not SafeSummoner).
    Summoner public immutable summoner;

    /// @notice rootId (the org root's 32-byte Nostr event id) => binding.
    mapping(bytes32 rootId => Binding) public bindingOf;

    /// @notice rootId => the address that first bound it (the only non-DAO
    /// address that may rebind it). Kept beside `bindingOf` so that getter's
    /// `(dao, boundAt)` shape stays stable for indexers.
    mapping(bytes32 rootId => address) public binderOf;

    // ------------------------------------------------------------------
    // Events / Errors
    // ------------------------------------------------------------------

    /// @notice A DAO binding was recorded for org root `rootId`. The `uri` is
    ///         the DAO's `dao.json` document URL (ERC-4824 `DAOURIRegistered`
    ///         parity) — empty when the DAO predates the field or exposes
    ///         none; readers MUST treat empty as "unknown", never as a value.
    event DaoBound(bytes32 indexed rootId, address indexed dao, uint64 boundAt, string uri);

    /// @notice Emitted once per root, when its first caller becomes its binder.
    event BinderSet(bytes32 indexed rootId, address indexed binder);

    error EmptyHolders();
    error HoldersSharesMismatch();
    /// @notice A binding for this root exists and the caller is neither its
    /// recorded binder nor its recorded DAO.
    error NotBinder(bytes32 rootId, address caller);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor() {
        summoner = new Summoner();
    }

    // ------------------------------------------------------------------
    // Binding
    // ------------------------------------------------------------------

    /// @dev The first caller for `rootId` becomes its binder; afterwards only that
    /// binder or the recorded DAO may rebind.
    function _authorizeBind(bytes32 rootId) internal {
        address binder = binderOf[rootId];
        if (binder == address(0)) {
            binderOf[rootId] = msg.sender;
            emit BinderSet(rootId, msg.sender);
            return;
        }
        if (msg.sender != binder && msg.sender != bindingOf[rootId].dao) {
            revert NotBinder(rootId, msg.sender);
        }
    }

    /// @notice Summon a majeur DAO with the initial member set and record it
    /// as the binding of org root `rootId`, atomically in one transaction.
    /// @return dao The summoned Moloch clone (shares minted to `p.holders`).
    function summonAndBind(bytes32 rootId, SummonParams calldata p) external returns (address dao) {
        if (p.holders.length == 0) revert EmptyHolders();
        if (p.holders.length != p.shares.length) revert HoldersSharesMismatch();
        _authorizeBind(rootId);

        dao = address(
            summoner.summon(
                p.name,
                p.symbol,
                p.uri,
                p.quorumBps,
                p.ragequittable,
                address(0), // renderer: Moloch.init skips zero — SVG metadata is optional
                p.salt,
                p.holders,
                p.shares,
                new Call[](0) // no governance calls at genesis
            )
        );

        Binding memory b = Binding({dao: dao, boundAt: uint64(block.timestamp)});
        bindingOf[rootId] = b;
        emit DaoBound(rootId, dao, b.boundAt, p.uri);
    }

    /// @notice Record an EXISTING DAO as the binding of org root `rootId` —
    /// e.g. one summoned directly through the canonical Summoner on a
    /// supported chain, or through a governance proposal. Recording-only by
    /// design; see the contract-level simplification notes.
    function bindDao(bytes32 rootId, address dao) external {
        _authorizeBind(rootId);
        Binding memory b = Binding({dao: dao, boundAt: uint64(block.timestamp)});
        bindingOf[rootId] = b;
        // Best-effort read of the existing DAO's own metadata. The
        // `code.length` gate matters: Solidity's "non-contract return" check
        // is NOT catchable by try/catch (it fires in THIS frame), so EOAs
        // must skip the call entirely. A griefing *contract* target can only
        // revert calls that name it — self-harm on a recording-only path.
        string memory uri = "";
        if (dao.code.length > 0) {
            try IMolochMetadata(dao).contractURI() returns (string memory u) {
                uri = u;
            } catch {}
        }
        emit DaoBound(rootId, dao, b.boundAt, uri);
    }
}
