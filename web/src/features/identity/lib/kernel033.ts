/**
 * Kernel 0.3.3 account module — the product's account generation (DECIDED
 * 2026-09-24): the deployed ZeroDev kernel-0.3.3 stack is THE account path;
 * the v0.8 core (`userop.ts` EIP-712 hash, `aa-kernel.ts` vendored-master
 * initcode) stays as the documented upgrade path and is NOT deleted.
 *
 * Everything here is extracted from the live-proven smoke
 * (`scripts/zerodev-smoke.mjs`, wave 4c) — every address, wire shape, and
 * convention below cites its source; nothing is invented (anti-hallucination
 * rule). Address citations (all live-probed on Sepolia 2026-09-24):
 *
 * - EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` —
 *   live `eth_supportedEntryPoints` through ZeroDev's hosted RPC AND the
 *   Kernel impl's live `entrypoint()` return (this generation is wired to
 *   v0.7; see the smoke header).
 * - Kernel factory 0.3.3 `0x2577507b78c2008Ff367261CB6285d44ba5eF2E9`
 *   (`createAccount(bytes,bytes32)` / `getAddress(bytes,bytes32)` —
 *   selectors 0xea6d13ac / 0x48aac392 present in its live dispatch
 *   bytecode) — @zerodev/sdk@5.5.10 `constants.ts`
 *   KernelVersionToAddressesMap["0.3.3"].factoryAddress.
 * - Kernel impl 0.3.3 `0xd6CEDDe84be40893d153Be9d467CD6aD37875b28` —
 *   ["0.3.3"].accountImplementationAddress.
 * - WebAuthnValidator `0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69`
 *   (PasskeyValidatorContractVersion.V0_0_3_PATCHED =
 *   `@zerodev/passkey-validator` kernelVersionRangeToContractVersionTo-
 *   Validator["0.3.0 || 0.3.1 || 0.3.2 || 0.3.3"]["0.0.3"]; code on Sepolia).
 *   Its signature tuple + `onInstall` data decode byte-compatibly with the
 *   vendored kernel-7579-plugins master `webauthn-auth.ts` was proven against.
 *
 * Conventions extracted (citations in the smoke header and at each site):
 * - Account init: `initialize(bytes21 rootValidator, address hook, bytes
 *   validatorData, bytes hookData, bytes[] initConfig)` (v3.3
 *   `src/Kernel.sol:105`), rootValidator = bytes21(0x01 ‖ validator)
 *   (VALIDATION_TYPE_VALIDATOR = 0x01, v3.3 `src/types/Constants.sol`),
 *   hook = HOOK_MODULE_NOT_INSTALLED = address(0), validatorData =
 *   `webAuthnValidatorModuleData(x, y)` (byte-identical to
 *   `@zerodev/passkey-validator` `getEnableData()` with
 *   authenticatorIdHash = 0).
 * - Hash: EntryPoint v0.7 `getUserOpHash = keccak256(abi.encode(userOp.hash(),
 *   address(this), block.chainid))`
 *   (https://raw.githubusercontent.com/eth-infinitism/account-abstraction/
 *   v0.7.0/contracts/core/EntryPoint.sol lines 363-368) where `userOp.hash()`
 *   is `keccak256(UserOperationLib.encode(userOp))` — the PLAIN 8-word
 *   `abi.encode(...)` of v0.7.0 `UserOperationLib.sol`
 *   (https://raw.githubusercontent.com/eth-infinitism/account-abstraction/
 *   v0.7.0/contracts/core/UserOperationLib.sol, `encode`/`hash`) — NO
 *   `PACKED_USEROP_TYPEHASH` prefix (that word belongs to the v0.8 EIP-712
 *   struct hash in `userop.ts` — NOT interchangeable; live-proven 2026-09-24
 *   against the real Sepolia EntryPoint, only the 8-word form byte-matches
 *   `getUserOpHash`). The computed hash is CHECKED AGAINST THE LIVE
 *   EntryPoint (`assertHashMatchesEntryPoint`, called by default in the send
 *   flow BEFORE any signing) — a mismatch aborts rather than sign wrong bytes.
 * - Signature: real passkey assertion over the op hash (`getPasskeyAssertion`
 *   with `challenge = opHash` bytes, `prfSalt` omitted) → strict DER → low-s
 *   `r‖s` (`derToRs`) → the V0_0_3_PATCHED 6-field tuple
 *   `encodeZeroDevWebAuthnSignature` (`webauthn-auth.ts`; vendored
 *   kernel-7579-plugins `src/validators/WebAuthnValidator.sol`
 *   `_verifySignature` tuple with fixed CHALLENGE_LOCATION = 23).
 *   Gas-estimation stub = the exact `getStubSignature()` tuple shipped by
 *   `@zerodev/passkey-validator` `toPasskeyValidator.ts` lines 262-280
 *   (`OFFICIAL_STUB_SIGNATURE`) — validator-version-specific; the wave-4b
 *   `type(uint256).max` convention belongs to the vendored-master validator
 *   and is NOT used here.
 *
 * The send flow is sponsor-first (server-side gas estimation via
 * `zd_sponsorUserOperation`) → hash-guard → real-passkey sign →
 * `eth_sendUserOperation` → bounded `eth_getUserOperationReceipt` polling
 * (`zerodev.ts` `sendSponsoredUserOp`). Idempotent: when the counterfactual
 * sender already has code, initCode is omitted (no redeploy) — the smoke's
 * proven behavior.
 *
 * NO FIXTURE KEYS in the app path: signing goes through the platform
 * WebAuthn ceremony (Touch ID). The injectable `getAssertion` seam exists
 * only because node (tests / the live-check script) has no
 * `navigator.credentials`; it injects the CEREMONY, never a key.
 */
