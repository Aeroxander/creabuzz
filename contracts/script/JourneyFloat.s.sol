// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RoyaltyDistributor, IERC20Bal} from "../src/RoyaltyDistributor.sol";
import {SellRateGate} from "../src/SellRateGate.sol";
import {TieredSellRouter} from "../src/TieredSellRouter.sol";
import {BuybackKeeper} from "../src/BuybackKeeper.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {ClaimStake} from "../src/ClaimStake.sol";

/// @notice A minimal ERC-20 for the journey (token + revenue currency).
contract JourneyERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address who, uint256 amt) external returns (bool) {
        allowance[msg.sender][who] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "balance");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(balanceOf[from] >= amt, "balance");
        if (allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= amt, "allowance");
            allowance[from][msg.sender] -= amt;
        }
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// @notice The sell venue of the journey (stands in for the LBAMM router).
contract JourneyVenue {
    uint256 public sold;

    function sell(uint256 amount) external {
        sold += amount;
    }
}

/// @notice Shared plumbing for the two journey phases (see `JourneyFloatA`).
abstract contract JourneyFloatBase is Script {
    // Anvil default keys (dev only!).
    uint256 internal constant TREASURY_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant CLAIMANT_KEY =
        0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant VERIFIER_KEY =
        0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;

    uint256 internal constant TRANCHE_1 = 120_000; // 20% allocation * 60%
    uint256 internal constant TRANCHE_2 = 80_000; // 20% allocation * 40%

    string internal constant ADDR_FILE = "deployments/journey-float.json";

    struct Deployed {
        JourneyERC20 token;
        JourneyERC20 usd;
        VerifierSet verifiers;
        ClaimStake stake;
        BuybackKeeper keeper;
        RoyaltyDistributor dist;
        SellRateGate gate;
        TieredSellRouter router;
        JourneyVenue venue;
    }

    function _load() internal view returns (Deployed memory d) {
        d.token = JourneyERC20(vm.parseJsonAddress(vm.readFile(ADDR_FILE), ".token"));
        d.usd = JourneyERC20(vm.parseJsonAddress(vm.readFile(ADDR_FILE), ".usd"));
        d.verifiers = VerifierSet(vm.parseJsonAddress(vm.readFile(ADDR_FILE), ".verifiers"));
        d.stake = ClaimStake(payable(vm.parseJsonAddress(vm.readFile(ADDR_FILE), ".stake")));
        d.keeper = BuybackKeeper(payable(vm.parseJsonAddress(vm.readFile(ADDR_FILE), ".keeper")));
        d.dist = RoyaltyDistributor(vm.parseJsonAddress(vm.readFile(ADDR_FILE), ".dist"));
        d.gate = SellRateGate(vm.parseJsonAddress(vm.readFile(ADDR_FILE), ".gate"));
        d.router = TieredSellRouter(vm.parseJsonAddress(vm.readFile(ADDR_FILE), ".router"));
        d.venue = JourneyVenue(vm.parseJsonAddress(vm.readFile(ADDR_FILE), ".venue"));
    }

    function _save(Deployed memory d) internal {
        // `serializeAddress` accumulates under the object key; chaining the
        // returned JSON as the next key would split the namespaces.
        string memory obj = vm.serializeAddress("journey", "token", address(d.token));
        vm.serializeAddress("journey", "usd", address(d.usd));
        vm.serializeAddress("journey", "verifiers", address(d.verifiers));
        vm.serializeAddress("journey", "stake", address(d.stake));
        vm.serializeAddress("journey", "keeper", address(d.keeper));
        vm.serializeAddress("journey", "dist", address(d.dist));
        vm.serializeAddress("journey", "gate", address(d.gate));
        vm.serializeAddress("journey", "router", address(d.router));
        obj = vm.serializeAddress("journey", "venue", address(d.venue));
        vm.writeJson(obj, ADDR_FILE);
    }

    function _hex(bytes32 b) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            out[i * 2] = alphabet[uint8(b[i]) >> 4];
            out[i * 2 + 1] = alphabet[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }

    function _hexAddr(address a) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(40);
        bytes20 bb = bytes20(a);
        for (uint256 i = 0; i < 20; i++) {
            out[i * 2] = alphabet[uint8(bb[i]) >> 4];
            out[i * 2 + 1] = alphabet[uint8(bb[i]) & 0x0f];
        }
        return string(abi.encodePacked("0x", string(out)));
    }

    /// @dev CREATE address derivation: keccak(RLP([sender, nonce])).
    function _createAddress(address deployer, uint64 nonce) internal pure returns (address) {
        bytes memory data;
        if (nonce == 0x00) {
            data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(0x80));
        } else if (nonce <= 0x7f) {
            data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, uint8(nonce));
        } else if (nonce <= 0xff) {
            data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(0x81), uint8(nonce));
        } else {
            revert("nonce beyond helper range");
        }
        return address(uint160(uint256(keccak256(data))));
    }
}

