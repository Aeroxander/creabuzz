// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Clones} from "oz5/proxy/Clones.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {ShareToken} from "./ShareToken.sol";
import {Treasury} from "./Treasury.sol";
import {Vester} from "./Vester.sol";
import {Pair} from "./Pair.sol";
import {TaskBook} from "./TaskBook.sol";
import {Parts} from "./Parts.sol";
import {HolderPause} from "./HolderPause.sol";
import {Council} from "./Council.sol";
import {
    IShares,
    ITreasuryClock,
    ITreasuryRunner,
    IPair,
    ITaskBook,
    IEarlierGrants,
    IHolderVote
} from "./Interfaces.sol";

/// @notice What the Launcher reads of the dollar token: the number of decimals (every amount in the Treasury is in raw
/// units of a 6-decimal token).
interface IDecimals {
    /// @notice Decimals of the token.
    function decimals() external view returns (uint8);
}

/// @title Launcher
/// @notice One per network. In one transaction `launch` creates a project's two ShareTokens (backer Shares and Team Shares),
/// Treasury, Vester and TaskBook as small clones, mints the whole Team pool to the Vester and ties them to a project id the founder
/// chose. The caller is the founder and the first runner. Everything else about a project (the pot, joining and leaving, the
/// allowance, grants, forfeits, the quiet rules) lives in those contracts; this one only keeps:
///  - the platform settings new projects are born with (the dollar, who gets the fee, the fee, the time unit, the agents'
///    default dollar limit). A founder commits to the exact set they saw by passing its hash to `launch`; nothing in a
///    launched project follows a later change;
///  - the registry of runner contracts it made (the Treasury asks `runnerKindOf`: 1 a Pair, 2 a Council), `makePair`, which
///    the second signer calls to accept the seat the founder offered, and (when the deployment turned the Council on)
///    `makeCouncil`, which anyone calls to make the Council of five accounts the runner offered the seat to;
///  - `windDown(key)`, the app's and a Pair's wind-down target: it checks the caller is the runner and forwards to the
///    Treasury.
/// The founder picks two numbers: the allowance rate and the size of the Team pool (`Terms`). The time unit N is a platform
/// setting: 7 days on a real network, and any multiple of 168 seconds on a test network.
/// @dev The door, the hand-over and the agents stay in the Treasury, where the runner calls them directly (a Pair reaches
/// them through `confirm`).
contract Launcher {
    using Clones for address;

    /// @notice Platform settings for new projects. Copied into each project at launch and covered by `settingsHash`.
    struct Platform {
        IERC20 quote; // the dollar token (6 decimals)
        address platform; // receives the platform fee on joins
        uint16 feeBps; // the fee on joins in ten-thousandths: 200 = 2%; at most 500
        uint32 unit; // the time unit N in seconds: 7 days on a real network; a multiple of 168 on a test network
        uint128 agentUsd; // default daily dollar limit of an agent: 25 dollars
    }

    /// @notice The two numbers a founder picks.
    struct Terms {
        uint32 ratePpm; // allowance: parts per million of the pot a day; at most 2,000 (0.20%); 1,000 is the default
        uint256 teamPool; // Team Shares (wei) minted to the Vester at birth; at most 100,000,000 Shares
    }

    /// @notice What the Launcher remembers of a project.
    struct Project {
        address founder;
        address shares;
        address team;
        address treasury;
        address vester;
        uint64 launchedAt;
    }

    /// @notice The dollar has 6 decimals; every amount in the Treasury assumes it.
    uint8 public constant QUOTE_DECIMALS = 6;
    /// @notice The fee ceiling the Treasury also enforces.
    uint16 public constant MAX_FEE_BPS = 500;
    /// @notice The allowance ceiling the Treasury also enforces: 0.20% of the pot a day.
    uint32 public constant MAX_RATE_PPM = 2000;
    /// @notice The largest Team pool a founder may ask for: 100,000,000 Shares.
    uint256 public constant MAX_TEAM_POOL = 100_000_000e18;
    /// @notice The time unit on a real network.
    uint32 public constant REAL_UNIT = 7 days;
    /// @notice A Team Share agent's daily limit is the pool divided by this.
    uint256 public constant AGENT_SHARE_DIV = 1000;

    /// @notice Who may change the platform settings for new projects.
    address public admin;
    /// @notice Who the admin offered the seat to, until they accept; zero when no offer is open.
    address public pendingAdmin;
    /// @notice The platform settings new projects are born with.
    Platform public platform;
    /// @notice True on the networks where a short time unit is allowed (local chain, Sepolia).
    bool public immutable testNetwork;
    address public immutable shareImpl;
    address public immutable treasuryImpl;
    address public immutable vesterImpl;
    address public immutable pairImpl;
    address public immutable tasksImpl;
    /// @notice Who deployed this Launcher. Only they may bind the holder pause, and only inside the first hour.
    address public immutable deployer;
    /// @notice When this Launcher was deployed.
    uint64 public immutable deployedAt;
    /// @notice The holder pause every project launched from now on is born with (the code its clones copy); zero while the
    /// deployment's switch is off, which is the default. Set once, by the deployer, in the first hour; never changed.
    address public holderPauseImpl;
    /// @notice True once the deployment's Council switch is on. Kept in the same storage slot as `holderPauseImpl`, so a launch
    /// with the switch off reads nothing more than it did before the Council existed (`settingsHash` and `launch` already read
    /// that slot).
    bool public councilBound;
    /// @notice The Council every Council of a project is a clone of; zero while the deployment's Council switch is off, which
    /// is the default. Set once, by the deployer, in the first hour, and only after the holder pause is bound; never changed.
    address public councilImpl;
    /// @notice The earlier backers' claim contract; zero while the deployment has none, which is the default. Set once, by the
    /// deployer, in the first hour, and only before project `earlierKey` has launched; never changed.
    address public earlier;
    /// @notice The one project whose Team pool carries the earlier backers' reserve (the claim contract's own key); zero
    /// while nothing is bound.
    bytes32 public earlierKey;

    /// @notice What kind of runner contract an address is: 0 none the Launcher made, 1 a Pair, 2 a Council. The Treasury asks it
    /// for both of its runner-seat checks, as one storage read.
    mapping(address => uint8) public runnerKindOf;
    mapping(bytes32 => Project) private _projects;

    /// @notice One event with everything a server needs to index a project.
    event ProjectLaunched(
        bytes32 indexed key,
        bytes32 indexed projectId,
        address indexed founder,
        Project project,
        Terms terms,
        Platform platform
    );
    /// @notice The Pair of (`first`, `second`) took the runner seat of project `key`.
    event PairMade(bytes32 indexed key, address indexed pair, address first, address second);
    /// @notice The deployment's Council switch was turned on: projects can now hand their seat to a Council, a clone of `impl`.
    /// `codehash` is the code hash of `impl`, to compare with the build.
    event CouncilBound(address impl, bytes32 codehash);
    /// @notice A Council took the runner seat of project `key` (`byVote` false: the runner handed the seat over). Its five
    /// accounts are in the Council's own `SeatsSet`, emitted in the same transaction, so a reader that finds the Council here
    /// reads its seats there.
    event CouncilMade(bytes32 indexed key, address indexed council, bool byVote);
    /// @notice The runner wound project `key` down.
    event WoundDown(bytes32 indexed key, address indexed runner);
    /// @notice The platform settings for new projects changed.
    event SettingsChanged(Platform platform);
    /// @notice The admin changed.
    event AdminChanged(address indexed admin);
    /// @notice The admin offered the seat to `next`.
    event AdminOffered(address indexed next);
    /// @notice The deployment's holder pause switch was turned on: projects launched from now on are born with a clone of
    /// `impl`. `codehash` is the code hash of `impl`, to compare with the build.
    event HolderPauseBound(address impl, bytes32 codehash);
    /// @notice The deployment's earlier backers' claim contract was bound: project `key` will be born with its reserve.
    event EarlierBound(address earlier, bytes32 key);
    /// @notice Project `key` was launched with `amount` Team Shares set aside in its Vester for the earlier backers, on top of
    /// its own Team pool (`ProjectLaunched` carries that one).
    event EarlierPoolFunded(bytes32 indexed key, address vester, uint256 amount);

    error ProjectExists();
    error UnknownProject();
    error NotAdmin();
    error BadSettings();
    error BadName();
    error BadTerms();
    error BadStack();
    error SettingsMoved();
    error NotRunner();
    /// @notice Only the deployer may do this.
    error NotDeployer();
    /// @notice The one-time, first-hour binding is closed (done already, or the hour is over).
    error BindClosed();
    /// @notice The deployment's Council switch is off.
    error NoCouncil();
    /// @notice A seat was named that is one of the project's own contracts, or another runner contract: it could never act.
    error BadSeatHolder(address who);
    /// @notice The bound holder pause is not also a vote contract (a Council can only be bound beside a `HolderVote`).
    error NotVote();
    /// @notice A Council by vote may be made only by the project's own vote contract (its pause).
    error NotVoteCaller();

    /// @param admin_ Who may change the settings for new projects.
    /// @param initial The first platform settings.
    /// @param parts_ The contract that made the ShareToken, Treasury, Vester and Pair implementations.
    constructor(address admin_, Platform memory initial, Parts parts_) {
        (shareImpl, treasuryImpl) = (parts_.shareImpl(), parts_.treasuryImpl());
        (vesterImpl, pairImpl, tasksImpl) = (parts_.vesterImpl(), parts_.pairImpl(), parts_.tasksImpl());
        if (
            shareImpl.code.length == 0 || treasuryImpl.code.length == 0 || vesterImpl.code.length == 0
                || pairImpl.code.length == 0 || tasksImpl.code.length == 0
        ) revert BadStack();
        testNetwork = block.chainid == 31_337 || block.chainid == 11_155_111;
        (deployer, deployedAt) = (msg.sender, uint64(block.timestamp));
        admin = admin_;
        _set(initial);
        emit AdminChanged(admin_);
    }

    // ================================================ birth ==========================================================

    /// @notice Create a project: its two ShareTokens, Treasury and Vester, with the whole Team pool minted to the Vester. The
    /// caller is the founder and the first runner. The project is known by `keyOf(founder, projectId)`, so nobody can take
    /// an id the founder has not used. A new project starts inside its check-in window and with its door open.
    /// @param projectId The id in the founder's signed project record.
    /// @param name The Shares' name (1 to 64 bytes). The Team Shares are named after it.
    /// @param symbol The Shares' ticker (1 to 64 bytes).
    /// @param terms The founder's two numbers: the allowance rate and the Team pool.
    /// @param expectedSettingsHash `settingsHash()` as the founder saw it. If the admin changed the
    /// platform settings since, the launch reverts instead of giving the founder a project built on settings they never
    /// agreed to.
    function launch(
        bytes32 projectId,
        string calldata name,
        string calldata symbol,
        Terms calldata terms,
        bytes32 expectedSettingsHash
    ) external returns (address shares, address team, address treasury, address vester) {
        bytes32 key = keyOf(msg.sender, projectId);
        address pauseImpl = holderPauseImpl;
        if (_settingsHash(pauseImpl) != expectedSettingsHash) revert SettingsMoved();
        if (_projects[key].treasury != address(0)) revert ProjectExists();
        if (
            bytes(name).length == 0 || bytes(name).length > 64 || bytes(symbol).length == 0 || bytes(symbol).length > 64
        ) {
            revert BadName();
        }
        if (terms.ratePpm > MAX_RATE_PPM || terms.teamPool > MAX_TEAM_POOL) revert BadTerms();
        Platform memory s = platform;
        // the one project named by `earlierKey` is born with the earlier backers' reserve on top of its own pool
        address claims = earlier;
        uint256 earlierPool;
        if (claims != address(0) && key == earlierKey) earlierPool = IEarlierGrants(claims).total();
        treasury = treasuryImpl.clone();
        shares = shareImpl.clone();
        team = shareImpl.clone();
        vester = vesterImpl.clone();
        address tasks = tasksImpl.clone();
        TaskBook(tasks).initialize(treasury, s.unit);
        ShareToken(shares).initialize(name, symbol, treasury, address(0), 0);
        ShareToken(team)
            .initialize(
                string.concat(name, " Team"),
                string.concat(symbol, "-T"),
                treasury,
                vester,
                terms.teamPool + earlierPool
            );
        if (earlierPool == 0) {
            Vester(vester).initialize(ITreasuryClock(treasury), IShares(team), terms.teamPool);
        } else {
            Vester(vester)
                .initializeWithEarlier(ITreasuryClock(treasury), IShares(team), terms.teamPool, claims, earlierPool);
        }
        Treasury(treasury)
            .initialize(
                Treasury.Setup({
                    quote: s.quote,
                    shares: IShares(shares),
                    team: IShares(team),
                    vester: vester,
                    founder: msg.sender,
                    platform: s.platform,
                    salePath: address(this),
                    unit: s.unit,
                    ratePpm: terms.ratePpm,
                    feeBps: s.feeBps,
                    agentUsd: s.agentUsd,
                    agentTeam: uint128(terms.teamPool / AGENT_SHARE_DIV),
                    tasks: ITaskBook(tasks)
                })
            );
        if (pauseImpl != address(0)) {
            address gate = pauseImpl.clone();
            HolderPause(gate).initialize(IShares(shares), s.unit);
            Treasury(treasury).bindPause(gate);
            // with the Council switch on the pause is a vote contract, and it needs its project (the Treasury, the key and
            // this Launcher) before anyone can vote. Bound in the launch transaction, once.
            if (councilBound) IHolderVote(gate).bindProject(ITreasuryRunner(treasury), key);
        }
        if (earlierPool != 0) {
            IEarlierGrants(claims).bind(vester);
            emit EarlierPoolFunded(key, vester, earlierPool);
        }
        Project memory p = Project({
            founder: msg.sender,
            shares: shares,
            team: team,
            treasury: treasury,
            vester: vester,
            launchedAt: uint64(block.timestamp)
        });
        _projects[key] = p;
        emit ProjectLaunched(key, projectId, msg.sender, p, terms, s);
    }

    // ================================================ the Pair =======================================================

    /// @notice Accept the second seat: make the Pair of (`first`, the caller) for project `key`. The founder (the runner)
    /// must have offered the seat to `pairAddress(key, first, caller)` first (`Treasury.handOver`); the Pair takes it in this
    /// call, so becoming Team is two transactions and no wait.
    /// @return pair The new Pair, now the project's runner.
    function makePair(bytes32 key, address first) external returns (address pair) {
        Project memory p = _project(key);
        pair = pairImpl.cloneDeterministic(_pairSalt(key, first, msg.sender));
        runnerKindOf[pair] = 1;
        Pair(pair).initialize(ITreasuryRunner(p.treasury), address(this), first, msg.sender);
        emit PairMade(key, pair, first, msg.sender);
    }

    /// @notice The address the Pair of (`first`, `second`) for project `key` will have.
    function pairAddress(bytes32 key, address first, address second) external view returns (address) {
        return pairImpl.predictDeterministicAddress(_pairSalt(key, first, second));
    }

    // ================================================ the Council ====================================================

    /// @notice Make the Council of `members` for project `key`. The runner must have offered the seat to
    /// `councilAddress(key, members, salt)` first (`Treasury.handOver`); the Council takes it in this call, as a Pair does, so
    /// anyone can make it and nobody can change who the five accounts are (the address commits to them). No wait, no vote.
    /// Only while the deployment's Council switch is on.
    /// @param key The project.
    /// @param members Five distinct accounts, none of them one of the project's own contracts.
    /// @param salt Anything; lets the same five accounts have more than one Council.
    /// @return council The new Council, now the project's runner.
    function makeCouncil(bytes32 key, address[5] calldata members, bytes32 salt) external returns (address council) {
        if (!councilBound) revert NoCouncil();
        address impl = councilImpl;
        Project memory p = _project(key);
        for (uint256 i; i < 5; ++i) {
            if (_isProjectAccount(p, members[i])) revert BadSeatHolder(members[i]);
        }
        council = impl.cloneDeterministic(_councilSalt(key, members, salt));
        runnerKindOf[council] = 2;
        Council(council).initialize(ITreasuryRunner(p.treasury), address(this), members, true);
        emit CouncilMade(key, council, false);
    }

    /// @notice The address the Council of `members` with `salt` for project `key` will have.
    function councilAddress(bytes32 key, address[5] calldata members, bytes32 salt) external view returns (address) {
        return councilImpl.predictDeterministicAddress(_councilSalt(key, members, salt));
    }

    /// @notice Make the Council that won a replace vote: the project's own vote contract (`Treasury.pauseGate()`) names the five
    /// accounts the ballot chose, and the Council is born in the vote path's own address space (salted by the ballot, so the
    /// same five can be elected again, and no hand-over salt can produce the address). It is seated by the vote contract in the
    /// same transaction (`Treasury.seatByVote`); it does not take an offered seat.
    /// @param key The project.
    /// @param members The five accounts the ballot chose.
    /// @param ballotId The ballot's id (it keeps two ballots from making the same address).
    /// @return council The new Council, one transaction away from the runner seat.
    function councilByVote(bytes32 key, address[5] calldata members, uint256 ballotId)
        external
        returns (address council)
    {
        if (!councilBound) revert NoCouncil();
        Project memory p = _project(key);
        if (msg.sender != Treasury(p.treasury).pauseGate()) revert NotVoteCaller();
        for (uint256 i; i < 5; ++i) {
            if (_isProjectAccount(p, members[i])) revert BadSeatHolder(members[i]);
        }
        council = councilImpl.cloneDeterministic(_voteCouncilSalt(key, members, ballotId));
        runnerKindOf[council] = 2;
        Council(council).initialize(ITreasuryRunner(p.treasury), address(this), members, false);
        emit CouncilMade(key, council, true);
    }

    /// @notice True when `who` is one of project `key`'s own contracts (its Treasury, Vester, task queue, both Share tokens, its
    /// pause), the Launcher, the Council implementation, or any runner contract this Launcher made: an account that can never
    /// act, so it can never hold a Council seat. A smart account stays allowed.
    function isProjectAccount(bytes32 key, address who) external view returns (bool) {
        return _isProjectAccount(_project(key), who);
    }

    // ================================================ wind-down ======================================================

    /// @notice Wind the project down, for good (see `Treasury.markWoundDown`). Only the runner: the founder or whoever holds
    /// the seat, or a Pair through `confirm` (both signers). Anyone may wind a project down on their own after 26 quiet time
    /// units, by calling the Treasury directly.
    function windDown(bytes32 key) external {
        Project memory p = _project(key);
        address runner = Treasury(p.treasury).runner();
        // a Pair runner must be in the middle of executing a proposal both signers agreed to (defence in depth: the Pair
        // has no other way here)
        if (msg.sender != runner || (runnerKindOf[runner] != 0 && !IPair(runner).bothSigned())) revert NotRunner();
        Treasury(p.treasury).markWoundDown();
        emit WoundDown(key, runner);
    }

    // ================================================ views ==========================================================

    /// @notice True for a Pair this Launcher made.
    function isPair(address who) external view returns (bool) {
        return runnerKindOf[who] == 1;
    }

    /// @notice True for a Council this Launcher made.
    function isCouncil(address who) external view returns (bool) {
        return runnerKindOf[who] == 2;
    }

    /// @notice The project a founder made under `projectId`.
    function project(address founder, bytes32 projectId) external view returns (Project memory) {
        return _project(keyOf(founder, projectId));
    }

    /// @notice The project stored under `key`.
    function projectByKey(bytes32 key) external view returns (Project memory) {
        return _project(key);
    }

    /// @notice A hash of the platform settings a project launched now would be born with. A founder's app reads it and
    /// passes it to `launch`.
    /// @dev With nothing bound the hash is `keccak256(abi.encode(platform))`, as before; a bound holder pause is added to it,
    /// and a bound claim contract after that, so a founder's launch is refused if either switch was turned on after they read
    /// it. (With only the pause bound it is `keccak256(abi.encode(platform, pause))`, as it was before the claim contract.) A
    /// bound Council comes first and gives a fourth form, `keccak256(abi.encode(platform, pause, claims, council))` (a zero
    /// where the claim contract is off), so a founder who read the hash before the Council was turned on reads it again.
    function settingsHash() public view returns (bytes32) {
        return _settingsHash(holderPauseImpl);
    }

    function _settingsHash(address pause) private view returns (bytes32) {
        address claims = earlier;
        // a Council can only be bound beside a bound pause, so with no pause nothing more is read (a launch on a deployment
        // with the switches off costs what it cost before the Council existed)
        if (pause != address(0) && councilBound) return keccak256(abi.encode(platform, pause, claims, councilImpl));
        if (claims != address(0)) return keccak256(abi.encode(platform, pause, claims));
        if (pause == address(0)) return keccak256(abi.encode(platform));
        return keccak256(abi.encode(platform, pause));
    }

    /// @notice The key a project is stored under.
    function keyOf(address founder, bytes32 projectId) public pure returns (bytes32) {
        return keccak256(abi.encode(founder, projectId));
    }

    // ================================================ the pause switch ===============================================

    /// @notice Turn the holder pause on for every project launched from now on: they are born with a clone of `impl` and
    /// keep it. Only the deployer, once, inside the first hour after deployment (the deploy script does it in the same
    /// broadcast, before any launch), so a key stolen later cannot turn it on. `impl` must have code. A project launched
    /// before this call has no pause, by design. The event carries the code hash, to compare with the build.
    /// @param impl The deployed `HolderPause` implementation.
    function bindPause(address impl) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (holderPauseImpl != address(0) || block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();
        if (impl.code.length == 0) revert BadStack();
        holderPauseImpl = impl;
        emit HolderPauseBound(impl, impl.codehash);
    }

    /// @notice Turn the Council on for every project: a runner may hand its seat to a Council of five accounts (`makeCouncil`).
    /// Only the deployer, once, inside the first hour (the deploy script does it in the same broadcast, before any launch), and
    /// only after the holder pause is bound (a Council is born reading its project's pause as its vote contract). `impl` must
    /// have code. The event carries the code hash, to compare with the build.
    /// @param impl The deployed `Council` implementation.
    function bindCouncil(address impl) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (councilBound || block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();
        if (impl.code.length == 0 || holderPauseImpl == address(0)) revert BadStack();
        // the pause the deployment bound must also be the vote contract, or a project would get a Council and no way to elect
        // or replace it. A plain HolderPause has no such view, so the call fails and the binding is refused.
        (bool ok, bytes memory ret) = holderPauseImpl.staticcall(abi.encodeCall(IHolderVote.isVote, ()));
        if (!ok || !abi.decode(ret, (bool))) revert NotVote();
        (councilBound, councilImpl) = (true, impl);
        emit CouncilBound(impl, impl.codehash);
    }

    /// @notice Bind the earlier backers' claim contract: the project it names (`EarlierGrants.key`) is born with a reserve of
    /// Team Shares for it, on top of its own pool. Only the deployer, once, inside the first hour (the deploy script does it in
    /// the same broadcast, before any launch), and only while that project has not launched (a project already launched could
    /// never have the reserve). The claim contract must name this Launcher.
    /// @param earlier_ The deployed `EarlierGrants`.
    function bindEarlier(address earlier_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (earlier != address(0) || block.timestamp > uint256(deployedAt) + 1 hours) revert BindClosed();
        if (earlier_.code.length == 0 || IEarlierGrants(earlier_).launcher() != address(this)) revert BadStack();
        bytes32 k = IEarlierGrants(earlier_).key();
        if (_projects[k].treasury != address(0)) revert BindClosed();
        (earlier, earlierKey) = (earlier_, k);
        emit EarlierBound(earlier_, k);
    }

    // ================================================ admin ==========================================================

    /// @notice Change the platform settings new projects are born with. Projects already launched keep what they were born
    /// with.
    function setSettings(Platform calldata next) external {
        if (msg.sender != admin) revert NotAdmin();
        _set(next);
    }

    /// @notice Offer the admin seat to `next`. It changes hands only when `next` calls `acceptAdmin`, so a wrong address
    /// cannot take the seat out of reach for good. A new offer replaces the old one.
    function transferAdmin(address next) external {
        if (msg.sender != admin) revert NotAdmin();
        if (next == address(0)) revert BadSettings();
        pendingAdmin = next;
        emit AdminOffered(next);
    }

    /// @notice Take the admin seat that was offered to the caller.
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        (admin, pendingAdmin) = (msg.sender, address(0));
        emit AdminChanged(msg.sender);
    }

    // ================================================ plumbing =======================================================

    function _project(bytes32 key) private view returns (Project memory p) {
        p = _projects[key];
        if (p.treasury == address(0)) revert UnknownProject();
    }

    function _pairSalt(bytes32 key, address first, address second) private pure returns (bytes32) {
        return keccak256(abi.encode(key, "pair", first, second));
    }

    function _councilSalt(bytes32 key, address[5] calldata members, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(key, "council", members, salt));
    }

    /// @dev The vote path's own address space: a different tag, and the ballot's id in place of a salt, so a hand-over salt can
    /// never produce it and the same five accounts can be elected in another ballot.
    function _voteCouncilSalt(bytes32 key, address[5] calldata members, uint256 ballotId)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(key, "council-vote", members, ballotId));
    }

    function _isProjectAccount(Project memory p, address who) private view returns (bool) {
        return who == p.treasury || who == p.vester || who == p.shares || who == p.team || who == address(this)
            || who == councilImpl || who == Treasury(p.treasury).pauseGate()
            || who == address(Treasury(p.treasury).tasks()) || runnerKindOf[who] != 0;
    }

    function _set(Platform memory s) private {
        if (
            address(s.quote) == address(0) || s.platform == address(0) || s.feeBps > MAX_FEE_BPS || s.unit == 0
                || s.unit % 168 != 0 || (!testNetwork && s.unit != REAL_UNIT)
        ) revert BadSettings();
        // the dollar token must be a contract with the decimals every amount assumes, and fees must not go to the token or
        // to this contract (where they could never be collected)
        if (s.platform == address(this) || s.platform == address(s.quote) || address(s.quote).code.length == 0) {
            revert BadSettings();
        }
        try IDecimals(address(s.quote)).decimals() returns (uint8 d) {
            if (d != QUOTE_DECIMALS) revert BadSettings();
        } catch {
            revert BadSettings();
        }
        platform = s;
        emit SettingsChanged(s);
    }
}
