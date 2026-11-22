// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ITreasuryRunner} from "./Interfaces.sol";

/// @title Pair
/// @notice The Team runner: a project run by two people. Every call that moves money or changes a rule needs both: one
/// proposes the exact call, the other confirms it and it runs. Either signer alone may check in, and nothing else: there
/// is no one-signer way to spend, grant, set a rate or forfeit. Calls go only to the project's Treasury or the Launcher.
/// @dev A clone per project, made by the Launcher when the second signer accepts (`Launcher.makePair`); its address commits
/// to the project and both signers, so the founder can offer the seat to it before it exists. `initialize` takes the seat in
/// the same transaction. No owner, no upgrade. `bothSigned()` is true only while a confirmed proposal executes (the Treasury
/// reads it on every runner-only call), so a call that did not come through `confirm` can never pass for a signed one.
contract Pair {
    /// @notice The project's Treasury.
    ITreasuryRunner public treasury;
    /// @notice The Launcher (wind down).
    address public launcher;
    /// @notice The first signer (the founder who offered the seat).
    address public first;
    /// @notice The second signer (who accepted).
    address public second;
    /// @notice Who proposed each pending call (keyed by `callId`); zero when none.
    mapping(bytes32 => address) public proposer;
    /// @notice When each pending call was proposed (keyed by `callId`).
    mapping(bytes32 => uint256) public proposedAt;
    /// @notice A proposal can be confirmed for this long, then it is dead: old consent is not consent. Two time units of the
    /// project (14 days on a real network), read from the Treasury when the Pair is set up, so a test network with a short
    /// unit has short-lived proposals too.
    uint256 public PROPOSAL_TTL;
    /// @notice A proposal lives this many time units of the project.
    uint256 public constant PROPOSAL_UNITS = 2;
    /// @notice Calls proposed so far; makes each proposal's id different.
    uint256 public nonce;

    bool private transient _executing;

    /// @notice A signer proposed a call; it runs when the other signer confirms it.
    event Proposed(bytes32 indexed id, address indexed by, address target, bytes data, uint256 nonce);
    /// @notice Both signers agreed and the call ran.
    event Executed(bytes32 indexed id, address indexed confirmedBy);
    /// @notice The proposer withdrew a call.
    event Cancelled(bytes32 indexed id);

    /// @notice Set up twice, on the implementation, or with a missing or repeated signer.
    error BadSetup();
    /// @notice The caller is not a signer, or is the proposer confirming their own call.
    error NotAllowed();
    /// @notice Calls may go only to the Treasury or the Launcher.
    error BadTarget();
    /// @notice No such pending call.
    error UnknownCall();
    /// @notice The call was proposed more than `PROPOSAL_TTL` ago; propose it again.
    error Expired();
    /// @notice A call is already executing.
    error Reentrancy();

    modifier onlySigner() {
        if (msg.sender != first && msg.sender != second) revert NotAllowed();
        _;
    }

    constructor() {
        launcher = address(1); // locks the implementation
    }

    /// @notice Set up the clone and take the runner seat the founder offered to this address. The Launcher calls it in
    /// `makePair`, in the same transaction that creates the clone (that call is the second signer's acceptance), so nobody
    /// else can reach a clone before it is set up.
    function initialize(ITreasuryRunner treasury_, address launcher_, address first_, address second_) external {
        if (launcher != address(0)) revert BadSetup();
        if (first_ == address(0) || second_ == address(0) || first_ == second_) revert BadSetup();
        (treasury, launcher, first, second) = (treasury_, launcher_, first_, second_);
        PROPOSAL_TTL = PROPOSAL_UNITS * uint256(treasury_.unit());
        treasury_.takeSeat();
    }

    /// @notice True only while a proposal both signers agreed to is executing.
    function bothSigned() external view returns (bool) {
        return _executing;
    }

    /// @notice True for the two signers. The Treasury asks it to bar both from taking a task or being paid for one.
    function isSeat(address a) external view returns (bool) {
        return a == first || a == second;
    }

    /// @notice Check in for the project. Either signer, alone: the one thing a single signer may do.
    function checkIn(bytes32 recordHash) external onlySigner {
        treasury.checkIn(recordHash);
    }

    /// @notice Propose a call to the Treasury or the Launcher. It runs when the other signer confirms the same call.
    /// @return id The proposal's id (`callId(target, data, nonce)`).
    function propose(address target, bytes calldata data) external onlySigner returns (bytes32 id) {
        if (target != address(treasury) && target != launcher) revert BadTarget();
        uint256 n = nonce++;
        id = callId(target, data, n);
        proposer[id] = msg.sender;
        proposedAt[id] = block.timestamp;
        emit Proposed(id, msg.sender, target, data, n);
    }

    /// @notice Confirm the other signer's proposed call and run it. The call must be exactly the one proposed (the id
    /// commits to the target, the bytes and the proposal's number), and a proposal runs once, and only within `PROPOSAL_TTL` of being proposed. Reverts with the call's own
    /// error if it fails (the proposal then stays pending).
    function confirm(address target, bytes calldata data, uint256 n) external onlySigner returns (bytes memory result) {
        if (_executing) revert Reentrancy();
        bytes32 id = callId(target, data, n);
        address by = proposer[id];
        if (by == address(0)) revert UnknownCall();
        if (by == msg.sender) revert NotAllowed();
        if (block.timestamp > proposedAt[id] + PROPOSAL_TTL) revert Expired();
        delete proposer[id];
        delete proposedAt[id];
        _executing = true;
        bool ok;
        (ok, result) = target.call(data);
        _executing = false;
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
        emit Executed(id, msg.sender);
    }

    /// @notice Withdraw a call you proposed.
    function cancel(bytes32 id) external {
        if (proposer[id] != msg.sender) revert NotAllowed();
        delete proposer[id];
        delete proposedAt[id];
        emit Cancelled(id);
    }

    /// @notice The id of a proposal.
    function callId(address target, bytes calldata data, uint256 n) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), target, data, n));
    }
}
