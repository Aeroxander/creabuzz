// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {SafeERC20} from "oz5/token/ERC20/utils/SafeERC20.sol";
import {IShares, ITreasuryFinish, ILauncherView} from "./Interfaces.sol";
import {IPinnedPositionManager, PoolKey} from "./Pinned.sol";

/// @title LiquidityHolder
/// @notice Owns the Uniswap position of every project's pool, for good. The strategy mints each position straight to this
/// contract, so nobody else ever held it, and this contract has no function that removes liquidity, moves a position,
/// approves anyone for one, or signs for one. The only thing that leaves is trading fees: anyone may call `collect`, and the
/// dollar side is split half to the platform and half to the project's Treasury (into its spendable bucket) while the Share
/// side is burned.
///
/// What "for good" rests on, and what could still go wrong:
///  - The position NFT can leave only if its owner, this contract, transfers or approves it, or signs a permit for it. This
///    contract has no code that does any of that. It also implements neither `isValidSignature` (so a permit signed "by"
///    this contract cannot be made) nor `onERC721Received`. `test/LiquidityHolder.t.sol` pins the contract's exact list of
///    functions, so adding one breaks a test.
///  - Liquidity can leave only through the position manager's `DECREASE_LIQUIDITY` or `BURN_POSITION`, which need the owner
///    or an approved address; the only call this contract makes is a decrease of zero, to collect fees.
///  - It can still go wrong inside Uniswap's own code (the pool manager or the position manager have a bug), which this
///    contract cannot protect against; and a dollar token that freezes the platform's address makes the platform's half wait
///    in `owed` (the project's half and the burn go through).
/// @dev One per Launcher, made in its constructor, so `launcher` is the contract that made this one. A position counts only if
/// its pool has the platform's guard as its hook and one of its currencies is a real project's Shares. Only the strategy can
/// create a pool with that hook, and only for a sale this platform's Launcher opened, so the fee, the tick spacing and the dollar
/// token are the project's own by construction; an NFT of any other pool that is sent here is a gift that nobody can use.
contract LiquidityHolder {
    using SafeERC20 for IERC20;

    // Position manager action numbers (v4-periphery `libraries/Actions.sol`); `PinnedDrift.t.sol` checks them.
    uint8 private constant DECREASE_LIQUIDITY = 0x01;
    uint8 private constant TAKE_PAIR = 0x11;

    /// @notice The Launcher that made this contract; it knows which Treasury each project's Shares belong to.
    address public immutable launcher;
    /// @notice Uniswap's position manager.
    IPinnedPositionManager public immutable positionManager;
    /// @notice The pool guard that is the hook of every project's pool.
    address public immutable guard;

    /// @notice Dollars that could not be sent to an address (its token refused) and wait for `sweepOwed`: token, then address.
    mapping(address token => mapping(address to => uint256)) public owed;
    bool private transient _locked;

    /// @notice Fees were collected from a project's position and split.
    event Collected(
        uint256 indexed tokenId,
        address indexed treasury,
        uint256 dollars,
        uint256 toPlatform,
        uint256 toProject,
        uint256 sharesBurned
    );
    /// @notice An amount that could not be sent was kept for the address.
    event Owed(address indexed token, address indexed to, uint256 amount);
    /// @notice An owed amount was sent.
    event OwedSent(address indexed token, address indexed to, uint256 amount);

    /// @notice The position is not held by this contract.
    error NotHeld();
    /// @notice The position belongs to no project of this platform: its pool is not a project's pool.
    error UnknownProject();
    /// @notice A call came back into this contract while another was running.
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    /// @param positionManager_ Uniswap's position manager.
    /// @param guard_ The platform's pool guard.
    constructor(address positionManager_, address guard_) {
        (launcher, positionManager, guard) = (msg.sender, IPinnedPositionManager(positionManager_), guard_);
    }

    /// @notice Collect a position's trading fees and split them: half the dollars to the platform, half to the project's
    /// Treasury (spendable), all Shares burned. Anyone may call it, as often as they like. Removes no liquidity.
    /// @param tokenId The position NFT (held by this contract).
    /// @return dollars The dollars collected.
    /// @return sharesBurned The Shares collected and burned.
    function collect(uint256 tokenId) external nonReentrant returns (uint256 dollars, uint256 sharesBurned) {
        if (positionManager.ownerOf(tokenId) != address(this)) revert NotHeld();
        (PoolKey memory key,) = positionManager.getPoolAndPositionInfo(tokenId);
        (address treasury, address sharesToken, address quote) = _project(key);

        uint256 q0 = IERC20(quote).balanceOf(address(this));
        uint256 s0 = IERC20(sharesToken).balanceOf(address(this));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        positionManager.modifyLiquidities(
            abi.encode(abi.encodePacked(DECREASE_LIQUIDITY, TAKE_PAIR), params), block.timestamp
        );
        dollars = IERC20(quote).balanceOf(address(this)) - q0;
        sharesBurned = IERC20(sharesToken).balanceOf(address(this)) - s0;

        uint256 toPlatform = dollars / 2;
        uint256 toProject = dollars - toPlatform;
        if (toPlatform != 0) _sendOrOwe(quote, ITreasuryFinish(treasury).platform(), toPlatform);
        if (toProject != 0) {
            IERC20(quote).forceApprove(treasury, toProject);
            ITreasuryFinish(treasury).topUp(toProject);
        }
        if (sharesBurned != 0) IShares(sharesToken).burn(sharesBurned);
        emit Collected(tokenId, treasury, dollars, toPlatform, toProject, sharesBurned);
    }

    /// @notice Send an amount that could not be sent in `collect` (for example to a frozen address). Anyone may call it.
    function sweepOwed(address token, address to) external nonReentrant {
        uint256 amount = owed[token][to];
        if (amount == 0) return;
        owed[token][to] = 0;
        IERC20(token).safeTransfer(to, amount);
        emit OwedSent(token, to, amount);
    }

    /// @dev The project a position belongs to. The pool's hook must be the platform's guard: only the strategy can create such a
    /// pool, and only for a sale this platform's Launcher opened, so one of its two currencies is that project's Shares and the other
    /// its dollar token, and the fee and tick spacing are the Launcher's. (A removal run showed a separate "exactly one side is a
    /// project's Shares" check could never be reached without a guarded pool, so there is none.)
    function _project(PoolKey memory key) private view returns (address treasury, address sharesToken, address quote) {
        if (key.hooks != guard) revert UnknownProject();
        address t0 = ILauncherView(launcher).treasuryOfShares(key.currency0);
        (treasury, sharesToken, quote) = t0 != address(0)
            ? (t0, key.currency0, key.currency1)
            : (ILauncherView(launcher).treasuryOfShares(key.currency1), key.currency1, key.currency0);
    }

    /// @dev A token that refuses a transfer (a frozen address) must not stop the project's half or the burn.
    function _sendOrOwe(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            owed[token][to] += amount;
            emit Owed(token, to, amount);
        }
    }
}
