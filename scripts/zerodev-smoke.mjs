#!/usr/bin/env node
/**
 * Live ZeroDev smoke (wave 4c): prove the passkey → Kernel → UserOperation
 * path on Sepolia through ZeroDev's HOSTED paymaster + HOSTED bundler.
 *
 * Run under the repo's Hermit toolchain (node ≥ 22.18 strips TS types):
 *   . ./bin/activate-hermit && node scripts/zerodev-smoke.mjs
 *
 * Credentials come from the repo-root `.env` at runtime (ZERODEV_PROJECT_ID,
 * ZERODEV_API_KEY, SEPOLIA_RPC_URL) and are MASKED in all output. Nothing
 * secret is committed or printed (hard rule).
 *
 * What runs (wave 4c research ledger; full ledger in the wave report):
 *
 * STEP A — aa-kernel path (the wave-4b core: `aa-kernel.ts` initcode +
 * EntryPoint v0.8.0 EIP-712 hash) is probed against its intended factory:
 * `contracts/lib/zerodev-kernel/releases/v0.4.0.json` pins the deterministic
 * CREATE2 expected addresses (deployer 0x4e59b44847b379578588920cA78FbF26
 * 0B4956C, zero salt). As of 2026-09-24 NONE of them has code on Sepolia
 * (live eth_getCode probes), i.e. the vendored-master KernelFactory
 * (`deploy(Install[],uint256)`) is NOT deployed — and the release's
 * constructor args wire EntryPoint v0.9, while wave 4b's hash core is
 * EntryPoint v0.8.0. The smoke DETECTS this and reports the exact
 * remediation instead of burning a sponsored op on a missing factory
 * ("stop before burning funds on a wrong path").
 *
 * STEP B — the deployed official stack (the live integration proof):
 *   - Kernel factory  0x2577507b78c2008Ff367261CB6285d44ba5eF2E9
 *     (`createAccount(bytes,bytes32)` / `getAddress(bytes,bytes32)`;
 *     @zerodev/sdk@5.5.10 `constants.ts` KernelVersionToAddressesMap
 *     ["0.3.3"].factoryAddress — selectors 0xea6d13ac / 0x48aac392 are
 *     present in its live dispatch bytecode).
 *   - Kernel impl     0xd6CEDDe84be40893d153Be9d467CD6aD37875b28
 *     (["0.3.3"].accountImplementationAddress). LIVE-verified `entrypoint()`
 *     = 0x0000000071727De22E5E9d8BAf0edAc6f37da032 → this generation is
 *     wired to EntryPoint v0.7 (same check used by the research ledger).
 *   - WebAuthnValidator 0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69
 *     (PasskeyValidatorContractVersion.V0_0_3_PATCHED =
 *     `@zerodev/passkey-validator@…/index.ts`
 *     kernelVersionRangeToContractVersionToValidator["0.3.0 || 0.3.1 ||
 *     0.3.2 || 0.3.3"]["0.0.3"]; code live on Sepolia). Its signature tuple
 *     and `onInstall` data decode byte-compatibly with the vendored
 *     kernel-7579-plugins master that `webauthn-auth.ts` was proven against.
 *   - Account init: `initialize(bytes21 rootValidator, address hook, bytes
 *     validatorData, bytes hookData, bytes[] initConfig)` (v3.3
 *     `src/Kernel.sol:105`), rootValidator = bytes21(VALIDATION_TYPE_VALIDATOR
 *     ‖ validator) with VALIDATION_TYPE_VALIDATOR = 0x01 (v3.3
 *     `src/types/Constants.sol`), hook = HOOK_MODULE_NOT_INSTALLED =
 *     address(0), validatorData = `webAuthnValidatorModuleData(x, y)` —
 *     byte-identical to `@zerodev/passkey-validator` `getEnableData()` with
 *     authenticatorIdHash = 0.
 *   - Hash: EntryPoint v0.7 `getUserOpHash =
 *     keccak256(abi.encode(userOp.hash(), address(this), block.chainid))`
 *     (https://raw.githubusercontent.com/eth-infinitism/account-abstraction/
 *     v0.7.0/contracts/core/EntryPoint.sol lines 363-368) where
 *     `userOp.hash()` is `keccak256(UserOperationLib.encode(userOp))` — the
 *     PLAIN 8-word `abi.encode(...)` of v0.7.0 `UserOperationLib.sol`, with
 *     NO `PACKED_USEROP_TYPEHASH` prefix (that word is the v0.8 EIP-712
 *     struct hash computed by `hashPackedUserOperation` in userop.ts — NOT
 *     interchangeable with v0.7; live-proven 2026-09-24 against the real
 *     Sepolia EntryPoint: only the 8-word form byte-matches `getUserOpHash`).
 *     The computed hash is CHECKED AGAINST THE LIVE EntryPoint via
 *     `eth_call getUserOpHash(...)` before signing — if they ever differ the
 *     smoke aborts rather than sign the wrong bytes.
 *   - Signature: deterministic fixture P-256 key (pinned JWK ported from
 *     `contracts/test/kernel-sign.mjs`, generated once 2026-09-24) wrapped
 *     with `encodeZeroDevWebAuthnSignature` over a canonical assertion
 *     (the exact construction the in-repo forge proof
 *     `contracts/test/KernelWebAuthnUserOp.t.sol` executed successfully):
 *     challenge = base64url(opHash) at `"challenge":"` byte 23,
 *     responseTypeLocation = 1, low-s normalized via `derToRs`.
 *
 * Idempotent-safe: if the counterfactual sender already has code, the smoke
 * reports it and sends only the self-call (no redeploy).
 */