/// @notice Journey phase 1 — deploy, escrow, claim, verdict, TRANCHE RELEASE.
///
/// Run both phases through `scripts/journey-float.sh` (it waits for the
/// settlement window to close between them — the seconds a live chain gives
/// for free):
///
/// ```
/// anvil &
/// scripts/journey-float.sh
/// ```
contract JourneyFloatA is JourneyFloatBase {
    function run() external {
        address treasury = vm.addr(TREASURY_KEY);
        address verifier = vm.addr(VERIFIER_KEY);
        bytes32 constantM1 = bytes32("m1"); // == claimIdWord("m1")
        bytes32 evidence = keccak256("journey-evidence");

        // ---- deploy (treasury is also governance + operator here) ----------
        vm.startBroadcast(TREASURY_KEY);
        Deployed memory d;
        d.token = new JourneyERC20();
        d.usd = new JourneyERC20();
        d.verifiers = new VerifierSet(treasury, 1);
        d.stake = new ClaimStake(d.verifiers, treasury, address(d.token));
        d.keeper = new BuybackKeeper(IERC20Bal(address(d.usd)), treasury, treasury);
        d.dist = new RoyaltyDistributor(
            IERC20Bal(address(d.usd)),
            IERC20Bal(address(d.token)),
            treasury,
            address(d.keeper),
            address(d.stake),
            treasury,
            1, // windowLen = 1s: the wrapper's sleep closes the window
            4000,
            2000
        );
        address predictedRouter = _createAddress(treasury, vm.getNonce(treasury) + 1);
        d.gate = new SellRateGate(d.dist, predictedRouter);
        d.router = new TieredSellRouter(d.gate, treasury);
        require(address(d.router) == predictedRouter, "router nonce drift");
        d.venue = new JourneyVenue();
        d.stake.setRoyalties(address(d.dist));
        d.verifiers.acceptVerifier(verifier);
        vm.stopBroadcast();
        _save(d);

        // ---- treasury mints + approves the milestone allocation ------------
        vm.startBroadcast(TREASURY_KEY);
        d.token.mint(treasury, TRANCHE_1 + TRANCHE_2);
        d.token.approve(address(d.stake), type(uint256).max);
        vm.stopBroadcast();

        // ---- wizard row m1 as an onchain claim (+ royalty schedule) --------
        vm.startBroadcast(CLAIMANT_KEY);
        d.stake.submitClaimWithSchedule(
            constantM1, TRANCHE_1, 0, evidence, 1, 365 days, 1, uint128(TRANCHE_1)
        );
        vm.stopBroadcast();

        // ---- treasury reserves the tranche FOR THAT CLAIM (fund is per claim) -
        vm.startBroadcast(TREASURY_KEY);
        d.stake.fund(constantM1, TRANCHE_1);
        vm.stopBroadcast();
        require(d.token.balanceOf(address(d.stake)) == TRANCHE_1, "m1 tranche reserved");

        // ---- verifier attests; settle releases on ATTESTATION --------------
        vm.startBroadcast(VERIFIER_KEY);
        d.verifiers.attest(constantM1, true);
        vm.stopBroadcast();

        vm.startBroadcast(TREASURY_KEY);
        d.stake.settle(constantM1);
        vm.stopBroadcast();

        vm.startBroadcast(CLAIMANT_KEY);
        d.stake.payout(constantM1);
        vm.stopBroadcast();

        address claimant = vm.addr(CLAIMANT_KEY);
        require(d.token.balanceOf(claimant) == TRANCHE_1, "tranche released on the verdict");
        require(d.dist.allocOf(claimant) == TRANCHE_1, "schedule allocation registered");

        // ---- first revenue lands with the work (sets the window clock) ----
        vm.startBroadcast(TREASURY_KEY);
        d.usd.mint(treasury, 10_000);
        d.usd.approve(address(d.dist), 10_000);
        d.dist.fund(treasury, 10_000);
        vm.stopBroadcast();

        console2.log("PHASE 1 OK - m1 tranche reserved for its claim; released on attestation.");
        console2.log("addresses:", ADDR_FILE);
    }
}

