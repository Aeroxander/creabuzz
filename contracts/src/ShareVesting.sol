// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The two Shares calls the vault makes. `delegate` is the DAO token's single delegation: a delegate
/// manages the owner's allocations, it does not move Shares.
interface IVestingShares {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function delegate(address delegatee) external;
}

/// @title ShareVesting
/// @notice Holds a founder's or contributor's Shares and releases them on a schedule.
///
/// WHY IT EXISTS. When a raise settles into a DAO treasury, anyone holding liquid Shares can `ragequit` and take their
/// percentage of the treasury at once. A founder allocated 60% of the Shares at launch could withdraw 60% of what the
/// backers just paid in, with no vote. The allocation therefore sits here: it still votes (the vault delegates its
/// allocations to the beneficiary, who backs and opposes proposals with it), but only what has vested can be
/// released, and only released Shares can be ragequit.
///
/// The schedule is linear from `start`, with nothing before `start + cliff`. There is no revocation and no admin:
/// Shares granted here are the beneficiary's, subject only to time. Deploy one vault per beneficiary (the DAO's
/// delegation is single, so one vault cannot serve two people).
///
/// LIFECYCLE. The deployer (`launcher`) deploys it before the DAO exists, so the vault's address can be named as an
/// initial holder; once the DAO is summoned the launcher calls `init(shares)` once. `init` reads the balance the DAO
/// minted here and fixes it as the vesting total, then delegates the vault's allocations to the beneficiary.
contract ShareVesting {
    address public immutable beneficiary;
    address public immutable launcher;
    uint64 public immutable start;
    uint64 public immutable cliff;
    uint64 public immutable duration;

    IVestingShares public shares;
    uint256 public total;
    uint256 public released;

    error OnlyLauncher();
    error AlreadyInitialized();
    error NothingGranted();
    error NotInitialized();
    error InvalidSchedule();
    event Initialized(address indexed shares, uint256 total);
    event Released(address indexed beneficiary, uint256 amount);

    constructor(address beneficiary_, uint64 start_, uint64 cliff_, uint64 duration_) {
        if (beneficiary_ == address(0) || duration_ == 0 || cliff_ > duration_) revert InvalidSchedule();
        beneficiary = beneficiary_;
        launcher = msg.sender;
        start = start_;
        cliff = cliff_;
        duration = duration_;
    }

    /// @notice One-shot, launcher only: bind the DAO's Shares token, fix the grant at the balance held, and hand the
    /// vault's voting allocations to the beneficiary.
    function init(address shares_) external {
        if (msg.sender != launcher) revert OnlyLauncher();
        if (address(shares) != address(0)) revert AlreadyInitialized();
        uint256 granted = IVestingShares(shares_).balanceOf(address(this));
        if (granted == 0) revert NothingGranted();
        shares = IVestingShares(shares_);
        total = granted;
        IVestingShares(shares_).delegate(beneficiary);
        emit Initialized(shares_, granted);
    }

    /// @notice Shares unlocked by now, whether or not they were released.
    function vested() public view returns (uint256) {
        if (address(shares) == address(0)) return 0;
        if (block.timestamp < uint256(start) + cliff) return 0;
        uint256 elapsed = block.timestamp - start;
        if (elapsed >= duration) return total;
        return (total * elapsed) / duration;
    }

    function releasable() public view returns (uint256) {
        return vested() - released;
    }

    /// @notice Send what has vested to the beneficiary. Anyone may call it; the money only ever goes one place.
    function release() external returns (uint256 amount) {
        if (address(shares) == address(0)) revert NotInitialized();
        amount = releasable();
        if (amount == 0) return 0;
        released += amount;
        shares.transfer(beneficiary, amount);
        emit Released(beneficiary, amount);
    }
}