import { createHash, createPrivateKey, sign as ecdsaSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildKernelSelfCallData } from "../web/src/features/identity/lib/aa-kernel.ts";
import { b64urlEncode } from "../web/src/features/identity/lib/passkey.ts";
import {
  abiEncode,
  abiEncodeCall,
  decodeAddressWord,
  functionSelector,
  hexToBytes,
} from "../web/src/features/identity/lib/userop-abi.ts";
import { keccak256 } from "../web/src/features/identity/lib/userop.ts";
import {
  derToRs,
  encodeZeroDevWebAuthnSignature,
} from "../web/src/features/identity/lib/webauthn-auth.ts";
import {
  ENTRY_POINT_V0_7,
  PaymasterDeniedError,
  sendSponsoredUserOp,
} from "../web/src/features/identity/lib/zerodev.ts";

// ---------------------------------------------------------------- env ----

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const env = { ...parseDotEnv(path.resolve(scriptDir, "..", ".env")), ...process.env };

function parseDotEnv(file) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return out;
}

/** Never print secrets — presence only, masked (`…abcd`). */
function mask(secret) {
  if (secret === undefined || secret === "") return "(unset)";
  return `…${secret.slice(-4)}`;
}

const ZERODEV_PROJECT_ID = env.ZERODEV_PROJECT_ID;
const ZERODEV_API_KEY = env.ZERODEV_API_KEY;
const CHAIN_RPC_URL =
  env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_ID = 11155111;

const out = (line = "") => console.log(line);
const step = (n, line) => out(`\n[${n}] ${line}`);

// ------------------------------------------------------------- JSON-RPC ---

async function chainRpc(method, params) {
  const response = await fetch(CHAIN_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error !== undefined) {
    throw new Error(`chain RPC ${method}: ${payload.error.message}`);
  }
  return payload.result;
}

const getCode = (address) => chainRpc("eth_getCode", [address, "latest"]);
const ethCall = (to, data) => chainRpc("eth_call", [{ to, data }, "latest"]);

// ------------------------------------------------- fixture P-256 signer ---
// Provenance: contracts/test/kernel-sign.mjs (the pinned JWK fixture signer
// behind the in-repo forge proof; JWK generated once on 2026-09-24 and
// pinned for reproducible signatures). Obviously-fake/test-only key.

const FIXTURE_JWK = {
  kty: "EC",
  x: "BqjPovesWJOn2eU86PyU1j9LVKlpvYN2w5KCEzAus2Y",
  y: "Ii_D2wwf1j9Rb0hDdPZvMCEM57JNbv48Uk62463QVG4",
  crv: "P-256",
  d: "T4FCxtt1hQgHJSwFv78_S0LGYtVvt73h7-RikHaQ_G8",
};
const fixtureKey = createPrivateKey({ key: FIXTURE_JWK, format: "jwk" });
const fixturePub = {
  x: BigInt(`0x${Buffer.from(FIXTURE_JWK.x, "base64url").toString("hex")}`),
  y: BigInt(`0x${Buffer.from(FIXTURE_JWK.y, "base64url").toString("hex")}`),
};

