// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {StackBase, Proj} from "./StackBase.sol";
import {Council} from "../../src/Council.sol";
import {HolderPause} from "../../src/HolderPause.sol";
import {HolderVote} from "../../src/HolderVote.sol";
import {Launcher} from "../../src/Launcher.sol";
import {Parts} from "../../src/Parts.sol";
import {Treasury} from "../../src/Treasury.sol";
import {ITreasuryRunner} from "../../src/Interfaces.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";

/// @notice The real stack with the Council switch ON: the Launcher is bound to a real `HolderVote` (the pause that is
/// also the vote contract) and a real `Council`
/// implementation before any launch, as the deploy script does it. The default project is run by its founder; `_makeCouncil`
/// hands its seat to a Council of the five accounts `s1` to `s5`. Time moves through `clock` (a storage copy of the block
/// time), because `vm.warp(block.timestamp + x)` is unreliable under the optimizer inside one test function.
abstract contract CouncilBase is StackBase {
    using stdStorage for StdStorage;

    Council internal councilImpl;
    Council internal council;
    uint256 internal clock;
    address internal s1 = makeAddr("seat1");
    address internal s2 = makeAddr("seat2");
    address internal s3 = makeAddr("seat3");
    address internal s4 = makeAddr("seat4");
    address internal s5 = makeAddr("seat5");
    address internal s6 = makeAddr("sixth account");

    function setUp() public virtual override {
        vm.warp(T0);
        clock = T0;
        usd = new QuoteToken();
        parts = new Parts();
        launcher = new Launcher(admin, _platform(UNIT), parts);
        launcher.bindPause(address(new HolderVote()));
        councilImpl = new Council();
        launcher.bindCouncil(address(councilImpl));
        _use(_launch(founder, "p1", 1000, POOL));
    }

    function _five() internal view returns (address[5] memory m) {
        m = [s1, s2, s3, s4, s5];
    }

    function _warp(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
    }

    function _warpTo(uint256 ts) internal {
        require(ts >= clock, "time only moves forward");
        clock = ts;
        vm.warp(ts);
    }

    /// @dev The founder offers the seat to the Council of `m` with `salt`; anyone then makes it. Returns it (not made the
    /// default `council`).
    function _handOverTo(address[5] memory m, bytes32 salt) internal returns (Council c) {
        address predicted = launcher.councilAddress(key, m, salt);
        vm.prank(t.runner());
        t.handOver(predicted, false);
        vm.prank(stranger);
        c = Council(launcher.makeCouncil(key, m, salt));
        assertEq(address(c), predicted, "the Council is at the address the offer named");
    }

    /// @dev Hand the default project's seat to the Council of `s1` to `s5` and make it the default `council`.
    function _makeCouncil() internal returns (Council c) {
        c = _handOverTo(_five(), bytes32(0));
        council = c;
    }

    /// @dev `by` proposes a call to the Council's Treasury; returns the proposal's number.
    function _propose(address by, bytes memory data) internal returns (uint256 n) {
        n = council.nonce();
        vm.prank(by);
        council.propose(address(t), data);
    }

    /// @dev `by` proposes with no call before it (so a `vm.expectRevert` just above meets the proposal itself).
    function _propRaw(address by, address target, bytes memory data) internal {
        vm.prank(by);
        council.propose(target, data);
    }

    function _proposeTo(address by, address target, bytes memory data) internal returns (uint256 n) {
        n = council.nonce();
        vm.prank(by);
        council.propose(target, data);
    }

    function _agree(address by, bytes memory data, uint256 n) internal {
        vm.prank(by);
        council.agree(address(t), data, n);
    }

    /// @dev Three seats agree to a call of the Treasury (proposed by `a`, agreed by `b`, then `c_` runs it).
    function _run3(address a, address b, address c_, bytes memory data) internal {
        uint256 n = _propose(a, data);
        _agree(b, data, n);
        _agree(c_, data, n);
    }

    /// @dev Three seats (s1, s2, s3) run a call of the Treasury.
    function _run(bytes memory data) internal {
        _run3(s1, s2, s3, data);
    }

    /// @dev The Council checks in for the project (three seats).
    function _councilCheckIn() internal {
        _run(abi.encodeCall(Treasury.checkIn, (bytes32(0))));
    }

    /// @dev Move time forward `secs`, a few days at a time, with a check-in by the Council before each window closes.
    function _warpAlive(uint256 secs) internal {
        uint256 end = clock + secs;
        while (clock + 6 days < end) {
            _warp(6 days);
            _councilCheckIn();
        }
        _warpTo(end);
    }

    /// @dev Register `who` as a runner contract of `kind` in the real Launcher (a stand-in that cannot be made any other way).
    function _register(address who, uint8 kind) internal {
        stdstore.target(address(launcher)).sig("runnerKindOf(address)").with_key(who).checked_write(uint256(kind));
    }

    /// @dev A bare Council clone whose "Treasury" is `fake` and whose vote contract is `fake`'s gate; initialised as the
    /// launcher `launcherAddr`.
    function _bareCouncil(FakeTreasury fake, address launcherAddr, address[5] memory m) internal returns (Council c) {
        c = Council(Clones.clone(address(councilImpl)));
        vm.prank(launcherAddr);
        c.initialize(ITreasuryRunner(address(fake)), launcherAddr, m, false);
    }
}

/// @notice A Treasury stand-in for the Council's own tests: the time unit, a gate (the vote contract), a seat to take, and a
/// `draw` that counts what ran and says whether the Council was executing when it did.
contract FakeTreasury {
    uint32 public unit;
    address public pauseGate;
    uint256 public draws;
    uint256 public drawnAmount;
    bool public sawBothSigned;
    address public council;
    bool public seatTaken;

    constructor(uint32 unit_, address gate) {
        (unit, pauseGate) = (unit_, gate);
    }

    function setGate(address gate) external {
        pauseGate = gate;
    }

    function setCouncil(address c) external {
        council = c;
    }

    function takeSeat() external {
        seatTaken = true;
    }

    /// @dev The same selector as `Treasury.draw`, so the Council's list accepts it.
    function draw(address, uint256 amount) external {
        ++draws;
        drawnAmount += amount;
        sawBothSigned = Council(council).bothSigned();
    }
}
