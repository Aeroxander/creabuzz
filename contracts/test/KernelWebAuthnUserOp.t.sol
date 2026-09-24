// SPDX-License-Identifier: MIT
// Wave 4b end-to-end proof: a passkey-style WebAuthn-signed ERC-4337 v0.8
// UserOperation deploys and executes on the REAL ZeroDev Kernel via the REAL
// WebAuthnValidator, and EntryPoint v0.8.0's getUserOpHash equals the web
// client's golden vector (web/src/features/identity/lib/userop.test.mjs).
//
// Signature fixture: `test/kernel-sign.mjs` (pinned P-256 JWK, node ffi).
// The low-s normalization below mirrors webauthn-auth.ts's `derToRs` — the
// plugin's P256 rejects s > n/2 (anti-malleability), so real authenticators
// emit exactly this case ~50% of the time.
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {Kernel} from "zerodev-kernel/Kernel.sol";
import {KernelUUPS} from "zerodev-kernel/KernelUUPS.sol";
import {KernelImmutableECDSA} from "zerodev-kernel/KernelImmutableECDSA.sol";
import {KernelFactory, Install} from "zerodev-kernel/KernelFactory.sol";
import {WebAuthnValidator, WebAuthnValidatorData} from "zerodev-kernel-7579-plugins/validators/WebAuthnValidator.sol";
import {Base64URL} from "zerodev-kernel-7579-plugins/utils/Base64URL.sol";
import {P256Verifier} from "zerodev-kernel-7579-plugins/utils/P256Verifier.sol";

contract KernelWebAuthnUserOpTest is Test {
    EntryPoint internal ep;
    KernelFactory internal factory;
    WebAuthnValidator internal validator;

    function setUp() public {
        // The plugin's usePrecompiled=false path calls the Daimo/FCL P256
        // verifier at a fixed address (P256.DAIMO_VERIFIER); etch the plugin's
        // drop-in source there.
        vm.etch(0xc2b78104907F722DABAc4C69f826a522B2754De4, address(new P256Verifier()).code);
        ep = new EntryPoint();
        factory = new KernelFactory(
            new KernelUUPS(IEntryPoint(address(ep))),
            new KernelImmutableECDSA(IEntryPoint(address(ep)))
        );
        validator = new WebAuthnValidator();
    }

    function _signerPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/kernel-sign.mjs");
    }

    function _pubkey() internal returns (uint256 x, uint256 y) {
        string[] memory cmd = new string[](3);
        cmd[0] = "node";
        cmd[1] = _signerPath();
        cmd[2] = "pub";
        bytes memory out = vm.ffi(cmd);
        (x, y) = abi.decode(out, (uint256, uint256));
    }

    function _sign(bytes memory message) internal returns (uint256 r, uint256 s) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = _signerPath();
        cmd[2] = "sign";
        cmd[3] = vm.toString(message);
        bytes memory out = vm.ffi(cmd);
        uint256 off = out.length == 65 ? 1 : 0; // tolerate a stray leading byte
        require(out.length == 64 + off, "bad ffi signature length");
        for (uint256 i = 0; i < 32; i++) {
            r |= uint256(uint8(out[off + i])) << (8 * (31 - i));
            s |= uint256(uint8(out[off + 32 + i])) << (8 * (31 - i));
        }
    }

    /// EntryPoint v0.8.0 getUserOpHash == the web client's cast-derived golden
    /// vector (entryPoint 0x1111..11, chainId 31337, op fields in
    /// web/src/features/identity/lib/userop.test.mjs).
    function test_GetUserOpHashMatchesWebGoldenVector() public {
        vm.chainId(31337);
        EntryPoint impl = new EntryPoint();
        vm.etch(0x1111111111111111111111111111111111111111, address(impl).code);
        IEntryPoint epAt = IEntryPoint(0x1111111111111111111111111111111111111111);
        PackedUserOperation memory op;
        op.sender = 0x2222222222222222222222222222222222222222;
        op.nonce = 0;
        op.initCode = hex"deadbeef";
        op.callData = hex"c0ffee";
        op.accountGasLimits = bytes32((uint256(3) << 128) | 5);
        op.preVerificationGas = 21000;
        op.gasFees = bytes32((uint256(1) << 128) | 2);
        op.paymasterAndData = "";
        assertEq(
            epAt.getUserOpHash(op),
            0xd6cacc8eda8775806acb23b07822677a113e5a7bb8fb41e1e840f11f6331d67a
        );
    }

    /// WebAuthn-signed UserOp deploys the Kernel through its factory and runs
    /// a self-call — the full passkey → UserOp path on real contracts.
    function test_WebAuthnSignedUserOpDeploysAndExecutesKernel() public {
        (uint256 x, uint256 y) = _pubkey();
        Install[] memory packages = new Install[](1);
        packages[0] = Install({
            moduleType: 1,
            module: address(validator),
            moduleData: abi.encode(WebAuthnValidatorData({pubKeyX: x, pubKeyY: y}), bytes32(0)),
            internalData: ""
        });
        uint256 deployNonce = 5;
        bytes memory initCode =
            abi.encodePacked(address(factory), abi.encodeCall(KernelFactory.deploy, (packages, deployNonce)));
        address sender = factory.getAddress(packages, deployNonce);

        PackedUserOperation memory op;
        op.sender = sender;
        op.nonce = 0;
        op.initCode = initCode;
        op.callData = abi.encodeCall(Kernel.execute, (bytes32(0), abi.encodePacked(sender, uint256(0))));
        op.accountGasLimits = bytes32((uint256(3000000) << 128) | 500000);
        op.preVerificationGas = 21000;
        op.gasFees = bytes32((uint256(1) << 128) | 2000000000);
        op.paymasterAndData = "";

        // WebAuthn assertion over the userOpHash (canonical clientDataJSON —
        // `"challenge":"` at byte 23, the validator's CHALLENGE_LOCATION).
        bytes32 userOpHash = ep.getUserOpHash(op);
        bytes memory authenticatorData = abi.encodePacked(sha256("localhost"), bytes1(0x05), uint32(0));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64URL.encode(abi.encodePacked(userOpHash)),
            '","origin":"https://example.com","crossOrigin":false}'
        );
        (uint256 r, uint256 s) = _sign(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        // P256.verifySignature rejects s > n/2 (malleability guard) — the
        // production wrapper (webauthn-auth.ts derToRs) normalizes exactly
        // this way; mirror it here.
        uint256 nDiv2 = 57896044605178124381348723474703786764998477612067880171211129530534256022184;
        if (s > nDiv2) {
            s = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551 - s;
        }
        op.signature = abi.encode(authenticatorData, clientDataJSON, uint256(1), r, s, false);

        vm.deal(address(this), 100 ether);
        ep.depositTo{value: 10 ether}(sender);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        ep.handleOps(ops, payable(0x000000000000000000000000000000000000bEEF));

        assertGt(sender.code.length, 0, "kernel not deployed");
        assertTrue(validator.isInitialized(sender), "validator not installed");
    }
}