/**
 * WebAuthn assertion over `opHash`, byte-for-byte the forge-proven
 * construction (`contracts/test/KernelWebAuthnUserOp.t.sol`):
 * authenticatorData = sha256("localhost") ‖ flags(0x05) ‖ signCount(0);
 * clientDataJSON canonical ( `"challenge":"` at byte 23 ); ES256 covers
 * sha256(authenticatorData ‖ sha256(clientDataJSON)); DER → r‖s with the
 * PRODUCTION low-s normalization (`derToRs`).
 */
function signAssertionOverHash(opHash) {
  const authenticatorData = Buffer.concat([
    createHash("sha256").update("localhost").digest(),
    Buffer.from([0x05]),
    Buffer.alloc(4),
  ]);
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${b64urlEncode(
    hexToBytes(opHash),
  )}","origin":"https://example.com","crossOrigin":false}`;
  const message = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest(),
  ]);
  const der = ecdsaSign("sha256", message, fixtureKey);
  const { r, s } = derToRs(new Uint8Array(der));
  return encodeZeroDevWebAuthnSignature({
    authenticatorData: `0x${authenticatorData.toString("hex")}`,
    clientDataJSON,
    responseTypeLocation: 1n,
    r: BigInt(r),
    s: BigInt(s),
    usePrecompiled: false,
  });
}

/**
 * Gas-estimation stub for the deployed V0_0_3_PATCHED validator — the
 * exact `getStubSignature()` tuple shipped by `@zerodev/passkey-validator`
 * (toPasskeyValidator.ts lines 262-280). Dummy policies are
 * validator-version-specific; this is the honest one for the deployed
 * contract (the wave-4b `type(uint256).max` convention belongs to the
 * vendored-master validator).
 */
const OFFICIAL_STUB_SIGNATURE = encodeZeroDevWebAuthnSignature({
  authenticatorData:
    "0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d00000000",
  clientDataJSON:
    '{"type":"webauthn.get","challenge":"tbxXNFS9X_4Byr1cMwqKrIGB-_30a0QhZ6y7ucM0BOE","origin":"http://localhost:3000","crossOrigin":false, "other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"}',
  responseTypeLocation: 1n,
  r: 44941127272049826721201904734628716258498742255959991581049806490182030242267n,
  s: 9910254599581058084911561569808925251374718953855182016200087235935345969636n,
  usePrecompiled: false,
});

// -------------------------------------------- hash ports + live checking ---

