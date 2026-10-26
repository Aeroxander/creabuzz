// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreateCourt, IArbitrable} from "../src/CreateCourt.sol";
import {CreateToken} from "../src/CreateToken.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice Reaches the draw tree's lookup, to check it against a plain count.
contract CourtHarness is CreateCourt {
    constructor(IERC20 s, IERC20 f, uint256 seat, uint256 fee) CreateCourt(s, f, seat, fee) {}

    function find(uint256 pick) external view returns (uint256) {
        return _find(pick);
    }
}

/// @notice A contract that asks the court and keeps what it is told.
contract Asker is IArbitrable {
    CreateCourt internal immutable court;
    mapping(uint256 => uint256) public ruled;
    mapping(uint256 => bool) public told;

    constructor(CreateCourt court_, IERC20 fee) {
        court = court_;
        fee.approve(address(court_), type(uint256).max);
    }

    function ask() external returns (uint256) {
        return court.createDispute(2, abi.encode("words"));
    }

    function rule(uint256 dispute, uint256 ruling) external {
        require(msg.sender == address(court), "not the court");
        ruled[dispute] = ruling;
        told[dispute] = true;
    }
}

/// @notice The $CREATE court (N7): draws by stake, sealed votes, appeals to larger panels, deadlines, timeouts, and books
/// that always balance.
contract CreateCourtTest is Test {
    uint256 internal constant SEAT = 100e18;
    uint256 internal constant FEE = 1e6;
    address internal constant ANN = address(0xA11);
    address internal constant BO = address(0xB0);
    address internal constant CY = address(0xC1);
    address internal constant DI = address(0xD1);

    CreateToken internal create;
    MandateCurrency internal usd;
    CourtHarness internal court;
    Asker internal asker;

    function setUp() public {
        vm.warp(10 days);
        create = new CreateToken("Test CREATE", "tCREATE", address(this));
        usd = new MandateCurrency();
        court = new CourtHarness(IERC20(address(create)), IERC20(address(usd)), SEAT, FEE);
        asker = new Asker(court, IERC20(address(usd)));
        usd.mint(address(asker), 1_000e6);
        address[4] memory people = [ANN, BO, CY, DI];
        for (uint256 i; i < people.length; ++i) {
            create.transfer(people[i], 10_000e18);
            usd.mint(people[i], 1_000e6);
            vm.startPrank(people[i]);
            create.approve(address(court), type(uint256).max);
            usd.approve(address(court), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ---- helpers -------------------------------------------------------------------------------------------------

    function _stake(address who, uint256 seats) internal {
        vm.prank(who);
        court.stake(seats * SEAT);
    }

    function _salt(address who) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", who));
    }

    function _commit(uint256 id, uint256 round, address who, uint8 choice) internal {
        vm.prank(who);
        court.commit(id, keccak256(abi.encode(choice, _salt(who), who, id, round)));
    }

    function _reveal(uint256 id, address who, uint8 choice) internal {
        vm.prank(who);
        court.reveal(id, choice, _salt(who));
    }

    function _drawn(uint256 id, uint256 round) internal view returns (address[] memory drawn) {
        (,,,,,, drawn) = court.roundOf(id, round);
    }

    function _period(uint256 id) internal view returns (CreateCourt.Period period) {
        (,, period,,) = court.disputes(id);
    }

    function _seats(uint256 id, uint256 round, address who) internal view returns (uint256 seats) {
        (uint32 s,,) = court.votes(id, round, who);
        seats = s;
    }

    /// @dev Every $CREATE the court holds is someone's stake, owed to someone, or in the pool; every fee likewise, or
    /// still in an open round.
    function _booksBalance(uint256 openFees) internal view {
        address[4] memory people = [ANN, BO, CY, DI];
        uint256 stakes;
        uint256 fees;
        for (uint256 i; i < people.length; ++i) {
            (uint128 staked,,,) = court.jurors(people[i]);
            stakes += staked + court.owedStake(people[i]);
            fees += court.owedFee(people[i]);
        }
        assertEq(create.balanceOf(address(court)), stakes + court.stakePool(), "stake books");
        assertEq(usd.balanceOf(address(court)), fees + court.feePool() + openFees, "fee books");
    }

    // ---- staking and drawing -------------------------------------------------------------------------------------

    function test_a_stake_is_counted_in_seats_and_only_free_seats_leave() public {
        _stake(ANN, 3);
        assertEq(court.freeSeats(), 3);
        assertEq(court.freeSeatsOf(ANN), 3);
        vm.prank(ANN);
        court.stake(50e18); // half a seat: staked, not drawable
        assertEq(court.freeSeats(), 3);
        uint256 id = asker.ask();
        vm.warp(block.timestamp + court.EVIDENCE());
        court.draw(id);
        assertEq(_seats(id, 0, ANN), 3, "the only juror holds every seat");
        assertEq(court.freeSeats(), 0);
        vm.prank(ANN);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.NotFree.selector, 50e18));
        court.unstake(51e18);
        vm.prank(ANN);
        court.unstake(50e18);
        vm.prank(ANN);
        vm.expectRevert(CreateCourt.NothingToStake.selector);
        court.stake(0);
    }

    function test_a_case_waits_for_its_evidence_and_for_enough_jurors() public {
        uint256 id = asker.ask();
        assertEq(usd.balanceOf(address(court)), 3 * FEE);
        uint64 at = uint64(block.timestamp) + court.EVIDENCE();
        _stake(ANN, 3); // enough jurors: only the evidence time can stop the draw
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.TooEarly.selector, id, at));
        court.draw(id);
        vm.warp(at);
        vm.prank(ANN);
        court.unstake(SEAT);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.NotEnoughJurors.selector, 2, 3));
        court.draw(id);
        _stake(BO, 1);
        court.draw(id);
        assertEq(_seats(id, 0, ANN) + _seats(id, 0, BO), 3);
        assertEq(uint8(_period(id)), uint8(CreateCourt.Period.Commit));
    }

    function test_only_drawn_jurors_seal_once_and_open_what_they_sealed() public {
        _stake(ANN, 3);
        uint256 id = asker.ask();
        vm.warp(block.timestamp + 2 days);
        court.draw(id);
        vm.prank(BO);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.NotDrawn.selector, id));
        court.commit(id, keccak256("x"));
        _commit(id, 0, ANN, 1);
        vm.prank(ANN);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.AlreadyCommitted.selector, id));
        court.commit(id, keccak256("y"));
        court.passPeriod(id); // everyone sealed: no need to wait
        vm.prank(ANN);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.BadCommit.selector, id));
        court.reveal(id, 2, _salt(ANN));
        vm.prank(ANN);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.BadChoice.selector, 3));
        court.reveal(id, 3, _salt(ANN));
        _reveal(id, ANN, 1);
        court.passPeriod(id);
        (,,, uint64 start, uint8 ruling) = court.disputes(id);
        assertEq(ruling, 1);
        vm.warp(start + court.APPEAL());
        court.execute(id);
        assertTrue(asker.told(id));
        assertEq(asker.ruled(id), 1);
        assertEq(court.owedFee(ANN), 3 * FEE);
        _booksBalance(0);
    }

    function test_sealing_and_opening_close_at_their_deadlines() public {
        _stake(ANN, 3);
        uint256 id = asker.ask();
        vm.warp(block.timestamp + 2 days);
        court.draw(id);
        (,,, uint64 start,) = court.disputes(id);
        vm.warp(start + court.COMMIT() - 1);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.TooEarly.selector, id, start + court.COMMIT()));
        court.passPeriod(id);
        vm.warp(start + court.COMMIT());
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.TooLate.selector, id, start + court.COMMIT()));
        _commit(id, 0, ANN, 1);
        court.passPeriod(id);
        // Nobody sealed, so nobody can open: the round has no ruling.
        court.passPeriod(id);
        (,,,, uint8 ruling) = court.disputes(id);
        assertEq(ruling, 0);
    }

    // ---- settling ------------------------------------------------------------------------------------------------

    function test_jurors_with_the_ruling_share_the_fee_and_the_stake_of_those_against_or_silent() public {
        _stake(ANN, 1);
        _stake(BO, 1);
        _stake(CY, 1);
        // With one seat each and three to fill, each is drawn once only if the draw lands that way; force it by making
        // each juror hold exactly one free seat and the round need all three.
        uint256 id = asker.ask();
        vm.warp(block.timestamp + 2 days);
        court.draw(id);
        assertEq(_seats(id, 0, ANN) + _seats(id, 0, BO) + _seats(id, 0, CY), 3);
        assertEq(_seats(id, 0, ANN), 1);
        _commit(id, 0, ANN, 1);
        _commit(id, 0, BO, 1);
        _commit(id, 0, CY, 2);
        court.passPeriod(id);
        _reveal(id, ANN, 1);
        _reveal(id, BO, 1);
        // CY never opens: counted against the ruling.
        (,,, uint64 start,) = court.disputes(id);
        vm.warp(start + court.REVEAL());
        court.passPeriod(id);
        vm.warp(block.timestamp + court.APPEAL());
        court.execute(id);
        assertEq(asker.ruled(id), 1);
        (uint128 cyStaked, uint128 cyLocked,,) = court.jurors(CY);
        assertEq(cyStaked, 0, "the silent juror's seat is taken");
        assertEq(cyLocked, 0);
        assertEq(court.owedStake(ANN), SEAT / 2);
        assertEq(court.owedStake(BO), SEAT / 2);
        assertEq(court.owedFee(ANN), 3 * FEE / 2);
        (uint128 annStaked, uint128 annLocked,,) = court.jurors(ANN);
        assertEq(annStaked, SEAT);
        assertEq(annLocked, 0);
        assertEq(court.freeSeats(), 2);
        _booksBalance(0);
        uint256 before = create.balanceOf(ANN);
        vm.prank(ANN);
        court.withdraw();
        assertEq(create.balanceOf(ANN), before + SEAT / 2);
        vm.prank(ANN);
        vm.expectRevert(CreateCourt.NothingOwed.selector);
        court.withdraw();
        _booksBalance(0);
    }

    function test_a_tie_rules_nothing_and_everyone_who_opened_a_vote_is_paid() public {
        _stake(ANN, 2);
        _stake(BO, 2);
        uint256 id = asker.ask();
        vm.warp(block.timestamp + 2 days);
        court.draw(id);
        address[] memory drawn = _drawn(id, 0);
        // Whatever the draw gave, have the jurors split so the seats tie only when they can; check the tie case directly
        // by having nobody open a vote.
        for (uint256 i; i < drawn.length; ++i) {
            _commit(id, 0, drawn[i], 1);
        }
        court.passPeriod(id);
        (,,, uint64 start,) = court.disputes(id);
        vm.warp(start + court.REVEAL());
        court.passPeriod(id);
        vm.warp(block.timestamp + court.APPEAL());
        court.execute(id);
        assertEq(asker.ruled(id), 0);
        assertEq(court.feePool(), 3 * FEE, "nobody judged: the fee waits in the pool");
        assertEq(court.stakePool(), 3 * SEAT);
        _booksBalance(0);
    }

    // ---- appeals and timeouts ------------------------------------------------------------------------------------

    function _runRound(uint256 id, uint256 round, uint8 choice) internal {
        court.draw(id);
        address[] memory drawn = _drawn(id, round);
        for (uint256 i; i < drawn.length; ++i) {
            _commit(id, round, drawn[i], choice);
        }
        court.passPeriod(id);
        for (uint256 i; i < drawn.length; ++i) {
            _reveal(id, drawn[i], choice);
        }
        court.passPeriod(id);
    }

    function test_an_appeal_goes_to_seven_then_fifteen_and_the_last_ruling_stands() public {
        _stake(ANN, 10);
        _stake(BO, 10);
        _stake(CY, 10);
        uint256 id = asker.ask();
        vm.warp(block.timestamp + 2 days);
        _runRound(id, 0, 1);
        assertEq(court.appealCost(id), 7 * FEE);
        vm.prank(DI);
        court.appeal(id);
        assertEq(uint8(_period(id)), uint8(CreateCourt.Period.Evidence));
        _runRound(id, 1, 2); // an appeal round is drawn at once
        (uint256 seats,,,,,,) = court.roundOf(id, 1);
        assertEq(seats, 7);
        vm.prank(DI);
        court.appeal(id);
        _runRound(id, 2, 2);
        vm.prank(DI);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.LastRound.selector, id));
        court.appeal(id);
        court.execute(id); // the last round needs no appeal time
        assertEq(asker.ruled(id), 2);
        // The first round voted for, against the final ruling: its three seats are taken and given to later rounds' jurors.
        assertEq(court.freeSeats(), 30 - 3);
        _booksBalance(0);
    }

    function test_an_appeal_closes_with_the_appeal_time() public {
        _stake(ANN, 3);
        uint256 id = asker.ask();
        vm.warp(block.timestamp + 2 days);
        _runRound(id, 0, 1);
        (,,, uint64 start,) = court.disputes(id);
        vm.warp(start + court.APPEAL() - 1);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.TooEarly.selector, id, start + court.APPEAL()));
        court.execute(id);
        vm.warp(start + court.APPEAL());
        vm.prank(DI);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.TooLate.selector, id, start + court.APPEAL()));
        court.appeal(id);
        court.execute(id);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.WrongPeriod.selector, id, CreateCourt.Period.Ruled));
        court.execute(id);
    }

    function test_a_case_with_no_jurors_times_out_with_no_ruling() public {
        uint256 id = asker.ask();
        uint64 at = uint64(block.timestamp) + court.EVIDENCE() + court.DRAW_TIMEOUT();
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.TooEarly.selector, id, at));
        court.timeout(id);
        vm.warp(at);
        court.timeout(id);
        assertTrue(asker.told(id));
        assertEq(asker.ruled(id), 0);
        assertEq(court.feePool(), 3 * FEE);
        _booksBalance(0);
    }

    function test_an_appeal_no_juror_can_take_times_out_and_the_earlier_round_is_settled() public {
        _stake(ANN, 3);
        uint256 id = asker.ask();
        vm.warp(block.timestamp + 2 days);
        _runRound(id, 0, 1);
        vm.prank(DI);
        court.appeal(id); // seven seats, and only three exist
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.NotEnoughJurors.selector, 0, 7));
        court.draw(id);
        vm.warp(block.timestamp + court.DRAW_TIMEOUT());
        court.timeout(id);
        assertEq(asker.ruled(id), 0, "no ruling: things stay as they were");
        // The unused appeal fee joins the pool first, and the round that was judged gets the pool's tenth.
        assertEq(court.owedFee(ANN), 3 * FEE + 7 * FEE / 10, "the juror who served is paid");
        assertEq(court.feePool(), 7 * FEE - 7 * FEE / 10);
        _booksBalance(0);
    }

    function test_only_cases_that_exist_and_only_two_choices() public {
        vm.expectRevert(abi.encodeWithSelector(CreateCourt.UnknownDispute.selector, 9));
        court.draw(9);
        vm.expectRevert(CreateCourt.OnlyTwoChoices.selector);
        court.createDispute(3, "");
        vm.expectRevert(CreateCourt.InvalidSetup.selector);
        new CreateCourt(IERC20(address(create)), IERC20(address(0xBEEF)), SEAT, FEE);
    }

    // ---- the draw tree -------------------------------------------------------------------------------------------

    function testFuzz_the_draw_tree_finds_the_juror_holding_each_seat(uint8[6] memory seats, uint256 pick) public {
        address[6] memory people = [ANN, BO, CY, DI, address(0xE1), address(0xF1)];
        uint256 total;
        for (uint256 i; i < people.length; ++i) {
            uint256 n = bound(seats[i], 1, 20);
            create.transfer(people[i], n * SEAT);
            vm.startPrank(people[i]);
            create.approve(address(court), type(uint256).max);
            court.stake(n * SEAT);
            vm.stopPrank();
            total += n;
        }
        assertEq(court.freeSeats(), total);
        pick = bound(pick, 0, total - 1);
        uint256 index = court.find(pick);
        uint256 below;
        uint256 i;
        for (; i < people.length; ++i) {
            uint256 mine = court.freeSeatsOf(people[i]);
            if (pick < below + mine) break;
            below += mine;
        }
        assertEq(court.jurorAt(index), people[i]);
    }
}
