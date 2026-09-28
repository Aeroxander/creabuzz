// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {RoyaltyDistributor, IERC20Bal} from "../src/RoyaltyDistributor.sol";
import {SellRateGate} from "../src/SellRateGate.sol";
import {TieredSellRouter} from "../src/TieredSellRouter.sol";
import {BuybackKeeper} from "../src/BuybackKeeper.sol";
import {MockCurrency, MockProjectToken} from "./RoyaltyDistributor.t.sol";

/// @notice A venue/target that records calls and can fail on demand.
contract MockVenue {
    uint256 public calls;
    bool public fail;

    function setFail(bool v) external {
        fail = v;
    }

    function doThing(uint256 x) external returns (uint256) {
        require(!fail, "venue: nope");
        calls += 1;
        return x + 1;
    }
}

/// @notice The S2 wiring layer: the router wrapper that consumes sell
///         allowance before venue calls (D8), and the keeper that holds the
///         buyback share `B` spendable only at approved buyback targets (I2).
///
/// Wiring note: the gate's `venue` is immutable and IS the router, and the
/// router holds its gate immutably — the pair is deployed gate-first with the
/// router's CREATE address predicted (`_wiredRouter`), the same constraint
/// `DeployRoyalty.s.sol` resolves for real deployments.
contract WiringTest is Test {
    uint64 internal constant WINDOW = 30 days;

    MockCurrency internal usd;
    MockProjectToken internal pt;
    RoyaltyDistributor internal dist;
    BuybackKeeper internal keeper;
    MockVenue internal venue;
    MockVenue internal attacker;

    address internal treasury = makeAddr("treasury");
    address internal governance = makeAddr("governance");
    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    bytes32 internal constant CLAIM_A = keccak256("claim-a");

    function setUp() public {
        usd = new MockCurrency();
        pt = new MockProjectToken();
        // The test acts as ClaimStake (direct mint) — wiring only.
        dist = new RoyaltyDistributor(
            IERC20Bal(address(usd)),
            IERC20Bal(address(pt)),
            treasury,
            makeAddr("buybackSink"),
            address(this),
            governance,
            WINDOW,
            4000,
            2000
        );
        keeper = new BuybackKeeper(IERC20Bal(address(usd)), governance, operator);
        venue = new MockVenue();
        attacker = new MockVenue();
    }

    /// @dev gate(venue = predicted router) -> router(gate). Router deploys at
    ///      nonce N+1 when the gate takes N.
    function _wiredRouter() internal returns (SellRateGate g, TieredSellRouter r) {
        address predicted = computeNewAddress(address(this), vm.getNonce(address(this)) + 1);
        g = new SellRateGate(dist, predicted);
        r = new TieredSellRouter(g, operator);
        require(address(r) == predicted, "nonce math");
    }

    function _gatedAlice(SellRateGate g) internal {
        pt.setBalance(alice, 100);
        dist.mint(CLAIM_A, alice, 1, 365 days, 1, 100); // Tier I cap: 3/window
    }

    // ---------------------------------------------------- TieredSellRouter

    function test_Router_ConsumesThenForwards() public {
        (SellRateGate g, TieredSellRouter r) = _wiredRouter();
        _gatedAlice(g);
        vm.prank(operator);
        r.setVenue(address(venue), true);

        vm.prank(operator);
        r.executeSell(alice, 2, address(venue), abi.encodeCall(venue.doThing, (7)));

        assertEq(venue.calls(), 1, "venue called");
        assertEq(g.soldInWindow(g.windowId(), alice), 2, "allowance consumed");
    }

    function test_Router_GateExceed_BlocksBeforeVenue() public {
        (SellRateGate g, TieredSellRouter r) = _wiredRouter();
        _gatedAlice(g);
        vm.prank(operator);
        r.setVenue(address(venue), true);

        vm.prank(operator);
        r.executeSell(alice, 3, address(venue), abi.encodeCall(venue.doThing, (1))); // to the cap
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SellRateGate.SellRateExceeded.selector, 1, 0));
        r.executeSell(alice, 1, address(venue), abi.encodeCall(venue.doThing, (1)));

        assertEq(venue.calls(), 1, "venue reached exactly once");
        assertEq(g.soldInWindow(g.windowId(), alice), 3, "cap held");
    }

    function test_Router_VenueFailure_RollsBackConsumption() public {
        (SellRateGate g, TieredSellRouter r) = _wiredRouter();
        _gatedAlice(g);
        vm.prank(operator);
        r.setVenue(address(venue), true);
        venue.setFail(true);

        vm.prank(operator);
        vm.expectRevert();
        r.executeSell(alice, 1, address(venue), abi.encodeCall(venue.doThing, (1)));

        assertEq(venue.calls(), 0, "venue did not complete");
        assertEq(g.soldInWindow(g.windowId(), alice), 0, "consumption rolled back");
    }

    function test_Router_OnlyOperator() public {
        (, TieredSellRouter r) = _wiredRouter();
        vm.expectRevert(TieredSellRouter.NotOperator.selector);
        r.executeSell(alice, 1, address(venue), "");
    }

    function test_Router_VenueAllowlist() public {
        (, TieredSellRouter r) = _wiredRouter();
        vm.prank(operator);
        vm.expectRevert(TieredSellRouter.VenueNotAllowed.selector);
        r.executeSell(alice, 1, address(attacker), "");
    }

    // ------------------------------------------------------- BuybackKeeper

    function test_Keeper_SpendsOnlyAtAllowlistedTargets() public {
        vm.prank(governance);
        keeper.setTarget(address(venue), true);
        usd.mint(address(keeper), 4_000);

        vm.prank(operator);
        keeper.executeBuyback(address(venue), abi.encodeCall(venue.doThing, (1)));
        assertEq(venue.calls(), 1, "buyback executed");

        vm.prank(operator);
        vm.expectRevert(BuybackKeeper.TargetNotAllowed.selector);
        keeper.executeBuyback(address(attacker), abi.encodeCall(attacker.doThing, (1)));
    }

    function test_Keeper_FailedTarget_SpendsNothing() public {
        usd.mint(address(keeper), 4_000);
        vm.prank(governance);
        keeper.setTarget(address(venue), true);
        venue.setFail(true);

        vm.expectRevert();
        keeper.executeBuyback(address(venue), abi.encodeCall(venue.doThing, (1)));
        assertEq(usd.balanceOf(address(keeper)), 4_000, "budget intact");
    }

    function test_Keeper_OnlyGovernanceSetsTargets_OnlyOperatorSpends() public {
        vm.prank(operator);
        vm.expectRevert(BuybackKeeper.NotGovernance.selector);
        keeper.setTarget(address(attacker), true);

        address operator2 = makeAddr("operator2");
        vm.prank(governance);
        keeper.setOperator(operator2);
        assertEq(keeper.operator(), operator2, "rotated");

        vm.prank(operator);
        vm.expectRevert(BuybackKeeper.NotOperator.selector);
        keeper.executeBuyback(address(venue), "");
    }

    /// @dev CREATE address derivation: keccak(RLP([sender, nonce])).
    function computeNewAddress(address deployer, uint64 nonce) internal pure returns (address) {
        bytes memory data;
        if (nonce == 0x00) {
            data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(0x80));
        } else if (nonce <= 0x7f) {
            data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, uint8(nonce));
        } else if (nonce <= 0xff) {
            data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(0x81), uint8(nonce));
        } else {
            revert("helper covers test-scale nonces only");
        }
        return address(uint160(uint256(keccak256(data))));
    }
}
