// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title OrgAllowance — per-agent spend allowances that ENFORCE where money moves.
///
/// @notice The ceiling and the payout path live in one contract (docs/dao-os.md
/// R3). `spendTo` debits an agent's allowance for (subject, token, epoch) and
/// THEN moves the tokens with `transferFrom(treasury, to, amount)`: the treasury
/// approves this contract for the token (its ERC-20 allowance is the second,
/// outer cap) and gives the agent's spender key NOTHING else — the spender can
/// move money only through `spendTo`, only up to the ledger, only for epochs that
/// have begun. A bare ledger cannot say that: the treasury key (or any key that
/// holds the funds) can always pay out without calling it.
///
/// `spend` is kept for accounting-only callers and is ADVISORY: it records
/// consumption but moves no tokens, so nothing stops the holder of the funds
/// from paying out without it. Surfaces must label anything settled through
/// `spend` as advisory and anything settled through `spendTo` as enforced.
///
/// Ownership is a single address (`owner`, the deployer = the community owner in
/// dev; DAO governance after the NIP-ORG onchain binding upgrade, docs/nips/
/// NIP-ORG.md "Opt-in onchain binding": `budgets` map to treasury allowances).
/// `setOwner` is a plain owner-only transfer; a two-step handover is left to
/// the DAO-bound upgrade.
///
/// @dev Subject identity: `subject` is the agent's 32-byte Nostr pubkey,
/// VERBATIM — no keccak hashing, no truncation. It is used directly as a
/// mapping key so Nostr bytes and chain state agree byte-for-byte.
///
/// @dev Epoch mapping: `epoch = uint64(unix_ts / epochSeconds)` with
/// `epochSeconds` per subject (owner-set, default 86400 = day; the relay's
/// budget windows are 86_400 / 604_800 / 2_592_000). A spend may name the
/// CURRENT epoch or an earlier one, never one that has not begun: an agent
/// cannot pre-spend allowance the owner staged for a future window. Unspent
/// allowance of a past epoch stays spendable (carry-over) until the owner
/// reduces it. Changing a subject's `epochSeconds` re-bases its epoch numbers.
contract OrgAllowance {
    using SafeTransferLib for address;

    /// @notice Epoch length used for a subject whose `epochSecondsOf` is unset.
    uint64 public constant DEFAULT_EPOCH_SECONDS = 86_400;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    /// @notice Community owner. The deployer in dev; DAO governance after the
    /// NIP-ORG onchain binding upgrade.
    address public owner;

    /// @notice The custody address `spendTo` pays from. It must have approved
    /// this contract for each token it lets agents spend. Owner-set;
    /// address(0) disables `spendTo`.
    address public treasury;

    /// @notice Epoch length in seconds per subject (0 = `DEFAULT_EPOCH_SECONDS`).
    mapping(bytes32 subject => uint64 seconds_) public epochSecondsOf;

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
    /// @notice Emitted by `spendTo` in addition to `Spent`: tokens actually moved.
    event SpentTo(bytes32 indexed subject, address indexed token, uint64 indexed epoch, uint256 amount, address to);
    event TreasurySet(address indexed previousTreasury, address indexed newTreasury);
    event EpochSecondsSet(bytes32 indexed subject, uint64 epochSeconds);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner(address caller);
    error NotSpender(address caller, bytes32 subject);
    error OverSpend(uint256 requested, uint256 remaining);
    error BelowSpent(uint256 newAllowance, uint256 spent);
    error ZeroAddress();
    /// @notice The epoch has not begun yet (`epoch > block.timestamp / epochSeconds`).
    error FutureEpoch(uint64 epoch, uint64 currentEpoch);
    /// @notice `spendTo` needs an owner-set treasury.
    error TreasuryNotSet();
    /// @notice `spendTo` cannot pay a zero recipient or the native token.
    error BadRecipient(address to);
    error BadToken(address token);
    error BadEpochSeconds(uint64 epochSeconds);

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
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerSet(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Set the custody address `spendTo` pays from (the treasury that
    /// approves this contract). address(0) disables `spendTo`.
    function setTreasury(address newTreasury) external onlyOwner {
        emit TreasurySet(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Set a subject's epoch length. 0 is refused (unset falls back to
    /// `DEFAULT_EPOCH_SECONDS`; to return to the default pass 86400).
    function setEpochSeconds(bytes32 subject, uint64 epochSeconds) external onlyOwner {
        if (epochSeconds == 0) revert BadEpochSeconds(epochSeconds);
        epochSecondsOf[subject] = epochSeconds;
        emit EpochSecondsSet(subject, epochSeconds);
    }

    /// @notice Authorize `spender` for `subject`. The harness backend EVM key
    /// in dev. Pass address(0) to revoke.
    function setSpender(bytes32 subject, address spender) external onlyOwner {
        spenderOf[subject] = spender;
        emit SpenderSet(subject, spender);
    }

    /// @notice Set (or replace) the allowance for (subject, token, epoch).
    /// Replaces any previous value but never below what was already spent
    /// (`BelowSpent`) — otherwise `remaining = allowance - spent` would
    /// underflow and the ledger would lie about what the agent may still do.
    function setAllowance(bytes32 subject, address token, uint64 epoch, uint256 amount) external onlyOwner {
        uint256 spent = _spent[subject][token][epoch];
        if (amount < spent) revert BelowSpent(amount, spent);
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
    /// ADVISORY / ACCOUNTING ONLY: moves no tokens, so it enforces nothing on
    /// whoever holds the funds. Enforced payouts go through `spendTo`. Only the
    /// subject's authorized spender may call, and only for an epoch that has
    /// begun.
    function spend(bytes32 subject, address token, uint64 epoch, uint256 amount) external onlySpenderOf(subject) {
        _debit(subject, token, epoch, amount);
        emit Spent(subject, token, epoch, amount, msg.sender);
    }

    /// @notice ENFORCED payout: debit the allowance, then move `amount` of
    /// `token` from `treasury` to `to` (`transferFrom(treasury, to, amount)`).
    /// Reverts as a whole — ledger and transfer together — if the treasury has
    /// not approved this contract for `amount`, lacks the balance, or the
    /// allowance is exhausted. Only the subject's authorized spender may call.
    function spendTo(bytes32 subject, address token, uint64 epoch, uint256 amount, address to)
        external
        onlySpenderOf(subject)
    {
        address from = treasury;
        if (from == address(0)) revert TreasuryNotSet();
        if (to == address(0)) revert BadRecipient(to);
        if (token == address(0)) revert BadToken(token);
        // Effects before the external call (the token may call back).
        _debit(subject, token, epoch, amount);
        token.safeTransferFrom(from, to, amount);
        emit Spent(subject, token, epoch, amount, msg.sender);
        emit SpentTo(subject, token, epoch, amount, to);
    }

    /// @dev Shared ledger debit: epoch must have begun, amount within remaining.
    function _debit(bytes32 subject, address token, uint64 epoch, uint256 amount) internal {
        uint64 current = currentEpoch(subject);
        if (epoch > current) revert FutureEpoch(epoch, current);
        uint256 remaining = _allowance[subject][token][epoch] - _spent[subject][token][epoch];
        if (amount > remaining) revert OverSpend(amount, remaining);
        _spent[subject][token][epoch] += amount;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice The epoch a spend may name at most: `block.timestamp / epochSeconds`.
    function currentEpoch(bytes32 subject) public view returns (uint64) {
        uint64 len = epochSecondsOf[subject];
        return uint64(block.timestamp / (len == 0 ? DEFAULT_EPOCH_SECONDS : len));
    }

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
