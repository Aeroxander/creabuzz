// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "oz5/proxy/Clones.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {ShareToken} from "./ShareToken.sol";
import {Treasury} from "./Treasury.sol";
import {Vester} from "./Vester.sol";
import {Finisher} from "./Finisher.sol";
import {LiquidityHolder} from "./LiquidityHolder.sol";
import {IShares, IVester, IFinisher, MAX_SPLIT_PART} from "./Interfaces.sol";
import {
    IPinnedStrategy,
    IPinnedAuctionFactory,
    IPinnedFeeController,
    IPinnedMinBid,
    IPinnedGuard,
    MigratorParameters,
    PoolParameters,
    LiquidityAllocationBracket,
    AuctionParameters,
    SaleParams
} from "./Pinned.sol";

/// @notice What the Launcher reads of the dollar token: the number of decimals (every amount in the Treasury is in raw
/// units of a 6-decimal token).
interface IDecimals {
    /// @notice Decimals of the token.
    function decimals() external view returns (uint8);
}

/// @notice The question that tells a mutable fee controller (the vendored one has an owner) from ours (which has none).
interface IOwned {
    /// @notice The address that may change the controller's settings.
    function owner() external view returns (address);
}

/// @title Launcher
/// @notice One per network. In one transaction it creates a project's Shares, Treasury, Vester and Finisher as small clones,
/// mints the 1,000,000,000 Shares to them, and ties them to a project id the founder chose. Later, in one transaction by the
/// founder, `openSale` opens the project's one public sale: it fills in every setting of the auction and of the pool strategy
/// itself, so the founder chooses only one of three sizes.
///
/// Birth allocation (of 1,000,000,000 Shares): 400M for the first sale and 100M to match the sale's dollars in the pool go to
/// the project's Finisher; 200M go to the founder's Vester; 200M work pot and 100M reserve go to the Treasury. Nothing here
/// needs a vote, a reviewer, a second person or a wait.
///
/// What the founder never touches: the dollars (the auction pays its recipient, the Finisher, and the Finisher pays the
/// Treasury), the strategy, the pool guard, the fee path, the bid rules and the pool's owner (all fixed when this Launcher is
/// made), and the three addresses the Treasury trusts (`opener` is the project's Finisher, `salePath` is this Launcher).
/// Nothing about a sale is a setting an admin can change.
///
/// What the admin can change, for new projects only: the dollar token, the platform's address for exit fees, the exit fee, the
/// 15 : 60 split and the agents' default limits. A founder commits to the exact set they saw by passing its hash to `launch`.
/// @dev Deploying a Launcher needs the platform's stack to exist already: the fee controller, the auction factory, the
/// strategy (at a mined address), the pool guard (at a mined address) and the bid hook. The constructor checks that they fit
/// each other and refuses otherwise, so a Launcher cannot exist with an unguarded sale, a changeable fee, or a bid hook other
/// than 1 dollar and a 4 times cap.
contract Launcher {
    using Clones for address;

    /// @notice The three sale sizes the founder can choose from.
    enum Size {
        Small, // goal 4,000 dollars, minimum 2,000
        Standard, // goal 10,000 dollars, minimum 2,500
        Large // goal 50,000 dollars, minimum 12,500
    }

    /// @notice Platform settings for new projects. Copied into each project at launch.
    struct Settings {
        IERC20 quote; // the dollar token
        address platform; // receives the platform's part of exit fees
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
        address finisher;
        uint64 launchedAt;
    }

    /// @notice How the 1,000,000,000 Shares were handed out at birth.
    struct Allocation {
        uint256 sale; // to the Finisher, for the first sale
        uint256 poolReserve; // to the Finisher, to pair with the sale's dollars in the pool
        uint256 founder; // to the Vester
        uint256 workPot; // to the Treasury, for Give Shares
        uint256 reserve; // to the Treasury, leaves only through a public sale
    }

    /// @notice 400,000,000 Shares for the first sale.
    uint256 public constant SALE = SaleParams.SALE_SHARES;
    /// @notice 100,000,000 Shares held back to pair with the sale's money in the pool.
    uint256 public constant POOL_RESERVE = SaleParams.POOL_SHARES;
    /// @notice 200,000,000 Shares for the founder, released over 365 days from the day the pool opens.
    uint256 public constant FOUNDER = 200_000_000e18;
    /// @notice 200,000,000 Shares the founder may give for work.
    uint256 public constant WORK_POT = 200_000_000e18;
    /// @notice 100,000,000 Shares kept for later public sales.
    uint256 public constant RESERVE = 100_000_000e18;
    /// @notice The highest exit fee a setting may name: 10%.
    uint16 public constant MAX_EXIT_FEE_BPS = 1000;
    /// @notice The decimals of the dollar token every amount here assumes.
    uint8 public constant QUOTE_DECIMALS = 6;
    /// @notice The platform's cut of every raise: 3%, in millionths, as the fee controller must report it.
    uint256 public constant RAISE_FEE_PIPS = 30_000;
    /// @notice The smallest bid: 1 dollar in raw units.
    uint128 public constant MIN_BID = 1e6;
    /// @notice The highest top price a bid may name, as a multiple of the price at the time.
    uint256 public constant MAX_PRICE_MULTIPLE = 4;
    /// @dev The price grid is one hundredth of the floor price, so the floor is tick 100 and the 4-times cap is tick 400.
    uint256 private constant TICKS_IN_FLOOR = 100;
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
    /// @notice The Finisher the clones copy.
    address public immutable finisherImpl;
    /// @notice The one contract that owns every project's pool position, made by this Launcher.
    address public immutable holder;
    /// @notice The pool strategy every sale uses. Fixed by the platform at construction; no caller names one.
    address public immutable strategy;
    /// @notice The pool guard (the hook of every project's pool). Fixed by the platform at construction.
    address public immutable poolGuard;
    /// @notice The bid rules (at least 1 dollar, a top price at most 4 times the current price). Fixed at construction.
    address public immutable minBid;
    /// @notice The auction factory of the strategy; its fee controller takes 3% of every raise.
    address public immutable auctionFactory;
    /// @notice Where the 3% of every raise goes (the fee controller's recipient).
    address public immutable raiseFeeRecipient;

    /// @notice Who may change the settings (for new projects) or hand this role on. Zero once renounced.
    address public admin;
    /// @notice The settings the next project will be born with.
    Settings public settings;
    /// @notice The Treasury of the project whose Shares these are; zero for any other token.
    mapping(address shares => address treasury) public treasuryOfShares;
    mapping(bytes32 => Project) private _projects;

    /// @notice One event with everything a server needs to index a project.
    event ProjectLaunched(
        bytes32 indexed projectId,
        address indexed founder,
        address shares,
        address treasury,
        address vester,
        address finisher,
        address quote,
        address platform,
        Allocation allocation,
        Settings settings
    );
    /// @notice A project's sale was opened, with every figure the page shows.
    event SaleOpened(
        bytes32 indexed projectId,
        address indexed founder,
        address indexed auction,
        address finisher,
        Size size,
        uint256 goal,
        uint256 minimum,
        uint64 startBlock,
        uint64 endBlock,
        uint256 floorPriceQ96,
        uint256 tickSpacingQ96
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
    /// @notice The platform's strategy, fee path or bid rules do not fit the sale this Launcher builds.
    error BadStack();
    /// @notice The settings are not the ones the founder committed to.
    error SettingsMoved();

    /// @param admin_ Who may change the settings for new projects.
    /// @param initial The first settings.
    /// @param strategy_ The pool strategy every sale will use (mined to a hook address).
    /// @param poolGuard_ The pool guard that is the hook of every project's pool (mined to a hook address).
    /// @param minBid_ The bid hook: 1 dollar minimum, 4 times cap.
    constructor(address admin_, Settings memory initial, address strategy_, address poolGuard_, address minBid_) {
        if (strategy_ == address(0) || strategy_.code.length == 0 || minBid_.code.length == 0) revert BadStack();
        // the guard: a contract at an address that asks for exactly the `beforeInitialize` bit, naming the strategy as the
        // only address that may create the pool (without it a stranger could create a project's pool first)
        if (poolGuard_.code.length == 0 || uint160(poolGuard_) & HOOK_BITS != BEFORE_INITIALIZE) revert NoPoolGuard();
        try IPinnedGuard(poolGuard_).authorized() returns (address creator) {
            if (creator != strategy_) revert NoPoolGuard();
        } catch {
            revert NoPoolGuard();
        }
        // the fee path: the strategy's auction factory takes its fee from a controller that reports exactly 3% and has no
        // owner who could change it
        address factory = IPinnedStrategy(strategy_).initializerFactory();
        address controller = IPinnedAuctionFactory(factory).protocolFeeController();
        if (controller.code.length == 0) revert BadStack();
        if (IPinnedFeeController(controller).getProtocolFeeAmount(address(0), 1e6) != RAISE_FEE_PIPS) revert BadStack();
        address recipient = IPinnedFeeController(controller).protocolFeeRecipient();
        if (recipient == address(0)) revert BadStack();
        try IOwned(controller).owner() returns (address) {
            revert BadStack(); // a controller with an owner can change the fee in the middle of a sale
        } catch {}
        // the bid rules
        if (IPinnedMinBid(minBid_).minAmount() != MIN_BID || IPinnedMinBid(minBid_).maxPriceMultiple() != MAX_PRICE_MULTIPLE) {
            revert BadStack();
        }
        (strategy, poolGuard, minBid, auctionFactory, raiseFeeRecipient) =
            (strategy_, poolGuard_, minBid_, factory, recipient);
        (shareImpl, treasuryImpl, vesterImpl) =
            (address(new ShareToken()), address(new Treasury()), address(new Vester()));
        finisherImpl = address(new Finisher(address(this), strategy_, poolGuard_));
        holder = address(new LiquidityHolder(IPinnedStrategy(strategy_).positionManager(), poolGuard_));
        admin = admin_;
        _set(initial);
        emit AdminChanged(admin_);
    }

    /// @notice Create a project: its Shares, Treasury, Vester and Finisher, with every Share minted to its place. The caller is
    /// the founder. The project is known by `(founder, projectId)`, so nobody can take an id the founder has not used.
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
        address finisher = finisherImpl.cloneDeterministic(keccak256(abi.encode(key, "finisher")));

        address[] memory to = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        (to[0], amounts[0]) = (finisher, SALE + POOL_RESERVE);
        (to[1], amounts[1]) = (vester, FOUNDER);
        (to[2], amounts[2]) = (treasury, WORK_POT + RESERVE);
        ShareToken(shares).initialize(name, symbol, to, amounts);
        Vester(vester).initialize(IShares(shares), treasury, treasury, msg.sender, FOUNDER);
        IFinisher(finisher).initialize(treasury, shares, address(s.quote));
        Treasury(treasury)
            .initialize(
                Treasury.Setup({
                    quote: s.quote,
                    shares: IShares(shares),
                    vester: IVester(vester),
                    founder: msg.sender,
                    platform: s.platform,
                    opener: finisher,
                    salePath: address(this),
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
            founder: msg.sender,
            shares: shares,
            treasury: treasury,
            vester: vester,
            finisher: finisher,
            launchedAt: uint64(block.timestamp)
        });
        treasuryOfShares[shares] = treasury;
        emit ProjectLaunched(
            projectId,
            msg.sender,
            shares,
            treasury,
            vester,
            finisher,
            address(s.quote),
            s.platform,
            Allocation({sale: SALE, poolReserve: POOL_RESERVE, founder: FOUNDER, workPot: WORK_POT, reserve: RESERVE}),
            s
        );
    }

    /// @notice Open the project's public sale, in one transaction by the founder. The founder picks one of three sizes and
    /// nothing else: this fills in the 24-hour length, the minimum to go through, the smallest bid (1 dollar), the 4 times
    /// cap on a bid's top price, the floor price from the size, the 3% raise fee (through the platform's fixed fee
    /// controller), the pool (22% of the dollars raised with the Shares that match them at the sale's final price, 1% fee,
    /// the platform's guard as its hook, the position owned by the LiquidityHolder) and the recipients (the project's Finisher,
    /// never the founder). Refused for a project that already sold, while a sale is open, and for 24 hours after a sale that
    /// failed to reach its minimum.
    /// @param projectId The founder's project id.
    /// @param size Small (goal 4,000 dollars, minimum 2,000), Standard (10,000 and 2,500) or Large (50,000 and 12,500).
    /// @return auction The new auction. Bids go to it.
    function openSale(bytes32 projectId, Size size) external returns (address auction) {
        Project memory p = _projects[keyOf(msg.sender, projectId)];
        if (p.shares == address(0)) revert UnknownProject();
        (uint256 goal, uint256 minimum) = sizeOf(size);
        (uint256 floorQ96, uint256 tickQ96) = _floorAndTick(goal);
        uint64 startBlock = uint64(block.number + 1);
        uint64 endBlock_ = startBlock + SaleParams.SALE_BLOCKS;
        bytes memory configData = abi.encode(
            _strategyParams(p, endBlock_), abi.encode(_auctionParams(p, minimum, startBlock, floorQ96, tickQ96))
        );
        (auction,) = IFinisher(p.finisher).open(configData);
        emit SaleOpened(
            projectId, msg.sender, auction, p.finisher, size, goal, minimum, startBlock, endBlock_, floorQ96, tickQ96
        );
    }

    /// @notice The goal and minimum, in raw dollars (6 decimals), of a size.
    function sizeOf(Size size) public pure returns (uint256 goal, uint256 minimum) {
        if (size == Size.Small) return (4000e6, 2000e6);
        if (size == Size.Standard) return (10_000e6, 2500e6);
        return (50_000e6, 12_500e6);
    }

    /// @notice The floor price and the price grid of a size, as the auction sees them (Q96: raw dollars per raw Share times
    /// 2^96). The floor is the price at which selling every sale Share raises the goal, rounded up to a whole tick; the tick
    /// is one hundredth of the floor, so a bid's top price may be any of 300 steps from the floor to 4 times the floor.
    function salePrices(Size size) external pure returns (uint256 floorQ96, uint256 tickQ96) {
        (uint256 goal,) = sizeOf(size);
        return _floorAndTick(goal);
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

    function _floorAndTick(uint256 goal) private pure returns (uint256 floorQ96, uint256 tickQ96) {
        uint256 exact = (goal << 96) / SaleParams.SALE_SHARES;
        tickQ96 = (exact + TICKS_IN_FLOOR - 1) / TICKS_IN_FLOOR;
        floorQ96 = tickQ96 * TICKS_IN_FLOOR;
    }

    /// @dev The strategy's settings of one sale. The pool takes `POOL_RATE` of the raise after the platform's fee in one
    /// bracket; no extra ranges, so one full-range position, minted to the LiquidityHolder; the Finisher receives what the
    /// pool does not take.
    function _strategyParams(Project memory p, uint64 endBlock_) private view returns (MigratorParameters memory) {
        LiquidityAllocationBracket[] memory brackets = new LiquidityAllocationBracket[](1);
        brackets[0] = LiquidityAllocationBracket({lowerThreshold: 0, rate: SaleParams.POOL_RATE});
        return MigratorParameters({
            token: p.shares,
            currency: address(Treasury(p.treasury).quote()),
            migrationBlock: endBlock_ + 1,
            reservedTokenAmountForLP: SaleParams.POOL_SHARES,
            recipient: p.finisher,
            positionRecipient: holder,
            poolParameters: PoolParameters({
                fee: SaleParams.POOL_FEE, tickSpacing: SaleParams.POOL_TICK_SPACING, hook: poolGuard
            }),
            positionDefinitions: abi.encode(new uint256[](0)),
            lpAllocationSchedule: abi.encode(brackets)
        });
    }

    /// @dev The auction's settings: 7,200 blocks, 7,100 at 1,388 ten-millionths of the supply a block and 100 at 1,452 (they
    /// add to exactly 10,000,000, which the auction requires), the strategy as the funds recipient (the auction insists), the
    /// Finisher as the unsold-Shares recipient.
    function _auctionParams(Project memory p, uint256 minimum, uint64 startBlock, uint256 floorQ96, uint256 tickQ96)
        private
        view
        returns (AuctionParameters memory)
    {
        return AuctionParameters({
            currency: address(Treasury(p.treasury).quote()),
            tokensRecipient: p.finisher,
            fundsRecipient: strategy,
            startBlock: startBlock,
            endBlock: startBlock + SaleParams.SALE_BLOCKS,
            claimBlock: startBlock + SaleParams.SALE_BLOCKS + 1,
            tickSpacing: tickQ96,
            validationHook: minBid,
            floorPrice: floorQ96,
            requiredCurrencyRaised: uint128(minimum),
            auctionStepsData: abi.encodePacked(bytes8(uint64(1388) << 40 | uint64(7100)), bytes8(uint64(1452) << 40 | uint64(100)))
        });
    }

    function _set(Settings memory s) private {
        if (
            address(s.quote) == address(0) || s.platform == address(0) || s.exitFeeBps > MAX_EXIT_FEE_BPS
                || s.platformFeeBps > s.exitFeeBps || s.spendableParts == 0 || s.floorParts == 0
                || s.spendableParts > MAX_SPLIT_PART || s.floorParts > MAX_SPLIT_PART
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
