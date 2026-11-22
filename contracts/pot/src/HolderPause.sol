// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {IShares} from "./Interfaces.sol";

/// @title HolderPause
/// @notice The holders' pause of one project (docs/next-version/STEP4-PLAN.md, section 1). Holders PARK backer Shares here.
/// When the Shares parked reach one third of all the Shares backers hold, the project's Treasury refuses two things, `draw`
/// and `announceTask`, from 24 hours later, for as long as that much stays parked. Nothing else: this contract holds no
/// dollars, cannot pay anyone, never calls the Treasury, never reads or slows `leave`, and has no owner, no upgrade and no
/// payable function. A project has one only when its deployment's switch was on at launch (`Launcher.holderPauseImpl`).
/// @dev One minimal clone per project, made and initialised by the Launcher in the launch transaction. Custody, not a mark:
/// the ShareToken has no hooks, so a mark on a balance cannot be kept true, while a Share held here is counted once. Only
/// `park` from the caller's own wallet raises the count; a Share sent here by a plain transfer is not parked and counts
/// nowhere.
///
/// The clock: `armedAt` is the second the line was first seen reached in an unbroken run. `park`, `unpark` and `poke` look
/// first (clearing `armedAt` if the line is not reached), then apply their change, then arm if the line is reached. The
/// Treasury calls `poke` after the one place backer Shares are minted (`_join`), so every way the ratio can fall is seen when
/// it happens; a pause therefore never begins without a full, seen, unbroken day. `paused()` also reads the ratio live.
contract HolderPause {
    /// @notice The line is one third: parked Shares must be at least the backer supply divided by this, rounded up.
    uint256 public constant LINE_DIVISOR = 3;

    /// @notice The project's backer Shares: the only token this contract accepts.
    IShares public shares;
    /// @notice The warning period in seconds: the time unit divided by 7 (24 hours on a real network).
    uint32 public day;
    /// @notice The second the line was first seen reached in an unbroken run; zero when it is not armed.
    uint64 public armedAt;
    /// @notice The sum of what `park` put in and `unpark` has not taken out.
    uint256 public parkedTotal;
    /// @notice What each holder has parked.
    mapping(address => uint256) public parkedOf;

    /// @notice `who` parked `amount` Shares. The numbers after: what they have parked, the total, the backer supply and
    /// `armedAt`.
    event Parked(
        address indexed who, uint256 amount, uint256 parkedBy, uint256 parkedTotal, uint256 backerShares, uint64 armedAt
    );
    /// @notice `who` took `amount` Shares back. The numbers after, as in `Parked`.
    event Unparked(
        address indexed who, uint256 amount, uint256 parkedBy, uint256 parkedTotal, uint256 backerShares, uint64 armedAt
    );
    /// @notice `poke` found `armedAt` changed (emitted only then).
    event Observed(uint256 parkedTotal, uint256 backerShares, uint64 armedAt);

    /// @notice `initialize` was already called (or this is the locked implementation).
    error AlreadyBorn();
    /// @notice An input is zero or not usable.
    error BadInput();
    /// @notice The caller has fewer Shares parked than the amount.
    error TooMuch(uint256 amount, uint256 parked);
    /// @notice The Share token did not move the Shares.
    error TransferFailed();

    constructor() {
        shares = IShares(address(1)); // locks the implementation the clones point at
    }

    /// @notice Set up the clone, once. The Launcher calls it in the transaction that creates the clone.
    /// @param shares_ The project's backer Shares.
    /// @param unit_ The project's time unit N in seconds (a multiple of 168); the warning period is `unit_ / 7`.
    function initialize(IShares shares_, uint32 unit_) external {
        if (address(shares) != address(0)) revert AlreadyBorn();
        if (address(shares_) == address(0) || unit_ == 0 || unit_ % 168 != 0) revert BadInput();
        shares = shares_;
        day = unit_ / 7;
    }

    // ================================================ park and unpark ================================================

    /// @notice Park `n` of your own backer Shares (approve this contract first). They stay yours: only you can take them
    /// back, at any time. Parking moves no money and costs no fee.
    /// @param n Shares to park.
    function park(uint256 n) external {
        if (n == 0) revert BadInput();
        _beforeChange(msg.sender);
        uint256 b = shares.totalSupply();
        _clearIfUnder(b);
        uint256 by = parkedOf[msg.sender] + n;
        parkedOf[msg.sender] = by;
        uint256 total = parkedTotal + n;
        parkedTotal = total;
        if (!IERC20(address(shares)).transferFrom(msg.sender, address(this), n)) revert TransferFailed();
        uint64 a = _arm(b);
        emit Parked(msg.sender, n, by, total, b, a);
    }

    /// @notice Take `n` of your parked Shares back, at once. No condition: not the pause, not a closed door, not a wind-down.
    /// @param n Shares to take back.
    function unpark(uint256 n) external {
        if (n == 0) revert BadInput();
        _beforeChange(msg.sender);
        uint256 mine = parkedOf[msg.sender];
        if (n > mine) revert TooMuch(n, mine);
        uint256 b = shares.totalSupply();
        _clearIfUnder(b);
        uint256 by = mine - n;
        parkedOf[msg.sender] = by;
        uint256 total = parkedTotal - n;
        parkedTotal = total;
        if (!shares.transfer(msg.sender, n)) revert TransferFailed();
        _afterUnpark(msg.sender, by);
        uint64 a = _arm(b); // clears when the line is no longer reached
        emit Unparked(msg.sender, n, by, total, b, a);
    }

    /// @notice Anyone may look at the ratio and re-arm or disarm. The Treasury calls it after every mint of backer Shares.
    /// It changes nothing else and cannot revert; it emits only when `armedAt` changed.
    function poke() external {
        uint64 before = armedAt;
        uint256 b = shares.totalSupply();
        uint64 a = _arm(b);
        if (a != before) emit Observed(parkedTotal, b, a);
    }

    // ===================================================== views =====================================================

    /// @notice True while the project's two gated calls must refuse: the line has been seen reached for a full day and is
    /// reached right now.
    function paused() external view returns (bool) {
        uint256 a = armedAt;
        if (a == 0 || block.timestamp < a + day) return false;
        return _reached(shares.totalSupply());
    }

    /// @notice The fewest parked Shares that reach the line now: one third of the backer supply, rounded up.
    function line() public view returns (uint256) {
        return (shares.totalSupply() + LINE_DIVISOR - 1) / LINE_DIVISOR;
    }

    /// @notice When the pause starts if the line stays reached; zero when nothing is armed.
    function pausesFrom() external view returns (uint256) {
        uint256 a = armedAt;
        return a == 0 ? 0 : a + day;
    }

    /// @notice Everything a reader needs in one call.
    /// @return parked Shares parked in total.
    /// @return backerShares The backer supply.
    /// @return lineShares The parked Shares that reach the line now.
    /// @return armed `armedAt`.
    /// @return pausesAt When the pause starts (zero when not armed).
    /// @return isPaused `paused()`.
    function state()
        external
        view
        returns (
            uint256 parked,
            uint256 backerShares,
            uint256 lineShares,
            uint64 armed,
            uint256 pausesAt,
            bool isPaused
        )
    {
        parked = parkedTotal;
        backerShares = shares.totalSupply();
        lineShares = (backerShares + LINE_DIVISOR - 1) / LINE_DIVISOR;
        armed = armedAt;
        pausesAt = armed == 0 ? 0 : uint256(armed) + day;
        isPaused = armed != 0 && block.timestamp >= pausesAt && _reached(backerShares);
    }

    // =================================================== plumbing ====================================================

    /// @dev Called before a park or an unpark changes `parkedOf[who]`. Empty here: the vote contract (a clone of this one
    /// in a deployment whose Council switch is on) keeps its snapshot in it, so a Share can never leave the custody without
    /// the count hearing of it.
    function _beforeChange(address) internal virtual {}

    /// @dev Called after an unpark, with the Shares `who` still has parked. Empty here: the vote contract lowers the weight
    /// cast if it has to.
    function _afterUnpark(address, uint256) internal virtual {}

    function _reached(uint256 b) private view returns (bool) {
        return b != 0 && parkedTotal * LINE_DIVISOR >= b;
    }

    /// @dev The look before a change: a line that is not reached clears `armedAt`, so a dip nobody saw cannot keep an old
    /// clock alive.
    function _clearIfUnder(uint256 b) private {
        if (armedAt != 0 && !_reached(b)) armedAt = 0;
    }

    /// @dev Arm when the line is reached and nothing is armed; clear when it is not. Returns `armedAt` after.
    function _arm(uint256 b) private returns (uint64 a) {
        a = armedAt;
        if (_reached(b)) {
            if (a == 0) armedAt = a = uint64(block.timestamp);
        } else if (a != 0) {
            armedAt = a = 0;
        }
    }
}
