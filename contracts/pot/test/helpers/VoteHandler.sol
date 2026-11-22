// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Council} from "../../src/Council.sol";
import {HolderVote} from "../../src/HolderVote.sol";
import {Launcher} from "../../src/Launcher.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {Treasury} from "../../src/Treasury.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";

/// @notice Drives one project that has a vote contract (docs/next-version/COUNCIL-PLAN.md 2.2) from a handful of holders with
/// fixed Shares: parking (small amounts, so a ballot often has a snapshot to take), un-parking (never more than the account
/// parked, so it can never revert for the amount), casting and moving a vote, standing a list or a person (bounded by the
/// places), opening a ballot when one may open, finishing, carrying out and lapsing when due, the founder handing the seat to
/// a Council and that offer being taken, and small steps of time (or a step to a ballot's own deadline, so ends and waits are
/// reached).
///
/// It checks inside each step the rules that need a before and an after: a vote call never moves a dollar of the Treasury's
/// buckets; an un-park never reverts for a ballot's reason; with no ballot live a park writes no vote slot (measured with
/// `vm.accesses`); the tallies do not move once `voteEnd` has passed; the runner changes only in a step that is one of the
/// three allowed ways (`handOver`/`takeSeat`/`seatByVote`), and always to a Council the Launcher made. The first rule a step
/// breaks is kept in `violation`, so the invariant file can state each rule once.
contract VoteHandler is Test {
    QuoteToken internal usd;
    Treasury internal t;
    ShareToken internal shares;
    HolderVote internal vote;
    Launcher internal launcher;
    bytes32 internal key;
    address internal founder;

    /// @dev The holders that act (all of them hold backer Shares, joined in the test's setUp).
    address[] internal actors;
    /// @dev The Shares each actor brought in. Nothing joins or leaves in this handler, so this never changes: a fixed stake.
    mapping(address => uint256) internal budget;
    /// @dev The five Council seats the project's lists may name.
    address[5] internal seats;

    /// @dev The handler's own copy of the block time (the optimizer caches `block.timestamp` inside one test function).
    uint256 public clock;

    // ------------------------------------------------------------------ ghosts
    uint256 public steps;
    uint256 public opens;
    uint256 public casts;
    uint256 public moves; // a cast by an account that already had a vote on this ballot
    uint256 public falls; // an un-park that took a cast weight down
    uint256 public finishes;
    uint256 public carryOuts;
    uint256 public lapses;
    uint256 public probes;
    uint256 public parksInAVote;
    uint256 public stands;
    uint256 public handOvers;
    uint256 public takeSeats;
    uint256 public runnerChanges;
    /// @dev The first rule a step broke; empty while every step held.
    string public violation;
    // the rules, one flag each, so the invariant file can state each of them once
    bool public moneyMoved;
    bool public runnerJumped;
    bool public talliesNotFrozen;
    bool public unparkReverted;
    bool public hookWrote;
    bool public openedOverLive;
    bool public offerSurvived;

    /// @dev Every ballot the handler saw open, its end (fixed at opening), and the state its tallies had at `voteEnd`.
    uint32[] internal ballotIds;
    mapping(uint32 => uint64) public voteEndOf;
    mapping(uint32 => bytes32) public frozen;
    mapping(uint32 => uint64) public frozenAt;

    // the state a step began in, for the before/after rules
    bytes32 internal _moneyBefore;
    address internal _runnerBefore;
    uint32 internal _liveBefore;

    constructor(
        QuoteToken usd_,
        Treasury t_,
        ShareToken shares_,
        HolderVote vote_,
        Launcher launcher_,
        bytes32 key_,
        address founder_,
        address[] memory actors_,
        address[5] memory seats_
    ) {
        (usd, t, shares, vote, launcher, key, founder) = (usd_, t_, shares_, vote_, launcher_, key_, founder_);
        require(actors_.length >= 6, "VoteHandler needs six actors at least");
        for (uint256 i; i < actors_.length; ++i) {
            actors.push(actors_[i]);
            budget[actors_[i]] = shares_.balanceOf(actors_[i]);
        }
        seats = seats_;
        clock = block.timestamp;
    }

    // ------------------------------------------------------------------ views

    function actorsList() external view returns (address[] memory) {
        return actors;
    }

    function ballotCount() external view returns (uint256) {
        return ballotIds.length;
    }

    function ballotAt(uint256 i) external view returns (uint32 id, uint64 voteEnd) {
        id = ballotIds[i];
        voteEnd = voteEndOf[id];
    }

    /// @dev The fixed Shares each actor brought in (their balance before any park): parking is a fraction of this, so the
    /// action space is the same on every run.
    function budgetOf(address who) external view returns (uint256) {
        return budget[who];
    }

    // ---------------------------------------------------------------- plumbing

    function _who(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _fail(string memory why) internal {
        if (bytes(violation).length == 0) violation = why;
    }

    /// @dev The cast total and every tally of a ballot, as one number (see `_stateHash`).
    function stateHash(uint32 id) external view returns (bytes32) {
        return _stateHash(id);
    }

    /// @dev The time unit N (a day is N / 7).
    function _unit() internal view returns (uint256) {
        return uint256(vote.day()) * 7;
    }

    /// @dev The ballot whose vote is running right now (zero when none): the same test the contract's hooks use.
    function _liveId() internal view returns (uint32 id) {
        id = vote.current();
        if (id != 0 && clock >= uint256(vote.ballot(id).voteEnd)) id = 0;
    }

    /// @dev The dollars and every bucket of the Treasury: a vote call must leave all of it alone.
    function _money() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                usd.balanceOf(address(t)),
                t.pot(),
                t.box(),
                t.arriving(),
                t.feesOwed(),
                t.locked(),
                t.notesOwed(),
                usd.balanceOf(address(vote))
            )
        );
    }

    /// @dev The cast total and every tally of a ballot, as one number: it must not change once `voteEnd` has passed.
    function _stateHash(uint32 id) internal view returns (bytes32) {
        HolderVote.Ballot memory b = vote.ballot(id);
        bytes memory enc = abi.encode(vote.castOf(id), b.optionCount);
        for (uint8 i; i < b.optionCount; ++i) {
            (, uint256 tally) = vote.optionOf(id, i);
            enc = abi.encodePacked(enc, tally);
        }
        return keccak256(enc);
    }

    /// @dev Five lists a ballot may name: the seats; five holders; and three mixed ones. Each is five distinct accounts and no
    /// project account.
    function _listAt(uint256 k) internal view returns (address[5] memory m) {
        k %= 5;
        if (k == 0) {
            m = seats;
        } else if (k == 1) {
            m = [actors[0], actors[1], actors[2], actors[3], actors[4]];
        } else if (k == 2) {
            m = [seats[0], seats[1], actors[0], actors[1], actors[2]];
        } else if (k == 3) {
            m = [seats[2], seats[3], seats[4], actors[3], actors[4]];
        } else {
            m = [actors[1], actors[2], actors[3], actors[4], actors[5]];
        }
    }

    function _warpTo(uint256 ts) internal {
        if (ts <= clock) ts = clock + 1 minutes;
        clock = ts;
        vm.warp(ts);
    }

    function _begin() internal {
        ++steps;
        _moneyBefore = _money();
        _runnerBefore = t.runner();
        _liveBefore = _liveId();
    }

    /// @dev The rules every step must hold. `mayMoveRunner` is true only for the three steps that are one of the allowed ways
    /// the runner seat may change (`handOver`/`takeSeat`/`seatByVote`).
    function _end(bool mayMoveRunner) internal {
        if (_money() != _moneyBefore) {
            moneyMoved = true;
            _fail("a vote call moved the Treasury's buckets");
        }
        address nowRunner = t.runner();
        if (nowRunner != _runnerBefore) {
            if (!mayMoveRunner) {
                runnerJumped = true;
                _fail("the runner changed outside a hand-over, a take-seat or a carried-out vote");
            } else {
                ++runnerChanges;
                if (launcher.runnerKindOf(nowRunner) != 2) {
                    runnerJumped = true;
                    _fail("the seat moved to an account that is not a Council the Launcher made");
                }
            }
        }
        _freeze();
    }

    /// @dev The tallies are frozen from `voteEnd`: record what they were the first time a step sees the ballot ended, and
    /// never let them move after that.
    function _freeze() internal {
        uint32 id = vote.current();
        if (id == 0) return;
        HolderVote.Ballot memory b = vote.ballot(id);
        if (clock < uint256(b.voteEnd)) return;
        bytes32 h = _stateHash(id);
        if (frozenAt[id] == 0) {
            frozen[id] = h;
            frozenAt[id] = uint64(clock);
        } else if (frozen[id] != h) {
            talliesNotFrozen = true;
            _fail("the tallies moved after voteEnd");
        }
    }

    // ------------------------------------------------------------------- steps

    /// @dev One step of a mixed, seeded sequence: the same actions a keeper and seven holders would take, in a proportion
    /// that reaches every phase (a ballot opened, names stood, voting and moves, an un-park that lowers a cast weight, the
    /// end of the vote, a result recorded and carried out, a lapse, and the deadlines the chain set). Not in the invariant's
    /// target list: it is the deterministic driver of the two rebuild tests, not an action a fuzzer picks.
    function step(uint256 seed) external {
        uint256 pick = seed % 26;
        uint256 a = seed >> 16;
        if (pick < 3) this.park(seed, a);
        else if (pick < 6) this.parkAll(seed);
        else if (pick < 8) this.unpark(seed, a);
        else if (pick < 9) this.unparkAll(seed); // the fall, when a voter takes every Share back
        else if (pick < 12) this.cast(seed, a); // a vote, and a move
        else if (pick < 14) this.castMany(seed); // several holders in one step: turnout
        else if (pick == 14) this.standList(seed);
        else if (pick == 15) this.stand(seed);
        else if (pick < 18) this.open(seed);
        else if (pick == 18) this.finishBallot();
        else if (pick == 19) this.carryOut();
        else if (pick == 20) this.lapseBallot();
        else if (pick < 25) this.advance(seed); // time has to reach the ends and the wait
        else this.warp(seed);
    }

    /// @dev Park a fraction of the account's fixed Shares (never more than it still holds).
    function park(uint256 seed, uint256 pct) external {
        _begin();
        address a = _who(seed);
        uint256 bal = shares.balanceOf(a);
        if (bal != 0) {
            uint256 n = (budget[a] * bound(pct, 1, 100)) / 100;
            if (n > bal) n = bal;
            if (n != 0) {
                vm.startPrank(a);
                shares.approve(address(vote), n);
                try vote.park(n) {
                    if (_liveId() != 0) ++parksInAVote;
                } catch {}
                vm.stopPrank();
            }
        }
        _end(false);
    }

    /// @dev Park everything the account still holds: enough, over the seven holders, for the open floor and the turnout floor,
    /// so ballots end in carried-out results and lapses as well as in short ones.
    function parkAll(uint256 seed) external {
        _begin();
        address a = _who(seed);
        uint256 n = shares.balanceOf(a);
        if (n != 0) {
            vm.startPrank(a);
            shares.approve(address(vote), n);
            try vote.park(n) {
                if (_liveId() != 0) ++parksInAVote;
            } catch {}
            vm.stopPrank();
        }
        _end(false);
    }

    /// @dev Take back a fraction of what the account parked: bounded by `parkedOf`, so a revert here is a ballot's doing.
    function unpark(uint256 seed, uint256 pct) external {
        _begin();
        address a = _who(seed);
        uint256 mine = vote.parkedOf(a);
        if (mine != 0) {
            uint256 n = bound(pct, 1, mine);
            uint32 id = _liveId();
            uint32 cur = vote.current();
            bytes32 stateBefore = cur == 0 ? bytes32(0) : _stateHash(cur);
            (,, uint256 weightBefore,) = vote.ballotOf(a);
            vm.prank(a);
            try vote.unpark(n) {
                if (id != 0) {
                    (,, uint256 weightAfter,) = vote.ballotOf(a);
                    if (weightAfter < weightBefore) ++falls;
                } else if (cur != 0 && _stateHash(cur) != stateBefore) {
                    hookWrote = true;
                    _fail("an un-park with no ballot live changed the count");
                }
            } catch {
                unparkReverted = true;
                _fail("un-park reverted for a holder who had parked that much");
            }
        }
        _end(false);
    }

    /// @dev Take every Share the account parked back while a ballot runs: the weight it cast falls with the custody (the
    /// `Fell` event), and taking out can never be slowed.
    function unparkAll(uint256 seed) external {
        _begin();
        address a = _who(seed);
        uint256 mine = vote.parkedOf(a);
        if (mine != 0) {
            uint32 id = _liveId();
            (,, uint256 weightBefore,) = vote.ballotOf(a);
            vm.prank(a);
            try vote.unpark(mine) {
                if (id != 0) {
                    (,, uint256 weightAfter,) = vote.ballotOf(a);
                    if (weightAfter < weightBefore) ++falls;
                }
            } catch {
                unparkReverted = true;
                _fail("un-park reverted for a holder who had parked that much");
            }
        }
        _end(false);
    }

    /// @dev Put the account's whole eligible weight on one option, or move it to another.
    function cast(uint256 seed, uint256 which) external {
        _begin();
        uint32 id = _liveId();
        if (id != 0) {
            HolderVote.Ballot memory b = vote.ballot(id);
            address a = _who(seed);
            (,, uint256 weightBefore,) = vote.ballotOf(a);
            uint8 option = uint8(bound(which, 0, b.optionCount - 1));
            vm.prank(a);
            try vote.castVote(option) {
                ++casts;
                if (weightBefore != 0) ++moves;
            } catch {}
        }
        _end(false);
    }

    /// @dev Several holders vote in the same step (people vote in the same block), which is what turns a ballot's turnout
    /// into a result that is carried out.
    function castMany(uint256 seed) external {
        _begin();
        uint32 id = _liveId();
        if (id != 0) {
            HolderVote.Ballot memory b = vote.ballot(id);
            // the group votes for a list or a person (option 0 is "keep"): this is what makes a ballot's result a won one
            uint8 option = b.optionCount < 2 ? 0 : uint8(1 + bound(seed >> 8, 0, b.optionCount - 2));
            for (uint256 k; k < 4; ++k) {
                address a = actors[(seed % actors.length + k) % actors.length];
                (,, uint256 weightBefore,) = vote.ballotOf(a);
                vm.prank(a);
                try vote.castVote(option) {
                    ++casts;
                    if (weightBefore != 0) ++moves;
                } catch {}
            }
        }
        _end(false);
    }

    /// @dev Stand a list for a replace vote, within the places the ballot has.
    function standList(uint256 seed) external {
        _begin();
        uint32 id = _liveId();
        if (id != 0) {
            HolderVote.Ballot memory b = vote.ballot(id);
            if (clock < b.standEnd && b.kind == vote.KIND_REPLACE()) {
                address by = _who(seed);
                vm.prank(by);
                try vote.standList(_listAt(seed >> 8), keccak256(abi.encode("list", seed))) {
                    ++stands;
                } catch {}
            }
        }
        _end(false);
    }

    /// @dev Stand a person for a seat that came up, within the places the ballot has.
    function stand(uint256 seed) external {
        _begin();
        uint32 id = _liveId();
        if (id != 0) {
            HolderVote.Ballot memory b = vote.ballot(id);
            if (clock < b.standEnd && b.kind == vote.KIND_SEATS()) {
                address by = _who(seed);
                vm.prank(by);
                try vote.stand(keccak256(abi.encode("person", seed))) {
                    ++stands;
                } catch {}
            }
        }
        _end(false);
    }

    /// @dev Open the ballot the contract says may open: a due seat election, else a replace vote with a holder's own list.
    function open(uint256 seed) external {
        _begin();
        bool opened;
        if (vote.canOpenSeats()) {
            try vote.openSeats() returns (uint32 id) {
                _noteOpen(id);
                opened = true;
            } catch {}
        }
        if (!opened && vote.canOpenReplace() && !_keptCooldownWouldStart()) {
            uint256 supply = shares.totalSupply();
            for (uint256 k; k < actors.length; ++k) {
                address by = actors[(seed % actors.length + k) % actors.length];
                // the opener needs a thousandth of the Shares: openReplace refuses an opener under it *after* recording the
                // last ballot's result, which would leave an event of a transaction that never happened
                if (vote.parkedOf(by) * vote.STAND_DIVISOR() < supply) continue;
                vm.prank(by);
                try vote.openReplace(_listAt(seed >> 8), keccak256(abi.encode("open", seed))) returns (uint32 id) {
                    _noteOpen(id);
                    opened = true;
                    break;
                } catch {}
            }
        }
        if (opened && _liveBefore != 0) {
            openedOverLive = true;
            _fail("a ballot opened while another was live");
        }
        _end(false);
    }

    /// @dev True when the ballot open now has ended and its result would be a "kept" one with the floor met: the contract's
    /// own `canOpenReplace` says a replace vote may open, but `openReplace` first records that result (which starts the 28-day
    /// cooldown) and then refuses with `Cooldown` — a view and a call that disagree for a second. The handler asks for what the
    /// call would do, so a step never records an event of a transaction that reverted.
    function _keptCooldownWouldStart() internal view returns (bool) {
        uint32 id = vote.current();
        if (id == 0) return false;
        HolderVote.Ballot memory b = vote.ballot(id);
        if (b.finished || clock < uint256(b.voteEnd)) return false;
        if (b.kind != vote.KIND_REPLACE()) return false;
        (uint8 o,,) = vote.resultOf(id);
        return o == vote.OUTCOME_KEPT() && vote.castOf(id) >= b.floor;
    }

    function _noteOpen(uint32 id) internal {
        ++opens;
        ballotIds.push(id);
        voteEndOf[id] = vote.ballot(id).voteEnd;
    }

    /// @dev Record the result of the ballot whose vote has ended.
    function finishBallot() external {
        _begin();
        uint32 id = vote.current();
        if (id != 0) {
            try vote.finish(id) {
                ++finishes;
            } catch {}
        }
        _end(false);
    }

    /// @dev Carry a won result out when the wait is over (the one step a vote call may move the runner seat). It must also
    /// clear any seat the old runner offered someone else, so nothing it left behind can reach the new Council (plan 2.7).
    function carryOut() external {
        _begin();
        uint32 id = vote.current();
        bool ran;
        bool replace;
        if (id != 0 && vote.canCarryOut(id)) {
            replace = vote.ballot(id).kind == vote.KIND_REPLACE();
            try vote.carryOut(id) {
                ++carryOuts;
                ran = true;
            } catch {}
        }
        if (ran && replace && t.pendingRunner() != address(0)) {
            offerSurvived = true;
            _fail("an offer the old runner made survived the vote that seated a Council");
        }
        _end(ran);
    }

    /// @dev Let go of a won result nobody carried out. Only called when the contract's own conditions hold: a `lapse` that
    /// reverts after recording the result would leave a `BallotFinished` in the log of a transaction that never happened.
    function lapseBallot() external {
        _begin();
        uint32 id = vote.current();
        if (id != 0 && _lapsable(id)) {
            try vote.lapse(id) {
                ++lapses;
            } catch {}
        }
        _end(false);
    }

    /// @dev True when `lapse(id)` would go through now (the plan's rule, read from the views).
    function _lapsable(uint32 id) internal view returns (bool) {
        HolderVote.Ballot memory b = vote.ballot(id);
        if (b.openedAt == 0 || b.carried || b.lapsed) return false;
        if (clock < uint256(b.voteEnd)) return false;
        uint8 o = b.outcome;
        if (!b.finished) (o,,) = vote.resultOf(id);
        if (o != vote.OUTCOME_MOVED() && o != vote.OUTCOME_SEATED()) return false;
        bool late = clock > uint256(b.effectiveAt) + vote.LAPSE_UNITS() * _unit();
        bool wound = t.windDownKind() != 0;
        bool councilGone = b.kind == vote.KIND_SEATS() && !_councilIsRunner(b.council);
        return late || wound || councilGone;
    }

    /// @dev True when `council` is the project's runner and was made as a Council.
    function _councilIsRunner(address council) internal view returns (bool) {
        return council != address(0) && launcher.runnerKindOf(council) == 2 && t.runner() == council;
    }

    /// @dev Move time to one of the deadlines the chain itself set (a ballot's stand end, vote end, effective date or lapse
    /// date, or the Council's next election), so ends and waits are reached; never a jump into the past.
    function advance(uint256 seed) external {
        _begin();
        _warpTo(_deadline(seed));
        _end(false);
    }

    /// @dev The next deadline the chain itself set: the end of the stand window, then the end of the vote, then (for a won
    /// result nobody carried out) the date it may be carried out and the end of its time to be; then the Council's next
    /// election. A ballot that is already settled has no deadline left, so time does not wander through a wait nobody is in.
    function _deadline(uint256 seed) internal view returns (uint256) {
        uint32 id = vote.current();
        if (id != 0) {
            HolderVote.Ballot memory b = vote.ballot(id);
            if (clock < b.standEnd) return b.standEnd;
            if (clock < b.voteEnd) return b.voteEnd;
            uint8 o = b.outcome;
            if (!b.finished) (o,,) = vote.resultOf(id);
            bool won = o == vote.OUTCOME_MOVED() || o == vote.OUTCOME_SEATED();
            if (won && !b.carried && !b.lapsed) {
                if (clock < b.effectiveAt) return b.effectiveAt;
                return uint256(b.effectiveAt) + 2 * _unit() + 1;
            }
        }
        address runner = t.runner();
        if (launcher.runnerKindOf(runner) == 2) {
            uint64 next = Council(runner).nextElection();
            if (next > clock) return next;
        }
        return clock + bound(seed, 1 minutes, 6 hours);
    }

    /// @dev A small step of time, a minute to a few hours: snapshot moments and falls are hit between deadlines.
    function warp(uint256 secs) external {
        _begin();
        _warpTo(clock + bound(secs, 1 minutes, 6 hours));
        _end(false);
    }

    /// @dev Park a small fixed amount and count the storage slots the vote contract writes. With no ballot live the hooks
    /// write nothing, so the slots are the pause's own: the account's parked amount and the total, plus `armedAt` only when
    /// arming changed. With a ballot live the snapshot adds at most one slot (the first touch of the account).
    function probe(uint256 seed) external {
        _begin();
        address a = _who(seed);
        uint256 bal = shares.balanceOf(a);
        if (bal != 0) {
            uint256 n = bal < 1e15 ? bal : 1e15;
            uint64 armedBefore = vote.armedAt();
            uint32 id = _liveId();
            vm.startPrank(a);
            shares.approve(address(vote), n);
            vm.record();
            try vote.park(n) {}
            catch {
                _fail("a probe park reverted");
            }
            vm.stopPrank();
            (, bytes32[] memory writes) = vm.accesses(address(vote));
            uint64 armedAfter = vote.armedAt();
            uint256 expected = 2 + (armedAfter != armedBefore ? 1 : 0);
            ++probes;
            if (id == 0) {
                if (writes.length != expected) {
                    hookWrote = true;
                    _fail("a park wrote a vote slot with no ballot live");
                }
            } else if (writes.length > expected + 1) {
                hookWrote = true;
                _fail("a park inside a ballot wrote more than the snapshot slot");
            }
        }
        _end(false);
    }

    /// @dev The founder (or whoever holds a founder-run seat) offers the seat to a Council of five, and now and then someone
    /// makes it, as the hand-over path does (two of the allowed ways the runner seat may change: the offer is taken by
    /// `takeSeat` when the clone is made, or by `takeOffer` in another step).
    function handOver(uint256 seed) external {
        _begin();
        address runner = t.runner();
        if (launcher.runnerKindOf(runner) == 0) {
            address[5] memory m = _listAt(seed >> 8);
            bytes32 salt = keccak256(abi.encode("salt", seed));
            address predicted = launcher.councilAddress(key, m, salt);
            vm.prank(runner);
            try t.handOver(predicted, false) {
                ++handOvers;
                if (seed % 3 != 0) {
                    vm.prank(_who(seed));
                    try launcher.makeCouncil(key, m, salt) {} catch {}
                }
            } catch {}
        }
        _end(true);
    }

    /// @dev Take a seat offered to the caller (the `takeSeat` way the runner seat may change). Only an offer made to a Council
    /// the Launcher has already made: the Treasury's `handOver`/`takeSeat` also let a founder hand the seat to a plain
    /// account (a new founder, runner kind 0, a single-signer runner by design), which is not this suite's subject.
    function takeOffer() external {
        _begin();
        address who = t.pendingRunner();
        if (who != address(0) && launcher.runnerKindOf(who) == 2) {
            vm.prank(who);
            try t.takeSeat() {
                ++takeSeats;
            } catch {}
        }
        _end(true);
    }
}
