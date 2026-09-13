// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {AllowlistHook} from "../src/hooks/AllowlistHook.sol";
import {TrustGatedHook} from "../src/hooks/TrustGatedHook.sol";
import {AuctionLauncher} from "../src/AuctionLauncher.sol";
import {AppTokenLBPInitializer} from "../src/AppTokenLBPInitializer.sol";
import {IContinuousClearingAuction} from "../src/CCA.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockAuction is IContinuousClearingAuction {
    bool public graduated;
    LBPInitializationParams public params;
    MockERC20 public currencyToken;
    MockERC20 public saleToken;
    address public override fundsRecipient;
    address public override tokensRecipient;

    constructor() {
        currencyToken = new MockERC20();
        saleToken = new MockERC20();
    }

    function setGraduated(bool g) external {
        graduated = g;
    }

    function setParams(uint256 price, uint256 sold, uint256 raised) external {
        params = LBPInitializationParams(price, sold, raised);
    }

    function setRecipients(address funds_, address tokens_) external {
        fundsRecipient = funds_;
        tokensRecipient = tokens_;
    }

    function fund(uint256 currency_, uint256 tokens_) external {
        currencyToken.mint(address(this), currency_);
        saleToken.mint(address(this), tokens_);
    }

    function isGraduated() external view override returns (bool) {
        return graduated;
    }

    function currencyRaised() external view override returns (uint256) {
        return params.currencyRaised;
    }

    function currency() external view override returns (address) {
        return address(currencyToken);
    }

    function token() external view override returns (address) {
        return address(saleToken);
    }

    function sweepCurrency() external override {
        require(msg.sender == fundsRecipient, "not funds recipient");
        currencyToken.transfer(fundsRecipient, currencyToken.balanceOf(address(this)));
    }

    function sweepUnsoldTokens() external override {
        require(msg.sender == tokensRecipient, "not tokens recipient");
        saleToken.transfer(tokensRecipient, saleToken.balanceOf(address(this)));
    }

    function lbpInitializationParams() external view override returns (LBPInitializationParams memory) {
        return params;
    }
}