import type { UserOperationReceipt } from "./aa.ts";
import { createBundlerTransport } from "./aa.ts";
import type { BundlerTransport } from "./aa.ts";
import { getPasskeyAssertion } from "./passkey.ts";
import type { PasskeyAssertion } from "./passkey.ts";
import type { PackedUserOperation } from "./userop.ts";
import { keccak256 } from "./userop.ts";
import {
  abiEncode,
  abiEncodeCall,
  bytesToHex,
  decodeAddressWord,
  functionSelector,
  hexToBytes,
} from "./userop-abi.ts";
import {
  buildKernelSelfCallData,
  webAuthnValidatorModuleData,
} from "./aa-kernel.ts";
import {
  wrapPasskeyAssertionForZeroDevValidator,
  encodeZeroDevWebAuthnSignature,
} from "./webauthn-auth.ts";
import type { SponsorshipResult, ZerodevConfig } from "./zerodev.ts";
import {
  ENTRY_POINT_V0_7,
  sendSponsoredUserOp,
  toRpcUserOperation,
  zerodevConfigFromEnv,
  zerodevRpcUrl,
} from "./zerodev.ts";

// ------------------------------------------------------- deployed stack ----

/** Kernel factory 0.3.3 (["0.3.3"].factoryAddress; live dispatch selectors). */
export const KERNEL_FACTORY_0_3_3 =
  "0x2577507b78c2008ff367261cb6285d44ba5ef2e9";

/** Kernel account implementation 0.3.3 (["0.3.3"].accountImplementationAddress). */
export const KERNEL_IMPL_0_3_3 = "0xd6cedde84be40893d153be9d467cd6ad37875b28";

/** WebAuthnValidator V0_0_3_PATCHED (the deployed passkey validator). */
export const WEB_AUTHN_VALIDATOR_V0_0_3_PATCHED =
  "0x7ab16ff354acb328452f1d445b3ddee9a91e9e69";

/** Zero salt — the factory's deterministic CREATE2 salt used by the smoke. */
export const KERNEL_0_3_3_ZERO_SALT = `0x${"00".repeat(32)}`;

/**
 * Gas-estimation stub for the deployed V0_0_3_PATCHED validator — the exact
 * `getStubSignature()` tuple shipped by `@zerodev/passkey-validator`
 * (`toPasskeyValidator.ts` lines 262-280, via the smoke's
 * `OFFICIAL_STUB_SIGNATURE`).
 */
