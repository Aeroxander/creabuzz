// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPayoutsDao {
    function shares() external view returns (address);
    function loot() external view returns (address);
    function payouts() external view returns (address);
}

interface ILockGuarded {
    function lockGuard() external view returns (address);
    function lockGuardSet() external view returns (bool);
}

/// @title Payouts
/// @notice Payouts to a DAO's holders (N10, docs/v3-review/PAYOUTS.md), for test networks. Two ways money reaches holders:
/// - **Revenue**: money sent to this contract's address is the project's revenue. Anyone can distribute it: `splitBps`
///   of it is credited to holders and the rest goes to the treasury. Nothing else counts as revenue.
/// - **A payout the DAO votes**: `declare(amount)` takes that much from the treasury, all for holders.
///
/// Who counts: every Share and Loot outside the DAO's own holding, which is what leaving pays out on. Each holder's part is
/// kept with a running total per unit, and the DAO tells this contract of every change in who holds what (transfers,
/// mints, burns), so units count only from the moment they are held: nobody is paid for payouts made before they held
/// them, and what was credited stays theirs after they sell, leave or are banned. Each holder withdraws their own.
/// Money moves out of the treasury when it is credited, so leaving cannot pay it again.
///
/// Only for DAOs whose Shares have no lock, for good (contributor projects): locked team Shares and their unlocks are not
/// counted here, so a DAO that could still add a lock is refused. The split changes only by a vote with 30 days' notice. No admin, no pause.
contract Payouts {
    using SafeERC20 for IERC20;

    uint256 internal constant MAG = 2 ** 96;
    /// @notice A payout needs at least one whole unit counting.
    uint256 public constant MIN_COUNTING = 1e18;
    /// @notice The running total per unit stays below this, and units below `MAX_UNITS`, so the DAO's notice of a change
    /// in holders (`perUnit * amount`) can never overflow and so can never block a transfer or leaving.
    uint256 public constant MAX_PER_UNIT = 2 ** 128;
    uint256 public constant MAX_UNITS = 2 ** 100;
    uint64 public constant SPLIT_NOTICE = 30 days;

    address public immutable dao;
    IERC20 public immutable shares;
    IERC20 public immutable loot;
    IERC20 public immutable currency;

    /// @notice The share of revenue credited to holders, in basis points; the rest goes to the treasury.
    uint16 public splitBps;
    uint16 public pendingSplitBps;
    uint64 public splitAnnouncedAt;

    /// @notice What one unit has been credited in all, times 2^96.
    uint256 public perUnit;
    /// @notice Credited to holders and not yet withdrawn: never revenue again.
    uint256 public reserved;
    mapping(address => int256) public correction;
    mapping(address => uint256) public withdrawn;
    bool private entered;

    error InvalidSetup();
    error OnlyDao();
    error NotNamed();
    error NothingNew();
    error NobodyCounting(uint256 counting);
    error NothingOwed(address who);
    error ShortTransfer(uint256 expected, uint256 received);
    error SplitNotDue(uint64 at);
    error Reentrancy();
    error TooMuch();

    event Distributed(uint256 revenue, uint256 toHolders, uint256 toTreasury, uint256 perUnit);
    event Declared(uint256 amount, uint256 perUnit);
    event Withdrawn(address indexed who, uint256 amount);
    event SplitAnnounced(uint16 bps, uint64 at);
    event SplitSet(uint16 bps);

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    modifier onlyDao() {
        if (msg.sender != dao) revert OnlyDao();
        _;
    }

    constructor(address dao_, IERC20 currency_, uint16 splitBps_) {
        if (dao_.code.length == 0 || address(currency_).code.length == 0 || splitBps_ > 10_000) revert InvalidSetup();
        address shares_ = IPayoutsDao(dao_).shares();
        if (!ILockGuarded(shares_).lockGuardSet() || ILockGuarded(shares_).lockGuard() != address(0)) {
            revert InvalidSetup();
        }
        dao = dao_;
        shares = IERC20(shares_);
        loot = IERC20(IPayoutsDao(dao_).loot());
        if (shares.totalSupply() + loot.totalSupply() >= MAX_UNITS) revert InvalidSetup();
        currency = currency_;
        splitBps = splitBps_;
    }

    // ---- told by the DAO -----------------------------------------------------------------------------------------

    /// @notice A change in who holds units: what `from` was credited stays theirs; `to` counts from now.
    function ownershipChanged(bool, address from, address to, uint256 amount) external onlyDao {
        int256 delta = int256(perUnit * amount);
        if (from != address(0) && from != dao) correction[from] += delta;
        if (to != address(0) && to != dao) correction[to] -= delta;
    }

    // ---- money in --------------------------------------------------------------------------------------------------

    /// @notice Credit the revenue that arrived since the last time: `splitBps` to holders, the rest to the treasury.
    /// Anyone may call it, once the DAO has named this contract.
    function distribute() external nonReentrant {
        _named();
        uint256 fresh = currency.balanceOf(address(this)) - reserved;
        if (fresh == 0) revert NothingNew();
        uint256 holders = fresh * splitBps / 10_000;
        uint256 credited = holders == 0 ? 0 : _credit(holders);
        // What rounding kept from holders stays here and is counted again next time.
        uint256 treasury = fresh - holders;
        emit Distributed(fresh, credited, treasury, perUnit);
        if (treasury != 0) currency.safeTransfer(dao, treasury);
    }

    /// @notice Pay holders `amount` from the treasury, all of it: a payout the DAO voted.
    function declare(uint256 amount) external onlyDao nonReentrant {
        _named();
        uint256 before = currency.balanceOf(address(this));
        currency.safeTransferFrom(dao, address(this), amount);
        uint256 received = currency.balanceOf(address(this)) - before;
        if (received != amount) revert ShortTransfer(amount, received);
        _credit(amount);
        emit Declared(amount, perUnit);
    }

    // ---- money out -------------------------------------------------------------------------------------------------

    /// @notice Send `who` everything credited to them and not yet withdrawn. Anyone may call it; it only pays `who`.
    function withdraw(address who) external nonReentrant {
        uint256 amount = owed(who);
        if (amount == 0) revert NothingOwed(who);
        withdrawn[who] += amount;
        reserved -= amount;
        emit Withdrawn(who, amount);
        currency.safeTransfer(who, amount);
    }

    // ---- the split -------------------------------------------------------------------------------------------------

    /// @notice Announce a new split; it can take effect `SPLIT_NOTICE` later.
    function announceSplit(uint16 bps) external onlyDao {
        if (bps > 10_000) revert InvalidSetup();
        pendingSplitBps = bps;
        splitAnnouncedAt = uint64(block.timestamp);
        emit SplitAnnounced(bps, splitAnnouncedAt);
    }

    /// @notice Make an announced split take effect, once its notice is over. Anyone may call it.
    function applySplit() external {
        uint64 at = splitAnnouncedAt + SPLIT_NOTICE;
        if (splitAnnouncedAt == 0 || block.timestamp < at) revert SplitNotDue(at);
        splitBps = pendingSplitBps;
        splitAnnouncedAt = 0;
        emit SplitSet(splitBps);
    }

    // ---- reads -----------------------------------------------------------------------------------------------------

    /// @notice The units that count now: every Share and Loot outside the DAO's own holding.
    function counting() public view returns (uint256) {
        return shares.totalSupply() + loot.totalSupply() - shares.balanceOf(dao) - loot.balanceOf(dao);
    }

    function unitsOf(address who) public view returns (uint256) {
        return who == dao ? 0 : shares.balanceOf(who) + loot.balanceOf(who);
    }

    /// @notice What `who` can withdraw now.
    function owed(address who) public view returns (uint256) {
        int256 total = int256(perUnit * unitsOf(who)) + correction[who];
        if (total <= 0) return 0;
        uint256 credited = uint256(total) / MAG;
        return credited > withdrawn[who] ? credited - withdrawn[who] : 0;
    }

    // ---- inside ----------------------------------------------------------------------------------------------------

    function _named() private view {
        if (IPayoutsDao(dao).payouts() != address(this)) revert NotNamed();
    }

    /// @dev Credit `amount` across the units counting now; returns what was set aside for them, which rounds up so
    /// every holder's rounded-down share is always covered, and never exceeds `amount`.
    function _credit(uint256 amount) private returns (uint256 credited) {
        uint256 c = counting();
        if (c < MIN_COUNTING) revert NobodyCounting(c);
        uint256 increment = amount * MAG / c;
        if (perUnit + increment >= MAX_PER_UNIT || c >= MAX_UNITS) revert TooMuch();
        perUnit += increment;
        credited = (increment * c + MAG - 1) / MAG;
        reserved += credited;
    }
}