contract LaunchpadTest is Test {
    AllowlistHook allowlist;
    AuctionLauncher launcher;
    address treasury = address(0xBEEF);
    address alice = address(0xA11CE);

    function setUp() public {
        allowlist = new AllowlistHook(treasury, 1000);
        launcher = new AuctionLauncher();
    }

    function test_allowlist_rejects_unknown_bidder() public {
        vm.expectRevert(abi.encodeWithSelector(AllowlistHook.NotAllowlisted.selector, alice));
        allowlist.validate(2, 100, alice, alice, "");
    }

    function test_allowlist_caps_accumulate() public {
        vm.prank(treasury);
        allowlist.setBidder(alice, true);
        allowlist.validate(2, 600, alice, alice, "");
        vm.expectRevert();
        allowlist.validate(2, 500, alice, alice, "");
        // Exact cap still passes.
        allowlist.validate(2, 400, alice, alice, "");
    }

    function test_allowlist_owner_only() public {
        vm.expectRevert(abi.encodeWithSelector(AllowlistHook.OnlyOwner.selector, alice));
        vm.prank(alice);
        allowlist.setBidder(alice, true);
    }

    function test_trust_hook_accepts_valid_proof() public {
        uint256 score = 50;
        bytes32 leaf = keccak256(abi.encode(alice, score));
        bytes32 sibling = keccak256("sibling");
        bytes32 root =
            leaf <= sibling ? keccak256(abi.encodePacked(leaf, sibling)) : keccak256(abi.encodePacked(sibling, leaf));
        TrustGatedHook hook = new TrustGatedHook(treasury, root, 10);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        hook.validate(2, 100, alice, alice, abi.encode(score, proof));
    }

    function test_trust_hook_rejects_low_score() public {
        TrustGatedHook hook = new TrustGatedHook(treasury, bytes32(uint256(1)), 10);
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert();
        hook.validate(2, 100, alice, alice, abi.encode(uint256(5), proof));
    }

    function test_launcher_rejects_bad_floor() public {
        AuctionLauncher.LaunchParams memory p = AuctionLauncher.LaunchParams({
            currency: address(1),
            floorPrice: 1,
            tickSpacing: 100,
            requiredRaised: 100,
            startBlock: 10,
            endBlock: 20,
            claimBlock: 30,
            steps: hex"0000000000000001",
            validationHook: address(0)
        });
        vm.expectRevert(AuctionLauncher.BadFloorPrice.selector);
        launcher.registerLaunch(bytes32(uint256(1)), p);
    }

    function test_launcher_rejects_bad_blocks() public {
        AuctionLauncher.LaunchParams memory p = AuctionLauncher.LaunchParams({
            currency: address(1),
            floorPrice: (uint256(1) << 32) + 1,
            tickSpacing: 100,
            requiredRaised: 100,
            startBlock: 20,
            endBlock: 20,
            claimBlock: 30,
            steps: hex"0000000000000001",
            validationHook: address(0)
        });
        vm.expectRevert(AuctionLauncher.BadBlocks.selector);
        launcher.registerLaunch(bytes32(uint256(1)), p);
    }

    function test_launcher_registers_and_commits_params() public {
        bytes memory steps = hex"00000000000000010000000000000002";
        AuctionLauncher.LaunchParams memory p = AuctionLauncher.LaunchParams({
            currency: address(1),
            floorPrice: (uint256(1) << 32) + 1,
            tickSpacing: 100,
            requiredRaised: 100,
            startBlock: 10,
            endBlock: 20,
            claimBlock: 30,
            steps: steps,
            validationHook: address(0)
        });
        launcher.registerLaunch(bytes32(uint256(7)), p);
        assertTrue(launcher.paramsHash(bytes32(uint256(7))) != bytes32(0));
        assertEq(launcher.curator(bytes32(uint256(7))), address(this));
        vm.expectRevert();
        launcher.registerLaunch(bytes32(uint256(7)), p);
    }

    function test_initializer_rejects_ungraduated() public {
        MockAuction auction = new MockAuction();
        auction.setParams(100, 1000, 5000);
        AppTokenLBPInitializer init_ = new AppTokenLBPInitializer(treasury, 4000);
        vm.expectRevert(abi.encodeWithSelector(AppTokenLBPInitializer.NotGraduated.selector, address(auction)));
        init_.graduate(address(auction));
    }

    function test_initializer_splits_reserve_and_treasury() public {
        MockAuction auction = new MockAuction();
        auction.setParams(100, 1000, 5000);
        auction.setGraduated(true);
        AppTokenLBPInitializer init_ = new AppTokenLBPInitializer(treasury, 4000);
        init_.graduate(address(auction));
        (uint256 price, uint256 sold, uint256 raised, uint256 reserve, uint256 tshare,,,) =
            init_.graduations(address(auction));
        assertEq(price, 100);
        assertEq(sold, 1000);
        assertEq(raised, 5000);
        assertEq(reserve, 2000);
        assertEq(tshare, 3000);
        vm.expectRevert();
        init_.graduate(address(auction));
    }

    function test_initializer_records_pools_treasury_only() public {
        MockAuction auction = new MockAuction();
        auction.setParams(100, 1000, 5000);
        auction.setGraduated(true);
        AppTokenLBPInitializer init_ = new AppTokenLBPInitializer(treasury, 4000);
        init_.graduate(address(auction));
        vm.expectRevert();
        init_.recordPools(address(auction), address(1), address(2));
        vm.prank(treasury);
        init_.recordPools(address(auction), address(1), address(2));
        (,,,,,,, bool recorded) = init_.graduations(address(auction));
        assertTrue(recorded);
    }
}
