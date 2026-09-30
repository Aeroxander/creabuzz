// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMolochMetadata {
    function contractURI() external view returns (string memory);
}

/// @title DaoURIAdapter
/// @notice The ERC-4824 surface for a bound DAO (OA.md/OAv2 Phase 3): the
///         standard's `daoURI()` getter over majeur's HALF-BUILT field.
///
///         Majeur's `setMetadata(name, symbol, uri)` already stores
///         `_orgURI` and `contractURI()` returns it — the ecosystem reached
///         for this slot and filled it with ERC-721 metadata. Phase 3 is a
///         shape upgrade, not a feature: the summon passes the DAO's
///         `dao.json` URL and this adapter exposes it under the standard's
///         name. **No new storage** — the slot was already there.
///
///         WHY THE ADAPTER IS REQUIRED (OAv2 §4.8, the DUNA category
///         error): with `renderer == address(0)` and an empty uri,
///         `contractURI()` falls through to majeur's DUNA operating-charter
///         renderer — a *Wyoming nonprofit* charter presented as the org's
///         own metadata. A commercial AO must never inherit that default. A
///         bound DAO either names its own wrapper in its `dao.json`
///         (jurisdiction + entity, `x-ao.personhoodClass`) or explicitly
///         says `none` — never someone else's charter by default.
contract DaoURIAdapter {
    event DAOURIUpdate(string newDaoUri);

    error ZeroAddress();

    /// The DAO this adapter fronts (immutable — one adapter per DAO).
    address public immutable dao;

    constructor(address dao_) {
        if (dao_ == address(0)) revert ZeroAddress();
        dao = dao_;
    }

    /// The standard's entry point: the URL of the recomputable document
    /// (`GET /dao.json` on the relay). Forwards to the DAO's own
    /// `contractURI()` — the half-built field, now in the right shape.
    function daoURI() external view returns (string memory) {
        return IMolochMetadata(dao).contractURI();
    }

    /// Anyone may announce that the document changed (indexer ping).
    /// Advisory by design: the bytes at `daoURI()` are recomputable from the
    /// signed event graph, so this event is a hint, never a trust anchor.
    function notifyUpdate(string calldata newDaoUri) external {
        emit DAOURIUpdate(newDaoUri);
    }
}
