// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IShares} from "./Interfaces.sol";

/// @title Vester
/// @notice Holds the founder's Shares and every Share given before the pool opened, and releases them evenly over 365
/// days from the day the pool opens. Until then nothing is released. A beneficiary claims what has been released;
/// claimed Shares are free (they can be sold or handed back). Shares still in here are not in anyone's hands: the
/// treasury leaves them out when it counts holders for the exit right.
/// @dev One copy per project, a minimal clone created by the Launcher. Nothing here can move Shares anywhere but to the
/// beneficiary they were granted to, and only as fast as the schedule allows. There is no owner.
contract Vester {
    /// @notice Length of the release, in seconds (365 days).
    uint256 public constant DURATION = 365 days;

    /// @notice The project's Shares.
    IShares public shares;
    /// @notice The only address that may start the clock (the pool-open signal; the project's treasury).
    address public starter;
    /// @notice The only address that may add grants after birth (the project's treasury, for Give Shares).
    address public granter;
    /// @notice When the pool opened (second the release starts from); zero until then.
    uint256 public start;
    /// @notice Shares granted and not yet claimed, over all beneficiaries.
    uint256 public committed;

    struct Grant {
        uint256 total;
        uint256 claimed;
    }

    /// @notice What each beneficiary was granted and has claimed.
    mapping(address => Grant) public grants;

    /// @notice Shares were set aside for a beneficiary.
    event Granted(address indexed beneficiary, uint256 amount);
    /// @notice Released Shares were sent to the beneficiary.
    event Claimed(address indexed beneficiary, uint256 amount);
    /// @notice The release clock started.
    event Started(uint256 time);

    /// @notice Called twice, or on the locked implementation.
    error AlreadyInitialized();
    /// @notice The caller is not allowed to do this.
    error NotAllowed();
    /// @notice The clock already started (grants close then) or has not started (it can start once).
    error WrongPhase();
    /// @notice The Shares to cover a grant are not here.
    error NotFunded();
    /// @notice Zero beneficiary or zero amount.
    error BadGrant();

    constructor() {
        starter = address(1); // locks the implementation: no clone state is shared with it
    }

    /// @notice Set up the clone, once. The Launcher calls this in the transaction that creates it, after the Shares
    /// have been minted here, and the founder's grant is made in the same call.
    /// @param shares_ The project's ShareToken.
    /// @param starter_ Who may start the clock, once.
    /// @param granter_ Who may add grants before it starts.
    /// @param founder The founder, whose grant is `founderAmount`.
    /// @param founderAmount Shares granted to the founder; they must already be held here.
    function initialize(IShares shares_, address starter_, address granter_, address founder, uint256 founderAmount)
        external
    {
        if (starter != address(0)) revert AlreadyInitialized();
        (shares, starter, granter) = (shares_, starter_, granter_);
        _grant(founder, founderAmount);
    }

    /// @notice Start the release clock at this moment, once. After this no grant can be added.
    function startNow() external {
        if (msg.sender != starter) revert NotAllowed();
        if (start != 0) revert WrongPhase();
        start = block.timestamp;
        emit Started(block.timestamp);
    }

    /// @notice Set aside Shares for a beneficiary. Only before the clock starts, and only if the Shares are here.
    function grant(address beneficiary, uint256 amount) external {
        if (msg.sender != granter) revert NotAllowed();
        if (start != 0) revert WrongPhase();
        _grant(beneficiary, amount);
    }

    /// @notice How much of a beneficiary's grant has been released so far (claimed or not).
    function released(address beneficiary) public view returns (uint256) {
        uint256 s = start;
        if (s == 0) return 0;
        uint256 elapsed = block.timestamp - s;
        uint256 total = grants[beneficiary].total;
        return elapsed >= DURATION ? total : total * elapsed / DURATION;
    }

    /// @notice What the beneficiary can claim right now.
    function claimable(address beneficiary) public view returns (uint256) {
        return released(beneficiary) - grants[beneficiary].claimed;
    }

    /// @notice Send a beneficiary their released Shares. Anyone may call it; the Shares always go to the beneficiary.
    /// @return amount Shares sent.
    function claim(address beneficiary) external returns (uint256 amount) {
        amount = claimable(beneficiary);
        if (amount == 0) return 0;
        grants[beneficiary].claimed += amount;
        committed -= amount;
        if (!shares.transfer(beneficiary, amount)) revert NotFunded();
        emit Claimed(beneficiary, amount);
    }

    function _grant(address beneficiary, uint256 amount) private {
        if (beneficiary == address(0) || amount == 0) revert BadGrant();
        if (shares.balanceOf(address(this)) < committed + amount) revert NotFunded();
        grants[beneficiary].total += amount;
        committed += amount;
        emit Granted(beneficiary, amount);
    }
}
