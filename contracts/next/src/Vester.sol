// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IShares} from "./Interfaces.sol";

/// @title Vester
/// @notice Holds every Share handed out before a market: the founder's, Shares given before the market, Creaton's stake and
/// Shares bought in backing rounds. One clock releases all of them evenly over 365 days, starting the day the market opens or
/// the day the project declares "no market". Until then nothing is released. A beneficiary claims what has been released;
/// claimed Shares are free (they can be sold or handed back). Shares the schedule has not released yet are not in anyone's
/// hands: the treasury leaves exactly those out (`unreleased`) when it counts holders for the exit right.
///
/// Two kinds of grant:
///  - plain grants (`grants`), keyed by beneficiary: the founder's, gifts before the market, the stake. Added only by the
///    treasury and only before the clock starts;
///  - backer grants (`heldGrants`), keyed by round and backer: Shares bought in a backing round. Added only by the project's
///    Rounds contract, at any time (a backer settled after the market opened is on the same clock as everyone), and cancelled
///    only by it, when the backer takes their money back. A cancel removes the Shares still held for that backer in that round
///    and sends them to the treasury (they join the reserve); what the backer already claimed stays theirs.
///
/// The founder's grant can be trimmed once, before the clock starts, when the founder leaves through the treasury's hand-over:
/// the founder keeps the part matching the days served since launch out of 365 and the rest goes back to the treasury.
///
/// Project zero only: no founder grant (its founder's slice is the Treasury's team budget, paid out over time with the gift
/// rules), and a plain grant made at birth to the earlier backers' claim contract (`EarlierBackers`), on the same clock. That
/// grant is not the founder's, so a trim never reaches it.
/// @dev One copy per project, a minimal clone created by the Launcher. Nothing here can move Shares anywhere but to the
/// beneficiary they were granted to (as fast as the schedule allows) or back to the treasury (a cancel or a trim). No owner.
contract Vester {
    /// @notice Length of the release, in seconds (365 days).
    uint256 public constant DURATION = 365 days;

    /// @notice The project's Shares.
    IShares public shares;
    /// @notice The only address that may start the clock (the project's treasury).
    address public starter;
    /// @notice The only address that may add plain grants, trim the founder and receive cancelled Shares (the treasury).
    address public granter;
    /// @notice The only address that may add and cancel backer grants (the project's Rounds).
    address public rounds;
    /// @notice The founder, whose grant `trimFounder` may cut.
    address public founder;
    /// @notice The part of the founder's plain grant that came from birth (what a trim works on).
    uint256 public founderAmount;
    /// @notice When the clone was set up (the launch); days served are counted from here.
    uint256 public bornAt;
    /// @notice The founder's grant was already trimmed.
    bool public trimmed;
    /// @notice When the clock started (the market opened or "no market" was declared); zero until then.
    uint256 public start;
    /// @notice Shares granted and not yet claimed or cancelled, over all grants (what this contract must hold).
    uint256 public committed;
    /// @notice Shares of all live grants (claimed or not); a cancelled backer grant leaves it whole. The clock runs on it.
    uint256 public granted;

    /// @notice What a grant is and how much of it was claimed.
    struct Grant {
        uint256 total;
        uint256 claimed;
    }

    /// @notice Plain grants by beneficiary.
    mapping(address => Grant) public grants;
    /// @notice Backer grants by round and backer.
    mapping(uint256 round => mapping(address backer => Grant)) public heldGrants;

    /// @notice Shares were set aside for a beneficiary.
    event Granted(address indexed beneficiary, uint256 amount);
    /// @notice Released Shares were sent to the beneficiary.
    event Claimed(address indexed beneficiary, uint256 amount);
    /// @notice The release clock started.
    event Started(uint256 time);
    /// @notice Shares bought in backing round `round` were set aside for `backer`.
    event HeldGranted(uint256 indexed round, address indexed backer, uint256 amount);
    /// @notice `backer` took their money back for round `round`: `amount` Shares still held for them went to the treasury.
    event HeldCancelled(uint256 indexed round, address indexed backer, uint256 amount);
    /// @notice Released Shares of a backer grant were sent to the backer.
    event HeldClaimed(uint256 indexed round, address indexed backer, uint256 amount);
    /// @notice The founder left: `kept` of the birth grant stays theirs, `cut` went back to the treasury.
    event FounderTrimmed(uint256 kept, uint256 cut);

    /// @notice Called twice, or on the locked implementation.
    error AlreadyInitialized();
    /// @notice The caller is not allowed to do this.
    error NotAllowed();
    /// @notice The clock already started (plain grants and trims close then) or has not started (it can start once).
    error WrongPhase();
    /// @notice The Shares to cover a grant are not here.
    error NotFunded();
    /// @notice Zero beneficiary or zero amount.
    error BadGrant();
    /// @notice Nothing is held for this backer in this round (never granted, already claimed or already cancelled).
    error NothingHeld();

    constructor() {
        starter = address(1); // locks the implementation: no clone state is shared with it
    }

    /// @notice Set up the clone, once. The Launcher calls this in the transaction that creates it, after the Shares have been
    /// minted here, and the founder's grant is made in the same call.
    /// @param shares_ The project's ShareToken.
    /// @param starter_ Who may start the clock, once.
    /// @param granter_ Who may add plain grants before it starts, trim the founder, and receives cancelled Shares.
    /// @param rounds_ Who may add and cancel backer grants.
    /// @param founder_ The founder, whose grant is `founderAmount_`.
    /// @param founderAmount_ Shares granted to the founder; they must already be held here. Zero for project zero only, whose
    /// founder's slice is its Treasury's team budget instead (the Launcher decides; a trim then cuts nothing).
    /// @param earlier_ Project zero's earlier backers' claim contract; zero for every other project.
    /// @param earlierAmount_ Shares granted to `earlier_` (already held here); zero for every other project.
    function initialize(
        IShares shares_,
        address starter_,
        address granter_,
        address rounds_,
        address founder_,
        uint256 founderAmount_,
        address earlier_,
        uint256 earlierAmount_
    ) external {
        if (starter != address(0)) revert AlreadyInitialized();
        if (founder_ == address(0)) revert BadGrant();
        (shares, starter, granter, rounds) = (shares_, starter_, granter_, rounds_);
        (founder, founderAmount, bornAt) = (founder_, founderAmount_, block.timestamp);
        if (founderAmount_ != 0) {
            _fund(founderAmount_);
            grants[founder_].total += founderAmount_;
            emit Granted(founder_, founderAmount_);
        }
        if (earlierAmount_ != 0) {
            if (earlier_ == address(0) || earlier_ == founder_) revert BadGrant();
            _fund(earlierAmount_);
            grants[earlier_].total += earlierAmount_;
            emit Granted(earlier_, earlierAmount_);
        }
    }

    /// @notice Start the release clock at this moment, once. After this no plain grant can be added.
    function startNow() external {
        if (msg.sender != starter) revert NotAllowed();
        if (start != 0) revert WrongPhase();
        start = block.timestamp;
        emit Started(block.timestamp);
    }

    /// @notice Set aside Shares for a beneficiary. Only the granter, only before the clock starts, only if the Shares are here.
    function grant(address beneficiary, uint256 amount) external {
        if (msg.sender != granter) revert NotAllowed();
        if (start != 0) revert WrongPhase();
        if (beneficiary == address(0)) revert BadGrant();
        _fund(amount);
        grants[beneficiary].total += amount;
        emit Granted(beneficiary, amount);
    }

    /// @notice Set aside Shares a backer bought in round `round`. Only the project's Rounds, only if the Shares are here.
    /// Allowed after the clock started: the grant then follows the same clock (part of it is released at once).
    function grantHeld(uint256 round, address backer, uint256 amount) external {
        if (msg.sender != rounds) revert NotAllowed();
        if (backer == address(0)) revert BadGrant();
        _fund(amount);
        heldGrants[round][backer].total += amount;
        emit HeldGranted(round, backer, amount);
    }

    /// @notice Cancel what is still held for `backer` in round `round` (granted and not claimed, released or not) and send it
    /// to the treasury. Only the project's Rounds, when the backer takes their money back. What the backer already claimed stays
    /// theirs; the grant is closed (it never releases again).
    /// @return cancelled Shares sent to the treasury.
    /// @return total The grant before the cancel (the Rounds scale the refund by `cancelled / total`).
    function cancelHeld(uint256 round, address backer) external returns (uint256 cancelled, uint256 total) {
        if (msg.sender != rounds) revert NotAllowed();
        Grant storage g = heldGrants[round][backer];
        total = g.total;
        cancelled = total - g.claimed;
        if (cancelled == 0) revert NothingHeld();
        granted -= total; // the whole grant leaves the clock: what was claimed is in hands, the rest leaves here
        committed -= cancelled;
        g.total = g.claimed;
        if (!shares.transfer(granter, cancelled)) revert NotFunded();
        emit HeldCancelled(round, backer, cancelled);
    }

    /// @notice Cut the founder's birth grant to the days served since launch out of 365, once, before the clock starts. Only
    /// the granter (the treasury, inside a hand-over the founder made while leaving). The cut Shares go to the treasury.
    /// @return cut Shares sent back.
    function trimFounder() external returns (uint256 cut) {
        if (msg.sender != granter) revert NotAllowed();
        if (start != 0 || trimmed) revert WrongPhase();
        trimmed = true;
        uint256 served = block.timestamp - bornAt;
        uint256 amount = founderAmount;
        uint256 keep = served >= DURATION ? amount : amount * served / DURATION;
        cut = amount - keep;
        founderAmount = keep;
        emit FounderTrimmed(keep, cut);
        if (cut == 0) return 0;
        grants[founder].total -= cut;
        granted -= cut;
        committed -= cut;
        if (!shares.transfer(granter, cut)) revert NotFunded();
    }

    /// @notice How much of a beneficiary's plain grant has been released so far (claimed or not).
    function released(address beneficiary) public view returns (uint256) {
        return _released(grants[beneficiary].total);
    }

    /// @notice How much of a backer grant has been released so far (claimed or not).
    function releasedHeld(uint256 round, address backer) public view returns (uint256) {
        return _released(heldGrants[round][backer].total);
    }

    /// @notice Shares the schedule has not released yet, over all live grants: everything granted before the clock starts,
    /// falling evenly to zero over 365 days. It depends only on the clock and on grants and cancels, never on who has
    /// claimed, so the treasury can leave exactly these Shares out of the exit count without a stranger's `claim` changing any
    /// price. Released Shares that nobody has claimed yet are not in this number: they belong to their beneficiary already.
    function unreleased() external view returns (uint256) {
        uint256 g = granted;
        return g - _released(g);
    }

    /// @notice What the beneficiary can claim right now from their plain grant.
    function claimable(address beneficiary) public view returns (uint256) {
        Grant memory g = grants[beneficiary];
        uint256 r = _released(g.total);
        return r > g.claimed ? r - g.claimed : 0;
    }

    /// @notice What a backer can claim right now from their grant of round `round`.
    function claimableHeld(uint256 round, address backer) public view returns (uint256) {
        Grant memory g = heldGrants[round][backer];
        uint256 r = _released(g.total);
        return r > g.claimed ? r - g.claimed : 0;
    }

    /// @notice Send a beneficiary their released Shares of their plain grant. Anyone may call it; the Shares always go to the
    /// beneficiary.
    /// @return amount Shares sent.
    function claim(address beneficiary) external returns (uint256 amount) {
        amount = claimable(beneficiary);
        if (amount == 0) return 0;
        grants[beneficiary].claimed += amount;
        _send(beneficiary, amount);
        emit Claimed(beneficiary, amount);
    }

    /// @notice Take out your released Shares of your grant of round `round`. Only the backer: taking Shares out ends the
    /// backer's refund for those Shares (the Rounds refund only what is still held here), so nobody else may end it for them.
    /// @return amount Shares sent.
    function claimHeld(uint256 round, address backer) external returns (uint256 amount) {
        if (msg.sender != backer) revert NotAllowed();
        amount = claimableHeld(round, backer);
        if (amount == 0) return 0;
        heldGrants[round][backer].claimed += amount;
        _send(backer, amount);
        emit HeldClaimed(round, backer, amount);
    }

    function _released(uint256 total) private view returns (uint256) {
        uint256 s = start;
        if (s == 0) return 0;
        uint256 elapsed = block.timestamp - s;
        return elapsed >= DURATION ? total : total * elapsed / DURATION;
    }

    function _fund(uint256 amount) private {
        if (amount == 0) revert BadGrant();
        if (shares.balanceOf(address(this)) < committed + amount) revert NotFunded();
        committed += amount;
        granted += amount;
    }

    function _send(address to, uint256 amount) private {
        committed -= amount;
        if (!shares.transfer(to, amount)) revert NotFunded();
    }
}
