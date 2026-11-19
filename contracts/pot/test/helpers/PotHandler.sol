// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {Treasury} from "../../src/Treasury.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {Vester} from "../../src/Vester.sol";
import {PotMath} from "../../src/PotMath.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";

/// @notice Drives one project through the real stack from many actors: joins, leaves, Team leaves, outside payments, forfeits
/// and grants (vesting is active time, so check-ins and warps move it), draws by the runner and by an agent, rate changes,
/// check-ins, lapses, a wind-down, fee collection and a full-exit probe. It keeps ghost sums of the dollars that went in and
/// out and records the FIRST rule a step broke in `violation`, so the invariant file can state each rule once.
///
/// Rules checked inside the steps (they need the state before and after one step):
///  - a joiner who leaves at once is paid no more than they put in after the fee, and earlier holders' total value falls on a
///    join by at most the quote offset allows (100 Shares priced at the old value less one dollar), plus rounding. (The price
///    a joiner is quoted is NOT monotone: the offset is virtual paid-in and Shares in the price but the credit uses the real
///    paid-in per Share, so the price can dip by a part in 1e13 at 76 million Shares and by more with few Shares.);
///  - no leave, Team leave, outside payment, grant, claim, forfeit, check-in, rate change, fee collection or draw lowers
///    what a backer Share is worth (to within one unit): only the allowance accruing with time and the platform fee may;
///  - a Team leave never reaches into the backers' paid-in money;
///  - the full-exit probe: every backer leaving in a shuffled order is paid what the first would have been, to within the
///    rounding of the run, and all backers and then the Team together are never paid more than the pot held.
contract PotHandler is Test {
    uint256 internal constant N_ACTORS = 6;

    QuoteToken internal usd;
    Treasury internal t;
    ShareToken internal shares;
    ShareToken internal team;
    Vester internal v;
    address internal founder;
    address internal agent;
    address internal sink = address(0x51F);

    address[] internal actors;

    // ghost sums
    uint256 public cashIn; // dollars sent into the Treasury by joins and outside payments
    uint256 public cashOut; // dollars it sent out: leaves, Team leaves, draws, fees collected
    uint256 public creditedMax; // sum of what joins could add to paid-in (their net amounts)
    uint256 public lastTeam; // Team supply after the last step: it must never rise
    uint256 public pool;
    string public violation;

    // step counters, to see that the run reached every kind of step
    mapping(bytes32 => uint256) public count;
    bytes32[] internal names;

    constructor(
        QuoteToken usd_,
        Treasury t_,
        ShareToken shares_,
        ShareToken team_,
        Vester v_,
        address founder_,
        uint256 pool_
    ) {
        (usd, t, shares, team, v, founder, pool) = (usd_, t_, shares_, team_, v_, founder_, pool_);
        lastTeam = pool_;
        for (uint256 i; i < N_ACTORS; ++i) {
            actors.push(makeAddr(string.concat("handler-actor-", vm.toString(i))));
        }
        agent = makeAddr("handler-agent");
        vm.prank(founder_);
        t_.authoriseAgent(agent);
    }

    function actorsList() external view returns (address[] memory) {
        return actors;
    }

    // ================================================= helpers =======================================================

    function _hit(bytes32 what) internal {
        if (count[what] == 0) names.push(what);
        ++count[what];
    }

    function _bad(string memory what) internal {
        if (bytes(violation).length == 0) violation = what;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % N_ACTORS];
    }

    /// @dev What `n` backer Shares are paid right now (the leave formula on the stored, settled numbers).
    function _value(uint256 n) internal view returns (uint256) {
        uint256 b = shares.totalSupply();
        if (b == 0) return 0;
        return PotMath.cash(n, t.pot(), t.paidIn(), b, team.totalSupply());
    }

    /// @dev Called at the end of a step: settle at this second (so the box is cut to its cap), and check what no step may break.
    function _after() internal {
        t.settle();
        uint256 g = team.totalSupply();
        if (g > lastTeam) _bad("Team Shares were created after birth");
        lastTeam = g;
    }

    /// @dev What a backer Share is worth, after a step that is not a spend, must not be lower than before (one unit of rounding).
    function _notLower(uint256 before_, string memory step) internal {
        uint256 after_ = t.leaveValue();
        if (after_ + 1 < before_) _bad(string.concat("a backer Share lost value on ", step));
    }

    // ================================================= steps =========================================================

    function join(uint256 who, uint256 amountSeed) public {
        t.settle();
        if (!t.doorOpenNow()) return;
        uint256 span = [uint256(1e8), 1e9, 1e10, 1e11, 1e12][amountSeed % 5];
        uint256 amount = bound(amountSeed >> 8, 1e6, span);
        address a = _actor(who);
        uint256 b0 = shares.totalSupply();
        uint256 mixed0 = b0 == 0 ? 0 : _value(b0);
        uint256 virtualWorth = b0 == 0 ? 0 : _value(PotMath.OFFSET_SHARES); // what the virtual Shares are worth now: the most the offset can hand a joiner
        uint256 pot0 = t.pot();
        uint256 arriving0 = t.arriving();
        (uint256 q,,,) = t.quoteBack(amount);
        usd.mint(a, amount);
        vm.startPrank(a);
        usd.approve(address(t), amount);
        uint256 n = t.join(amount, 0, a);
        vm.stopPrank();
        if (n != q) _bad("a join gave other Shares than its quote");
        cashIn += amount;
        creditedMax += amount - t.feeFor(amount);
        uint256 give = virtualWorth > PotMath.OFFSET_USD ? virtualWorth - PotMath.OFFSET_USD : 0; // the virtual Shares' worth less the virtual money
        if (b0 == 0) {
            give = Math.mulDiv(pot0 + arriving0, PotMath.OFFSET_SHARES, PotMath.OFFSET_SHARES + team.totalSupply()); // the virtual Shares' slice
        }
        uint256 instant = PotMath.cash(n, t.pot(), t.paidIn(), shares.totalSupply(), team.totalSupply());
        if (instant > amount - t.feeFor(amount) + give + 50) {
            _bad("a joiner could leave at once with more than they paid in");
        }
        if (b0 != 0) {
            // all earlier Shares together, valued on the new state, against before: they may lose at most what the offset gives
            // away: the virtual Shares at the old value, less the virtual money, plus a little rounding
            uint256 mixed1 = PotMath.cash(b0, t.pot(), t.paidIn(), shares.totalSupply(), team.totalSupply());
            if (mixed1 + give + 50 < mixed0) _bad("earlier holders lost more than the quote offset allows on a join");
        }
        _hit("join");
        _after();
    }

    function leave(uint256 who, uint256 pct) public {
        t.settle();
        address a = _actor(who);
        uint256 bal = shares.balanceOf(a);
        if (bal == 0) return;
        uint256 n = Math.max(1, bal * bound(pct, 1, 100) / 100);
        uint256 lv0 = t.leaveValue();
        vm.prank(a);
        uint256 cash = t.leave(n, 0, a);
        cashOut += cash;
        if (shares.totalSupply() != 0) _notLower(lv0, "a leave");
        _hit("leave");
        _after();
    }

    function leaveTeam(uint256 who, uint256 pct) public {
        t.settle();
        address a = _actor(who);
        uint256 bal = team.balanceOf(a);
        if (bal == 0) return;
        uint256 n = Math.max(1, bal * bound(pct, 1, 100) / 100);
        uint256 lv0 = t.leaveValue();
        uint256 pot0 = t.pot();
        uint256 a0 = t.paidIn();
        vm.prank(a);
        uint256 cash = t.leaveTeam(n, 0, a);
        cashOut += cash;
        // the Team can never take the backers' paid-in money: what is left is at least what was owed to backers first
        uint256 owed = pot0 < a0 ? pot0 : a0;
        if (t.pot() < owed) _bad("the Team took backers' paid-in money");
        if (shares.totalSupply() != 0) _notLower(lv0, "a Team leave");
        _hit("leaveTeam");
        _after();
    }

    function revenue(uint256 who, uint256 amountSeed) public {
        t.settle();
        uint256 amount = bound(amountSeed, 1e6, [uint256(1e8), 1e9, 1e11][amountSeed % 3]);
        address a = _actor(who);
        uint256 lv0 = t.leaveValue();
        usd.mint(a, amount);
        vm.startPrank(a);
        usd.approve(address(t), amount);
        t.addRevenue(amount);
        vm.stopPrank();
        cashIn += amount;
        _notLower(lv0, "an outside payment");
        _hit("revenue");
        _after();
    }

    function warp(uint256 seed) public {
        uint256 kind = seed % 8;
        uint256 secs = kind < 5
            ? bound(seed >> 8, 1, 3 days)
            : kind < 7 ? bound(seed >> 8, 3 days, 20 days) : bound(seed >> 8, 20 days, 400 days);
        vm.warp(block.timestamp + secs);
        _hit("warp");
        _after(); // time is a spend (the allowance accrues); nothing is asserted about value across it
    }

    function checkIn(uint256 seed) public {
        t.settle();
        uint256 lv0 = t.leaveValue();
        vm.prank(founder);
        t.checkIn(keccak256(abi.encode(seed)));
        _notLower(lv0, "a check-in");
        _hit("checkIn");
        _after();
    }

    function draw(uint256 pct, bool byAgent) public {
        t.settle();
        uint256 box = t.box();
        if (box == 0) return;
        uint256 x = Math.max(1, box * bound(pct, 1, 100) / 100);
        uint256 lv0 = t.leaveValue();
        vm.prank(byAgent ? agent : founder);
        t.draw(sink, x);
        cashOut += x;
        _notLower(lv0, "a draw");
        _hit(byAgent ? bytes32("agentDraw") : bytes32("draw"));
        _after();
    }

    function lowerRate(uint256 seed) public {
        t.settle();
        uint32 r = t.ratePpm();
        if (r == 0) return;
        uint256 lv0 = t.leaveValue();
        vm.prank(founder);
        t.setRate(uint32(bound(seed, 0, r - 1)));
        _notLower(lv0, "a lower rate");
        _hit("lowerRate");
        _after();
    }

    function proposeRate(uint256 seed) public {
        t.settle();
        uint32 r = t.ratePpm();
        if (r >= 2000) return;
        vm.prank(founder);
        t.proposeRate(uint32(bound(seed, r + 1, 2000)));
        _hit("proposeRate");
        _after();
    }

    function applyRate() public {
        t.settle();
        uint256 lv0 = t.leaveValue();
        t.applyRate();
        _notLower(lv0, "a rate change");
        _hit("applyRate");
        _after();
    }

    function grant(uint256 who, uint256 seed) public {
        t.settle();
        uint256 lv0 = t.leaveValue();
        vm.prank(founder);
        t.grantTeam(_actor(who), bound(seed, 1, pool / 40));
        _notLower(lv0, "a grant");
        _hit("grant");
        _after();
    }

    /// @dev The whole path to Team Shares in hands, in one step: grant to `who`, let 14 time units of active time pass with a
    /// check-in each (the cliff is 13), and claim what vested. This is what makes Team leaves reachable in a run.
    function teamPath(uint256 who, uint256 seed) public {
        t.settle();
        address a = _actor(who);
        vm.prank(founder);
        uint256 id = t.grantTeam(a, bound(seed, 1, pool / 40));
        uint32 unit = t.unit();
        for (uint256 i; i < 14; ++i) {
            vm.warp(block.timestamp + unit);
            vm.prank(founder);
            t.checkIn(keccak256(abi.encode(seed, i)));
        }
        v.claim(id);
        _hit("teamPath");
        _after();
    }

    function claim(uint256 seed) public {
        uint256 n = v.grantCount();
        if (n == 0) return;
        t.settle();
        uint256 lv0 = t.leaveValue();
        v.claim(seed % n);
        _notLower(lv0, "a claim");
        _hit("claim");
        _after();
    }

    function ownExit(uint256 seed) public {
        uint256 n = v.grantCount();
        if (n == 0) return;
        uint256 id = seed % n;
        t.settle();
        uint256 lv0 = t.leaveValue();
        vm.prank(v.grantOf(id).member);
        v.announceForfeit(id);
        _notLower(lv0, "a forfeit notice");
        _hit("ownExit");
        _after();
    }

    function executeForfeit(uint256 seed) public {
        uint256 n = v.grantCount();
        if (n == 0) return;
        t.settle();
        uint256 lv0 = t.leaveValue();
        v.execute(seed % n);
        _notLower(lv0, "a burn");
        _hit("executeForfeit");
        _after();
    }

    function collectFees() public {
        t.settle();
        uint256 owed = t.feesOwed();
        if (owed == 0) return;
        uint256 lv0 = t.leaveValue();
        t.collectFees();
        cashOut += owed;
        _notLower(lv0, "collecting fees");
        _hit("collectFees");
        _after();
    }

    function toggleDoor(bool open) public {
        vm.prank(founder);
        t.setDoor(open);
        _hit("toggleDoor");
        _after();
    }

    /// @dev Rare: the runner winds the project down; after it the run goes on with leaves, outside money and fee collection.
    function windDown(uint256 seed) public {
        if (seed % 40 != 0) return;
        t.settle();
        uint256 lv0 = t.leaveValue();
        vm.prank(founder);
        t.windDown();
        _notLower(lv0, "a wind-down");
        _hit("windDown");
        _after();
    }

    /// @dev Everyone out, in a shuffled order, on a snapshot that is thrown away: each backer is paid what their Shares were
    /// worth before the run, to within the rounding of the run; then the Team leaves; nobody is paid more than the pot held.
    function probeFullExit(uint256 seed) public {
        t.settle();
        if (shares.totalSupply() == 0) return;
        uint256 snap = vm.snapshotState();
        // The allowance box above its cap flows back into the pot at the next settle, and every leave shrinks the cap; that
        // is a legitimate lift for those who stay, so the probe takes the box out of the picture: rate to zero, settle.
        if (t.ratePpm() > 0) {
            vm.prank(founder);
            try t.setRate(0) {} catch {}
        }
        t.settle();
        uint256 b0 = shares.totalSupply();
        uint256 pot0 = t.pot();
        uint256 a0 = t.paidIn();
        uint256 g0 = team.totalSupply();
        uint256 a1 = pot0 < a0 ? pot0 : a0;
        uint256 s0 = pot0 - a1;
        uint256[] memory order = new uint256[](N_ACTORS);
        for (uint256 i; i < N_ACTORS; ++i) {
            order[i] = i;
        }
        for (uint256 i = N_ACTORS; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % i;
            (order[i - 1], order[j]) = (order[j], order[i - 1]);
        }
        uint256 paid;
        uint256 leavers;
        uint256 worst; // the largest difference from the pre-run value
        for (uint256 i; i < N_ACTORS; ++i) {
            address a = actors[order[i]];
            uint256 n = shares.balanceOf(a);
            if (n == 0) continue;
            uint256 exact = Math.mulDiv(n, a1, b0) + Math.mulDiv(n, s0, b0 + g0);
            if (exact == 0) continue;
            vm.prank(a);
            try t.leave(n, 0, a) returns (uint256 cash) {
                paid += cash;
                ++leavers;
                uint256 d = cash > exact ? cash - exact : exact - cash;
                if (d > worst) worst = d;
            } catch {}
        }
        for (uint256 i; i < N_ACTORS; ++i) {
            address a = actors[i];
            uint256 n = team.balanceOf(a);
            if (n == 0) continue;
            vm.prank(a);
            try t.leaveTeam(n, 0, a) returns (uint256 cash) {
                paid += cash;
            } catch {}
        }
        vm.revertToState(snap);
        if (paid > pot0) _bad("a full exit paid out more than the pot held");
        // each leaver is paid what they were owed before the run, give or take the rounding of the run (two units each)
        if (worst > 2 * leavers + 4) _bad("a leaver in a full exit was not paid the same per Share as the first");
        _hit("probeFullExit");
    }

    /// @dev One step chosen by `seed` out of every kind, for the tests that drive the handler by hand (joins and warps are the
    /// commonest, since nothing else happens without money and time). A step that does not apply reverts: callers use try/catch.
    /// The full-exit probe is left out unless asked for (it snapshots and reverts state, which a log replay cannot follow).
    function step(uint256 seed, bool withProbe) external {
        uint256 a = seed >> 8;
        uint256 b = uint256(keccak256(abi.encode(seed, "b")));
        uint256 k = seed % 21;
        if (k < 6) return join(a, b);
        if (k < 8) return warp(a);
        if (k == 8) return leave(a, b);
        if (k == 9) return leaveTeam(a, b);
        if (k == 10) return revenue(a, b);
        if (k == 11) return checkIn(a);
        if (k == 12) return draw(b, a % 2 == 0);
        if (k == 13) return teamPath(a, b);
        if (k == 14) return ownExit(a);
        if (k == 15) return executeForfeit(a);
        if (k == 16) return grant(a, b);
        if (k == 17) return collectFees();
        if (k == 18) return lowerRate(a);
        if (k == 19) return proposeRate(a);
        if (withProbe) return probeFullExit(a);
        applyRate();
    }

    // ================================================= reporting =====================================================

    function stepNames() external view returns (bytes32[] memory) {
        return names;
    }
}
