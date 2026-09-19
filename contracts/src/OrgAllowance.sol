// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OrgAllowance — per-agent spend enforcement ledger for the Buzz org graph.
///
/// @notice This contract is the ENFORCEMENT LEDGER for agent spending inside a
/// community org graph (docs/nips/NIP-ORG.md): it records who may spend how
/// much, and what was actually spent. It deliberately does NOT custody or move
/// tokens. Actual token custody/transfers stay with the treasury EOA in dev;
/// the harness backend EVM key acts as the authorized spender and settles
/// transfers out-of-band against what this contract permits. This mirrors the
/// NIP-LP rule ("the chain is the ledger; Nostr is the record") one level up:
/// here the contract is the ledger of authority, the treasury holds the money.
///
/// /// DELIBERATE SIMPLIFICATION (dev-first):
/// - Ownership is a single EOA (`owner`, the deployer = the community owner in
///   dev). `setOwner` is a simple owner-only transfer; a two-step
///   (propose/accept) pattern is left to the DAO-bound upgrade.
/// - The DAO-bound upgrade replaces `owner` with DAO governance and moves
///   token custody onchain. Per docs/nips/NIP-ORG.md, "Opt-in onchain
///   binding": on binding, node `holders` map to DAO shares, `budgets` map to
///   treasury allowances (`setAllowance`/`spendAllowance`), and the exit
///   right is ragequit. This contract's `setAllowance`/`spend` surface is the
///   shape that upgrade binds to.
///
/// @dev Subject identity: `subject` is the agent's 32-byte Nostr pubkey,
/// VERBATIM — no keccak hashing, no truncation. It is used directly as a
/// mapping key so Nostr bytes and chain state agree byte-for-byte.
///
/// @dev Epoch mapping (documented contract; callers compute the uint64):
/// - day   epoch = uint64(unix_ts / 86400)
/// - week  epoch = uint64(unix_ts / 604800)
/// - month epoch = uint64(unix_ts / 2592000)  // fixed 30-day months, dev only
/// A governance-defined epoch counter (set by proposal, not derived from wall
/// time) is the DAO-bound upgrade path; callers must treat the epoch domain as
/// namespaced by the governance mode that minted it.
contract OrgAllowance {
    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    /// @notice Community owner. The deployer in dev; DAO governance after the
    /// NIP-ORG onchain binding upgrade.
    address public owner;

    /// @notice Authorized spender per subject. The dev harness backend EVM key.
    /// address(0) means "no spender authorized" — a subject with no spender
    /// can never spend, even with an open allowance.
    mapping(bytes32 subject => address spender) public spenderOf;

    /// @notice Allowance granted per (subject, token, epoch).
    mapping(bytes32 subject => mapping(address token => mapping(uint64 epoch => uint256 amount))) private _allowance;

    /// @notice Amount spent per (subject, token, epoch). Monotonically
    /// non-decreasing within an epoch.
    mapping(bytes32 subject => mapping(address token => mapping(uint64 epoch => uint256 amount))) private _spent;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event OwnerSet(address indexed previousOwner, address indexed newOwner);
    event SpenderSet(bytes32 indexed subject, address indexed spender);
    event AllowanceSet(bytes32 indexed subject, address indexed token, uint64 indexed epoch, uint256 amount);
    event Spent(bytes32 indexed subject, address indexed token, uint64 indexed epoch, uint256 amount, address spender);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner(address caller);
    error NotSpender(address caller, bytes32 subject);
    error OverSpend(uint256 requested, uint256 remaining);
    error BelowSpent(uint256 newAllowance, uint256 spent);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlySpenderOf(bytes32 subject) {
        if (spenderOf[subject] != msg.sender) revert NotSpender(msg.sender, subject);
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @notice Deploys with `msg.sender` as owner (the community owner in dev).
    constructor() {
        owner = msg.sender;
        emit OwnerSet(address(0), owner);
    }

    // ---------------------------------------------------------------------
    // Owner administration
    // ---------------------------------------------------------------------

    /// @notice Transfer ownership. Simple owner-only set (documented
    /// simplification; two-step handover is the DAO-upgrade's concern).
    function setOwner(address newOwner) external onlyOwner {
        emit OwnerSet(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Authorize `spender` for `subject`. The harness backend EVM key
    /// in dev. Pass address(0) to revoke.
    function setSpender(bytes32 subject, address spender) external onlyOwner {
        spenderOf[subject] = spender;
        emit SpenderSet(subject, spender);
    }

    /// @notice Set (or replace) the allowance for (subject, token, epoch).
    /// Replaces any previous value; to reduce an existing allowance below its
    /// current spend, see `decreaseAllowance` (which enforces the floor).
    function setAllowance(bytes32 subject, address token, uint64 epoch, uint256 amount) external onlyOwner {
        _allowance[subject][token][epoch] = amount;
        emit AllowanceSet(subject, token, epoch, amount);
    }

    /// @notice Reduce the allowance for (subject, token, epoch) by `amount`.
    /// Never allows the allowance to drop below what was already spent.
    function decreaseAllowance(bytes32 subject, address token, uint64 epoch, uint256 amount) external onlyOwner {
        uint256 current = _allowance[subject][token][epoch];
        uint256 spent = _spent[subject][token][epoch];
        uint256 reduced = current - amount; // reverts on underflow via checked math
        if (reduced < spent) revert BelowSpent(reduced, spent);
        _allowance[subject][token][epoch] = reduced;
        emit AllowanceSet(subject, token, epoch, reduced);
    }

    // ---------------------------------------------------------------------
    // Spend
    // ---------------------------------------------------------------------

    /// @notice Record a spend of `amount` against (subject, token, epoch).
    /// Only the subject's authorized spender may call. Records authority and
    /// consumption; does NOT transfer tokens (treasury EOA settles custody in
    /// dev — see the contract-level simplification note).
    function spend(bytes32 subject, address token, uint64 epoch, uint256 amount) external onlySpenderOf(subject) {
        uint256 remaining = _allowance[subject][token][epoch] - _spent[subject][token][epoch];
        if (amount > remaining) revert OverSpend(amount, remaining);
        _spent[subject][token][epoch] += amount;
        emit Spent(subject, token, epoch, amount, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function allowanceOf(bytes32 subject, address token, uint64 epoch) external view returns (uint256) {
        return _allowance[subject][token][epoch];
    }

    function spentOf(bytes32 subject, address token, uint64 epoch) external view returns (uint256) {
        return _spent[subject][token][epoch];
    }

    function remainingOf(bytes32 subject, address token, uint64 epoch) external view returns (uint256) {
        return _allowance[subject][token][epoch] - _spent[subject][token][epoch];
    }
}