export const OFFICIAL_STUB_SIGNATURE = encodeZeroDevWebAuthnSignature({
  authenticatorData:
    "0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d00000000",
  clientDataJSON:
    '{"type":"webauthn.get","challenge":"tbxXNFS9X_4Byr1cMwqKrIGB-_30a0QhZ6y7ucM0BOE","origin":"http://localhost:3000","crossOrigin":false, "other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"}',
  responseTypeLocation: 1n,
  r: 44941127272049826721201904734628716258498742255959991581049806490182030242267n,
  s: 9910254599581058084911561569808925251374718953855182016200087235935345969636n,
  usePrecompiled: false,
});

/** Function signatures (cast-verified 1.4.3; selectors in the smoke header). */
export const KERNEL_CREATE_ACCOUNT_SIGNATURE = "createAccount(bytes,bytes32)";
export const KERNEL_GET_ADDRESS_SIGNATURE_0_3_3 = "getAddress(bytes,bytes32)";
export const KERNEL_INITIALIZE_SIGNATURE =
  "initialize(bytes21,address,bytes,bytes,bytes[])";
export const ENTRY_POINT_GET_USER_OP_HASH_SIGNATURE =
  "getUserOpHash((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))";
export const ENTRY_POINT_GET_NONCE_SIGNATURE = "getNonce(address,uint192)";

// ------------------------------------------------------------- errors ------

/** Build-time / runtime configuration is missing or inconsistent. */
export class Kernel033ConfigError extends Error {
  constructor(message: string) {
    super(`kernel033: ${message}`);
    this.name = "Kernel033ConfigError";
  }
}

/**
 * The locally computed userOpHash does not byte-match the live EntryPoint's
 * `getUserOpHash` — the send flow refuses to sign in this state (the guard
 * that earned its keep twice in the smoke).
 */
export class Kernel033HashMismatchError extends Error {
  readonly localHash: string;
  readonly onChainHash: string;

  constructor(localHash: string, onChainHash: string) {
    super(
      `kernel033: hash mismatch: local ${localHash} != on-chain ` +
        `EntryPoint.getUserOpHash ${onChainHash} — refusing to sign the wrong bytes`,
    );
    this.name = "Kernel033HashMismatchError";
    this.localHash = localHash;
    this.onChainHash = onChainHash;
  }
}

/** Bounded chain JSON-RPC failure (raw server text preserved — Rule 1). */
export class Kernel033ChainRpcError extends Error {
  readonly method: string;
  readonly serverMessage: string;

  constructor(method: string, serverMessage: string) {
    super(`kernel033: chain RPC ${method} failed: ${serverMessage}`);
    this.name = "Kernel033ChainRpcError";
    this.method = method;
    this.serverMessage = serverMessage;
  }
}

// -------------------------------------------------------------- types ------

/** Passkey P-256 public key coordinates (the validator's enable data). */
export interface Kernel033AccountParams {
  pubKeyX: bigint;
  pubKeyY: bigint;
  /** Root validator address. Default `WEB_AUTHN_VALIDATOR_V0_0_3_PATCHED`. */
  validationId?: string | undefined;
  /** Kernel factory. Default `KERNEL_FACTORY_0_3_3`. */
  factory?: string | undefined;
  /** CREATE2 salt (bytes32). Default `KERNEL_0_3_3_ZERO_SALT`. */
  salt?: string | undefined;
}

/**
 * The bounded chain-RPC seam (`eth_call` / `eth_getCode` / base fee) — the
 * same trio the smoke drives over the chain RPC (NOT the ZeroDev RPC, which
 * is bundler+paymaster only).
 */
export interface Kernel033ChainRpc {
  ethCall(tx: { to: string; data: string }): Promise<string>;
  getCode(address: string): Promise<string>;
  /** `eth_getBlockByNumber("latest")` → `baseFeePerGas` (0n when absent). */
  latestBaseFeePerGas(): Promise<bigint>;
}

/**
 * WebAuthn ceremony seam: same shape as `getPasskeyAssertion`. Defaults to
 * the REAL passkey (Touch ID); injectable only because node has no
 * `navigator.credentials` (tests / live check) — the seam supplies a real
 * assertion ceremony, never a fixture key on the app path.
 */
export type PasskeyAssertionSource = (options: {
  credentialId: string;
  challenge: Uint8Array;
  rpId?: string | undefined;
}) => Promise<PasskeyAssertion>;

/** Progress phases surfaced to the UI (honest states; Rule 6/7). */
export type Kernel033SendPhase =
  | "preparing"
  | "sponsoring"
  | "signing"
  | "submitting"
  | "confirming";

