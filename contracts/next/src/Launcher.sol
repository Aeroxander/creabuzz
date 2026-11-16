// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "oz5/proxy/Clones.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {ShareToken} from "./ShareToken.sol";
import {Treasury} from "./Treasury.sol";
import {Vester} from "./Vester.sol";
import {IShares, IVester, MAX_SPLIT_PART} from "./Interfaces.sol";

/// @notice The only thing the Launcher asks of a pool guard (the vendored `InitializerHook`): who may create the pool.
interface IPoolGuard {
    /// @notice The only address allowed to create the guarded pool.
    function authorized() external view returns (address);
}

/// @notice What the Launcher reads of the dollar token: the number of decimals (every amount in the Treasury is in raw
/// units of a 6-decimal token).
interface IDecimals {
    /// @notice Decimals of the token.
    function decimals() external view returns (uint8);
}

/// @title Launcher
/// @notice One per network. In one transaction it creates a project's Shares, Treasury and Vester as small clones, mints
/// the 1,000,000,000 Shares to them, and ties them to a project id the founder chose, so the signed project record and
/// the chain parts match. The founder never holds the money: it goes to the Treasury, which only the rules in
/// `Treasury` can move.
///
/// Birth allocation (of 1,000,000,000 Shares): 400M for the first sale and 100M for the pool's match stay in the
/// Launcher until milestone 3 opens the sale; 200M go to the founder's Vester; 200M work pot and 100M reserve go to the
/// Treasury. Nothing here needs a vote, a reviewer, a second person or a wait.
/// @dev MILESTONE 2 VERSION: LOCAL TESTS ONLY. This Launcher can start projects but has no way to move the 500M Shares
/// it holds for each project's sale and pool (`openSale` always reverts), so any project launched on it has half its
/// Shares locked for ever. The constructor therefore refuses to run on any chain but 31337 (Foundry's and anvil's local
/// chain). Milestone 3 ships a new Launcher; projects born here are not carried over.
///
/// What a founder can and cannot rely on: the settings (`opener`, `salePath`, `quote`, `platform`, the fee numbers) are
/// plain admin-changeable values copied into each new project, so a founder commits to the exact set they saw by
/// passing its hash to `launch`. `strategy` and `poolGuard` are fixed at construction by the platform and no caller
/// supplies them. While `opener` and `salePath` are plain addresses nothing real may be deployed; milestone 3 makes
/// them contracts the Launcher derives, not settings.
///
/// The platform's settings are copied into each new project when it is launched, so changing them never reaches a
/// project that exists. The three implementations are created by this contract's constructor, so one Launcher is one
/// auditable set.
contract Launcher {
    using Clones for address;

    /// @notice Platform settings. Copied into each project at launch.
    struct Settings {
        IERC20 quote; // the dollar token
        address platform; // receives the platform's part of exit fees
        address opener; // may prove a project's pool open (milestone 3's finish; a stub until then)
        address salePath; // may take a project's reserve out for a public sale (a stub until milestone 3)
        uint16 exitFeeBps; // total exit fee in ten-thousandths: 500 = 5%
        uint16 platformFeeBps; // the part of it owed to the platform: 100 = 1%
        uint16 spendableParts; // 15
        uint16 floorParts; // 60
        uint128 agentUsd; // default daily dollar limit of an agent: 25 dollars
        uint128 agentShares; // default daily Share limit of an agent: 0.1% of the supply
    }

    /// @notice What the Launcher remembers of a project.
    struct Project {
        address founder;
        address shares;
        address treasury;
        address vester;
        uint64 launchedAt;
    }

    /// @notice How the 1,000,000,000 Shares were handed out at birth.
    struct Allocation {
        uint256 sale; // held here until milestone 3 opens the sale
        uint256 poolReserve; // held here until milestone 3 pairs it with the sale's money in the pool
        uint256 founder; // to the Vester
        uint256 workPot; // to the Treasury, for Give Shares
        uint256 reserve; // to the Treasury, leaves only through a public sale
    }

    /// @notice 400,000,000 Shares for the first sale.
    uint256 public constant SALE = 400_000_000e18;
    /// @notice 100,000,000 Shares held back to pair with the sale's money in the pool.
    uint256 public constant POOL_RESERVE = 100_000_000e18;
    /// @notice 200,000,000 Shares for the founder, released over 365 days from the day the pool opens.
    uint256 public constant FOUNDER = 200_000_000e18;
    /// @notice 200,000,000 Shares the founder may give for work.
    uint256 public constant WORK_POT = 200_000_000e18;
    /// @notice 100,000,000 Shares kept for later public sales.
    uint256 public constant RESERVE = 100_000_000e18;
    /// @notice The highest exit fee a setting may name: 10%.
    uint16 public constant MAX_EXIT_FEE_BPS = 1000;
    /// @notice The only chain this milestone's Launcher may be created on: the local test chain.
    uint256 public constant TEST_CHAIN_ID = 31_337;
    /// @notice The decimals of the dollar token every amount here assumes.
    uint8 public constant QUOTE_DECIMALS = 6;
    /// @dev Uniswap v4 reads a hook's permissions from the low 14 bits of its address; the pool guard asks for exactly
    /// one, `beforeInitialize` (bit 13).
    uint160 private constant HOOK_BITS = (1 << 14) - 1;
    uint160 private constant BEFORE_INITIALIZE = 1 << 13;

    /// @notice The ShareToken the clones copy.
    address public immutable shareImpl;
    /// @notice The Treasury the clones copy.
    address public immutable treasuryImpl;
    /// @notice The Vester the clones copy.
    address public immutable vesterImpl;
    /// @notice The pool strategy every sale will use. Fixed by the platform at construction; no caller names one.
    address public immutable strategy;
    /// @notice The pool guard (the hook of every project's pool). Fixed by the platform at construction.
    address public immutable poolGuard;

    /// @notice Who may change the settings (for new projects) or hand this role on. Zero once renounced.
    address public admin;
    /// @notice The settings the next project will be born with.
    Settings public settings;
    mapping(bytes32 => Project) private _projects;

    /// @notice One event with everything a server needs to index a project.
    event ProjectLaunched(
        bytes32 indexed projectId,
        address indexed founder,
        address shares,
        address treasury,
        address vester,
        address quote,
        address platform,
        Allocation allocation,
        Settings settings
    );
    /// @notice The settings for new projects were changed.
    event SettingsChanged(Settings settings);
    /// @notice The admin role moved (to zero when renounced).
    event AdminChanged(address indexed admin);

    /// @notice This founder already launched a project with this id.
    error ProjectExists();
    /// @notice No such project for this founder.
    error UnknownProject();
    /// @notice The caller may not change settings.
    error NotAdmin();
    /// @notice A setting is out of range or zero.
    error BadSettings();
    /// @notice The name or symbol is empty or longer than 64 bytes.
    error BadName();
    /// @notice A sale needs the platform's pool guard: a contract at an address that asks only for the `beforeInitialize`
    /// hook bit and names the strategy as the only address allowed to create the pool.
    error NoPoolGuard();
    /// @notice The settings are not the ones the founder committed to.
    error SettingsMoved();
    /// @notice This milestone's Launcher may only be created on the local test chain.
    error TestChainOnly();
    /// @notice The sale cannot be opened yet: milestone 3 builds it.
    error SaleNotBuilt();

    /// @param admin_ Who may change the settings for new projects.
    /// @param initial The first settings.
    /// @param strategy_ The pool strategy every sale will use.
    /// @param poolGuard_ The pool guard that must be the hook of every project's pool.
    constructor(address admin_, Settings memory initial, address strategy_, address poolGuard_) {
        if (block.chainid != TEST_CHAIN_ID) revert TestChainOnly();
        if (strategy_ == address(0) || poolGuard_ == address(0)) revert BadSettings();
        (strategy, poolGuard) = (strategy_, poolGuard_);
        (shareImpl, treasuryImpl, vesterImpl) =
            (address(new ShareToken()), address(new Treasury()), address(new Vester()));
        admin = admin_;
        _set(initial);
        emit AdminChanged(admin_);
    }

    /// @notice Create a project: its Shares, Treasury and Vester, with every Share minted to its place. The caller is the
    /// founder. The project is known by `(founder, projectId)`, so nobody can take an id the founder has not used.
    /// @param projectId The id in the founder's signed project record.
    /// @param name The Shares' name (1 to 64 bytes).
    /// @param symbol The Shares' ticker (1 to 64 bytes).
    /// @param expectedSettingsHash `settingsHash()` as the founder saw it. If the admin changed the settings since, the
    /// launch reverts instead of giving the founder a project built on settings they never agreed to.
    function launch(bytes32 projectId, string calldata name, string calldata symbol, bytes32 expectedSettingsHash)
        external
        returns (address shares, address treasury, address vester)
    {
        if (settingsHash() != expectedSettingsHash) revert SettingsMoved();
        bytes32 key = keyOf(msg.sender, projectId);
        if (_projects[key].shares != address(0)) revert ProjectExists();
        if (
            bytes(name).length == 0 || bytes(name).length > 64 || bytes(symbol).length == 0 || bytes(symbol).length > 64
        ) {
            revert BadName();
        }
        Settings memory s = settings;
        shares = shareImpl.cloneDeterministic(keccak256(abi.encode(key, "shares")));
        treasury = treasuryImpl.cloneDeterministic(keccak256(abi.encode(key, "treasury")));
        vester = vesterImpl.cloneDeterministic(keccak256(abi.encode(key, "vester")));

        address[] memory to = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        (to[0], amounts[0]) = (address(this), SALE + POOL_RESERVE);
        (to[1], amounts[1]) = (vester, FOUNDER);
        (to[2], amounts[2]) = (treasury, WORK_POT + RESERVE);
        ShareToken(shares).initialize(name, symbol, to, amounts);
        Vester(vester).initialize(IShares(shares), treasury, treasury, msg.sender, FOUNDER);
        Treasury(treasury)
            .initialize(
                Treasury.Setup({
                    quote: s.quote,
                    shares: IShares(shares),
                    vester: IVester(vester),
                    founder: msg.sender,
                    platform: s.platform,
                    opener: s.opener,
                    salePath: s.salePath,
                    exitFeeBps: s.exitFeeBps,
                    platformFeeBps: s.platformFeeBps,
                    spendableParts: s.spendableParts,
                    floorParts: s.floorParts,
                    agentUsd: s.agentUsd,
                    agentShares: s.agentShares,
                    workPot: WORK_POT
                })
            );
        _projects[key] = Project({
            founder: msg.sender, shares: shares, treasury: treasury, vester: vester, launchedAt: uint64(block.timestamp)
        });
        emit ProjectLaunched(
            projectId,
            msg.sender,
            shares,
            treasury,
            vester,
            address(s.quote),
            s.platform,
            Allocation({sale: SALE, poolReserve: POOL_RESERVE, founder: FOUNDER, workPot: WORK_POT, reserve: RESERVE}),
            s
        );
    }

    /// @notice Open the project's sale. A stub: it checks the platform's pool guard and then reverts, because the sale is
    /// built in milestone 3. A sale with no proper pool guard is never opened: without one a stranger could create the
    /// project's pool first, at a price of their choosing, and the finish could not tell it from the real one. The
    /// guard and the strategy are the platform's, fixed at construction; the caller names only the project, so a
    /// founder cannot supply a guard of their own that merely claims the right things.
    /// @param projectId The founder's project id.
    function openSale(bytes32 projectId) external view {
        if (_projects[keyOf(msg.sender, projectId)].shares == address(0)) revert UnknownProject();
        address guard = poolGuard;
        // no contract there, or an address that does not ask for exactly the `beforeInitialize` bit (the pool manager
        // would then never call it, and the guard would guard nothing)
        if (guard.code.length == 0 || uint160(guard) & HOOK_BITS != BEFORE_INITIALIZE) revert NoPoolGuard();
        try IPoolGuard(guard).authorized() returns (address creator) {
            if (creator != strategy) revert NoPoolGuard();
        } catch {
            revert NoPoolGuard();
        }
        revert SaleNotBuilt();
    }

    /// @notice Change the settings new projects are born with. Projects already launched keep what they were born with.
    function setSettings(Settings calldata next) external {
        if (msg.sender != admin) revert NotAdmin();
        _set(next);
    }

    /// @notice Hand the admin role on, or renounce it with the zero address (settings then never change again).
    function transferAdmin(address next) external {
        if (msg.sender != admin) revert NotAdmin();
        admin = next;
        emit AdminChanged(next);
    }

    /// @notice What the Launcher knows of a project.
    function project(address founder, bytes32 projectId) external view returns (Project memory) {
        return _projects[keyOf(founder, projectId)];
    }

    /// @notice A hash of the settings a project launched now would be born with. A founder's app reads it and passes it
    /// to `launch`.
    function settingsHash() public view returns (bytes32) {
        return keccak256(abi.encode(settings));
    }

    /// @notice The key a project is stored under.
    function keyOf(address founder, bytes32 projectId) public pure returns (bytes32) {
        return keccak256(abi.encode(founder, projectId));
    }

    function _set(Settings memory s) private {
        if (
            address(s.quote) == address(0) || s.platform == address(0) || s.opener == address(0)
                || s.salePath == address(0) || s.exitFeeBps > MAX_EXIT_FEE_BPS || s.platformFeeBps > s.exitFeeBps
                || s.spendableParts == 0 || s.floorParts == 0 || s.spendableParts > MAX_SPLIT_PART
                || s.floorParts > MAX_SPLIT_PART
        ) revert BadSettings();
        // the dollar token must be a contract with the decimals every amount assumes, and fees must not go to the token
        // or to this contract (where they could never be collected)
        if (s.platform == address(this) || s.platform == address(s.quote) || address(s.quote).code.length == 0) {
            revert BadSettings();
        }
        try IDecimals(address(s.quote)).decimals() returns (uint8 d) {
            if (d != QUOTE_DECIMALS) revert BadSettings();
        } catch {
            revert BadSettings();
        }
        settings = s;
        emit SettingsChanged(s);
    }
}