function word32(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

/**
 * EntryPoint v0.7 `UserOperationLib.hash` — `keccak256(encode(userOp))`
 * where `encode` (v0.7.0 `UserOperationLib.sol`) is the PLAIN 8-word
 * `abi.encode(sender, nonce, keccak(initCode), keccak(callData),
 * accountGasLimits, preVerificationGas, gasFees, keccak(paymasterAndData))`
 * — NO `PACKED_USEROP_TYPEHASH` prefix.
 * (https://raw.githubusercontent.com/eth-infinitism/account-abstraction/
 * v0.7.0/contracts/core/UserOperationLib.sol, `encode`/`hash`.)
 *
 * The typehash-prefixed variant is the EntryPoint v0.8 EIP-712 struct hash
 * (`hashPackedUserOperation` in userop.ts) and does NOT belong in the v0.7
 * hash chain — live-proven 2026-09-24: against the real Sepolia EntryPoint
 * v0.7 only this 8-word form byte-matches `getUserOpHash`; the earlier
 * typehash-prefixed port mismatched (`hash mismatch` abort in `checkedHash`).
 */
function hashPackedUserOperationV07(packed) {
  return keccak256(
    abiEncode([
      { kind: "address", value: packed.sender },
      { kind: "uint", value: BigInt(packed.nonce) },
      { kind: "bytes32", value: keccak256(packed.initCode) },
      { kind: "bytes32", value: keccak256(packed.callData) },
      { kind: "bytes32", value: packed.accountGasLimits },
      { kind: "uint", value: BigInt(packed.preVerificationGas) },
      { kind: "bytes32", value: packed.gasFees },
      { kind: "bytes32", value: keccak256(packed.paymasterAndData) },
    ]),
  );
}

/**
 * EntryPoint v0.7 final hash: `keccak256(abi.encode(userOp.hash(),
 * entryPoint, chainId))` (v0.7.0 EntryPoint.sol:363-368) over the v0.7
 * struct hash above.
 */
function hashUserOpV07(packed, entryPoint, chainId) {
  return keccak256(
    abiEncode([
      { kind: "bytes32", value: hashPackedUserOperationV07(packed) },
      { kind: "address", value: entryPoint },
      { kind: "bytes32", value: word32(chainId) },
    ]),
  );
}

function getUserOpHashCalldata(packed) {
  return abiEncodeCall(
    "getUserOpHash((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))",
    [
      {
        kind: "tuple",
        fields: [
          { kind: "address", value: packed.sender },
          { kind: "uint", value: BigInt(packed.nonce) },
          { kind: "bytes", value: packed.initCode },
          { kind: "bytes", value: packed.callData },
          { kind: "bytes32", value: packed.accountGasLimits },
          { kind: "uint", value: BigInt(packed.preVerificationGas) },
          { kind: "bytes32", value: packed.gasFees },
          { kind: "bytes", value: packed.paymasterAndData },
          { kind: "bytes", value: packed.signature },
        ],
      },
    ],
  );
}

/** Hash port with a LIVE byte-equality check against the real EntryPoint. */
async function checkedHash(hashFn, packed, entryPoint, chainId) {
  const local = hashFn(packed, entryPoint, chainId);
  const onchain = await ethCall(entryPoint, getUserOpHashCalldata(packed));
  if (onchain.toLowerCase() !== local.toLowerCase()) {
    throw new Error(
      `hash mismatch: local ${local} != on-chain EntryPoint.getUserOpHash ` +
        `${onchain} — refusing to sign the wrong bytes`,
    );
  }
  out(`      hash check ✓ local == EntryPoint.getUserOpHash(${local})`);
  return local;
}

// ------------------------------------------------------ deployed stack ----
// (all addresses live-probed on Sepolia 2026-09-24; sources in the header)

const KERNEL_FACTORY_0_3_3 = "0x2577507b78c2008Ff367261CB6285d44ba5eF2E9";
const WEB_AUTHN_VALIDATOR = "0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69";
const AA_KERNEL_FACTORY_RELEASE = // releases/v0.4.0.json expected address
  "0xa299a4efee7bbfb2ea5668b30218c45fff78356c";
const ZERO_WORD = `0x${"00".repeat(32)}`;
const SALT = ZERO_WORD;

function wordU160LeftPadded(value) {
  // bytes21 rootValidator = VALIDATION_TYPE_VALIDATOR (0x01) ‖ validator,
  // right-padded to its ABI word (static bytesN encoding).
  return `0x01${value.slice(2).toLowerCase()}${"00".repeat(11)}`;
}

/**
 * `initialize(bytes21,address,bytes,bytes,bytes[])` (v3.3 Kernel.sol:105) —
 * hand-encoded because the in-repo ABI encoder predates bytes21/bytes[]:
 * 5 head words (id, hook, offsets…) + dynamic tails; offsets computed, not
 * hard-coded. Eaten by the live bundler simulation and the on-chain deploy,
 * so a wrong layout fails loudly.
 */
function encodeKernelInitialize({ rootValidator, validatorData }) {
  const tail1Len = (validatorData.length - 2) / 2;
  const tail1 =
    word32(tail1Len).slice(2) +
    validatorData.slice(2).padEnd(Math.ceil(tail1Len / 32) * 64, "0");
  const tail2 = word32(0).slice(2); // hookData = 0x
  const tail3 = word32(0).slice(2); // initConfig = []
  const headSize = 5 * 32;
  const off1 = headSize;
  const off2 = off1 + tail1.length / 2;
  const off3 = off2 + tail2.length / 2;
  return (
    functionSelector("initialize(bytes21,address,bytes,bytes,bytes[])") +
    [
      wordU160LeftPadded(rootValidator).slice(2),
      `0x${"00".repeat(32)}`.slice(2), // hook = HOOK_MODULE_NOT_INSTALLED
      word32(off1).slice(2),
      word32(off2).slice(2),
      word32(off3).slice(2),
      tail1,
      tail2,
      tail3,
    ].join("")
  );
}

/** `webAuthnValidatorModuleData` byte-equivalent (aa-kernel.ts). */
function validatorEnableData(x, y) {
  return abiEncode([
    {
      kind: "tuple",
      fields: [
        { kind: "uint", value: x },
        { kind: "uint", value: y },
      ],
    },
    { kind: "bytes32", value: ZERO_WORD },
  ]);
}

async function main() {
  out("ZeroDev live smoke — Sepolia (wave 4c)");
  out(
    `  project  …${(ZERODEV_PROJECT_ID ?? "").slice(-4)}   api key ${mask(
      ZERODEV_API_KEY,
    )}   chain rpc host ${new URL(CHAIN_RPC_URL).host}`,
  );

  // ------------------------------------------------ STEP A: aa-kernel ----
  step("A", "aa-kernel path (wave-4b core) — factory deployment probe");
  const aaFactory = env.ZERODEV_KERNEL_FACTORY ?? AA_KERNEL_FACTORY_RELEASE;
  const aaFactoryCode = await getCode(aaFactory);
  if (aaFactoryCode === undefined || aaFactoryCode === "0x") {
    out(`      KernelFactory ${aaFactory} has NO code on Sepolia.`);
    out("      BLOCKER (exact): the vendored-master KernelFactory ABI");
    out("        deploy((uint256,address,bytes,bytes)[],uint256)");
    out("      is not deployed — releases/v0.4.0.json expected CREATE2");
    out("      addresses are all empty on Sepolia (live eth_getCode).");
    out("      Remediation (either unblocks `--aa-kernel` runs):");
    out("        1. deploy contracts/lib/zerodev-kernel/releases/v0.4.0.json");
    out("           via the deterministic deployer 0x4e59b44847b379578588920c");
    out("           A78FbF26c0B4956C (its init_code/salt produce the manifest's");
    out("           expected addresses), or");
    out("        2. set ZERODEV_KERNEL_FACTORY=<deployed factory> in .env.");
    out("      NOTE: the v0.4.0 manifest's constructor args wire EntryPoint");
    out("      v0.9 (0x43370900…); wave 4b's hash core is EntryPoint v0.8.0");
    out("      (0x4337084D…). Wire the factory to v0.8 or expect a hash");
    out("      adaptation. Deploying for v0.8 keeps this exact path.");
    out("      Continuing with STEP B (deployed official stack) to prove the");
    out("      hosted paymaster + bundler integration live.");
  } else {
    out(`      factory ${aaFactory} has code — would run the aa-kernel flow`);
    out("      (buildKernelInitCode + EntryPoint v0.8.0 hash).");
  }

  // -------------------------------------- STEP B: deployed stack flow ----
  step("B", "deployed official stack — sponsored deploy + self-call");
  out(`      factory   ${KERNEL_FACTORY_0_3_3}   (kernel 0.3.3)`);
  out(`      validator ${WEB_AUTHN_VALIDATOR}   (V0_0_3_PATCHED)`);
  out(`      entryPoint ${ENTRY_POINT_V0_7}   (v0.7 — impl entrypoint())`);

  const initData = encodeKernelInitialize({
    rootValidator: WEB_AUTHN_VALIDATOR,
    validatorData: validatorEnableData(fixturePub.x, fixturePub.y),
  });
  // `data` for the factory is the FULL initialize calldata (selector + args)
  // — the factory forwards it with `account.call(data)` (v3.3
  // KernelFactory.createAccount).
  const createAccountData = abiEncodeCall("createAccount(bytes,bytes32)", [
    { kind: "bytes", value: initData },
    { kind: "bytes32", value: SALT },
  ]);
  const getAddressData = abiEncodeCall("getAddress(bytes,bytes32)", [
    { kind: "bytes", value: initData },
    { kind: "bytes32", value: SALT },
  ]);
  const sender = decodeAddressWord(
    await ethCall(KERNEL_FACTORY_0_3_3, getAddressData),
  );
  out(`      counterfactual sender ${sender}`);

  const senderCode = await getCode(sender);
  const alreadyDeployed = senderCode !== undefined && senderCode !== "0x";
  if (alreadyDeployed) {
    out("      sender already deployed — NOT redeploying (idempotent run);");
    out("      sending the self-call only.");
  }
  const nonceCall = await ethCall(ENTRY_POINT_V0_7, abiEncodeCall("getNonce(address,uint192)", [
    { kind: "address", value: sender },
    { kind: "uint", value: 0n },
  ]));
  const nonce = word32(BigInt(nonceCall));
  out(`      nonce ${nonce}`);

  const block = await chainRpc("eth_getBlockByNumber", ["latest", false]);
  const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
  const fees = {
    maxFeePerGas: word32(baseFee * 3n + 2n * 10n ** 9n),
    maxPriorityFeePerGas: word32(10n ** 9n),
  };
  out(`      fees maxFee ${fees.maxFeePerGas} priority ${fees.maxPriorityFeePerGas}`);

  const callData = buildKernelSelfCallData(sender);
  const initCode = alreadyDeployed
    ? "0x"
    : `${KERNEL_FACTORY_0_3_3}${createAccountData.slice(2)}`;

  const config = {
    projectId: ZERODEV_PROJECT_ID,
    apiKey: ZERODEV_API_KEY,
    chainId: CHAIN_ID,
  };
  const request = {
    config,
    entryPointAddress: ENTRY_POINT_V0_7,
    sender,
    nonce,
    initCode,
    callData,
    fees,
    dummySignature: OFFICIAL_STUB_SIGNATURE,
    signUserOpHash: signAssertionOverHash,
    hashUserOp: (packed, entryPoint, chainId) =>
      checkedHash(hashUserOpV07, packed, entryPoint, chainId),
    receipt: { pollIntervalMs: 2000, maxPolls: 90 },
  };

  let result;
  try {
    result = await sendSponsoredUserOp(request);
  } catch (error) {
    if (error instanceof PaymasterDeniedError) {
      printSponsorshipDenied(error);
      return;
    }
    throw error;
  }

  // ------------------------------------------------------- summary ------
  // `eth_getUserOperationReceipt` nests the standard transaction receipt
  // under `receipt` (ERC-4337 bundler RPC spec; live-verified 2026-09-24).
  step("C", "summary");
  out(`      op hash     ${result.opHash}`);
  out(`      tx hash     ${result.receipt.receipt.transactionHash}`);
  out(
    `      block       ${BigInt(result.receipt.receipt.blockNumber)} ` +
      `(tx status ${result.receipt.receipt.status}, userOp success ${result.receipt.success})`,
  );
  out(`      sender      ${sender}${alreadyDeployed ? " (pre-deployed)" : " (deployed this run)"}`);
  out(`      gas used    ${BigInt(result.receipt.actualGasUsed).toString()} (sponsored)`);
  out(`      gas cost    ${BigInt(result.receipt.actualGasCost).toString()} wei (paid by paymaster)`);
  out(`      paymaster   ${result.sponsorship.paymaster}`);
  out(
    `      pm limits   pv ${result.sponsorship.paymasterVerificationGasLimit ?? "-"} post ${
      result.sponsorship.paymasterPostOpGasLimit ?? "-"
    }`,
  );
  out(`      api key     ${mask(ZERODEV_API_KEY)}`);
  out("\nSMOKE OK — passkey → Kernel → sponsored UserOperation landed on Sepolia.");
}

function printSponsorshipDenied(error) {
  out("\nSPONSORSHIP DENIED BY DASHBOARD POLICY");
  out(`  server: ${error.serverMessage}`);
  out(`  action: ${error.dashboardAction}`);
  out("\nThe integration path (build → sponsor → sign → submit) is proven up");
  out("to the policy gate; enable the policy and re-run.");
}

// Import guard so tooling can import the helpers without running the flow.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof PaymasterDeniedError) {
      printSponsorshipDenied(error);
      process.exit(0);
    }
    console.error(`\nSMOKE FAILED: ${error.stack ?? error.message}`);
    process.exit(1);
  });
}