export interface Kernel033SendRequest {
  /** base64url credential id of the passkey that owns the account. */
  credentialId: string;
  pubKeyX: bigint;
  pubKeyY: bigint;
  /** ZeroDev project config (sponsor + bundler). */
  config: ZerodevConfig;
  /** Chain RPC for sender/nonce/hash-guard reads. */
  rpc: Kernel033ChainRpc;
  /** Root validator / factory / salt overrides (see `Kernel033AccountParams`). */
  validationId?: string | undefined;
  factory?: string | undefined;
  salt?: string | undefined;
  /** callData to send; defaults to a harmless Kernel self-call. */
  callData?: string | undefined;
  /** Fee ceiling to sign for; defaults to latest baseFee × 3 + 2 gwei. */
  fees?: { maxFeePerGas: string; maxPriorityFeePerGas: string } | undefined;
  /** rpId for the assertion ceremony (defaults to the origin's). */
  rpId?: string | undefined;
  /** Receipt polling bounds (Rule 4). Defaults: 2000 ms × 90 polls. */
  receipt?: { pollIntervalMs?: number; maxPolls?: number } | undefined;
  /** UI phase callback (sponsor pending / Touch ID / submitted / receipt). */
  onPhase?: ((phase: Kernel033SendPhase) => void) | undefined;
  /** Ceremony seam (node tests / live check only — see `PasskeyAssertionSource`). */
  getAssertion?: PasskeyAssertionSource | undefined;
  /** Injection seam for tests (mirrors `SponsoredUserOpRequest.transport`). */
  transport?: BundlerTransport | undefined;
}

export interface Kernel033SendResult {
  txHash: string;
  blockNumber: string;
  userOpHash: string;
  sender: string;
  gasUsed: string;
  paymaster: string;
  /** True when this op deployed the account (initCode path). */
  deployed: boolean;
  /** Bundler-reported userOp success (provider extra on the receipt). */
  success: boolean;
  sponsorship: SponsorshipResult;
  receipt: UserOperationReceipt;
}

// ------------------------------------------------------------ helpers ------

function fail(message: string): never {
  throw new Error(`kernel033: ${message}`);
}

function requireAddress(value: string, what: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    fail(`${what} must be a 20-byte address, got ${value}`);
  }
  return value;
}

function requireBytes32(value: string, what: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail(`${what} must be a 32-byte bytes32, got ${value}`);
  }
  return value;
}

function word32(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/**
 * Parse the 65-byte uncompressed secp256r1 key (`0x04‖x‖y`) into the
 * validator's `{ pubKeyX, pubKeyY }`. Accepts both hex forms: `passkey
 * -identity.ts` persists `evmOwnerFromR1`'s `r1UncompressedHex` (noble
 * `bytesToHex` — BARE hex, no `0x`) at `buzz.passkey.r1`.
 */
export function parseR1PublicKey(r1UncompressedHex: string): {
  pubKeyX: bigint;
  pubKeyY: bigint;
} {
  const normalized = r1UncompressedHex.startsWith("0x")
    ? r1UncompressedHex
    : `0x${r1UncompressedHex}`;
  const bytes = hexToBytes(normalized);
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    fail(
      `r1 public key must be a 65-byte uncompressed secp256r1 key (0x04‖x‖y), got ${bytes.length} bytes`,
    );
  }
  return {
    pubKeyX: BigInt(bytesToHex(bytes.slice(1, 33))),
    pubKeyY: BigInt(bytesToHex(bytes.slice(33, 65))),
  };
}

// -------------------------------------------------- account init encoding ---
// Extracted from the smoke's cast-verified encoder (the in-repo ABI encoder
// predates bytes21/bytes[]). Golden-tested against `cast calldata` in
// `kernel033.test.mjs` — a wrong layout fails loudly (it is eaten by the live
// bundler simulation and the on-chain deploy).

/** bytes21 rootValidator = 0x01 ‖ validator, right-padded to its ABI word. */
function rootValidatorWord(validationId: string): string {
  return `0x01${validationId.slice(2).toLowerCase()}${"00".repeat(11)}`;
}

