// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Call, Moloch, Shares, Loot} from "../../src/majeur/MolochPatched.sol";
import {AllocationVoting} from "../../src/AllocationVoting.sol";
import {MilestoneChallenge} from "../../src/MilestoneChallenge.sol";
import {TreasuryMandate} from "../../src/TreasuryMandate.sol";
import {ClaimStake} from "../../src/ClaimStake.sol";
import {VerifierSet} from "../../src/VerifierSet.sol";
import {ExitPreview} from "./ExitPreview.sol";

/// @notice The sale currency: six decimals, like USDC, so rounding in exits and bonds is the rounding a real raise has.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin (test)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Like USDC's issuer, block an address: transfers to or from it revert.
    mapping(address => bool) public blocked;

    function setBlocked(address who, bool on) external {
        blocked[who] = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, value);
    }
}

/// @notice Drives one launched project after its sale (the buyers have claimed): a patched Moloch DAO with a treasury in
/// USDC and ETH, Shares with a milestone challenge lock as their lock guard, a reviewed work budget with bonded reviewers,
/// and Loot. Every action is something a real account can do from the outside: move Shares, leave, run a whole vote
/// (open, allocate, wait, queue, wait, execute), publish / object / vote / settle a milestone, file and judge work claims,
/// post and take back bonds, and an attacker trying every privileged door. Nothing here pranks the DAO itself.
///
/// After each action the handler checks how money moved: the DAO's balances may fall only by an exit (exactly what the
/// web's exit preview says) or by a vote that met its bars (checked here, independently of the governor); the budget
/// only towards a claim it reserved for or back to the DAO; a bond only to its owner after the wait or, by a vote, to
/// the DAO. Any other movement is recorded as a violation, which the invariant contract asserts is zero.
contract MoneyPathsHandler is Test {
    // ---- the system -------------------------------------------------------------------------------
    Moloch public immutable dao;
    Shares public immutable shares;
    Loot public immutable loot;
    AllocationVoting public immutable policy;
    MilestoneChallenge public immutable lock;
    TreasuryMandate public immutable mandate;
    VerifierSet public immutable panel;
    ClaimStake public immutable claims;
    MockUSDC public immutable usdc;

    address[] internal _team;
    address[] internal _backers;
    address[] internal _reviewers;
    address public immutable looter;
    address public immutable contributor;
    address public immutable manager;
    address public constant ATTACKER = address(0xBAD);
    bytes32 public constant CHECK = keccak256("work budget acceptance check");
    address internal constant ETH = address(0);

    bytes32[] internal _claimIds;
    bytes32[] internal _projects;
    uint256 internal _nonce;

    // ---- what the run found -----------------------------------------------------------------------
    uint256 public violations;
    string public firstViolation;
    /// @notice USDC pushed straight into the lock from outside (it can never leave; the custody check allows for it).
    uint256 public donatedToLock;

    // Coverage counters, so a run that never reached a path is visible in the summary.
    mapping(bytes32 => uint256) public count;
    bytes32[] internal _countKeys;

    // Per-action allowances for money leaving the DAO, the budget and the reviewer panel.
    uint256 private _allowDaoUsdcOut;
    uint256 private _allowDaoEthOut;
    uint256 private _allowMandateOut;
    uint256 private _allowPanelOut;
    bool private _slashAllowed;
    uint256 private _daoUsdcBefore;
    uint256 private _daoEthBefore;
    uint256 private _mandateBefore;
    uint256 private _panelBefore;
    uint256 private _slashedBefore;

    constructor(
        Moloch dao_,
        MilestoneChallenge lock_,
        TreasuryMandate mandate_,
        MockUSDC usdc_,
        address[] memory team_,
        address[] memory backers_,
        address[] memory reviewers_,
        address looter_,
        address contributor_,
        address manager_
    ) {
        dao = dao_;
        shares = dao_.shares();
        loot = dao_.loot();
        policy = AllocationVoting(dao_.votingWeight());
        lock = lock_;
        mandate = mandate_;
        panel = mandate_.verifiers();
        claims = mandate_.claims();
        usdc = usdc_;
        _team = team_;
        _backers = backers_;
        _reviewers = reviewers_;
        looter = looter_;
        contributor = contributor_;
        manager = manager_;
    }

    // ---- views for the invariants -------------------------------------------------------------------

    function team() external view returns (address[] memory) {
        return _team;
    }

    function reviewers() external view returns (address[] memory) {
        return _reviewers;
    }

    /// @notice Every account that can be owed money by the lock: the actors and the DAO.
    function payees() external view returns (address[] memory list) {
        list = new address[](_team.length + _backers.length + 4);
        uint256 n;
        for (uint256 i; i < _team.length; ++i) list[n++] = _team[i];
        for (uint256 i; i < _backers.length; ++i) list[n++] = _backers[i];
        (list[n++], list[n++], list[n++], list[n]) = (looter, contributor, ATTACKER, address(dao));
    }

    function claimIds() external view returns (bytes32[] memory) {
        return _claimIds;
    }

    function countKeys() external view returns (bytes32[] memory) {
        return _countKeys;
    }

    // ---- bookkeeping --------------------------------------------------------------------------------

    function _fail(string memory why) internal {
        if (violations == 0) firstViolation = why;
        violations++;
    }

    function _hit(bytes32 key) internal {
        if (count[key] == 0) _countKeys.push(key);
        count[key]++;
    }

    function _slashedTotal() internal view returns (uint256 total) {
        for (uint256 i; i < _reviewers.length; ++i) {
            (,,, uint256 slashed) = panel.verifiers(_reviewers[i]);
            total += slashed;
        }
    }

    modifier step() {
        _allowDaoUsdcOut = 0;
        _allowDaoEthOut = 0;
        _allowMandateOut = 0;
        _allowPanelOut = 0;
        _slashAllowed = false;
        _daoUsdcBefore = usdc.balanceOf(address(dao));
        _daoEthBefore = address(dao).balance;
        _mandateBefore = usdc.balanceOf(address(mandate));
        _panelBefore = usdc.balanceOf(address(panel));
        _slashedBefore = _slashedTotal();
        _;
        _checkMoney();
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 12);
    }

    function _checkMoney() internal {
        uint256 daoUsdc = usdc.balanceOf(address(dao));
        uint256 daoEth = address(dao).balance;
        if (daoUsdc < _daoUsdcBefore && _daoUsdcBefore - daoUsdc > _allowDaoUsdcOut) {
            _fail("USDC left the DAO without a vote or an exit");
        }
        if (daoEth < _daoEthBefore && _daoEthBefore - daoEth > _allowDaoEthOut) {
            _fail("ETH left the DAO without a vote or an exit");
        }
        uint256 m = usdc.balanceOf(address(mandate));
        if (m < _mandateBefore && _mandateBefore - m > _allowMandateOut) {
            _fail("money left the work budget other than to a reserved claim or back to the DAO");
        }
        uint256 p = usdc.balanceOf(address(panel));
        if (p < _panelBefore && _panelBefore - p > _allowPanelOut) {
            _fail("bond money left the panel other than by a withdrawal or a voted slash");
        }
        if (_slashedTotal() != _slashedBefore && !_slashAllowed) _fail("a reviewer was slashed without a vote");
    }

    function _pick(address[] storage list, uint256 seed) internal view returns (address) {
        return list[seed % list.length];
    }

    /// @dev Anyone who might hold Shares or Loot: the team, the backers, the Loot holder, the contributor and the attacker.
    function _anyone(uint256 seed) internal view returns (address) {
        uint256 n = _team.length + _backers.length + 3;
        uint256 i = seed % n;
        if (i < _team.length) return _team[i];
        i -= _team.length;
        if (i < _backers.length) return _backers[i];
        i -= _backers.length;
        if (i == 0) return looter;
        if (i == 1) return contributor;
        return ATTACKER;
    }

    function _isTeam(address who) internal view returns (bool) {
        return lock.isTeam(who);
    }

    // ---- Shares: moving them ------------------------------------------------------------------------

    /// @notice Move Shares between holders. A team member's locked part must never move: a transfer that would dip into
    /// it must fail, and one that stays within the free part must succeed.
    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external step {
        address from = _anyone(fromSeed);
        address to = _anyone(toSeed);
        if (from == to) return;
        uint256 balance = shares.balanceOf(from);
        uint256 amount = bound(amountSeed, 0, balance);
        uint256 free = ExitPreview.burnable(balance, lock.lockedOf(from));
        vm.prank(from);
        (bool ok,) = address(shares).call(abi.encodeCall(Shares.transfer, (to, amount)));
        if (ok && amount > free) _fail("locked Shares moved by transfer");
        if (!ok && amount <= free) _fail("free Shares could not be transferred");
        if (ok) _hit(amount > 0 && _isTeam(from) ? bytes32("transfer.team") : bytes32("transfer"));
        else _hit("transfer.refusedLocked");
    }

    /// @notice A third party spends an allowance: the lock applies to `transferFrom` as well.
    function transferFromShares(uint256 fromSeed, uint256 amountSeed) external step {
        address from = _anyone(fromSeed);
        uint256 balance = shares.balanceOf(from);
        uint256 amount = bound(amountSeed, 0, balance);
        uint256 free = ExitPreview.burnable(balance, lock.lockedOf(from));
        vm.prank(from);
        shares.approve(ATTACKER, amount);
        vm.prank(ATTACKER);
        (bool ok,) = address(shares).call(abi.encodeCall(Shares.transferFrom, (from, ATTACKER, amount)));
        if (ok && amount > free) _fail("locked Shares moved by transferFrom");
        if (!ok && amount <= free) _fail("free Shares could not be moved with an allowance");
        _hit(ok ? bytes32("transferFrom") : bytes32("transferFrom.refusedLocked"));
    }

    // ---- leaving ------------------------------------------------------------------------------------

    /// @notice A holder leaves with part of their Shares and Loot. It must pay exactly what the exit screen computes from
    /// the same reads, and a burn into locked Shares must fail.
    function ragequit(uint256 whoSeed, uint256 sharesSeed, uint256 lootSeed, bool withEth) external step {
        address who = _anyone(whoSeed);
        uint256 sBal = shares.balanceOf(who);
        uint256 lBal = loot.balanceOf(who);
        uint256 sharesToBurn = bound(sharesSeed, 0, sBal);
        uint256 lootToBurn = bound(lootSeed, 0, lBal);
        if (sharesToBurn == 0 && lootToBurn == 0) return;
        uint256 burnable = ExitPreview.burnable(sBal, lock.lockedOf(who));
        uint256 total = ExitPreview.denominator(
            shares.totalSupply(),
            loot.totalSupply(),
            shares.balanceOf(address(dao)) + loot.balanceOf(address(dao)),
            lock.totalLocked()
        );
        address[] memory tokens = new address[](withEth ? 2 : 1);
        if (withEth) {
            tokens[0] = ETH;
            tokens[1] = address(usdc);
        } else {
            tokens[0] = address(usdc);
        }
        uint256 amt = sharesToBurn + lootToBurn;
        uint256 dueUsdc = ExitPreview.due(usdc.balanceOf(address(dao)), amt, total);
        uint256 dueEth = withEth ? ExitPreview.due(address(dao).balance, amt, total) : 0;
        uint256 usdcBefore = usdc.balanceOf(who);
        uint256 ethBefore = who.balance;
        _allowDaoUsdcOut = dueUsdc;
        _allowDaoEthOut = dueEth;
        vm.prank(who);
        (bool ok,) = address(dao).call(abi.encodeCall(Moloch.ragequit, (tokens, sharesToBurn, lootToBurn)));
        if (ok && sharesToBurn > burnable) _fail("locked Shares were ragequit");
        // A holder the currency blocks cannot be paid, so their exit fails; anyone else's must go through.
        if (!ok && sharesToBurn <= burnable && !(usdc.blocked(who) && dueUsdc != 0)) {
            _fail("an exit within the free Shares was refused");
        }
        if (!ok) {
            _hit("ragequit.refusedLocked");
            return;
        }
        if (usdc.balanceOf(who) - usdcBefore != dueUsdc) _fail("ragequit USDC differs from the exit preview");
        if (who.balance - ethBefore != dueEth) _fail("ragequit ETH differs from the exit preview");
        if (_daoUsdcBefore - usdc.balanceOf(address(dao)) != dueUsdc) _fail("DAO USDC fell by other than the exit");
        _hit(_isTeam(who) ? bytes32("ragequit.team") : bytes32("ragequit"));
    }

    // ---- governance: a whole vote -------------------------------------------------------------------

    struct Vote {
        uint256 id;
        bool passing;
        bool executed;
    }

    /// @dev Open a proposal for (target, value, data), let the holders allocate according to `voteSeed`, wait out the review
    /// and the hold, queue, wait out the delay, and try to execute. Returns whether it ran and whether it met every bar,
    /// checked here from the policy's raw numbers rather than from the governor's own `state`.
    function _govern(address target, uint256 value, bytes memory data, uint256 voteSeed)
        internal
        returns (Vote memory v)
    {
        bytes32 nonce = bytes32(++_nonce);
        address proposer;
        for (uint256 i; i < _backers.length; ++i) {
            address b = _backers[(voteSeed % _backers.length + i) % _backers.length];
            if (policy.capacity(b) != 0) {
                proposer = b;
                break;
            }
        }
        if (proposer == address(0)) return v;
        vm.prank(proposer);
        try dao.openProposalWithAction(0, target, value, data, nonce) returns (uint256 id) {
            v.id = id;
        } catch {
            _hit("govern.openRefused");
            return v;
        }
        // Most rounds the holders mostly agree; some rounds anything goes.
        bool contested = voteSeed % 4 == 0;
        uint256 voters = _team.length + _backers.length;
        for (uint256 i; i < voters; ++i) {
            address voter = i < _team.length ? _team[i] : _backers[i - _team.length];
            uint256 r = uint256(keccak256(abi.encode(voteSeed, i)));
            uint8 side = contested ? uint8(r % 4) : (r % 10 < 8 ? 1 : uint8(r % 4));
            if (side == 3) continue;
            uint256 amount = r % 3 == 0 ? (r >> 8) % (policy.capacity(voter) + 1) : type(uint256).max;
            vm.prank(voter);
            try dao.castVote(v.id, side, amount) {} catch {}
        }
        vm.warp(vm.getBlockTimestamp() + 48 hours + 12 hours + 1);
        vm.roll(vm.getBlockNumber() + 1);
        try dao.queue(v.id) {} catch {}
        // Sometimes a holder changes their mind while it is queued, which must restart the clock.
        if (voteSeed % 7 == 3) {
            address late = _backers[voteSeed % _backers.length];
            vm.prank(late);
            try dao.castVote(v.id, 0, type(uint256).max) {} catch {}
        }
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.roll(vm.getBlockNumber() + 1);
        v.passing = _passing(v.id);
        try dao.executeByVotes(0, target, value, data, nonce) {
            v.executed = dao.executed(v.id);
        } catch {}
        if (v.executed && !v.passing) _fail("a proposal executed without meeting its bars");
        _hit(v.executed ? bytes32("govern.executed") : bytes32("govern.notExecuted"));
    }

    /// @dev Independent of `Moloch.state`: quorum of voting supply (supply at the snapshot less the DAO's own and burned
    /// Shares), approval share and majority, the review and the unbroken hold, not expired, and queued for the delay.
    function _passing(uint256 id) internal view returns (bool) {
        (
            uint96 votingSupply,
            uint96 quorum,
            uint96 minYes,
            uint16 approvalBps,
            uint64 reviewEndsAt,
            uint64 expiresAt,
            uint64 delay,
            uint64 hold,
            bool bounded,
        ) = policy.proposals(id);
        (uint96 yes, uint96 no, uint96 abstain, uint64 since) = policy.proposalSupport(id);
        uint48 snap = dao.snapshotBlock(id);
        uint256 expectSupply = shares.getPastTotalSupply(snap) - policy.getPastCapacity(address(dao), snap)
            - policy.getPastCapacity(policy.BURN(), snap);
        uint256 laneQuorum = (expectSupply * (bounded ? 1000 : 2000) + 9999) / 10_000;
        uint64 queued = dao.queuedAt(id);
        uint256 earliest = uint256(since) + hold;
        if (earliest < reviewEndsAt) earliest = reviewEndsAt;
        return votingSupply == expectSupply && quorum >= laneQuorum && approvalBps >= (bounded ? 5500 : 6600)
            && delay >= 1 days && since != 0 && block.timestamp >= earliest && block.timestamp < expiresAt
            && uint256(yes) + no + abstain >= quorum && yes >= minYes && yes > no
            && uint256(yes) * 10_000 >= uint256(approvalBps) * (uint256(yes) + no) && queued != 0
            && block.timestamp >= uint256(queued) + delay;
    }

    /// @notice A vote that tries to create Shares or Loot, hand out the DAO's own Shares, or burn a holder's Shares. Under
    /// the issuance rule (D76) and the leaving-only burn (D73) none of these can run, however the holders vote: Shares come
    /// only from awards for reviewed work, and only their owner's exit burns them.
    function governShareMoves(uint8 kind, uint256 whoSeed, uint256 amountSeed, uint256 voteSeed) external step {
        address who = _anyone(whoSeed);
        uint256 amount = bound(amountSeed, 1, 100e18);
        kind %= 4;
        bytes memory data;
        address target = address(shares);
        if (kind == 0) data = abi.encodeCall(Shares.mintFromMoloch, (who, amount));
        else if (kind == 1) data = abi.encodeCall(Shares.transfer, (who, amount));
        else if (kind == 2) data = abi.encodeCall(Shares.burnFromMoloch, (who, 1));
        else (target, data) = (address(loot), abi.encodeCall(Loot.mintFromMoloch, (who, amount)));
        uint256 supply = shares.totalSupply();
        uint256 lootSupply = loot.totalSupply();
        uint256 balance = shares.balanceOf(who);
        Vote memory v = _govern(target, 0, data, voteSeed);
        if (v.executed) _fail("a vote created, handed out or burned Shares outside an award or an exit");
        if (shares.totalSupply() != supply || loot.totalSupply() != lootSupply || shares.balanceOf(who) != balance) {
            _fail("Shares changed hands outside an award or an exit");
        }
        _hit("govern.shareMoveRefused");
    }

    /// @notice A vote to pay USDC or ETH out of the treasury to anyone (the attacker included).
    function governPay(uint256 amountSeed, uint256 toSeed, bool inEth, uint256 voteSeed) external step {
        address to = _anyone(toSeed);
        uint256 amount;
        Vote memory v;
        if (inEth) {
            amount = bound(amountSeed, 1, address(dao).balance + 1);
            _allowDaoEthOut = amount;
            v = _govern(to, amount, "", voteSeed);
        } else {
            amount = bound(amountSeed, 1, usdc.balanceOf(address(dao)) + 1);
            _allowDaoUsdcOut = amount;
            v = _govern(address(usdc), 0, abi.encodeCall(ERC20.transfer, (to, amount)), voteSeed);
        }
        if (v.executed) _hit(inEth ? bytes32("govern.payEth") : bytes32("govern.payUsdc"));
    }

    /// @notice A bounded-lane vote approving a project inside the work budget.
    function governApproveProject(uint256 amountSeed, uint256 voteSeed) external step {
        bytes32 pid = keccak256(abi.encode("project", ++_nonce));
        uint128 amount = uint128(bound(amountSeed, 1, mandate.perProjectCap()));
        bytes memory data = abi.encodeCall(
            TreasuryMandate.approveProject, (pid, manager, amount, 0, mandate.expiresAt(), CHECK)
        );
        Vote memory v = _govern(address(mandate), 0, data, voteSeed);
        if (v.executed) {
            _projects.push(pid);
            _hit("govern.approveProject");
        }
    }

    /// @notice Votes that act on the budget after the fact: freeze a claim, unwind a frozen one, close the budget.
    function governMandate(uint8 kind, uint256 claimSeed, uint256 voteSeed) external step {
        kind %= 3;
        bytes memory data;
        if (kind == 2) {
            data = abi.encodeCall(TreasuryMandate.close, ());
            // Closing returns the unreserved budget to the DAO.
            _allowMandateOut = usdc.balanceOf(address(mandate));
        } else {
            if (_claimIds.length == 0) return;
            bytes32 claimId = _claimIds[claimSeed % _claimIds.length];
            data = kind == 0
                ? abi.encodeCall(TreasuryMandate.freezeClaim, (claimId))
                : abi.encodeCall(TreasuryMandate.resolveFrozenClaim, (claimId));
        }
        Vote memory v = _govern(address(mandate), 0, data, voteSeed);
        if (v.executed) _hit(kind == 0 ? bytes32("govern.freeze") : kind == 1 ? bytes32("govern.unwind") : bytes32("govern.close"));
    }

    /// @notice A vote to take part of a reviewer's bond. It must take no more than the reviewer holds (stake, then bond
    /// waiting to be taken back), and pay what it took to the DAO.
    function governSlash(uint256 reviewerSeed, uint256 amountSeed, uint256 voteSeed) external step {
        address r = _pick(_reviewers, reviewerSeed);
        (, uint256 stake,, uint256 slashedBefore) = panel.verifiers(r);
        (uint256 pending,) = panel.unbonds(r);
        uint256 held = stake + pending;
        uint256 amount = bound(amountSeed, 1, held * 2 + 1);
        _slashAllowed = true;
        _allowPanelOut = held;
        Vote memory v = _govern(address(mandate), 0, abi.encodeCall(TreasuryMandate.slashReviewer, (r, amount)), voteSeed);
        (,,, uint256 slashedAfter) = panel.verifiers(r);
        uint256 taken = slashedAfter - slashedBefore;
        if (!v.executed) {
            if (taken != 0) _fail("a bond was slashed by a vote that did not run");
            return;
        }
        if (taken != (amount < held ? amount : held)) _fail("a slash took other than min(asked, held)");
        if (usdc.balanceOf(address(dao)) < _daoUsdcBefore + taken) _fail("a slashed bond did not reach the DAO");
        _hit(taken == 0 ? bytes32("govern.slashEmpty") : bytes32("govern.slash"));
    }

    /// @notice A vote to give up a departed team member's remaining tranches: burned, never freed.
    function governForfeit(uint256 teamSeed, uint256 voteSeed) external step {
        // Rarer than the other votes: a forfeit ends the milestone schedule for that member.
        if (voteSeed % 4 != 0) return;
        address who = _pick(_team, teamSeed);
        uint256 locked = lock.lockedOf(who);
        uint256 balance = shares.balanceOf(who);
        Vote memory v = _govern(address(lock), 0, abi.encodeCall(MilestoneChallenge.forfeit, (who)), voteSeed);
        if (!v.executed) return;
        if (lock.lockedOf(who) != 0) _fail("a forfeit left Shares locked");
        if (shares.balanceOf(who) != balance - locked) _fail("a forfeit burned other than the locked Shares");
        _hit("govern.forfeit");
    }

    // ---- milestones that unlock unless holders object -----------------------------------------------

    /// @dev Most of the time aim at the milestone in play (the first not yet standing, or the newest one that still can be
    /// objected to late); sometimes any milestone at all, so out-of-order calls are tried too.
    function _target(uint256 seed) internal view returns (uint256) {
        uint256 n = lock.milestoneCount();
        if (seed % 5 == 0) return (seed >> 8) % n;
        for (uint256 k; k < n; ++k) {
            (bool open,,,,,,,,) = lock.objection(k);
            if (open) return k;
        }
        uint256 latestStood = type(uint256).max;
        for (uint256 k; k < n; ++k) {
            (MilestoneChallenge.Phase phase,,,,,,,) = lock.milestone(k);
            if (phase != MilestoneChallenge.Phase.Stood) {
                // Once a milestone has stood, its successor is the one in play only after the late-objection month.
                if (latestStood != type(uint256).max && seed % 3 == 0) return latestStood;
                return k;
            }
            latestStood = k;
        }
        return n - 1;
    }

    function submitMilestone(uint256 teamSeed, uint256 indexSeed) external step {
        _submit(_pick(_team, teamSeed), _target(indexSeed));
    }

    function objectMilestone(uint256 whoSeed, uint256 indexSeed) external step {
        _object(_anyone(whoSeed), _target(indexSeed));
    }

    function voteMilestone(uint256 whoSeed, uint256 indexSeed, bool reject) external step {
        _vote(_anyone(whoSeed), _target(indexSeed), reject);
    }

    function finishMilestone(uint256 indexSeed) external step {
        _finish(_target(indexSeed));
    }

    function resolveMilestone(uint256 indexSeed) external step {
        _resolve(_target(indexSeed));
    }

    /// @notice One milestone played through in a plausible order: published, then either waited out and finished or objected
    /// to and voted on by the holders, then perhaps objected to again within the month and settled. The single-step actions
    /// above try the strange orders; this one makes sure runs get deep into the schedule.
    function milestoneRound(uint256 seed) external step {
        uint256 index = _target(seed);
        uint256 r = uint256(keccak256(abi.encode(seed, "round")));
        (MilestoneChallenge.Phase phase,,,,, uint64 windowEnds,,) = lock.milestone(index);
        if (phase == MilestoneChallenge.Phase.None) {
            _submit(_pick(_team, r), index);
            (phase,,,,, windowEnds,,) = lock.milestone(index);
        }
        if (phase == MilestoneChallenge.Phase.Pending) {
            if (r % 3 == 0) {
                vm.warp(windowEnds);
                _finish(index);
            } else {
                _objectAndSettle(r, index);
            }
        }
        (phase,,,,,,,) = lock.milestone(index);
        if (phase == MilestoneChallenge.Phase.Stood && (r >> 16) % 5 < 2) _objectAndSettle(r >> 32, index);
        if ((r >> 48) % 2 == 0) vm.warp(vm.getBlockTimestamp() + lock.clawback());
        _hit("milestone.round");
    }

    /// @dev An objection by a random holder, votes by everyone else at random, the vote waited out and settled.
    function _objectAndSettle(uint256 r, uint256 index) internal {
        address objector = _anyone(r);
        vm.roll(vm.getBlockNumber() + 1);
        if (!_object(objector, index)) return;
        vm.roll(vm.getBlockNumber() + 1);
        // D57's attack: after the objection, a holder passes Shares to another wallet and both vote. Each must count only
        // the smaller of what it owned before the objection and what it holds now.
        if ((r >> 24) % 2 == 0) {
            address from = _backers[(r >> 32) % _backers.length];
            address to = (r >> 40) % 2 == 0 ? ATTACKER : contributor;
            uint256 half = shares.balanceOf(from) / 2;
            vm.prank(from);
            try shares.transfer(to, half) {
                _hit("milestone.sharesPassedOn");
            } catch {}
        }
        uint256 voters = _team.length + _backers.length + 3;
        for (uint256 i; i < voters; ++i) {
            uint256 v = uint256(keccak256(abi.encode(r, i)));
            if (v % 3 == 0) continue;
            _vote(_anyone(i), index, v % 2 == 0);
        }
        (,,,, uint64 voteEnds,,,,) = lock.objection(index);
        vm.warp(voteEnds);
        vm.roll(vm.getBlockNumber() + 1);
        // Sometimes the currency's issuer blocks the objector while the vote runs: settling must still go through.
        if ((r >> 56) % 4 == 0) {
            usdc.setBlocked(objector, true);
            _hit("issuer.blockObjector");
        }
        _resolve(index);
    }

    function _submit(address who, uint256 index) internal {
        vm.prank(who);
        try lock.submit(index, keccak256(abi.encode("evidence", index, _nonce++))) {
            _hit("milestone.submit");
        } catch {}
    }

    function _expectedWeight(address who, uint48 snapshot) internal view returns (uint256) {
        if (who == address(dao) || _isTeam(who)) return 0;
        uint256 past = policy.getPastCapacity(who, snapshot);
        uint256 now_ = shares.balanceOf(who);
        return past < now_ ? past : now_;
    }

    /// @dev D57: an objection counts the Shares the objector owned just before it, capped by what they hold now.
    function _object(address who, uint256 index) internal returns (bool ok) {
        uint256 expected = _expectedWeight(who, uint48(vm.getBlockNumber() - 1));
        vm.prank(who);
        try lock.object(index) {
            ok = true;
            (, bool late,,,,,, uint256 rejectWeight,) = lock.objection(index);
            if (_isTeam(who)) _fail("a team member objected to their own milestone");
            if (rejectWeight != expected) _fail("an objection counted other than the Shares owned before it");
            _hit(late ? bytes32("milestone.objectLate") : bytes32("milestone.object"));
        } catch {}
    }

    function _vote(address who, uint256 index, bool reject) internal {
        (bool open,,, uint48 snapshot,,,, uint256 rejBefore, uint256 accBefore) = lock.objection(index);
        if (!open) return;
        uint256 expected = _expectedWeight(who, snapshot);
        vm.prank(who);
        try lock.vote(index, reject) {
            (,,,,,,, uint256 rej, uint256 acc) = lock.objection(index);
            if (_isTeam(who)) _fail("a team member voted on their own milestone");
            if ((rej - rejBefore) + (acc - accBefore) != expected) {
                _fail("a milestone vote counted other than the Shares owned before the objection");
            }
            _hit("milestone.vote");
        } catch {}
    }

    function _finish(uint256 index) internal {
        try lock.finish(index) {
            _hit("milestone.finish");
        } catch {}
    }

    /// @dev Settle a vote. A late objection that is upheld must burn exactly what is still locked, and (D58) for any
    /// milestone but the last there must be something to burn unless the DAO already gave those tranches up.
    function _resolve(uint256 index) internal {
        (bool open, bool late,,,,, uint256 eligible, uint256 rej, uint256 acc) = lock.objection(index);
        if (!open) return;
        bool upheld = rej > acc && rej * 10_000 >= eligible * lock.minRejectBps();
        uint256 lockedBefore;
        bool aheadForfeited = true;
        for (uint256 b; b < _team.length; ++b) {
            lockedBefore += lock.lockedOf(_team[b]);
            for (uint256 j = index + 1; j < lock.milestoneCount(); ++j) {
                if (!lock.trancheOf(_team[b], j).forfeited) aheadForfeited = false;
            }
        }
        uint256 supplyBefore = shares.totalSupply();
        (,,,, uint64 voteEnds,,,,) = lock.objection(index);
        try lock.resolve(index) {} catch {
            // Liveness: once the vote has ended anyone must be able to settle it, whoever the currency blocks.
            if (block.timestamp >= voteEnds) _fail("a vote that had ended could not be settled");
            return;
        }
        uint256 burned = supplyBefore - shares.totalSupply();
        (MilestoneChallenge.Phase phase,,,,,,,) = lock.milestone(index);
        if (late) {
            if (upheld) {
                if (burned != lockedBefore) _fail("an upheld late objection burned other than what was locked");
                if (index + 1 < lock.milestoneCount() && burned == 0 && !aheadForfeited) {
                    _fail("D58: an upheld late objection had nothing to burn");
                }
                _hit(burned == 0 ? bytes32("milestone.lateUpheldEmpty") : bytes32("milestone.lateUpheld"));
            } else {
                if (burned != 0) _fail("a late objection that failed burned Shares");
                _hit("milestone.lateFailed");
            }
        } else {
            if (burned != 0) _fail("an objection before the unlock burned Shares");
            if (upheld && phase != MilestoneChallenge.Phase.None) _fail("an upheld objection did not send it back");
            if (!upheld && phase != MilestoneChallenge.Phase.Stood) _fail("a failed objection did not let it stand");
            _hit(upheld ? bytes32("milestone.upheld") : bytes32("milestone.objectionFailed"));
        }
    }

    function releaseBond(uint256 indexSeed) external step {
        uint256 index = _target(indexSeed);
        try lock.releaseBond(index) {
            _hit("milestone.releaseBond");
        } catch {}
    }

    /// @notice Someone sends USDC straight to the lock. It is stuck there (no path takes it out), which is fine, but it
    /// must never make the lock pay out more than it owes.
    function donateToLock(uint256 amountSeed) external step {
        uint256 amount = bound(amountSeed, 1, 1_000e6);
        usdc.mint(address(this), amount);
        usdc.transfer(address(lock), amount);
        donatedToLock += amount;
        _hit("lock.donation");
    }

    // ---- the work budget ----------------------------------------------------------------------------

    function submitClaim(uint256 amountSeed, uint256 stakeSeed) external step {
        bytes32 claimId = keccak256(abi.encode("claim", ++_nonce));
        uint256 amount = bound(amountSeed, 0, 30_000e6);
        uint256 stake = bound(stakeSeed, 0, 500e6);
        vm.startPrank(contributor);
        try claims.submitClaim(claimId, amount, stake, keccak256(abi.encode("work", claimId))) {
            claims.setCheck(claimId, CHECK);
            _claimIds.push(claimId);
            _hit("work.submit");
        } catch {}
        vm.stopPrank();
    }

    function fundClaim(uint256 projectSeed, uint256 claimSeed) external step {
        if (_projects.length == 0 || _claimIds.length == 0) return;
        bytes32 pid = _projects[projectSeed % _projects.length];
        bytes32 claimId = _claimIds[claimSeed % _claimIds.length];
        (, uint256 amount,,) = claims.claimTerms(claimId);
        uint256 claimsBefore = usdc.balanceOf(address(claims));
        _allowMandateOut = amount;
        vm.prank(manager);
        try mandate.fundMilestone(pid, claimId, contributor) {
            if (usdc.balanceOf(address(claims)) - claimsBefore != amount) _fail("a reservation did not reach its claim");
            _hit("work.fund");
        } catch {}
    }

    function attestClaim(uint256 reviewerSeed, uint256 claimSeed, bool approve) external step {
        if (_claimIds.length == 0) return;
        address r = _pick(_reviewers, reviewerSeed);
        vm.prank(r);
        try panel.attest(_claimIds[claimSeed % _claimIds.length], approve) {
            _hit("work.attest");
        } catch {}
    }

    function settleClaim(uint256 claimSeed) external step {
        if (_claimIds.length == 0) return;
        try claims.settle(_claimIds[claimSeed % _claimIds.length]) {
            _hit("work.settle");
        } catch {}
    }

    /// @notice The contributor takes an approved payout. It must pay exactly the claim and its stake, once, and only after
    /// the challenge window.
    function payoutClaim(uint256 claimSeed) external step {
        if (_claimIds.length == 0) return;
        _payout(_claimIds[claimSeed % _claimIds.length]);
    }

    function _payout(bytes32 claimId) internal {
        (, uint256 amount, uint256 stake, ClaimStake.Status status,,,, uint64 releasedAt) = claims.claims(claimId);
        uint256 before = usdc.balanceOf(contributor);
        vm.prank(contributor);
        try claims.payout(claimId) {
            if (status != ClaimStake.Status.Approved) _fail("a payout ran for a claim that was not approved");
            if (block.timestamp < uint256(releasedAt) + 7 days) _fail("a payout ran inside the challenge window");
            if (usdc.balanceOf(contributor) - before != amount + stake) _fail("a payout paid other than claim + stake");
            _hit("work.payout");
        } catch {}
    }

    /// @notice Anyone lets a claim lapse. Liveness (ES-2): once an open claim is past its deadline this must always go
    /// through, whoever the currency blocks, so its reserve can never be stranded.
    function expireClaim(uint256 claimSeed) external step {
        if (_claimIds.length == 0) return;
        bytes32 claimId = _claimIds[claimSeed % _claimIds.length];
        (,,, ClaimStake.Status status,,, uint64 expiresAt,) = claims.claims(claimId);
        try claims.expire(claimId) {
            _hit("work.expire");
        } catch {
            if (status == ClaimStake.Status.Open && block.timestamp > expiresAt) {
                _fail("a lapsed claim could not be expired");
            }
        }
    }

    /// @notice One claim played through: filed, reserved for in a project, judged by the reviewers, settled, perhaps frozen
    /// by a vote, then paid after the challenge window or unwound.
    function workRound(uint256 seed) external step {
        if (_projects.length == 0) return;
        uint256 r = uint256(keccak256(abi.encode(seed, "work")));
        bytes32 claimId = keccak256(abi.encode("claim", ++_nonce));
        uint256 amount = bound(r, 0, 20_000e6);
        vm.startPrank(contributor);
        try claims.submitClaim(claimId, amount, bound(r >> 64, 0, 300e6), keccak256(abi.encode("work", claimId))) {
            claims.setCheck(claimId, CHECK);
        } catch {
            vm.stopPrank();
            return;
        }
        vm.stopPrank();
        _claimIds.push(claimId);
        _allowMandateOut = amount;
        vm.prank(manager);
        try mandate.fundMilestone(_projects[seed % _projects.length], claimId, contributor) {} catch {}
        bool approve = (r >> 128) % 4 != 0;
        for (uint256 i; i < _reviewers.length; ++i) {
            vm.prank(_reviewers[i]);
            try panel.attest(claimId, approve) {} catch {}
        }
        try claims.settle(claimId) {} catch {}
        // Straight after approval the payout must still be refused: the challenge window has only just begun.
        _payout(claimId);
        if ((r >> 136) % 4 == 0) {
            Vote memory v = _govern(address(mandate), 0, abi.encodeCall(TreasuryMandate.freezeClaim, (claimId)), r);
            if (v.executed) {
                _govern(address(mandate), 0, abi.encodeCall(TreasuryMandate.resolveFrozenClaim, (claimId)), r >> 8);
            }
        }
        vm.warp(vm.getBlockTimestamp() + 7 days);
        _payout(claimId);
        _hit("work.round");
    }

    function returnUnused() external step {
        _allowMandateOut = usdc.balanceOf(address(mandate));
        uint256 daoBefore = usdc.balanceOf(address(dao));
        try mandate.returnUnused() {
            if (usdc.balanceOf(address(dao)) - daoBefore != _allowMandateOut) _fail("unused budget did not return to the DAO");
            _hit("work.returnUnused");
        } catch {}
    }

    /// @notice Reviewers post bond, ask for it back, and take it back after the wait.
    function reviewerBond(uint256 reviewerSeed, uint8 kind, uint256 amountSeed) external step {
        address r = _pick(_reviewers, reviewerSeed);
        kind %= 3;
        if (kind == 0) {
            uint256 amount = bound(amountSeed, 1, 2_000e6);
            vm.prank(r);
            try panel.bond(amount) {
                _hit("bond.post");
            } catch {}
        } else if (kind == 1) {
            (, uint256 stake,,) = panel.verifiers(r);
            if (stake == 0) return;
            vm.prank(r);
            try panel.requestUnbond(bound(amountSeed, 1, stake)) {
                _hit("bond.requestBack");
            } catch {}
        } else {
            (uint256 pending, uint64 availableAt) = panel.unbonds(r);
            _allowPanelOut = pending;
            uint256 before = usdc.balanceOf(r);
            vm.prank(r);
            try panel.withdraw() {
                if (block.timestamp < availableAt) _fail("a bond was taken back before the wait");
                if (usdc.balanceOf(r) - before != pending) _fail("a bond withdrawal paid other than what was pending");
                _hit("bond.withdraw");
            } catch {}
        }
    }

    // ---- an outsider at every privileged door -------------------------------------------------------

    /// @notice A stranger (or a holder, or a reviewer) calls something only the DAO, the lock or the budget may call. Every
    /// one of these must revert; if any succeeds, that is a violation in itself, and `_checkMoney` catches any money moved.
    /// The allowance, permit and leaving-switch doors no longer exist on the DAO (D73, D76); calling them must still fail.
    function attack(uint8 door, uint256 whoSeed, uint256 amountSeed) external step {
        address who = whoSeed % 3 == 0 ? ATTACKER : whoSeed % 3 == 1 ? _anyone(whoSeed >> 2) : _pick(_reviewers, whoSeed);
        uint256 amount = bound(amountSeed, 1, 1_000_000e6);
        bytes memory transferOut = abi.encodeCall(ERC20.transfer, (who, amount));
        address target;
        bytes memory data;
        door %= 18;
        if (door == 0) (target, data) = (address(dao), abi.encodeWithSignature("spendAllowance(address,uint256)", address(usdc), amount));
        else if (door == 1) (target, data) = (address(dao), abi.encodeWithSignature("setAllowance(address,address,uint256)", who, address(usdc), amount));
        else if (door == 2) {
            Call[] memory calls = new Call[](1);
            calls[0] = Call(address(usdc), 0, transferOut);
            (target, data) = (address(dao), abi.encodeCall(Moloch.batchCalls, (calls)));
        } else if (door == 3) {
            (target, data) = (
                address(dao),
                abi.encodeCall(Moloch.executeByVotes, (0, address(usdc), 0, transferOut, bytes32(amountSeed)))
            );
        } else if (door == 4) {
            (target, data) =
                (address(dao), abi.encodeWithSignature(
                    "spendPermit(uint8,address,uint256,bytes,bytes32)", uint8(0), address(usdc), uint256(0), transferOut, bytes32(amountSeed)
                ));
        } else if (door == 5) (target, data) = (address(mandate), abi.encodeCall(TreasuryMandate.close, ()));
        else if (door == 6) {
            (target, data) =
                (address(mandate), abi.encodeCall(TreasuryMandate.slashReviewer, (_pick(_reviewers, amountSeed), amount)));
        } else if (door == 7) (target, data) = (address(panel), abi.encodeCall(VerifierSet.slash, (_pick(_reviewers, amountSeed), amount)));
        else if (door == 8) (target, data) = (address(shares), abi.encodeCall(Shares.burnForfeited, (_pick(_team, amountSeed), amount)));
        else if (door == 9) (target, data) = (address(shares), abi.encodeCall(Shares.burnFromMoloch, (_anyone(amountSeed), 1)));
        else if (door == 10) (target, data) = (address(shares), abi.encodeCall(Shares.mintFromMoloch, (who, amount)));
        else if (door == 11) (target, data) = (address(lock), abi.encodeCall(MilestoneChallenge.forfeit, (_pick(_team, amountSeed))));
        else if (door == 12) (target, data) = (address(usdc), abi.encodeCall(ERC20.transferFrom, (address(dao), who, amount)));
        else if (door == 13) (target, data) = (address(shares), abi.encodeCall(Shares.setLockGuard, (address(0))));
        else if (door == 14) {
            if (_claimIds.length == 0) return;
            (target, data) = (address(claims), abi.encodeCall(ClaimStake.freeze, (_claimIds[amountSeed % _claimIds.length])));
        } else if (door == 15) {
            if (_projects.length == 0) return;
            // Somebody other than the project's manager tries to reserve budget for a claim.
            (target, data) = (
                address(mandate),
                abi.encodeCall(
                    TreasuryMandate.fundMilestone,
                    (_projects[amountSeed % _projects.length], keccak256(abi.encode(amountSeed)), who)
                )
            );
            if (who == manager) return;
        } else if (door == 16) (target, data) = (address(dao), abi.encodeWithSignature("setRagequittable(bool)", false));
        else {
            bytes[] memory inner = new bytes[](1);
            inner[0] = abi.encodeWithSignature("spendAllowance(address,uint256)", address(usdc), amount);
            (target, data) = (address(dao), abi.encodeCall(Moloch.multicall, (inner)));
        }
        vm.prank(who);
        (bool ok,) = target.call(data);
        if (ok) _fail("a privileged door opened for an outsider");
        _hit("attack.refused");
    }

    // ---- the currency's issuer ----------------------------------------------------------------------

    /// @notice The issuer blocks (or unblocks) one of the actors, as USDC's can. Nothing they are owed may be lost, and
    /// nothing anyone else does may get stuck because of it.
    function issuerBlocks(uint256 whoSeed, bool on) external step {
        address who = _anyone(whoSeed);
        usdc.setBlocked(who, on);
        _hit(on ? bytes32("issuer.block") : bytes32("issuer.unblock"));
    }

    /// @notice Someone takes what settling a vote could not pay them; only ever to themselves.
    function withdrawOwed(uint256 whoSeed) external step {
        address who = _anyone(whoSeed);
        uint256 amount = lock.owed(who);
        uint256 before = usdc.balanceOf(who);
        vm.prank(who);
        try lock.withdrawOwed() {
            if (usdc.balanceOf(who) - before != amount) _fail("withdrawOwed paid other than what was owed");
            if (amount != 0) _hit("lock.withdrawOwed");
        } catch {
            if (!usdc.blocked(who)) _fail("an unblocked payee could not take what was owed");
        }
    }

    // ---- time ---------------------------------------------------------------------------------------

    function elapse(uint256 secondsSeed) external step {
        vm.warp(vm.getBlockTimestamp() + bound(secondsSeed, 1 hours, 12 days));
        _hit("elapse");
    }
}