/// @title PayoutsFactory
/// @notice Makes a DAO's payout module at an address known before it exists, so one vote can make it and name it:
/// `create(dao, currency, splitBps)` then `dao.setPayouts(predict(...))`, in one batch. Anyone may make a module first;
/// it is the same contract either way, and `create` then returns it, so making it early cannot make the vote fail.
contract PayoutsFactory {
    /// @notice The DAO each module this factory made is for: how a DAO knows a module is this code, made for it.
    mapping(address => address) public daoOf;

    event Created(address indexed dao, address payouts, address currency, uint16 splitBps);

    function create(address dao, IERC20 currency, uint16 splitBps) external returns (Payouts module) {
        address made = predict(dao, currency, splitBps);
        if (made.code.length != 0) return Payouts(made);
        module = new Payouts{salt: _salt(dao, currency, splitBps)}(dao, currency, splitBps);
        daoOf[address(module)] = dao;
        emit Created(dao, address(module), address(currency), splitBps);
    }

    function predict(address dao, IERC20 currency, uint16 splitBps) public view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                _salt(dao, currency, splitBps),
                keccak256(abi.encodePacked(type(Payouts).creationCode, abi.encode(dao, currency, splitBps)))
            )
        );
        return address(uint160(uint256(hash)));
    }

    function _salt(address dao, IERC20 currency, uint16 splitBps) private pure returns (bytes32) {
        return keccak256(abi.encode(dao, currency, splitBps));
    }
}