/**
 * `initialize(bytes21,address,bytes,bytes,bytes[])` calldata (v3.3
 * Kernel.sol:105): 5 head words + dynamic tails; offsets computed, not
 * hard-coded. hook = HOOK_MODULE_NOT_INSTALLED = address(0), hookData = 0x,
 * initConfig = [].
 */
export function encodeKernel033Initialize(params: {
  pubKeyX: bigint;
  pubKeyY: bigint;
  validationId?: string | undefined;
}): string {
  const validationId = requireAddress(
    params.validationId ?? WEB_AUTHN_VALIDATOR_V0_0_3_PATCHED,
    "validationId",
  );
  const validatorData = webAuthnValidatorModuleData(
    params.pubKeyX,
    params.pubKeyY,
  );
  const tail1Len = (validatorData.length - 2) / 2;
  const tail1 =
    word32(BigInt(tail1Len)).slice(2) +
    validatorData.slice(2).padEnd(Math.ceil(tail1Len / 32) * 64, "0");
  const tail2 = word32(0n).slice(2); // hookData = 0x
  const tail3 = word32(0n).slice(2); // initConfig = []
  const headSize = 5 * 32;
  const off1 = headSize;
  const off2 = off1 + tail1.length / 2;
  const off3 = off2 + tail2.length / 2;
  return (
    functionSelector(KERNEL_INITIALIZE_SIGNATURE) +
    [
      rootValidatorWord(validationId).slice(2),
      word32(0n).slice(2), // hook = HOOK_MODULE_NOT_INSTALLED
      word32(BigInt(off1)).slice(2),
      word32(BigInt(off2)).slice(2),
      word32(BigInt(off3)).slice(2),
      tail1,
      tail2,
      tail3,
    ].join("")
  );
}

function kernel033AccountData(params: Kernel033AccountParams): {
  factory: string;
  salt: string;
  initData: string;
  createAccountData: string;
  getAddressData: string;
} {
  const factory = requireAddress(
    params.factory ?? KERNEL_FACTORY_0_3_3,
    "factory",
  );
  const salt = requireBytes32(params.salt ?? KERNEL_0_3_3_ZERO_SALT, "salt");
  const initData = encodeKernel033Initialize(params);
  // The factory forwards `data` with `account.call(data)` (v3.3
  // KernelFactory.createAccount) — so `data` is the FULL initialize calldata.
  return {
    factory,
    salt,
    initData,
    createAccountData: abiEncodeCall(KERNEL_CREATE_ACCOUNT_SIGNATURE, [
      { kind: "bytes", value: initData },
      { kind: "bytes32", value: salt },
    ]),
    getAddressData: abiEncodeCall(KERNEL_GET_ADDRESS_SIGNATURE_0_3_3, [
      { kind: "bytes", value: initData },
      { kind: "bytes32", value: salt },
    ]),
  };
}

/**
 * Counterfactual initCode: the 20-byte factory address followed by the
 * `createAccount(bytes,bytes32)` call — the exact prefix/args `SenderCreator`
 * executes to create the account (the smoke's cast-verified encoder).
 */
export function buildKernel033InitCode(params: Kernel033AccountParams): string {
  const { factory, createAccountData } = kernel033AccountData(params);
  return `${factory}${createAccountData.slice(2)}`.toLowerCase();
}

/**
 * Counterfactual account address via the factory's `getAddress(bytes,bytes32)`
 * `eth_call` (bounded by the injected `rpc`) — the smoke's deterministic
 * sender derivation.
 */
export async function getKernel033Sender(
  params: Kernel033AccountParams & { rpc: Pick<Kernel033ChainRpc, "ethCall"> },
): Promise<string> {
  const { factory, getAddressData } = kernel033AccountData(params);
  return decodeAddressWord(
    await params.rpc.ethCall({ to: factory, data: getAddressData }),
  );
}

// --------------------------------------------------- v0.7 hash (8-word) -----

/**
 * EntryPoint v0.7 `UserOperationLib.hash` — `keccak256(encode(userOp))` where
 * `encode` (v0.7.0 `UserOperationLib.sol`) is the PLAIN 8-word
 * `abi.encode(sender, nonce, keccak(initCode), keccak(callData),
 * accountGasLimits, preVerificationGas, gasFees, keccak(paymasterAndData))` —
 * NO `PACKED_USEROP_TYPEHASH` prefix.
 * (https://raw.githubusercontent.com/eth-infinitism/account-abstraction/
 * v0.7.0/contracts/core/UserOperationLib.sol, `encode`/`hash`.)
 *
 * The typehash-prefixed variant is the EntryPoint v0.8 EIP-712 struct hash
 * (`hashPackedUserOperation` in userop.ts) and does NOT belong in the v0.7
 * hash chain — live-proven 2026-09-24 against the real Sepolia EntryPoint.
 */
