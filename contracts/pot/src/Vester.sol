// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "oz5/utils/math/Math.sol";
import {IShares, ITreasuryClock} from "./Interfaces.sol";

/// @title Vester
/// @notice Holds the project's whole Team pool, minted here at birth, and hands it out in grants. Every grant has a clock
/// of its own. It starts when the grant is made and runs on the project's ACTIVE time only (the seconds inside the
/// check-in window of 2 time units), so a quiet project stops vesting and a lapse is never paid back.
///  - a grant vests linearly over 104 time units (about 24 months of active time) and nothing is vested before the cliff of
///    13 time units (about 3 months); the cliff sits inside the 104;
///  - a grant is lost only by the member's own exit, or by both signers of a Pair runner after a public notice of one time
///    unit (`announceForfeit`, then `execute`). The part that does not stay is announced to burn at once, so every join
///    is priced as if it had burned already (the Treasury's `Z`), and burns when the notice has run;
///  - a member leaving in good standing keeps what has accrued (no cliff); both signers can take away only what has not
///    vested (cliff counted);
///  - after a wind-down every grant that was not already announced can be burned by anyone once a time unit has passed:
///    what has not been kept is burned (a wind-down by choice keeps what has accrued, a quiet one only what has vested).
///    The part of the pool nobody was granted burns the same way;
///  - a protected grant vests on calendar time over 365 days with no cliff and can never be forfeited, paused or burned.
///    The Treasury makes none in step 1 (it passes `false`); the flag is the seam for the earlier backers' grant.
/// Team Shares leave only from hands: this contract has no call into `leaveTeam`, so Shares still here are never paid out.
/// @dev One copy per project, a minimal clone created and initialised by the Launcher in one transaction. No owner.
contract Vester {
    /// @notice The vest cliff is this many time units of active time.
    uint256 public constant CLIFF_MULT = 13;
    /// @notice A grant vests fully after this many time units of active time (about 24 months).
    uint256 public constant VEST_MULT = 104;
    /// @notice A protected grant vests over this many seconds of calendar time.
    uint256 public constant PROTECTED_LENGTH = 365 days;
    /// @notice The most grants one member can ever be given (it bounds the hand-over trim).
    uint256 public constant MAX_GRANTS_PER_MEMBER = 8;
    /// @notice The smallest grant: one whole Team Share (1e18 wei).
    uint256 public constant MIN_GRANT = 1e18;

    /// @notice A grant lives (vesting), is announced to forfeit, or is closed (what stays is fixed).
    enum State {
        Live,
        Announced,
        Closed
    }

    /// @notice One grant. After an announce or a close, `total` is what the member keeps and all of it has vested.
    struct Grant {
        address member;
        bool protected_;
        State state;
        uint64 burnAt; // when an announced burn may run
        uint256 total; // Team Share wei granted (what the member keeps, once announced or closed)
        uint256 claimed; // already sent to the member
        uint256 start; // active seconds at the grant (calendar time for a protected grant)
        uint256 burn; // announced to burn, not yet burned
    }

    ITreasuryClock public treasury;
    IShares public team;
    /// @notice Team Shares promised to someone and not yet sent or burned: what this contract must always hold.
    uint256 public committed;
    /// @notice Grants made so far; the next id.
    uint256 public grantCount;
    mapping(uint256 => Grant) private _grants;
    mapping(address => uint256[]) private _ids;
    bool private _born;

    /// @notice Team Shares were set aside for `member`. `kind` is 0 for a normal grant and 1 for a protected one.
    event GrantMade(uint256 indexed id, address indexed member, uint256 amount, uint256 startActive, uint8 kind);
    /// @notice The unvested part of a grant was announced to burn at `burnAt`. `byMember` is true for an own exit.
    event ForfeitAnnounced(
        uint256 indexed id, address indexed member, uint256 amount, bool byMember, uint64 burnAt, uint256 zAfter
    );
    /// @notice Team Shares of a grant were burned (after the notice, or after a wind-down).
    event Forfeited(uint256 indexed id, address indexed member, uint256 burned, uint256 zAfter, uint256 teamAfter);
    /// @notice Vested Team Shares were sent to the member.
    event GrantClaimed(uint256 indexed id, address indexed member, uint256 amount);
    /// @notice The Team Shares nobody was granted were burned after a wind-down.
    event UngrantedBurned(uint256 amount, uint256 teamAfter);

    error AlreadyInitialized();
    error NotAllowed();
    error BadGrant();
    error NotFunded();
    error TooManyGrants();
    error UnknownGrant();
    error WrongState();
    error ProtectedGrant();
    error NothingToBurn();
    error NothingToClaim();
    error NotWoundDown();
    error NotYet(uint256 readyAt);

    modifier onlyTreasury() {
        if (msg.sender != address(treasury)) revert NotAllowed();
        _;
    }

    constructor() {
        _born = true; // the copy the clones point at can never be initialised
    }

    /// @notice Set up the clone, once. The Launcher calls it in the transaction that creates it, after the whole pool was
    /// minted here.
    /// @param treasury_ The project's Treasury: the only address that may grant, and the clock.
    /// @param team_ The project's Team ShareToken.
    /// @param pool_ The Team pool set at birth; it must already be held here.
    function initialize(ITreasuryClock treasury_, IShares team_, uint256 pool_) external {
        if (_born) revert AlreadyInitialized();
        if (address(treasury_) == address(0) || team_.controller() != address(treasury_)) revert BadGrant();
        if (team_.balanceOf(address(this)) != pool_) revert NotFunded();
        _born = true;
        (treasury, team) = (treasury_, team_);
    }

    // ===================================================== grants ====================================================

    /// @notice Set aside `amount` Team Shares for `member`, on a clock of its own that starts now. Only the Treasury (which
    /// has checked the runner, or an agent's daily Team Share limit). The pool can never be passed: the Shares must be
    /// here and not already promised. A grant is at least one whole Team Share, so dust grants cannot fill a member's 8
    /// slots (an agent may grant inside its daily limit). A member can be given at most 8 grants.
    /// @param protected_ A protected grant (calendar time over 365 days, no cliff, never forfeited or burned).
    /// @return id The grant's id.
    function grant(address member, uint256 amount, bool protected_) external onlyTreasury returns (uint256 id) {
        if (member == address(0) || amount < MIN_GRANT) revert BadGrant();
        if (_ids[member].length >= MAX_GRANTS_PER_MEMBER) revert TooManyGrants();
        if (team.balanceOf(address(this)) < committed + amount) revert NotFunded();
        committed += amount;
        id = grantCount++;
        uint256 start = protected_ ? block.timestamp : treasury.activeNow();
        _grants[id] = Grant({
            member: member,
            protected_: protected_,
            state: State.Live,
            burnAt: 0,
            total: amount,
            claimed: 0,
            start: start,
            burn: 0
        });
        _ids[member].push(id);
        emit GrantMade(id, member, amount, start, protected_ ? 1 : 0);
    }

    /// @notice Send the member what has vested of grant `id` and not been sent. Anyone may call it; the Shares always go
    /// to the member.
    /// @return amount Team Shares sent.
    function claim(uint256 id) external returns (uint256 amount) {
        Grant storage g = _get(id);
        amount = _vested(g) - g.claimed;
        if (amount == 0) revert NothingToClaim();
        g.claimed += amount;
        committed -= amount;
        if (!team.transfer(g.member, amount)) revert NotFunded();
        emit GrantClaimed(id, g.member, amount);
    }

    // ===================================================== forfeits ==================================================

    /// @notice Leave your own grant `id`: you keep what has accrued so far (no cliff) and the rest is announced to burn. It
    /// burns after one time unit, and from now every join is priced as if it had burned. Only the member.
    function announceForfeit(uint256 id) external {
        Grant storage g = _get(id);
        if (msg.sender != g.member) revert NotAllowed();
        _announce(id, g, true);
    }

    /// @notice Both signers of the Pair runner announce the forfeit of grant `id`: the member keeps what has vested (cliff
    /// counted), the rest is announced to burn and burns after one time unit. Only the Treasury, which has checked that
    /// the runner is a Pair and that both signers agreed to this very call.
    function announceByRunner(uint256 id) external onlyTreasury {
        _announce(id, _get(id), false);
    }

    /// @notice The hand-over trim: announce every live grant of `member` as an own exit. Only the Treasury. Grants with
    /// nothing to burn, announced ones and protected ones are skipped. At most 8 grants.
    function exitAll(address member) external onlyTreasury {
        uint256[] storage ids = _ids[member];
        for (uint256 i; i < ids.length; ++i) {
            Grant storage g = _grants[ids[i]];
            if (g.protected_ || g.state != State.Live) continue;
            if (g.total - _accrued(g) == 0) continue;
            _announce(ids[i], g, true);
        }
    }

    /// @notice Burn the announced part of grant `id` once its notice has run. Anyone.
    function execute(uint256 id) external {
        Grant storage g = _get(id);
        if (g.state != State.Announced) revert WrongState();
        if (block.timestamp < g.burnAt) revert NotYet(g.burnAt);
        uint256 burned = g.burn;
        g.burn = 0;
        g.state = State.Closed;
        committed -= burned;
        treasury.forfeitBurn(burned);
        emit Forfeited(id, g.member, burned, treasury.Z(), team.totalSupply());
    }

    /// @notice After a wind-down and one more time unit, burn what grant `id` does not keep: a wind-down by choice keeps what
    /// has accrued, a quiet one only what has vested. A grant announced before the wind-down is burned with `execute`.
    /// Anyone.
    function burnAfterWindDown(uint256 id) external {
        Grant storage g = _get(id);
        if (g.protected_) revert ProtectedGrant();
        if (g.state != State.Live) revert WrongState();
        _requireNoticeOver();
        uint256 kept = treasury.windDownKind() == 1 ? _accrued(g) : _vested(g);
        uint256 burned = g.total - kept;
        g.total = kept;
        g.state = State.Closed;
        committed -= burned;
        if (burned != 0) treasury.burnAfterWindDown(burned);
        emit Forfeited(id, g.member, burned, treasury.Z(), team.totalSupply());
    }

    /// @notice After a wind-down and one more time unit, burn the Team Shares nobody was granted. Anyone.
    function burnUngrantedAfterWindDown() external returns (uint256 amount) {
        _requireNoticeOver();
        uint256 held = team.balanceOf(address(this));
        amount = held > committed ? held - committed : 0;
        if (amount == 0) revert NothingToBurn();
        treasury.burnAfterWindDown(amount);
        emit UngrantedBurned(amount, team.totalSupply());
    }

    // ===================================================== views =====================================================

    /// @notice One grant.
    function grantOf(uint256 id) external view returns (Grant memory) {
        return _get(id);
    }

    /// @notice The ids of a member's grants.
    function idsOf(address member) external view returns (uint256[] memory) {
        return _ids[member];
    }

    /// @notice How much of grant `id` has vested so far (claimed or not): nothing before the cliff, then linear over 104
    /// time units of active time. For a grant that was announced or closed: everything it keeps.
    function vestedOf(uint256 id) external view returns (uint256) {
        return _vested(_get(id));
    }

    /// @notice How much of grant `id` has accrued so far, with no cliff (what a member keeps on an own exit).
    function accruedOf(uint256 id) external view returns (uint256) {
        Grant storage g = _get(id);
        return g.state == State.Live ? _accrued(g) : g.total;
    }

    /// @notice What the member can claim from grant `id` right now.
    function claimable(uint256 id) external view returns (uint256) {
        Grant storage g = _get(id);
        return _vested(g) - g.claimed;
    }

    // ===================================================== plumbing ==================================================

    function _get(uint256 id) private view returns (Grant storage g) {
        g = _grants[id];
        if (g.member == address(0)) revert UnknownGrant();
    }

    /// @dev Seconds of vesting clock so far: active seconds since the grant, or calendar seconds when protected.
    function _elapsed(Grant storage g) private view returns (uint256) {
        return (g.protected_ ? block.timestamp : treasury.activeNow()) - g.start;
    }

    /// @dev Accrued with no cliff. Only meaningful while the grant is live.
    function _accrued(Grant storage g) private view returns (uint256) {
        uint256 len = g.protected_ ? PROTECTED_LENGTH : VEST_MULT * treasury.unit();
        uint256 el = _elapsed(g);
        return el >= len ? g.total : Math.mulDiv(g.total, el, len);
    }

    /// @dev Vested: accrued, but nothing before the cliff (a protected grant has none). Once a grant is announced or
    /// closed, `total` is already what stays and all of it counts.
    function _vested(Grant storage g) private view returns (uint256) {
        if (g.state != State.Live) return g.total;
        if (!g.protected_ && _elapsed(g) < CLIFF_MULT * treasury.unit()) return 0;
        return _accrued(g);
    }

    function _announce(uint256 id, Grant storage g, bool byMember) private {
        if (g.protected_) revert ProtectedGrant();
        if (g.state != State.Live) revert WrongState();
        uint256 kept = byMember ? _accrued(g) : _vested(g);
        uint256 burn = g.total - kept;
        if (burn == 0) revert NothingToBurn();
        g.total = kept;
        g.burn = burn;
        g.state = State.Announced;
        uint64 when = uint64(block.timestamp + treasury.unit());
        g.burnAt = when;
        treasury.forfeitAnnounced(burn);
        emit ForfeitAnnounced(id, g.member, burn, byMember, when, treasury.Z());
    }

    function _requireNoticeOver() private view {
        if (treasury.windDownKind() == 0) revert NotWoundDown();
        uint256 readyAt = uint256(treasury.windDownAt()) + treasury.unit();
        if (block.timestamp < readyAt) revert NotYet(readyAt);
    }
}