/// @notice Journey phase 2 — revenue settles, royalties, buyback share, the
///         sell-rate gate, and the attestation-feed mirror payloads.
contract JourneyFloatB is JourneyFloatBase {
    function run() external {
        // The local simulation's clock is frozen at the fork timestamp (end
        // of phase 1); the node's clock has genuinely moved during the
        // wrapper's sleep. Nudge the SIM clock to match the real seconds —
        // the sends estimate against the node, which is honestly ahead.
        vm.warp(block.timestamp + 5);
        Deployed memory d = _load();
        address treasury = vm.addr(TREASURY_KEY);
        address claimant = vm.addr(CLAIMANT_KEY);

        // ---- window 0 closes on the revenue funded in phase 1 -------------
        vm.startBroadcast(TREASURY_KEY);
        d.dist.settle(); // window 1 (trapezoid-dipped release window, D4 carries)
        vm.stopBroadcast();
        require(d.usd.balanceOf(claimant) == 2_000, "window 1: trapezoid dip credited");
        require(d.dist.carry() == 2_000, "the dip carried (D4)");
        require(d.usd.balanceOf(address(d.keeper)) == 4_000, "buyback share in the keeper");

        vm.startBroadcast(TREASURY_KEY);
        d.usd.mint(treasury, 10_000);
        d.usd.approve(address(d.dist), 10_000);
        d.dist.fund(treasury, 10_000);
        d.dist.settle(); // window 2 (h = 1; pool = 4000 + carried 2000)
        vm.stopBroadcast();
        require(d.usd.balanceOf(claimant) == 8_000, "window 2: full pool + carried");

        // ---- sell-rate gate through the router (D8) -----------------------
        uint256 cap = (TRANCHE_1 * 300) / 10_000; // Tier I: 3%/window
        vm.startBroadcast(TREASURY_KEY);
        d.router.setVenue(address(d.venue), true);
        d.router.executeSell(claimant, cap, address(d.venue), abi.encodeCall(d.venue.sell, (cap)));
        vm.stopBroadcast();
        require(d.gate.sellAllowance(claimant) == 0, "tier drip consumed");
        require(d.venue.sold() == cap, "venue executed");

        // ---- the attestation feed's payloads (47006 + 47007) --------------
        console2.log("JOURNEY OK - royalties settled, buyback funded, gate enforced.");
        console2.log("kind:47006 schedule mirror (unsigned template):");
        console2.log(
            string(
                abi.encodePacked(
                    '{"kind":47006,"content":"{\\"claimId\\":\\"m1\\",\\"evidenceHash\\":\\"',
                    _hex(keccak256("journey-evidence")),
                    '\\",\\"contributor\\":\\"',
                    _hexAddr(claimant),
                    '\\",\\"weight\\":1,\\"term\\":31536000,\\"band\\":1,\\"allocation\\":\\"120000\\"}"}'
                )
            )
        );
        console2.log("kind:47007 close mirror for window 2 (unsigned template):");
        console2.log(
            '{"kind":47007,"content":"{\\"windowId\\":1,\\"revenue\\":\\"10000\\",\\"buybackShare\\":\\"4000\\",\\"treasuryShare\\":\\"2000\\",\\"pool\\":\\"6000\\",\\"carried\\":\\"0\\"}"}'
        );
    }
}
