// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {SafeERC20} from "oz5/token/ERC20/utils/SafeERC20.sol";
import {IShares, IVester, ITreasuryRounds} from "./Interfaces.sol";

/// @title Rounds
/// @notice A project's backing rounds: one fixed price, no auction, no market, and a personal refund of the money not yet paid
/// to the project. One copy per project, made by the Launcher with the 150,000,000 Shares for backing.
///
/// The rules, as integers (dollars are a 6-decimal token, Shares have 18 decimals):
///  - Price: 1 raw dollar unit buys `SHARES_PER_RAW_DOLLAR` = 3e15 raw Share units, so 1 dollar buys exactly 3,000 Shares and
///    50,000 dollars buy exactly the 150,000,000 backing Shares. The same for every project; nobody types it.
///  - A round lasts 24 hours from `open`. Its size (set by the Launcher: whatever is left under the stage's cap) is the most it
///    can accept. Anyone may ask, any amount; a backer's ask in a round must total at least 1 dollar; no per-account cap.
///    An ask may be lowered or withdrawn only in the first 12 hours; after that it can only grow.
///  - Close (anyone, after 24 hours): `accepted` = the smaller of what was asked and the size. If more was asked, every ask is
///    scaled back by the same ratio: a backer's accepted part is `ask * accepted / asked`, rounded down, and the rest of the
///    ask is returned. The rounding dust (`accepted` less the sum of the parts: under one raw unit per backer) therefore goes
///    back to the backers with the rest of their asks. It still counts in `accepted`, in `raised` (what the caps measure) and in
///    `RoundClosed.accepted`, so the sum of `Settled.accepted` is up to that dust below them; the stage caps are measured on
///    `raised`, which is the sum of `RoundClosed.accepted`. The dust's Shares (3e15 raw units per raw dollar of dust) stay set
///    aside in `reserved` and are never returned to the reserve.
///  - Each accepted 100: 3 to the platform (`acc * 300 / 10000`, rounded down), 82 held here (`acc * 8200 / 10000`, rounded
///    down), and the rest, 15 plus the rounding dust, to the project's `spendable` at once.
///  - The held 82 is released to the project evenly over 26 weeks (182 days) of ACTIVE time: time counts only inside the
///    treasury's check-in window (14 days after the runner's last check-in) and not while payments are paused. A lapse
///    pushes the end date out by exactly the time lapsed and is never paid back (the built treasury's rule). One clock
///    (`activeNow`) serves every round; a round's release is `held * min(activeNow - activeAtClose, 182 days) / 182 days`.
///  - Shares bought are set aside in the Vester as held Shares of that round (released over 365 days from the market or a
///    "no market" declaration, like every Share handed out before a market).
///  - Refund (personal, per round, any time): the backer takes back their own unreleased money for the Shares still held for
///    them (its released part rounded up, so the unreleased part rounds down against the backer), less 5% of it (rounded up
///    against the backer; 1% to the platform, 4% to the project's `spendable`), and those
///    held Shares are cancelled (they go to the treasury's reserve). Before a market nothing has been claimed, so it is the
///    whole position: per 100 paid, 77.9 on day 0, 65.9 at week 4, 38.95 at week 13, nothing at week 26. After a market the
///    refund covers only the Shares still in the Vester for the backer: taking Shares out ends the refund for those Shares.
///    Nobody else's refund changes anyone's number: each position has its own money, and the clock is shared.
///  - After a wind-down releases stop for good and the refund fee is the platform's 1% only.
/// @dev Everything per backer is lazy: `close` is the same cost whatever the number of asks; `settle` handles one backer (the
/// scale-back, the split, the Shares). Anyone may call `close`, `settle`, `release` and `sweepFees`.
contract Rounds {
    using SafeERC20 for IERC20;

    /// @notice Raw Share units bought by one raw dollar unit: 3,000 Shares a dollar.
    uint256 public constant SHARES_PER_RAW_DOLLAR = 3e15;
    /// @notice The smallest total ask of a backer in a round, and the smallest round: 1 dollar.
    uint256 public constant MIN_ASK = 1e6;
    /// @notice How long a round takes asks.
    uint256 public constant WINDOW = 24 hours;
    /// @notice Asks may be lowered or withdrawn only this long after the round opened.
    uint256 public constant LOWER_WINDOW = 12 hours;
    /// @notice The held part is released over this much active time: 26 weeks.
    uint256 public constant RELEASE = 182 days;
    /// @notice The platform's part of accepted money, in ten-thousandths (3%).
    uint256 public constant PLATFORM_BPS = 300;
    /// @notice The part of accepted money held and released over 26 weeks, in ten-thousandths (82%).
    uint256 public constant HELD_BPS = 8200;
    /// @notice The refund fee, in ten-thousandths of the unreleased money taken back (5%).
    uint256 public constant REFUND_FEE_BPS = 500;
    /// @notice The platform's part of the refund fee (1%); the rest of the fee goes to the project.
    uint256 public constant REFUND_PLATFORM_BPS = 100;
    uint256 private constant BPS = 10_000;

    /// @notice One round.
    struct Round {
        uint64 openedAt;
        uint64 closedAt; // zero while open
        uint256 size; // the most it may accept
        uint256 asked; // the sum of every ask
        uint256 accepted; // set at close: min(asked, size)
        uint256 activeAtClose; // the shared clock (`activeNow`) when it closed
        uint256 held; // the held 82 of every settled position not taken back
        uint256 frozen; // the released part of positions taken back (still owed to the project)
        uint256 paidOut; // sent to the project from the held part so far
    }

    /// @notice One backer in one round.
    struct Position {
        uint256 ask; // dollars asked (and escrowed here until settle)
        uint256 held; // their 82 still in the round (falls on refund)
        uint256 bought; // Shares bought (set aside in the Vester)
        bool settled;
    }

    /// @notice The Launcher (opens rounds).
    address public launcher;
    /// @notice The project's treasury: the check-in window, `spendable`, and where cancelled Shares go.
    ITreasuryRounds public treasury;
    /// @notice The project's Vester, where bought Shares are held.
    IVester public vester;
    /// @notice The project's Shares.
    IShares public shares;
    /// @notice The dollar token.
    IERC20 public quote;
    /// @notice Where the platform's 3 and its part of refund fees go.
    address public platform;

    /// @notice Rounds opened so far; round ids are 1, 2, ...
    uint256 public count;
    /// @notice Money accepted in all rounds, ever (refunds do not lower it): what the stage caps are measured on.
    uint256 public raised;
    /// @notice When the first round that accepted money closed; zero until then (the project is Backed from then on).
    uint256 public firstMoneyAt;
    /// @notice Shares owed to accepted asks that are not settled yet (they stay here until then).
    uint256 public reserved;
    /// @notice Platform money waiting to be swept.
    uint256 public platformOwed;
    /// @notice The project wound down: no release, refund fee 1%.
    bool public woundDown;

    // ---- the shared release clock
    /// @notice Active seconds counted up to `accruedUpTo`.
    uint256 public activeTotal;
    /// @notice Time up to which `activeTotal` was worked out.
    uint256 public accruedUpTo;

    mapping(uint256 => Round) internal _rounds;
    mapping(uint256 => mapping(address => Position)) internal _positions;
    bool private transient _locked;

    /// @notice A round opened for asks.
    event RoundOpened(uint256 indexed round, uint256 size, uint256 opensAt, uint256 closesAt);
    /// @notice A backer's ask in a round is now `total` (asked more: `added` > 0; lowered or withdrawn: `added` == 0).
    event Asked(uint256 indexed round, address indexed backer, uint256 total, uint256 added);
    /// @notice A backer lowered (or, with `total` 0, withdrew) their ask; `returned` dollars came back.
    event AskLowered(uint256 indexed round, address indexed backer, uint256 total, uint256 returned);
    /// @notice A round closed: `accepted` of `asked`; every ask is scaled by `accepted / asked` when that is below one.
    event RoundClosed(uint256 indexed round, uint256 asked, uint256 accepted, uint256 activeAtClose);
    /// @notice A backer's position was settled: `accepted` dollars bought `shares` held Shares; `returned` came back.
    event Settled(
        uint256 indexed round,
        address indexed backer,
        uint256 accepted,
        uint256 returned,
        uint256 shares,
        uint256 toPlatform,
        uint256 toProject,
        uint256 held
    );
    /// @notice Held money of a round was released to the project's `spendable`.
    event Released(uint256 indexed round, uint256 amount);
    /// @notice A backer took back their unreleased money: `paid` to them, `toProject` and `toPlatform` the fee, `shares`
    /// held Shares cancelled.
    event Refunded(
        uint256 indexed round,
        address indexed backer,
        uint256 unreleased,
        uint256 paid,
        uint256 toProject,
        uint256 toPlatform,
        uint256 shares
    );
    /// @notice The platform's owed money was sent.
    event FeesSwept(address indexed to, uint256 amount);
    /// @notice Backing Shares nobody bought went to the treasury's reserve.
    event UnsoldReturned(uint256 amount);
    /// @notice The project wound down.
    event WoundDown(uint256 time);

    /// @notice Set up twice, or on the implementation.
    error BadSetup();
    /// @notice The caller may not do this.
    error NotAllowed();
    /// @notice A call came back in while another was running.
    error Reentrancy();
    /// @notice A round is still open, or the size is below 1 dollar or more than the Shares left can cover.
    error CannotOpen();
    /// @notice No such round, or it is not in the right phase for this.
    error WrongPhase();
    /// @notice The amount is zero, or leaves a backer's ask between zero and 1 dollar, or is not lower than the ask.
    error BadAmount();
    /// @notice The dollar token moved a different amount than asked.
    error TokenMisbehaved();
    /// @notice Nothing to take back (nothing held for you in this round, or all of it was released).
    error NothingToRefund();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor() {
        launcher = address(1); // locks the implementation
    }

    /// @notice Set up the clone, once, in the Launcher's launch transaction (the backing Shares are minted here first).
    function initialize(
        address launcher_,
        ITreasuryRounds treasury_,
        IVester vester_,
        IShares shares_,
        IERC20 quote_,
        address platform_
    ) external {
        if (launcher != address(0) || launcher_ == address(0)) revert BadSetup();
        (launcher, treasury, vester, shares, quote, platform) =
            (launcher_, treasury_, vester_, shares_, quote_, platform_);
        accruedUpTo = block.timestamp;
        quote_.forceApprove(address(treasury_), type(uint256).max); // the treasury pulls what goes to `spendable`
    }

    // ================================================ a round =======================================================

    /// @notice Open a round of `size` raw dollars for 24 hours. Only the Launcher, which checks the runner and the stage's
    /// cap. Refused while another round is open or when the Shares left (not bought, not owed) cannot cover the size.
    /// @return id The new round's id.
    function open(uint256 size) external returns (uint256 id) {
        if (msg.sender != launcher) revert NotAllowed();
        if (isOpen() || size < MIN_ASK || size * SHARES_PER_RAW_DOLLAR > unsold()) revert CannotOpen();
        id = ++count;
        Round storage r = _rounds[id];
        (r.openedAt, r.size) = (uint64(block.timestamp), size);
        emit RoundOpened(id, size, block.timestamp, block.timestamp + WINDOW);
    }

    /// @notice Ask to back round `id` with `amount` more raw dollars (approve this contract first). The dollars wait here
    /// until the backer is settled after the close. A backer's total ask must be at least 1 dollar.
    function ask(uint256 id, uint256 amount) external nonReentrant {
        Round storage r = _rounds[id];
        if (r.openedAt == 0 || block.timestamp >= r.openedAt + WINDOW) revert WrongPhase();
        Position storage p = _positions[id][msg.sender];
        uint256 total = p.ask + amount;
        if (amount == 0 || total < MIN_ASK) revert BadAmount();
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), amount);
        if (quote.balanceOf(address(this)) - before != amount) revert TokenMisbehaved();
        p.ask = total;
        r.asked += amount;
        emit Asked(id, msg.sender, total, amount);
    }

    /// @notice Lower your ask in round `id` to `total` (zero withdraws it), in the first 12 hours only. The difference
    /// comes back at once.
    function lower(uint256 id, uint256 total) external nonReentrant {
        Round storage r = _rounds[id];
        if (r.openedAt == 0 || block.timestamp >= r.openedAt + LOWER_WINDOW) revert WrongPhase();
        Position storage p = _positions[id][msg.sender];
        uint256 old = p.ask;
        if (total >= old || (total != 0 && total < MIN_ASK)) revert BadAmount();
        p.ask = total;
        r.asked -= old - total;
        _send(msg.sender, old - total);
        emit AskLowered(id, msg.sender, total, old - total);
    }

    /// @notice Close round `id`, once, 24 hours after it opened. Anyone may. Costs the same whatever the number of asks.
    function close(uint256 id) external {
        Round storage r = _rounds[id];
        if (r.openedAt == 0 || r.closedAt != 0 || block.timestamp < r.openedAt + WINDOW) revert WrongPhase();
        uint256 accepted = r.asked < r.size ? r.asked : r.size;
        uint256 clock = activeNow();
        (r.closedAt, r.accepted, r.activeAtClose) = (uint64(block.timestamp), accepted, clock);
        raised += accepted;
        reserved += accepted * SHARES_PER_RAW_DOLLAR;
        if (accepted != 0 && firstMoneyAt == 0) firstMoneyAt = block.timestamp;
        emit RoundClosed(id, r.asked, accepted, clock);
    }

    /// @notice Settle `backer` in closed round `id`, once: work out their accepted part (scaled back if more was asked than
    /// the size), return the rest of their ask, pay the platform's 3 (owed) and the project's 15 (at once), keep the 82
    /// and set aside their Shares in the Vester. Anyone may call it; everything goes to its owner.
    function settle(uint256 id, address backer) public nonReentrant {
        _settle(id, backer);
    }

    /// @notice `settle` for several backers of one round.
    function settleMany(uint256 id, address[] calldata backers) external nonReentrant {
        for (uint256 i; i < backers.length; ++i) {
            _settle(id, backers[i]);
        }
    }

    // ================================================ the money =====================================================

    /// @notice Send round `id`'s released money to the project's `spendable`. Anyone may call it.
    /// @return amount Dollars sent.
    function release(uint256 id) public nonReentrant returns (uint256 amount) {
        amount = releasable(id);
        if (amount == 0) return 0;
        _rounds[id].paidOut += amount;
        treasury.topUp(amount);
        emit Released(id, amount);
    }

    /// @notice Take back your unreleased money in round `id` for the Shares still held for you, less the fee, and cancel
    /// those Shares. Settles you first if nobody has.
    /// @return paid Dollars sent to you.
    function refund(uint256 id) external nonReentrant returns (uint256 paid) {
        Round storage r = _rounds[id];
        Position storage p = _positions[id][msg.sender];
        if (!p.settled) _settle(id, msg.sender);
        if (p.held == 0) revert NothingToRefund();
        (uint256 total, uint256 claimed) = vester.heldGrants(id, msg.sender);
        uint256 still = total - claimed;
        if (still == 0) revert NothingToRefund();
        uint256 part = still == total ? p.held : p.held * still / total;
        uint256 released_ = _releasedUp(part, _elapsed(r));
        uint256 unreleased_ = part - released_;
        uint256 feeBps = woundDown ? REFUND_PLATFORM_BPS : REFUND_FEE_BPS;
        uint256 fee = (unreleased_ * feeBps + BPS - 1) / BPS; // rounded up: the backer never pays less than the fee
        paid = unreleased_ - fee;
        if (paid == 0) revert NothingToRefund();
        uint256 toPlatform = woundDown ? fee : unreleased_ * REFUND_PLATFORM_BPS / BPS;
        uint256 toProject = fee - toPlatform;
        (r.held, r.frozen, p.held) = (r.held - part, r.frozen + released_, p.held - part);
        platformOwed += toPlatform;
        (uint256 cancelled,) = vester.cancelHeld(id, msg.sender);
        if (toProject != 0) treasury.topUp(toProject);
        _send(msg.sender, paid);
        emit Refunded(id, msg.sender, unreleased_, paid, toProject, toPlatform, cancelled);
    }

    /// @notice Send the platform its owed money. Anyone may call it; a platform address that refuses dollars blocks only this.
    function sweepFees() external nonReentrant {
        uint256 owed = platformOwed;
        if (owed == 0) return;
        platformOwed = 0;
        _send(platform, owed);
        emit FeesSwept(platform, owed);
    }

    /// @notice Once no round can open again (the market opened, "no market" was declared, or the project wound down), send
    /// the backing Shares nobody bought to the treasury's reserve. Anyone may call it.
    function returnUnsold() external nonReentrant {
        if (!treasury.poolOpen() && !treasury.woundDown()) revert WrongPhase();
        if (isOpen()) revert WrongPhase();
        uint256 amount = unsold();
        if (amount == 0) return;
        if (!shares.transfer(address(treasury), amount)) revert TokenMisbehaved();
        emit UnsoldReturned(amount);
    }

    /// @notice Work the shared clock out up to now. Anyone may; the treasury does it before it changes the active window.
    function sync() external {
        activeTotal = activeNow();
        accruedUpTo = block.timestamp;
    }

    /// @notice The project wound down. Only the treasury, after it worked the clock out.
    function windDown() external {
        if (msg.sender != address(treasury)) revert NotAllowed();
        woundDown = true;
        emit WoundDown(block.timestamp);
    }

    // ================================================ reading =======================================================

    /// @notice The shared clock: active seconds since this project was born, counting only time inside the treasury's
    /// check-in window and not paused (`treasury.activeEnd()`).
    function activeNow() public view returns (uint256) {
        uint256 end = treasury.activeEnd();
        uint256 upto = block.timestamp < end ? block.timestamp : end;
        uint256 from = accruedUpTo;
        return upto > from ? activeTotal + (upto - from) : activeTotal;
    }

    /// @notice True while a round takes asks or waits to be closed.
    function isOpen() public view returns (bool) {
        uint256 c = count;
        return c != 0 && _rounds[c].closedAt == 0;
    }

    /// @notice Backing Shares held here that nobody bought and no accepted ask is owed.
    function unsold() public view returns (uint256) {
        return shares.balanceOf(address(this)) - reserved;
    }

    /// @notice Round `id`'s released money not yet sent to the project.
    function releasable(uint256 id) public view returns (uint256) {
        Round storage r = _rounds[id];
        if (r.closedAt == 0) return 0;
        uint256 due = r.held * _elapsed(r) / RELEASE + r.frozen;
        return due > r.paidOut ? due - r.paidOut : 0;
    }

    /// @notice What `backer` would be paid by `refund(id)` now (zero when nothing can be taken back). Settled positions only.
    function refundable(uint256 id, address backer) external view returns (uint256) {
        Position storage p = _positions[id][backer];
        if (!p.settled || p.held == 0) return 0;
        (uint256 total, uint256 claimed) = vester.heldGrants(id, backer);
        uint256 still = total - claimed;
        if (still == 0) return 0;
        uint256 part = still == total ? p.held : p.held * still / total;
        uint256 unreleased_ = part - _releasedUp(part, _elapsed(_rounds[id]));
        uint256 feeBps = woundDown ? REFUND_PLATFORM_BPS : REFUND_FEE_BPS;
        return unreleased_ - (unreleased_ * feeBps + BPS - 1) / BPS;
    }

    /// @notice One round.
    function roundOf(uint256 id) external view returns (Round memory) {
        return _rounds[id];
    }

    /// @notice One backer in one round.
    function positionOf(uint256 id, address backer) external view returns (Position memory) {
        return _positions[id][backer];
    }

    // ================================================ plumbing ======================================================

    /// @dev The released part of a position that is taken back, rounded UP (against the backer). The round's release to the
    /// project rounds the whole round's held money down, so rounding each refunded position's released part up keeps the sum of
    /// the parts never below what the project was already paid: no raw unit is ever paid twice.
    function _releasedUp(uint256 part, uint256 elapsed) private pure returns (uint256) {
        return (part * elapsed + RELEASE - 1) / RELEASE;
    }

    /// @dev Active seconds since round `r` closed, at most 26 weeks.
    function _elapsed(Round storage r) private view returns (uint256) {
        uint256 e = activeNow() - r.activeAtClose;
        return e > RELEASE ? RELEASE : e;
    }

    function _settle(uint256 id, address backer) private {
        Round storage r = _rounds[id];
        if (r.closedAt == 0) revert WrongPhase();
        Position storage p = _positions[id][backer];
        uint256 askd = p.ask;
        if (p.settled || askd == 0) revert WrongPhase();
        uint256 acc = r.asked <= r.size ? askd : askd * r.accepted / r.asked;
        uint256 toPlatform = acc * PLATFORM_BPS / BPS;
        uint256 held_ = acc * HELD_BPS / BPS;
        uint256 toProject = acc - toPlatform - held_;
        uint256 bought = acc * SHARES_PER_RAW_DOLLAR;
        (p.settled, p.held, p.bought) = (true, held_, bought);
        r.held += held_;
        reserved -= bought;
        platformOwed += toPlatform;
        if (bought != 0) {
            if (!shares.transfer(address(vester), bought)) revert TokenMisbehaved();
            vester.grantHeld(id, backer, bought);
        }
        if (toProject != 0) treasury.topUp(toProject);
        if (askd != acc) _send(backer, askd - acc);
        emit Settled(id, backer, acc, askd - acc, bought, toPlatform, toProject, held_);
    }

    function _send(address to, uint256 amount) private {
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransfer(to, amount);
        if (before - quote.balanceOf(address(this)) != amount) revert TokenMisbehaved();
    }
}
