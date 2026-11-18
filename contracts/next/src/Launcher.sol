// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "oz5/proxy/Clones.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {ShareToken} from "./ShareToken.sol";
import {Treasury} from "./Treasury.sol";
import {Vester} from "./Vester.sol";
import {Finisher} from "./Finisher.sol";
import {Rounds} from "./Rounds.sol";
import {Pair} from "./Pair.sol";
import {Parts} from "./Parts.sol";
import {LiquidityHolder} from "./LiquidityHolder.sol";
import {
    IShares,
    IVester,
    IFinisher,
    ITreasuryRounds,
    ITreasuryRunner,
    IEarlierBackers,
    MAX_SPLIT_PART
} from "./Interfaces.sol";
import {
    IPinnedStrategy,
    IPinnedAuctionFactory,
    IPinnedFeeController,
    IPinnedMinBid,
    IPinnedGuard,
    IPinnedAuction,
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
/// @notice One per network, and the keeper of every project's stage. In one transaction `launch` creates a project's Shares,
/// Treasury, Vester, Rounds and Finisher as small clones, mints the 1,000,000,000 Shares to them and ties them to a project id
/// the founder chose. From then on the project's runner (the Treasury's `runner`: the founder, then a Pair, later a Council)
/// asks this contract for every raise, and this contract enforces the stage rules:
///  - Solo to Backed: `openRound` opens a 24-hour backing round sized to whatever is left under the cap: 10,000 dollars in
///    total while the runner is one person, 50,000 with a Pair (or a Council). The runner names the round's price (see
///    `Rounds`: 333,333 to 50,000,000 dollars for the whole project), fixed for the round; the caps stay in dollars at every
///    price. A project is Backed once a round closed with money in it (read from the Rounds). Rounds may follow each other
///    with no wait inside the cap.
///  - Team: the founder offers the runner seat to a Pair and the second signer accepts with `makePair` (two transactions).
///  - The one auction (`openAuction`): only a Pair runner (and, when `requireCouncilForAuction`, only a Council runner);
///    250,000,000 Shares from a starting price the runner names (at least 0.0004 dollars a Share, `salePrices`, and at most
///    0.05, `MAX_START_Q96`), a minimum of what all 250,000,000 raise at that price (100,000 dollars at 0.0004: every Share
///    sold at the starting price or above), bids at most 4 times the starting price, no bids in the last 720 blocks, the
///    3 / 22 / 15 / 60 split through the built Finisher. Creaton's stake (20,000,000 Shares from the reserve, held) is set
///    aside by the Treasury when the Finisher proves the pool open.
///  - "No market" (`declareNoMarket`): the runner, 365 days after the first round that took money (or after launch if none
///    did), while no auction is running: the Vester's clock starts and no auction ever opens.
///  - Reserve sales (`openReserveSale`): a plain auction of reserve Shares, starting at the last sale's end price, at least
///    28 days (201,600 blocks) after the last sale ended, 3 / 15 / 82 into the floor, no pool step. Only a Council runner.
///  - Wind down (`windDown`): the runner before a market, only a Council runner after it.
///
/// Birth allocation (of 1,000,000,000 Shares): founder 200M (Vester), work pot 200M and reserve 100M (Treasury), backing 150M
/// (Rounds), auction 250M and pool match 100M (Finisher). Unsold auction Shares, Shares the pool did not take, unsold backing
/// Shares and Shares cancelled by refunds join the reserve.
///
/// What the founder never touches: the dollars (rounds pay the Treasury, the auction pays the Finisher and the Finisher pays
/// the Treasury), the strategy, the pool guard, the fee path, the bid rules, the price ranges, the caps and the pool's owner
/// (all fixed when this Launcher is made), and the three addresses the Treasury trusts (`opener` is the project's Finisher,
/// `salePath` is this Launcher, `rounds` is the project's Rounds).
///
/// What the admin can change, for new projects only: the dollar token, the platform's address for fees, the stake's address,
/// the exit fee, the 15 : 60 split and the agents' default limits. A founder commits to the exact set they saw by passing its
/// hash to `launch`. Nothing in a launched project follows a later change. The admin may also name, once, the one project
/// that launches with no stake (`nameProjectZero`: Creaton's own project, project zero); no other project can.
///
/// Project zero only (Creaton's own project, `docs/next-version/EARLIER-BACKERS.md`), two differences from every other
/// launch. First, its founder's slice is not granted to the founder: it goes to the Treasury as a public, earmarked team
/// budget the runner pays out over time (`Treasury.payTeam`, a gift's rules), and the founder's Vester grant is zero.
/// Second, its earlier raise (Creaton's backers under the old SAFTs): the admin names the claim contract
/// (`nameEarlierBackers`: an `EarlierBackers` made for this Launcher and project zero's key) and the backing Shares project
/// zero keeps for its own rounds. At that launch the list's total comes first from the backing Shares beyond those kept,
/// then from the founder's slice (so the team budget is what is left of it); the Vester makes the claim contract one plain
/// grant of it, and project zero's launch hash covers the claim and the amount kept. The work pot, the reserve, the auction
/// and the pool match are never touched, and no other launch can use either.
/// @dev The Council is milestone 9. The seam here: `councilMaker`, fixed at construction (zero on every network until the
/// Council contract exists), is the only address that may mark an address as a Council (`registerCouncil`) and name a
/// project's pauser (`setPauser`, for the holders' vote).
contract Launcher {
    using Clones for address;

    /// @notice Who runs a project, as far as the stage rules care.
    enum RunnerKind {
        Single, // one person (the founder, or a successor they named)
        Pair, // a Pair made by this Launcher
        Council // an address the council maker registered
    }

    /// @notice The five stages of the plan, read from the chain.
    enum Stage {
        Solo,
        Backed,
        Team,
        Council,
        Open
    }

    /// @notice Platform settings for new projects. Copied into each project at launch.
    struct Settings {
        IERC20 quote; // the dollar token
        address platform; // receives the platform's part of exit and refund fees and of backing rounds
        address stake; // receives Creaton's stake (held) when a project's market opens
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
        address rounds;
        uint64 launchedAt;
    }

    /// @notice How the 1,000,000,000 Shares were handed out at birth.
    struct Allocation {
        uint256 sale; // to the Finisher, for the one auction
        uint256 poolReserve; // to the Finisher, to pair with the auction's dollars in the pool
        uint256 founder; // to the Vester (zero for project zero: its slice is the team budget, see `ProjectZeroSplit`)
        uint256 workPot; // to the Treasury, for Give Shares
        uint256 reserve; // to the Treasury, leaves only through a reserve sale and the stake
        uint256 backing; // to the Rounds, for backing rounds
    }

    /// @notice A project's reserve sales.
    struct ReserveSales {
        address auction; // the reserve sale running now; zero when none
        uint64 lastEndBlock; // the last block of the last finished sale (the auction or a reserve sale)
        uint256 lastEndPriceQ96; // the price the last finished sale ended at
        uint32 count; // reserve sales opened so far
    }

    /// @notice 250,000,000 Shares for the one auction.
    uint256 public constant SALE = SaleParams.SALE_SHARES;
    /// @notice 100,000,000 Shares held back to pair with the auction's money in the pool.
    uint256 public constant POOL_RESERVE = SaleParams.POOL_SHARES;
    /// @notice 200,000,000 Shares for the founder, held in the Vester.
    uint256 public constant FOUNDER = 200_000_000e18;
    /// @notice 200,000,000 Shares the runner may give for work.
    uint256 public constant WORK_POT = 200_000_000e18;
    /// @notice 100,000,000 Shares kept for reserve sales and the stake.
    uint256 public constant RESERVE = 100_000_000e18;
    /// @notice 150,000,000 Shares for backing rounds (50,000 dollars at 3,000 Shares a dollar).
    uint256 public constant BACKING = 150_000_000e18;
    /// @notice Creaton's stake when a market opens: 20,000,000 Shares from the reserve, held.
    uint256 public constant STAKE = 20_000_000e18;
    /// @notice The most outside money backing rounds may take in total while the runner is one person: 10,000 dollars.
    uint256 public constant SOLO_CAP = 10_000e6;
    /// @notice The most backing rounds may take in total with a Pair or Council runner: 50,000 dollars.
    uint256 public constant TEAM_CAP = 50_000e6;
    /// @notice The least auction minimum: 100,000 dollars, every auction Share sold at the lowest starting price. A higher
    /// starting price has a higher minimum (all 250,000,000 Shares at that price).
    uint256 public constant AUCTION_MINIMUM = 100_000e6;
    /// @notice The highest starting price the runner may name for the auction: 0.05 dollars a Share (50,000,000 dollars for
    /// the whole project), as raw dollars per raw Share times 2^96.
    uint256 public constant MAX_START_Q96 = (uint256(50_000) << 96) / 1e18;
    /// @notice "No market" may be declared this long after the first round that took money (or after launch).
    uint256 public constant NO_MARKET_AFTER = 365 days;
    /// @notice Reserve sales start at least this many blocks after the last sale ended: 28 days at 12 seconds.
    uint64 public constant RESERVE_SALE_GAP_BLOCKS = 201_600;
    /// @notice From this long after the market opened the stage reads Open.
    uint256 public constant OPEN_AFTER = 365 days;
    /// @notice The highest exit fee a setting may name: 10%.
    uint16 public constant MAX_EXIT_FEE_BPS = 1000;
    /// @notice The decimals of the dollar token every amount here assumes.
    uint8 public constant QUOTE_DECIMALS = 6;
    /// @notice The platform's cut of every raise: 3%, in millionths, as the fee controller must report it.
    uint256 public constant RAISE_FEE_PIPS = 30_000;
    /// @notice The smallest bid: 1 dollar in raw units.
    uint128 public constant MIN_BID = 1e6;
    /// @notice The highest top price a bid may name, as a multiple of the sale's starting price (absolute: it never moves
    /// during a sale, so no clearing price can pass it).
    uint256 public constant MAX_PRICE_MULTIPLE = 4;
    /// @notice No bids in the last 720 blocks of a sale (see `MinBid`).
    uint64 public constant BID_CLOSING_BLOCKS = SaleParams.BID_CLOSING_BLOCKS;
    /// @dev The price grid is one hundredth of the starting price, so it is tick 100 and the 4-times cap is tick 400.
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
    /// @notice The Rounds the clones copy.
    address public immutable roundsImpl;
    /// @notice The Pair the clones copy.
    address public immutable pairImpl;
    /// @notice The Finisher the clones copy.
    address public immutable finisherImpl;
    /// @notice The one contract that owns every project's pool position, made by this Launcher.
    address public immutable holder;
    /// @notice The pool strategy every sale uses. Fixed by the platform at construction; no caller names one.
    address public immutable strategy;
    /// @notice The pool guard (the hook of every project's pool). Fixed by the platform at construction.
    address public immutable poolGuard;
    /// @notice The bid rules (at least 1 dollar, a top price at most 4 times the starting price). Fixed at construction.
    address public immutable minBid;
    /// @notice The auction factory of the strategy; its fee controller takes 3% of every raise.
    address public immutable auctionFactory;
    /// @notice Where the 3% of every auction raise goes (the fee controller's recipient).
    address public immutable raiseFeeRecipient;
    /// @notice The only address that may register a Council or name a pauser (milestone 9); zero for none.
    address public immutable councilMaker;
    /// @notice True on every network but a local test chain (31337) and Sepolia: the auction then needs a Council runner.
    bool public immutable requireCouncilForAuction;
    /// @notice The code hash every earlier backers' claim contract must have (read from `Parts`).
    bytes32 public immutable earlierCodeHash;

    /// @notice Who may change the settings (for new projects) or hand this role on. Zero once renounced.
    address public admin;
    /// @notice The settings the next project will be born with.
    Settings public settings;
    /// @notice The Treasury of the project whose Shares these are; zero for any other token.
    mapping(address shares => address treasury) public treasuryOfShares;
    /// @notice Pairs this Launcher made.
    mapping(address => bool) public isPair;
    /// @notice Addresses the council maker registered as Councils.
    mapping(address => bool) public isCouncil;
    /// @notice The key (`keyOf`) of the one project that launches with no stake: project zero, Creaton's own. Zero when none
    /// is named. Its launch uses the name up and sets `projectZeroLaunched`.
    bytes32 public projectZeroKey;
    /// @notice True once project zero launched: every later project takes the stake.
    bool public projectZeroLaunched;
    /// @notice Project zero's earlier backers' claim contract (zero: none). Cleared when project zero is named again.
    address public earlierClaim;
    /// @notice The backing Shares project zero keeps for its own rounds; the rest of the backing slice goes to the claim.
    uint256 public earlierKeep;
    mapping(bytes32 => Project) private _projects;
    mapping(bytes32 => ReserveSales) private _reserve;

    /// @notice One event with everything a server needs to index a project.
    event ProjectLaunched(
        bytes32 indexed key,
        bytes32 indexed projectId,
        address indexed founder,
        Project project,
        Allocation allocation,
        Settings settings
    );
    /// @notice A backing round opened: `size` is what is left under `cap` after `raisedBefore`; `sharesPerRawDollar` is the
    /// round's price (raw Share units per raw dollar unit, fixed for the round).
    event RoundOpened(
        bytes32 indexed key,
        address indexed rounds,
        uint256 indexed round,
        uint256 size,
        uint256 cap,
        uint256 raisedBefore,
        uint256 sharesPerRawDollar
    );
    /// @notice A project's auction was opened, with every figure the page shows.
    event SaleOpened(
        bytes32 indexed key,
        address indexed auction,
        address indexed runner,
        address finisher,
        uint256 minimum,
        uint64 startBlock,
        uint64 endBlock,
        uint256 floorPriceQ96,
        uint256 tickSpacingQ96
    );
    /// @notice The second signer accepted: `pair` now runs the project.
    event PairMade(bytes32 indexed key, address indexed pair, address first, address second);
    /// @notice The council maker registered a Council.
    event CouncilRegistered(address indexed council);
    /// @notice The council maker named a project's pauser.
    event PauserNamed(bytes32 indexed key, address indexed pauser);
    /// @notice The project declared "no market".
    event NoMarket(bytes32 indexed key, address indexed runner);
    /// @notice The project wound down.
    event WoundDown(bytes32 indexed key, address indexed runner);
    /// @notice A reserve sale opened.
    event ReserveSaleOpened(
        bytes32 indexed key,
        address indexed auction,
        uint256 amount,
        uint256 floorPriceQ96,
        uint256 tickSpacingQ96,
        uint64 startBlock,
        uint64 endBlock
    );
    /// @notice A reserve sale finished: `toTreasury` dollars split 15 : 82, `sharesBack` unsold, `endPriceQ96` its end price.
    event ReserveSaleFinished(
        bytes32 indexed key, address indexed auction, uint256 toTreasury, uint256 sharesBack, uint256 endPriceQ96
    );
    /// @notice The settings for new projects were changed.
    event SettingsChanged(Settings settings);
    /// @notice The admin role moved (to zero when renounced).
    event AdminChanged(address indexed admin);
    /// @notice The admin named the project that will launch with no stake (zero: the name was taken back).
    event ProjectZeroNamed(bytes32 indexed key);
    /// @notice The admin named project zero's earlier backers' claim contract (zero: none) and the backing Shares it keeps.
    event EarlierBackersNamed(bytes32 indexed key, address indexed claim, uint256 keepBacking);
    /// @notice Project zero launched: the earlier backers' claim contract (zero: none) has a Vester grant of `fromBacking`
    /// (from the backing slice) plus `fromFounder` (from the founder's slice), and the rest of the founder's slice,
    /// `teamBudget`, is in the Treasury as the team budget. `ProjectLaunched` beside it shows a founder grant of zero and the
    /// backing slice after the cut.
    event ProjectZeroSplit(
        bytes32 indexed key, address indexed claim, uint256 fromBacking, uint256 fromFounder, uint256 teamBudget
    );

    /// @notice This founder already launched a project with this id.
    error ProjectExists();
    /// @notice No such project.
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
    /// @notice The platform's strategy, fee path, bid rules or parts do not fit the sale this Launcher builds.
    error BadStack();
    /// @notice The settings are not the ones the founder committed to.
    error SettingsMoved();
    /// @notice Only the project's runner may do this.
    error NotRunner();
    /// @notice Only the council maker may do this.
    error NotCouncilMaker();
    /// @notice The runner is not of the kind this needs (`needed`).
    error WrongRunner(RunnerKind needed);
    /// @notice The project is not at a point where this is allowed (a market, a wind-down, a running round or sale).
    error WrongStage();
    /// @notice The stage's cap is reached.
    error CapReached(uint256 cap);
    /// @notice Too early: allowed from `from` (a time for "no market", a block for a reserve sale).
    error TooEarly(uint256 from);
    /// @notice The auction's starting price is below `salePrices` or above `MAX_START_Q96`.
    error BadStart();
    /// @notice The earlier backers' claim is not the known code, not made for this Launcher and project zero, or does not fit
    /// in the backing Shares beyond those kept plus the founder's slice.
    error BadCut();

    /// @param admin_ Who may change the settings for new projects.
    /// @param initial The first settings.
    /// @param strategy_ The pool strategy every sale will use (mined to a hook address).
    /// @param poolGuard_ The pool guard that is the hook of every project's pool (mined to a hook address).
    /// @param minBid_ The bid hook: 1 dollar minimum, top price at most 4 times the starting price, no bids in the last 720
    /// blocks.
    /// @param parts_ The contract that made the ShareToken, Treasury, Vester, Rounds and Pair implementations.
    /// @param councilMaker_ The only address that may register Councils and name pausers; zero until milestone 9.
    constructor(
        address admin_,
        Settings memory initial,
        address strategy_,
        address poolGuard_,
        address minBid_,
        Parts parts_,
        address councilMaker_
    ) {
        if (strategy_ == address(0) || strategy_.code.length == 0 || minBid_.code.length == 0) {
            revert BadStack();
        }
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
        if (IPinnedFeeController(controller).getProtocolFeeAmount(address(0), 1e6) != RAISE_FEE_PIPS) {
            revert BadStack();
        }
        address recipient = IPinnedFeeController(controller).protocolFeeRecipient();
        if (recipient == address(0)) revert BadStack();
        try IOwned(controller).owner() returns (address) {
            revert BadStack(); // a controller with an owner can change the fee in the middle of a sale
        } catch {}
        // the bid rules
        if (
            IPinnedMinBid(minBid_).minAmount() != MIN_BID
                || IPinnedMinBid(minBid_).maxPriceMultiple() != MAX_PRICE_MULTIPLE
                || IPinnedMinBid(minBid_).closingBlocks() != BID_CLOSING_BLOCKS
        ) {
            revert BadStack();
        }
        (strategy, poolGuard, minBid, auctionFactory, raiseFeeRecipient) =
            (strategy_, poolGuard_, minBid_, factory, recipient);
        (shareImpl, treasuryImpl, vesterImpl) = (parts_.shareImpl(), parts_.treasuryImpl(), parts_.vesterImpl());
        (roundsImpl, pairImpl) = (parts_.roundsImpl(), parts_.pairImpl());
        if (
            shareImpl.code.length == 0 || treasuryImpl.code.length == 0 || vesterImpl.code.length == 0
                || roundsImpl.code.length == 0 || pairImpl.code.length == 0
        ) revert BadStack();
        finisherImpl = address(new Finisher(address(this), strategy_, poolGuard_));
        holder = address(new LiquidityHolder(IPinnedStrategy(strategy_).positionManager(), poolGuard_));
        councilMaker = councilMaker_;
        earlierCodeHash = parts_.earlierCodeHash();
        requireCouncilForAuction = block.chainid != 31_337 && block.chainid != 11_155_111;
        admin = admin_;
        _set(initial);
        emit AdminChanged(admin_);
    }

    // ================================================ birth ==========================================================

    /// @notice Create a project: its Shares, Treasury, Vester, Rounds and Finisher, with every Share minted to its place. The
    /// caller is the founder and the first runner. The project is known by `keyOf(founder, projectId)`, so nobody can take an
    /// id the founder has not used.
    /// @param projectId The id in the founder's signed project record.
    /// @param name The Shares' name (1 to 64 bytes).
    /// @param symbol The Shares' ticker (1 to 64 bytes).
    /// @param expectedSettingsHash `launchHash(keyOf(founder, projectId))` as the founder saw it (`settingsHash()` for every
    /// project but the named project zero). If the admin changed the settings (or which project is project zero, or its
    /// earlier raise) since, the launch reverts instead of giving the founder a project built on settings they never agreed to.
    function launch(bytes32 projectId, string calldata name, string calldata symbol, bytes32 expectedSettingsHash)
        external
        returns (address shares, address treasury, address vester)
    {
        bytes32 key = keyOf(msg.sender, projectId);
        if (launchHash(key) != expectedSettingsHash) revert SettingsMoved();
        if (_projects[key].shares != address(0)) revert ProjectExists();
        if (
            bytes(name).length == 0 || bytes(name).length > 64 || bytes(symbol).length == 0 || bytes(symbol).length > 64
        ) {
            revert BadName();
        }
        Settings memory s = settings;
        // project zero (named by the admin, used up here) takes no stake; it reads `stake` zero in ProjectLaunched too. Its
        // earlier raise, if named, comes from the backing Shares beyond those kept, then from the founder's slice, and the
        // rest of that slice is the Treasury's team budget: its founder's Vester grant is zero.
        address claim;
        uint256 fromBacking;
        uint256 fromFounder;
        uint256 founderGrant = FOUNDER;
        uint256 team;
        if (key == projectZeroKey) {
            (projectZeroKey, projectZeroLaunched, s.stake) = (bytes32(0), true, address(0));
            claim = earlierClaim;
            if (claim != address(0)) (fromBacking, fromFounder) = _cut(IEarlierBackers(claim).total(), earlierKeep);
            (founderGrant, team) = (0, FOUNDER - fromFounder);
        }
        Project memory p = Project({
            founder: msg.sender,
            shares: shareImpl.cloneDeterministic(keccak256(abi.encode(key, "shares"))),
            treasury: treasuryImpl.cloneDeterministic(keccak256(abi.encode(key, "treasury"))),
            vester: vesterImpl.cloneDeterministic(keccak256(abi.encode(key, "vester"))),
            finisher: finisherImpl.cloneDeterministic(keccak256(abi.encode(key, "finisher"))),
            rounds: roundsImpl.cloneDeterministic(keccak256(abi.encode(key, "rounds"))),
            launchedAt: uint64(block.timestamp)
        });
        (shares, treasury, vester) = (p.shares, p.treasury, p.vester);

        address[] memory to = new address[](4);
        uint256[] memory amounts = new uint256[](4);
        (to[0], amounts[0]) = (p.finisher, SALE + POOL_RESERVE);
        (to[1], amounts[1]) = (vester, founderGrant + fromBacking + fromFounder);
        (to[2], amounts[2]) = (treasury, WORK_POT + RESERVE + team);
        (to[3], amounts[3]) = (p.rounds, BACKING - fromBacking);
        ShareToken(shares).initialize(name, symbol, to, amounts);
        Vester(vester)
            .initialize(
                IShares(shares),
                treasury,
                treasury,
                p.rounds,
                msg.sender,
                founderGrant,
                claim,
                fromBacking + fromFounder
            );
        IFinisher(p.finisher).initialize(treasury, shares, address(s.quote));
        Rounds(p.rounds)
            .initialize(address(this), ITreasuryRounds(treasury), IVester(vester), IShares(shares), s.quote, s.platform);
        Treasury(treasury)
            .initialize(
                Treasury.Setup({
                    quote: s.quote,
                    shares: IShares(shares),
                    vester: IVester(vester),
                    rounds: p.rounds,
                    founder: msg.sender,
                    platform: s.platform,
                    opener: p.finisher,
                    salePath: address(this),
                    stake: s.stake,
                    stakeAmount: s.stake == address(0) ? 0 : STAKE,
                    exitFeeBps: s.exitFeeBps,
                    platformFeeBps: s.platformFeeBps,
                    spendableParts: s.spendableParts,
                    floorParts: s.floorParts,
                    agentUsd: s.agentUsd,
                    agentShares: s.agentShares,
                    workPot: WORK_POT,
                    earlier: claim,
                    teamBudget: team
                })
            );
        _projects[key] = p;
        treasuryOfShares[shares] = treasury;
        if (founderGrant == 0) {
            if (claim != address(0)) IEarlierBackers(claim).bind();
            emit ProjectZeroSplit(key, claim, fromBacking, fromFounder, team);
        }
        emit ProjectLaunched(
            key,
            projectId,
            msg.sender,
            p,
            Allocation({
                sale: SALE,
                poolReserve: POOL_RESERVE,
                founder: founderGrant,
                workPot: WORK_POT,
                reserve: RESERVE,
                backing: BACKING - fromBacking
            }),
            s
        );
    }

    // ================================================ backing rounds and Team ========================================

    /// @notice Open a 24-hour backing round sized to whatever is left under the project's cap (10,000 dollars in total for one
    /// person, 50,000 for a Pair or Council runner). Only the runner, only before any market, "no market" or wind-down, never
    /// while the auction runs, and never while another round is open. A Pair runner's two signers both sign the price.
    /// @param sharesPerRawDollar The round's price: raw Share units one raw dollar unit buys, from
    /// `Rounds.MIN_SHARES_PER_RAW_DOLLAR` (2e13: 50,000,000 dollars for the whole project) to
    /// `Rounds.MAX_SHARES_PER_RAW_DOLLAR` (3e15: 333,333 dollars). The Rounds refuse any other.
    /// @return round The round's id in the project's Rounds.
    function openRound(bytes32 key, uint256 sharesPerRawDollar) external returns (uint256 round) {
        Project memory p = _project(key);
        Treasury t = Treasury(p.treasury);
        address runner = _runner(t);
        if (t.poolOpen() || t.woundDown() || Finisher(p.finisher).stage() == Finisher.Stage.Open) revert WrongStage();
        uint256 cap = capOf(runner);
        uint256 raised = Rounds(p.rounds).raised();
        if (raised >= cap) revert CapReached(cap);
        round = Rounds(p.rounds).open(cap - raised, sharesPerRawDollar);
        emit RoundOpened(key, p.rounds, round, cap - raised, cap, raised, sharesPerRawDollar);
    }

    /// @notice Accept the second seat: make the Pair of (`first`, the caller) for project `key`. The founder (the runner)
    /// must have offered the seat to `pairAddress(key, first, caller)` first (`Treasury.handOver`); the Pair takes it in this
    /// call, so becoming Team is two transactions and no wait.
    /// @return pair The new Pair, now the project's runner.
    function makePair(bytes32 key, address first) external returns (address pair) {
        Project memory p = _project(key);
        pair = pairImpl.cloneDeterministic(_pairSalt(key, first, msg.sender));
        isPair[pair] = true;
        Pair(pair).initialize(ITreasuryRunner(p.treasury), address(this), first, msg.sender);
        emit PairMade(key, pair, first, msg.sender);
    }

    /// @notice The address the Pair of (`first`, `second`) for project `key` will have.
    function pairAddress(bytes32 key, address first, address second) external view returns (address) {
        return pairImpl.predictDeterministicAddress(_pairSalt(key, first, second));
    }

    // ================================================ the auction ====================================================

    /// @notice Open the project's one auction. Only a Pair runner (a Council runner too), and only a Council runner when
    /// `requireCouncilForAuction`. Refused once a market opened, "no market" was declared or the project wound down, and
    /// while a backing round is open. Everything but the starting price is fixed here: 250,000,000 Shares over 24 hours, a
    /// minimum of what all of them raise at the starting price (rounded down to a raw unit: 100,000 dollars at the lowest
    /// start, 1,500,000 at 0.006), bids of at least 1 dollar and at most 4 times the starting price, the 3% raise fee, the
    /// pool (22 of each 100 raised with the Shares that match them, 1% fee, the platform's guard, the position owned by the
    /// LiquidityHolder) and the recipients (the project's Finisher, never a person). A failed auction may be opened again,
    /// at a lower start too.
    /// @param startQ96 The starting price, as raw dollars per raw Share times 2^96: at least the `salePrices` floor (0.0004
    /// dollars a Share) and at most `MAX_START_Q96` (0.05). It is put on a grid of one hundredth of itself, rounded up.
    /// @return auction The new auction. Bids go to it.
    function openAuction(bytes32 key, uint256 startQ96) external returns (address auction) {
        Project memory p = _project(key);
        Treasury t = Treasury(p.treasury);
        address runner = _runner(t);
        RunnerKind kind = runnerKind(runner);
        if (kind == RunnerKind.Single) revert WrongRunner(RunnerKind.Pair);
        if (requireCouncilForAuction && kind != RunnerKind.Council) revert WrongRunner(RunnerKind.Council);
        if (t.poolOpen() || t.woundDown() || Rounds(p.rounds).isOpen()) revert WrongStage();
        (uint256 baseQ96,) = salePrices();
        if (startQ96 < baseQ96 || startQ96 > MAX_START_Q96) revert BadStart();
        (uint256 floorQ96, uint256 tickQ96) = _floorAndTick(startQ96);
        uint256 minimum = floorQ96 * SaleParams.SALE_SHARES >> 96;
        uint64 startBlock = uint64(block.number + 1);
        uint64 endBlock_ = startBlock + SaleParams.SALE_BLOCKS;
        bytes memory configData = abi.encode(
            _strategyParams(p, endBlock_),
            abi.encode(_auctionParams(address(t.quote()), p.finisher, strategy, minimum, startBlock, floorQ96, tickQ96))
        );
        (auction,) = IFinisher(p.finisher).open(configData);
        emit SaleOpened(key, auction, runner, p.finisher, minimum, startBlock, endBlock_, floorQ96, tickQ96);
    }

    /// @notice The lowest starting price the auction may have, and its price grid, as the auction sees them (Q96: raw dollars
    /// per raw Share times 2^96): the price at which selling every auction Share raises `AUCTION_MINIMUM` (100,000 dollars),
    /// rounded up to a whole tick; the tick is one hundredth of it, so a bid's top price may be any of 300 steps up to 4 times
    /// it. Passed to `openAuction` it gives exactly the sale of a project that does not choose a price.
    function salePrices() public pure returns (uint256 floorQ96, uint256 tickQ96) {
        return _floorAndTick((AUCTION_MINIMUM << 96) / SaleParams.SALE_SHARES);
    }

    // ================================================ no market and wind down ========================================

    /// @notice Declare "no market", for good. Only the runner, from 365 days after the first backing round that took money
    /// closed (from launch if none did), while no auction runs and no round is open, and only before any market. The Vester's
    /// clock starts (held Shares begin their 365-day release) and the auction is closed to this project for ever.
    function declareNoMarket(bytes32 key) external {
        Project memory p = _project(key);
        Treasury t = Treasury(p.treasury);
        address runner = _runner(t);
        if (t.poolOpen() || Finisher(p.finisher).stage() == Finisher.Stage.Open || Rounds(p.rounds).isOpen()) {
            revert WrongStage();
        }
        uint256 since = Rounds(p.rounds).firstMoneyAt();
        uint256 from = (since == 0 ? p.launchedAt : since) + NO_MARKET_AFTER;
        if (block.timestamp < from) revert TooEarly(from);
        t.markNoMarket();
        emit NoMarket(key, runner);
    }

    /// @notice Wind the project down, for good (see `Treasury.markWoundDown`). Before a market (or after "no market" or an
    /// abandoned sale) the runner may; after a market only a Council runner. Refused while a round is open or the auction runs.
    function windDown(bytes32 key) external {
        Project memory p = _project(key);
        Treasury t = Treasury(p.treasury);
        address runner = _runner(t);
        bool market = t.poolOpen() && !t.noMarket() && !t.abandoned();
        if (market && !isCouncil[runner]) revert WrongRunner(RunnerKind.Council);
        if (Rounds(p.rounds).isOpen() || Finisher(p.finisher).stage() == Finisher.Stage.Open) revert WrongStage();
        t.markWoundDown();
        emit WoundDown(key, runner);
    }

    // ================================================ reserve sales ==================================================

    /// @notice Open a reserve sale of `amount` reserve Shares: a plain 24-hour auction (no pool step) starting at the price the
    /// last sale ended at, bids at most 4 times that, no bids in the last 720 blocks, at least 28 days (201,600 blocks) after
    /// the last sale ended. Only a Council runner, only after the market opened, never after a wind-down, one at a time.
    /// Exits wait while it runs.
    /// @return auction The reserve sale's auction.
    function openReserveSale(bytes32 key, uint256 amount) external returns (address auction) {
        Project memory p = _project(key);
        Treasury t = Treasury(p.treasury);
        if (!isCouncil[_runner(t)]) revert WrongRunner(RunnerKind.Council);
        if (Finisher(p.finisher).stage() != Finisher.Stage.Done || t.woundDown()) revert WrongStage();
        ReserveSales storage rs = _reserve[key];
        if (rs.auction != address(0)) revert WrongStage();
        (uint64 lastEnd, uint256 lastPrice) = lastSale(key);
        if (block.number < lastEnd + RESERVE_SALE_GAP_BLOCKS) revert TooEarly(lastEnd + RESERVE_SALE_GAP_BLOCKS);
        (uint256 floorQ96, uint256 tickQ96) = _floorAndTick(lastPrice);
        uint64 startBlock = uint64(block.number + 1);
        t.releaseReserve(address(this), amount);
        auction = IPinnedAuctionFactory(auctionFactory)
            .create(
                p.shares,
                amount,
                abi.encode(
                    _auctionParams(address(t.quote()), address(this), address(this), 0, startBlock, floorQ96, tickQ96)
                ),
                bytes32(uint256(++rs.count))
            );
        rs.auction = auction;
        IShares(p.shares).transfer(auction, amount);
        IPinnedAuction(auction).onTokensReceived();
        emit ReserveSaleOpened(key, auction, amount, floorQ96, tickQ96, startBlock, startBlock + SaleParams.SALE_BLOCKS);
    }

    /// @notice Finish the running reserve sale after its end. Anyone may. In one transaction: the dollars (less the
    /// platform's 3, taken by the auction's fee path) go to the Treasury and are split 15 spendable : 82 floor, the unsold
    /// Shares go back to the reserve, exits open again, and the sale's end price becomes the next one's starting point.
    function finishReserveSale(bytes32 key) external {
        Project memory p = _project(key);
        ReserveSales storage rs = _reserve[key];
        IPinnedAuction a = IPinnedAuction(rs.auction);
        if (address(a) == address(0)) revert WrongStage();
        IERC20 quote = Treasury(p.treasury).quote();
        uint256 d0 = quote.balanceOf(address(this));
        uint256 s0 = IShares(p.shares).balanceOf(address(this));
        a.sweepCurrency();
        a.sweepUnsoldTokens();
        uint256 got = quote.balanceOf(address(this)) - d0;
        uint256 back = IShares(p.shares).balanceOf(address(this)) - s0;
        (rs.auction, rs.lastEndBlock, rs.lastEndPriceQ96) = (address(0), a.endBlock(), a.clearingPrice());
        if (got != 0) {
            quote.transfer(p.treasury, got);
            Treasury(p.treasury).settleReserveSale(got);
        }
        if (back != 0) IShares(p.shares).transfer(p.treasury, back);
        Treasury(p.treasury).closeReserveSale();
        emit ReserveSaleFinished(key, address(a), got, back, rs.lastEndPriceQ96);
    }

    /// @notice The last block and end price of the project's last finished sale (the auction, or the last reserve sale).
    function lastSale(bytes32 key) public view returns (uint64 endBlock, uint256 priceQ96) {
        ReserveSales storage rs = _reserve[key];
        if (rs.lastEndBlock != 0) return (rs.lastEndBlock, rs.lastEndPriceQ96);
        Finisher f = Finisher(_project(key).finisher);
        return (f.endBlock(), IPinnedAuction(f.auction()).clearingPrice());
    }

    /// @notice The reserve sale running now for a project (zero when none) and how many were opened.
    function reserveSaleOf(bytes32 key) external view returns (ReserveSales memory) {
        return _reserve[key];
    }

    // ================================================ the council seam ===============================================

    /// @notice Mark `council` as a Council runner. Only the council maker (milestone 9).
    function registerCouncil(address council) external {
        if (msg.sender != councilMaker || council == address(0)) revert NotCouncilMaker();
        isCouncil[council] = true;
        emit CouncilRegistered(council);
    }

    /// @notice Name the address that may pause project `key`'s payments (the holders' vote). Only the council maker.
    function setPauser(bytes32 key, address pauser) external {
        if (msg.sender != councilMaker) revert NotCouncilMaker();
        Treasury(_project(key).treasury).setPauser(pauser);
        emit PauserNamed(key, pauser);
    }

    // ================================================ reading ========================================================

    /// @notice What kind of runner `runner` is: a Council the council maker registered, a Pair this Launcher made, or one
    /// person.
    function runnerKind(address runner) public view returns (RunnerKind) {
        if (isCouncil[runner]) return RunnerKind.Council;
        if (isPair[runner]) return RunnerKind.Pair;
        return RunnerKind.Single;
    }

    /// @notice The most backing rounds may take in total under this runner.
    function capOf(address runner) public view returns (uint256) {
        return runnerKind(runner) == RunnerKind.Single ? SOLO_CAP : TEAM_CAP;
    }

    /// @notice The project's stage, read from the chain: Open from 365 days after its market opened, Council once it opened,
    /// Team with a Pair (or Council) runner, Backed once a round took money, else Solo.
    function stageOf(bytes32 key) external view returns (Stage) {
        Project memory p = _project(key);
        if (Finisher(p.finisher).stage() == Finisher.Stage.Done) {
            uint256 opened = Vester(p.vester).start();
            return block.timestamp >= opened + OPEN_AFTER ? Stage.Open : Stage.Council;
        }
        if (runnerKind(Treasury(p.treasury).runner()) != RunnerKind.Single) return Stage.Team;
        return Rounds(p.rounds).firstMoneyAt() != 0 ? Stage.Backed : Stage.Solo;
    }

    /// @notice What the Launcher knows of a project, by founder and id.
    function project(address founder, bytes32 projectId) external view returns (Project memory) {
        return _projects[keyOf(founder, projectId)];
    }

    /// @notice What the Launcher knows of a project, by key.
    function projectByKey(bytes32 key) external view returns (Project memory) {
        return _projects[key];
    }

    /// @notice A hash of the settings a project launched now would be born with. A founder's app reads it and passes it
    /// to `launch`.
    function settingsHash() public view returns (bytes32) {
        return keccak256(abi.encode(settings));
    }

    /// @notice What `launch` checks for the project `key`: `settingsHash()`, and for the named project zero a hash of it with
    /// the earlier raise (the claim contract, zero for none, and the backing Shares kept), so its founder commits to being
    /// project zero (no founder grant: the founder's slice is the team budget) and to the cut. Naming a key project zero, or
    /// taking the name back, after its founder read the hash makes that launch revert.
    function launchHash(bytes32 key) public view returns (bytes32 h) {
        h = settingsHash();
        if (key == projectZeroKey) h = keccak256(abi.encode(h, earlierClaim, earlierKeep));
    }

    /// @notice The key a project is stored under.
    function keyOf(address founder, bytes32 projectId) public pure returns (bytes32) {
        return keccak256(abi.encode(founder, projectId));
    }

    // ================================================ admin ==========================================================

    /// @notice Change the settings new projects are born with. Projects already launched keep what they were born with.
    function setSettings(Settings calldata next) external {
        if (msg.sender != admin) revert NotAdmin();
        _set(next);
    }

    /// @notice Name the one project that launches with no stake: project zero, Creaton's own, by its key (`keyOf` of its
    /// founder and id). Only the admin, only before that project launched and only while no project zero has launched; a
    /// name may be changed or taken back (zero) until then. Every other project takes the stake whatever is named.
    function nameProjectZero(bytes32 key) external {
        if (msg.sender != admin) revert NotAdmin();
        if (projectZeroLaunched || _projects[key].shares != address(0)) revert ProjectExists();
        (projectZeroKey, earlierClaim) = (key, address(0));
        emit ProjectZeroNamed(key);
    }

    /// @notice Name project zero's earlier raise: `claim`, an `EarlierBackers` made for this Launcher and the named project
    /// zero, and `keepBacking`, the backing Shares project zero keeps for its own rounds (Creaton: 8,333,333.33, what the
    /// 50,000 Team cap buys at 6,000,000). At its launch the list's total comes from the rest of the backing slice first,
    /// then from the founder's slice (the rest of which is the team budget). Only the admin, only while project zero is
    /// named and has not launched; zero `claim` takes it back. Naming project zero again clears it.
    function nameEarlierBackers(address claim, uint256 keepBacking) external {
        if (msg.sender != admin) revert NotAdmin();
        bytes32 key = projectZeroKey;
        if (key == bytes32(0)) revert BadCut(); // none named, or project zero launched: its earlier raise is fixed
        if (claim != address(0)) {
            if (
                claim.codehash != earlierCodeHash || IEarlierBackers(claim).launcher() != address(this)
                    || IEarlierBackers(claim).key() != key
            ) revert BadCut();
            _cut(IEarlierBackers(claim).total(), keepBacking);
        }
        (earlierClaim, earlierKeep) = (claim, keepBacking);
        emit EarlierBackersNamed(key, claim, keepBacking);
    }

    /// @notice Hand the admin role on, or renounce it with the zero address (settings then never change again).
    function transferAdmin(address next) external {
        if (msg.sender != admin) revert NotAdmin();
        admin = next;
        emit AdminChanged(next);
    }

    // ================================================ plumbing =======================================================

    function _project(bytes32 key) private view returns (Project memory p) {
        p = _projects[key];
        if (p.shares == address(0)) revert UnknownProject();
    }

    /// @dev The project's runner, which must be the caller.
    function _runner(Treasury t) private view returns (address runner) {
        runner = t.runner();
        if (msg.sender != runner) revert NotRunner();
    }

    /// @dev The earlier raise's two parts: the backing Shares beyond `keep` first, then the founder's slice.
    function _cut(uint256 total, uint256 keep) private pure returns (uint256 fromBacking, uint256 fromFounder) {
        if (keep > BACKING) revert BadCut();
        fromBacking = BACKING - keep;
        if (total < fromBacking) fromBacking = total;
        fromFounder = total - fromBacking;
        if (fromFounder > FOUNDER) revert BadCut();
    }

    function _pairSalt(bytes32 key, address first, address second) private pure returns (bytes32) {
        return keccak256(abi.encode(key, "pair", first, second));
    }

    /// @dev A starting price on the grid: the tick is one hundredth of `exactQ96` rounded up, the price is 100 ticks.
    function _floorAndTick(uint256 exactQ96) private pure returns (uint256 floorQ96, uint256 tickQ96) {
        tickQ96 = (exactQ96 + TICKS_IN_FLOOR - 1) / TICKS_IN_FLOOR;
        floorQ96 = tickQ96 * TICKS_IN_FLOOR;
    }

    /// @dev The strategy's settings of the auction. The pool takes `POOL_RATE` of the raise after the platform's fee in one
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

    /// @dev An auction's settings: 7,200 blocks, 7,100 at 1,388 ten-millionths of the supply a block and 100 at 1,452 (they
    /// add to exactly 10,000,000, which the auction requires), the project's dollar token, the bid hook, the starting price and
    /// grid, the minimum.
    function _auctionParams(
        address currency,
        address tokensTo,
        address fundsTo,
        uint256 minimum,
        uint64 startBlock,
        uint256 floorQ96,
        uint256 tickQ96
    ) private view returns (AuctionParameters memory) {
        return AuctionParameters({
            currency: currency,
            tokensRecipient: tokensTo,
            fundsRecipient: fundsTo,
            startBlock: startBlock,
            endBlock: startBlock + SaleParams.SALE_BLOCKS,
            claimBlock: startBlock + SaleParams.SALE_BLOCKS + 1,
            tickSpacing: tickQ96,
            validationHook: minBid,
            floorPrice: floorQ96,
            requiredCurrencyRaised: uint128(minimum),
            auctionStepsData: abi.encodePacked(
                bytes8(uint64(1388) << 40 | uint64(7100)), bytes8(uint64(1452) << 40 | uint64(100))
            )
        });
    }

    function _set(Settings memory s) private {
        if (
            address(s.quote) == address(0) || s.platform == address(0) || s.stake == address(0)
                || s.exitFeeBps > MAX_EXIT_FEE_BPS || s.platformFeeBps > s.exitFeeBps || s.spendableParts == 0
                || s.floorParts == 0 || s.spendableParts > MAX_SPLIT_PART || s.floorParts > MAX_SPLIT_PART
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
