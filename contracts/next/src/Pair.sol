// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ITreasuryRunner} from "./Interfaces.sol";
import {RollingCap} from "./RollingCap.sol";

/// @title Pair
/// @notice The Team runner: a project run by two people. Either signer alone may check in and spend up to 500 dollars in any
/// 7 days (each signer has their own limit); everything else the runner can do (spend more, open a backing round or the
/// auction, give Shares, set agents, hand the seat on, wind down) needs both: one proposes the exact call, the other confirms
/// it and it runs. Calls go only to the project's Treasury or the Launcher.
/// @dev A clone per project, made by the Launcher when the second signer accepts (`Launcher.makePair`); its address commits to
/// the project and both signers, so the founder can offer the seat to it before it exists. `initialize` takes the seat in
/// the same transaction. No owner, no upgrade.
contract Pair {
    using RollingCap for RollingCap.Ring;

    /// @notice What one signer alone may spend in any 7 days: 500 dollars in raw units.
    uint256 public constant ALONE_CAP = 500e6;
    /// @notice The stretch the limit is counted over.
    uint256 public constant WINDOW = 7 days;
    /// @dev The window is cut into 7 parts: a spend counts for 7 to 8 days.
    uint256 private constant PARTS = 7;

    /// @notice The project's Treasury.
    ITreasuryRunner public treasury;
    /// @notice The Launcher (raises, wind down, "no market").
    address public launcher;
    /// @notice The first signer (the founder who offered the seat).
    address public first;
    /// @notice The second signer (who accepted).
    address public second;
    /// @notice Who proposed each pending call (keyed by `callId`); zero when none.
    mapping(bytes32 => address) public proposer;
    /// @notice Calls proposed so far; makes each proposal's id different.
    uint256 public nonce;

    mapping(address => RollingCap.Ring) private _spent;

    /// @notice A signer spent alone, inside their 7-day limit.
    event SpentAlone(address indexed by, address indexed to, uint256 amount);
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

    modifier onlySigner() {
        if (msg.sender != first && msg.sender != second) revert NotAllowed();
        _;
    }

    constructor() {
        launcher = address(1); // locks the implementation
    }

    /// @notice Set up the clone and take the runner seat the founder offered to this address. Only the Launcher, in
    /// `makePair`, which the second signer calls (that call is the acceptance).
    function initialize(ITreasuryRunner treasury_, address launcher_, address first_, address second_) external {
        if (launcher != address(0) || msg.sender != launcher_) revert BadSetup();
        if (first_ == address(0) || second_ == address(0) || first_ == second_) revert BadSetup();
        (treasury, launcher, first, second) = (treasury_, launcher_, first_, second_);
        treasury_.takeSeat();
    }

    /// @notice Spend from the project's `spendable` alone: at most 500 dollars in any 7 days for each signer.
    function spend(address to, uint256 amount) external onlySigner {
        _spent[msg.sender].consume(WINDOW, PARTS, ALONE_CAP, amount);
        treasury.spend(to, amount);
        emit SpentAlone(msg.sender, to, amount);
    }

    /// @notice Check in for the project. Either signer.
    function checkIn() external onlySigner {
        treasury.checkIn();
    }

    /// @notice Propose a call to the Treasury or the Launcher. It runs when the other signer confirms the same call.
    /// @return id The proposal's id (`callId(target, data, nonce)`).
    function propose(address target, bytes calldata data) external onlySigner returns (bytes32 id) {
        if (target != address(treasury) && target != launcher) revert BadTarget();
        uint256 n = nonce++;
        id = callId(target, data, n);
        proposer[id] = msg.sender;
        emit Proposed(id, msg.sender, target, data, n);
    }

    /// @notice Confirm the other signer's proposed call and run it. Reverts with the call's own error if it fails (the
    /// proposal then stays pending).
    function confirm(address target, bytes calldata data, uint256 n) external onlySigner returns (bytes memory result) {
        bytes32 id = callId(target, data, n);
        address by = proposer[id];
        if (by == address(0)) revert UnknownCall();
        if (by == msg.sender) revert NotAllowed();
        delete proposer[id];
        bool ok;
        (ok, result) = target.call(data);
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
        emit Cancelled(id);
    }

    /// @notice What `signer` has spent alone inside the current 7-day limit.
    function spentAlone(address signer) external view returns (uint256) {
        return _spent[signer].used(WINDOW, PARTS);
    }

    /// @notice The id of a proposal.
    function callId(address target, bytes calldata data, uint256 n) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), target, data, n));
    }
}