export function hashPackedUserOperationV07(packed: {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  accountGasLimits: string;
  preVerificationGas: string;
  gasFees: string;
  paymasterAndData: string;
}): string {
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
 * struct hash above. `chainId` is encoded as a full word (uint256 in the
 * Solidity source — identical bytes).
 */
export function hashUserOpV07(
  op: PackedUserOperation,
  entryPoint: string,
  chainId: bigint,
): string {
  return keccak256(
    abiEncode([
      { kind: "bytes32", value: hashPackedUserOperationV07(op) },
      { kind: "address", value: entryPoint },
      { kind: "bytes32", value: word32(chainId) },
    ]),
  );
}

/** `getUserOpHash(...)` call data (the live byte-equality probe's calldata). */
export function userOpHashCalldataV07(packed: PackedUserOperation): string {
  return abiEncodeCall(ENTRY_POINT_GET_USER_OP_HASH_SIGNATURE, [
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
  ]);
}

/**
 * The LIVE byte-equality guard: compute the v0.7 hash locally, `eth_call` the
 * real EntryPoint's `getUserOpHash`, and refuse (`Kernel033HashMismatchError`)
 * unless they match byte-for-byte. Returns the verified hash. This runs by
 * default in the send flow BEFORE any signing — never sign the wrong bytes.
 */
export async function assertHashMatchesEntryPoint(
  packed: PackedUserOperation,
  options: {
    entryPoint?: string | undefined;
    chainId: bigint;
    rpc: Pick<Kernel033ChainRpc, "ethCall">;
  },
): Promise<string> {
  const entryPoint = options.entryPoint ?? ENTRY_POINT_V0_7;
  const local = hashUserOpV07(packed, entryPoint, options.chainId);
  const onChain = await options.rpc.ethCall({
    to: entryPoint,
    data: userOpHashCalldataV07(packed),
  });
  if (onChain.toLowerCase() !== local.toLowerCase()) {
    throw new Kernel033HashMismatchError(local, onChain);
  }
  return local;
}

// ------------------------------------------------------- passkey signing ----

/**
 * REAL passkey signing seam: prompt `getPasskeyAssertion` with the OP HASH
 * BYTES as the WebAuthn challenge (`prfSalt` omitted — no PRF needed), then
 * wrap the assertion as the V0_0_3_PATCHED 6-field tuple (strict DER → low-s
 * `r‖s`, fixed CHALLENGE_LOCATION = 23 — see `webauthn-auth.ts` and the
 * vendored validator citation in this header). Returns the `signature` bytes
 * for the UserOperation.
 */
export async function signKernel033UserOp(options: {
  credentialId: string;
  /** 0x-hex 32-byte userOpHash — the exact bytes the assertion must cover. */
  opHash: string;
  rpId?: string | undefined;
  /** `usePrecompiled` flag of the validator tuple. Default false (smoke). */
  usePrecompiled?: boolean | undefined;
  /** Ceremony seam (node tests / live check only). Default: real Touch ID. */
  getAssertion?: PasskeyAssertionSource | undefined;
}): Promise<string> {
  requireBytes32(options.opHash, "opHash");
  const getAssertion = options.getAssertion ?? getPasskeyAssertion;
  const assertion = await getAssertion({
    credentialId: options.credentialId,
    challenge: hexToBytes(options.opHash),
    rpId: options.rpId,
  });
  const wrapped = wrapPasskeyAssertionForZeroDevValidator(assertion, {
    challengeHex: options.opHash,
    usePrecompiled: options.usePrecompiled ?? false,
  });
  return wrapped.encoded;
}

// ------------------------------------------------------------ chain RPC -----

/**
 * Chain RPC URL: `VITE_CHAIN_RPC_URL`, falling back to the public Sepolia
 * endpoint the smoke ran against (`SEPOLIA_RPC_URL` default) only when the
 * configured chain IS Sepolia. Any other chain without an explicit URL is a
 * configuration error (never silently point at the wrong chain).
 */
export function kernel033ChainRpcUrl(chainId?: number): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const url = env?.VITE_CHAIN_RPC_URL;
  if (url !== undefined && url !== "") {
    return url;
  }
  const effective = chainId ?? zerodevConfigFromEnv().chainId;
  if (effective === 11155111) {
    return "https://ethereum-sepolia-rpc.publicnode.com";
  }
  throw new Kernel033ConfigError(
    "no chain RPC URL — set VITE_CHAIN_RPC_URL (the ZeroDev RPC is " +
      "bundler+paymaster only); the built-in fallback covers Sepolia only",
  );
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Bounded chain JSON-RPC client (Rule 4): per-attempt timeout, bounded
 * retries with backoff for 429/5xx/network blips, terminal typed errors that
 * preserve the raw server text (Rule 1).
 */
export function createKernel033ChainRpc(options: {
  url: string;
  timeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
  backoffMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Kernel033ChainRpc {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffMs = Math.max(0, options.backoffMs ?? DEFAULT_BACKOFF_MS);
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    let lastError = new Kernel033ChainRpcError(method, "no attempt made");
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetchImpl(options.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
        const text = await response.text();
        if (response.status === 429 || response.status >= 500) {
          lastError = new Kernel033ChainRpcError(
            method,
            `HTTP ${response.status}: ${text.slice(0, 2000)}`,
          );
        } else {
          let payload: {
            result?: T;
            error?: { message?: string };
          };
          try {
            payload = JSON.parse(text) as typeof payload;
          } catch {
            throw new Kernel033ChainRpcError(
              method,
              `unparseable HTTP ${response.status} body: ${text.slice(0, 2000)}`,
            );
          }
          if (payload.error !== undefined) {
            throw new Kernel033ChainRpcError(
              method,
              payload.error.message ?? JSON.stringify(payload.error),
            );
          }
          return payload.result as T;
        }
      } catch (error) {
        if (error instanceof Kernel033ChainRpcError) {
          if (!/HTTP (429|5\d\d)/.test(error.serverMessage)) {
            throw error;
          }
          lastError = error;
        } else {
          const message = (error as Error).message ?? String(error);
          if (!/abort|network|fetch|socket|ECONN|ETIMEDOUT/i.test(message)) {
            throw new Kernel033ChainRpcError(method, message);
          }
          lastError = new Kernel033ChainRpcError(method, message);
        }
      } finally {
        clearTimeout(timer);
      }
      if (attempt + 1 < maxAttempts) {
        await sleep(Math.min(MAX_BACKOFF_MS, backoffMs * 2 ** attempt));
      }
    }
    throw lastError;
  }

  return {
    ethCall: async (tx) =>
      request<string>("eth_call", [{ to: tx.to, data: tx.data }, "latest"]),
    getCode: async (address) =>
      request<string>("eth_getCode", [address, "latest"]),
    latestBaseFeePerGas: async () => {
      const block = await request<{ baseFeePerGas?: string } | null>(
        "eth_getBlockByNumber",
        ["latest", false],
      );
      return BigInt(block?.baseFeePerGas ?? "0x0");
    },
  };
}

// ----------------------------------------------------------- send flow ------

const GWEI = 10n ** 9n;

function nonceCalldata(sender: string): string {
  return abiEncodeCall(ENTRY_POINT_GET_NONCE_SIGNATURE, [
    { kind: "address", value: sender },
    { kind: "uint", value: 0n },
  ]);
}

/**
 * The product send flow (extracted from the smoke's proven STEP B):
 * derive sender → idempotent deploy detection → nonce → fees →
 * sponsor-first (`zd_sponsorUserOperation`, server-side gas) → LIVE
 * hash-guard (`assertHashMatchesEntryPoint`) → REAL passkey sign →
 * `eth_sendUserOperation` → bounded receipt poll. Nothing is signed before
 * the hash guard passes; every step is bounded (Rule 4) and every failure
 * surfaces typed (`PaymasterDeniedError` passes through with its
 * `dashboardAction`).
 */
export async function sendKernel033UserOp(
  request: Kernel033SendRequest,
): Promise<Kernel033SendResult> {
  const rawOnPhase = request.onPhase ?? (() => {});
  // Phase transitions only (the receipt poll re-fires "confirming").
  let lastPhase: Kernel033SendPhase | null = null;
  const onPhase = (phase: Kernel033SendPhase): void => {
    if (phase !== lastPhase) {
      lastPhase = phase;
      rawOnPhase(phase);
    }
  };
  onPhase("preparing");
  const config = request.config;
  const chainId = config.chainId ?? zerodevConfigFromEnv().chainId;
  if (chainId === undefined || !Number.isInteger(chainId) || chainId <= 0) {
    throw new Kernel033ConfigError(
      "chain id is not configured — set VITE_ZERODEV_CHAIN_ID or pass config.chainId",
    );
  }
  const params: Kernel033AccountParams = {
    pubKeyX: request.pubKeyX,
    pubKeyY: request.pubKeyY,
    validationId: request.validationId,
    factory: request.factory,
    salt: request.salt,
  };
  const sender = await getKernel033Sender({ ...params, rpc: request.rpc });
  // Idempotent sender detection (the smoke): an existing account gets NO
  // initCode — never redeploy over live state.
  const senderCode = await request.rpc.getCode(sender);
  const alreadyDeployed = senderCode !== undefined && senderCode !== "0x";
  const nonce = word32(
    BigInt(
      await request.rpc.ethCall({
        to: ENTRY_POINT_V0_7,
        data: nonceCalldata(sender),
      }),
    ),
  );
  const fees =
    request.fees ??
    (await (async () => {
      const baseFee = await request.rpc.latestBaseFeePerGas();
      return {
        maxFeePerGas: word32(baseFee * 3n + 2n * GWEI),
        maxPriorityFeePerGas: word32(GWEI),
      };
    })());
  const callData = request.callData ?? buildKernelSelfCallData(sender);
  const initCode = alreadyDeployed ? "0x" : buildKernel033InitCode(params);

  // Same default construction as `sendSponsoredUserOp` (ZeroDev unpacked
  // wire encoder — zerodev.ts ledger item 3), wrapped for phase-honest UI
  // states (submitted / receipt).
  const baseTransport =
    request.transport ??
    createBundlerTransport({
      url: zerodevRpcUrl(config),
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      backoffMs: config.backoffMs,
      fetchImpl: config.fetchImpl,
      userOpEncoder: toRpcUserOperation,
    });
  const transport: BundlerTransport = {
    url: baseTransport.url,
    estimateUserOperationGas:
      baseTransport.estimateUserOperationGas.bind(baseTransport),
    request: baseTransport.request.bind(baseTransport),
    sendUserOperation: (op, entryPoint) => {
      onPhase("submitting");
      return baseTransport.sendUserOperation(op, entryPoint);
    },
    getUserOperationReceipt: (hash) => {
      onPhase("confirming");
      return baseTransport.getUserOperationReceipt(hash);
    },
  };

  onPhase("sponsoring");
  const result = await sendSponsoredUserOp({
    config,
    entryPointAddress: ENTRY_POINT_V0_7,
    sender,
    nonce,
    initCode,
    callData,
    fees,
    dummySignature: OFFICIAL_STUB_SIGNATURE,
    // Hash guard FIRST (throws on mismatch — never sign wrong bytes) …
    hashUserOp: (packed, entryPoint, chain) =>
      assertHashMatchesEntryPoint(packed, {
        entryPoint,
        chainId: chain,
        rpc: request.rpc,
      }),
    // … then the REAL passkey ceremony.
    signUserOpHash: (opHash) => {
      onPhase("signing");
      return signKernel033UserOp({
        credentialId: request.credentialId,
        opHash,
        rpId: request.rpId,
        getAssertion: request.getAssertion,
      });
    },
    receipt: request.receipt,
    transport,
  });

  return {
    txHash: result.receipt.receipt.transactionHash,
    blockNumber: result.receipt.receipt.blockNumber,
    userOpHash: result.opHash,
    sender,
    gasUsed: result.receipt.actualGasUsed,
    paymaster: result.sponsorship.paymaster,
    deployed: !alreadyDeployed,
    success: result.receipt.success === true,
    sponsorship: result.sponsorship,
    receipt: result.receipt,
  };
}
