// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MerkleProof} from "oz5/utils/cryptography/MerkleProof.sol";
import {IVester} from "./Interfaces.sol";

/// @title EarlierGrants
/// @notice The earlier backers' claim (docs/next-version/STEP4-PLAN.md, section 3): Team Shares on a protected grant for
/// the people who backed project zero before this network. The list is ONE fingerprint, a Merkle root over rows of (index,
/// account, amount); the rows are not in this contract or in the repository. A claimant claims their own row with a proof
/// and, in the same call, names the fingerprint of the text they accept; the acceptance is recorded here and in the event.
///  - a row can be claimed once (a bitmap by index), and only by the account named in the row (the sender is in the leaf);
///  - the claim makes one protected grant in the project's Vester out of a reserve minted at birth for this purpose: calendar
///    vesting over 365 days from the project's birth, no cliff, never forfeited, trimmed or burned;
///  - unclaimed rows stay claimable: there is no end time, no sweep and no admin, and a claim after a wind-down still works;
///  - it holds no dollars, takes no payment, has no fee, no vote, no call into the Treasury and no owner.
/// The text is an opaque 32-byte fingerprint: a new text is a new fingerprint and a new contract. The text itself, the
/// consent wording and the list are not here and are not decided here.
/// @dev One per deployment, not a clone. Inert until the Launcher binds it to the Vester of the one project it funds.
contract EarlierGrants {
    /// @notice The most the pool may hold: 1,000,000,000 Shares (ten times the founder's Team pool limit).
    uint256 public constant MAX_EARLIER_POOL = 1_000_000_000e18;
    /// @notice The smallest row: one whole Team Share, the Vester's `MIN_GRANT` (a smaller row could never be granted).
    uint256 public constant MIN_ROW = 1e18;
    /// @notice The deepest proof a claim accepts.
    uint256 public constant MAX_PROOF = 32;

    /// @notice The Launcher this contract serves; it alone may bind it.
    address public immutable launcher;
    /// @notice The fingerprint of the list: a Merkle root over `keccak256(keccak256(abi.encode(index, account, amount)))`.
    bytes32 public immutable root;
    /// @notice The fingerprint of the text a claimant accepts.
    bytes32 public immutable textHash;
    /// @notice The pool in Team Share wei: the most all rows can claim together.
    uint256 public immutable total;
    /// @notice The number of rows; an index is below it.
    uint32 public immutable rows;
    /// @notice The key of the one project (`Launcher.keyOf(founder, projectId)`) whose Team pool carries this reserve.
    bytes32 public immutable key;

    /// @notice The project's Vester, once bound; zero until then.
    IVester public vester;
    /// @notice How many rows were claimed.
    uint32 public claimedRows;
    /// @notice Team Share wei claimed so far; never more than `total`.
    uint256 public claimedTotal;
    /// @notice When an account first accepted the text (its first claim); zero for an account that has not claimed.
    mapping(address => uint64) public acceptedAt;
    /// @dev One bit per row index: claimed.
    mapping(uint256 => uint256) private _claimed;

    /// @notice The claim contract was tied to the project's Vester.
    event Bound(address vester);
    /// @notice Row `index` was claimed by `account`: a protected grant of `amount` Team Shares was made (`grantId`), the
    /// account accepted the text with fingerprint `textHash`, and the totals after.
    event Claimed(
        uint256 indexed index,
        address indexed account,
        uint256 amount,
        uint256 grantId,
        bytes32 textHash,
        uint32 claimedRows,
        uint256 claimedTotal
    );

    /// @notice Only the Launcher may do this.
    error NotLauncher();
    /// @notice The claim contract is not tied to a project yet (or it already is).
    error NotBound();
    /// @notice It was already tied to a Vester.
    error AlreadyBound();
    /// @notice The text the caller named is not the one this contract was made for.
    error WrongText();
    /// @notice The index is not below the number of rows, or the proof is deeper than 32.
    error BadRow();
    /// @notice The row was claimed already.
    error AlreadyClaimed();
    /// @notice The proof does not tie (index, sender, amount) to the list.
    error BadProof();
    /// @notice The row is smaller than one whole Team Share, which can never be granted.
    error RowTooSmall();
    /// @notice The rows claimed would pass the pool.
    error OverPool();
    /// @notice A setting is zero or past its limit.
    error BadSettings();

    /// @param launcher_ The Launcher this serves (it checks the address when the claim contract is bound to it).
    /// @param root_ The list's fingerprint.
    /// @param textHash_ The text's fingerprint.
    /// @param total_ The pool in Team Share wei.
    /// @param rows_ The number of rows.
    /// @param key_ The project (`Launcher.keyOf(founder, projectId)`) that carries the pool.
    constructor(address launcher_, bytes32 root_, bytes32 textHash_, uint256 total_, uint32 rows_, bytes32 key_) {
        if (
            launcher_ == address(0) || root_ == bytes32(0) || textHash_ == bytes32(0) || total_ == 0
                || total_ > MAX_EARLIER_POOL || rows_ == 0 || key_ == bytes32(0)
        ) revert BadSettings();
        (launcher, root, textHash, total, rows, key) = (launcher_, root_, textHash_, total_, rows_, key_);
    }

    /// @notice Tie the claim contract to the project's Vester, once. Only the Launcher, in the launch transaction of the
    /// project named by `key`; from then on claims work.
    /// @param vester_ The project's Vester.
    function bind(address vester_) external {
        if (msg.sender != launcher) revert NotLauncher();
        if (address(vester) != address(0)) revert AlreadyBound();
        if (vester_ == address(0)) revert BadSettings();
        vester = IVester(vester_);
        emit Bound(vester_);
    }

    /// @notice Claim your row: a protected grant of `amount` Team Shares for the caller. The caller names, in
    /// `acceptedText`, the fingerprint of the text they accept; the acceptance is recorded. Only the account in the row can
    /// claim it, once. Checks, in this order: the contract is bound; the text; the row's index and the proof's depth; not
    /// claimed before; the proof; the row is at least one whole Team Share; the pool.
    /// @param index The row's index in the list.
    /// @param amount The row's amount in Team Share wei.
    /// @param proof The Merkle proof of the row.
    /// @param acceptedText The fingerprint of the text the caller accepts; it must equal `textHash`.
    /// @return grantId The id of the protected grant in the Vester.
    function claim(uint256 index, uint256 amount, bytes32[] calldata proof, bytes32 acceptedText)
        external
        returns (uint256 grantId)
    {
        IVester v = vester;
        if (address(v) == address(0)) revert NotBound();
        if (acceptedText != textHash) revert WrongText();
        if (index >= rows || proof.length > MAX_PROOF) revert BadRow();
        uint256 word = index >> 8;
        uint256 bit = 1 << (index & 255);
        uint256 seen = _claimed[word];
        if (seen & bit != 0) revert AlreadyClaimed();
        // the double hash keeps an inner node of the tree from ever passing as a row
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, msg.sender, amount))));
        if (!MerkleProof.verifyCalldata(proof, root, leaf)) revert BadProof();
        if (amount < MIN_ROW) revert RowTooSmall();
        uint256 sum = claimedTotal + amount;
        if (sum > total) revert OverPool();

        _claimed[word] = seen | bit;
        claimedTotal = sum;
        uint32 count = claimedRows + 1;
        claimedRows = count;
        if (acceptedAt[msg.sender] == 0) acceptedAt[msg.sender] = uint64(block.timestamp);
        grantId = v.grant(msg.sender, amount, true);
        emit Claimed(index, msg.sender, amount, grantId, acceptedText, count, sum);
    }

    /// @notice Whether row `index` was claimed.
    function isClaimed(uint256 index) external view returns (bool) {
        return _claimed[index >> 8] & (1 << (index & 255)) != 0;
    }

    /// @notice The fingerprint `who` accepted: `textHash` for an account that has claimed, zero for one that has not. There
    /// is one text for the life of the contract, so it is never overwritten.
    function acceptedText(address who) external view returns (bytes32) {
        return acceptedAt[who] == 0 ? bytes32(0) : textHash;
    }
}
