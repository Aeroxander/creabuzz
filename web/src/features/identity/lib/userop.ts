/**
 * ERC-4337 v0.8 PackedUserOperation: wire shape, packed-uint helpers, and the
 * userOpHash exactly as EntryPoint v0.8.0 computes it.
 *
 * Sources of truth (vendored locally for inspection; both trees agree):
 * - eth-infinitism/account-abstraction tag v0.8.0:
 *   - `contracts/interfaces/PackedUserOperation.sol` — the struct.
 *   - `contracts/core/UserOperationLib.sol` — `encode`/`hash` (the EIP-712
 *     struct hash) and `unpackUints` (128/128 packing of `accountGasLimits`
 *     and `gasFees`).
 *   - `contracts/core/EntryPoint.sol` lines 51-54 + 140-147 —
 *     `DOMAIN_NAME = "ERC4337"`, `DOMAIN_VERSION = "1"`, and
 *     `getUserOpHash = toTypedDataHash(domainSeparator, userOp.hash(...))`.
 *   - `contracts/core/EntryPointSimulations.sol` lines 195-200 — the
 *     EIP-712 domain typehash and separator construction.
 *   - `contracts/core/Eip7702Support.sol` — the initCode hash override for
 *     EIP-7702 senders.
 * - `contracts/core/NonceManager.sol` lines 14-19 + `INonceManager.sol` —
 *   the 192-bit key + 64-bit sequence nonce packing ("the high 192 bit of the
 *   nonce" is the key; `nonce = (key << 64) | sequence`).
 * - ERC-4337 (canonical text): https://eips.ethereum.org/EIPS/eip-4337
 *   ("Support for EIP-712 signatures": userOpHash is an EIP-712 typed message
 *   hash over `PackedUserOperation(...)`; the `accountGasLimits`/`gasFees`
 *   fields are 16+16-byte concatenations).
 *
 * Note on the wave-4b brief wording: "packUints … (192-bit + 64-bit packed
 * fields)" matches the *nonce* key/sequence field (`packNonce` below); the gas
 * packUints are 128+128 per `UserOperationLib.unpackUints`. Both are
 * implemented here against their real definitions.
 *
 * Golden vector (`userop.test.mjs`) derived stepwise with `cast abi-encode` +
 * `cast keccak`; the exact commands are recorded in that test.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { abiEncode, bytesToHex, hexToBytes } from "./userop-abi.ts";

/** ERC-4337 v0.8 PackedUserOperation, in JSON-RPC hex-quantity form. */
export interface PackedUserOperation {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  accountGasLimits: string;
  preVerificationGas: string;
  gasFees: string;
  paymasterAndData: string;
  signature: string;
}

/**
 * `keccak256("PackedUserOperation(address sender,uint256 nonce,bytes initCode,
 * bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32
 * gasFees,bytes paymasterAndData)")` — `UserOperationLib.PACKED_USEROP_TYPEHASH`.
 */
export const PACKED_USEROP_TYPEHASH =
  "0x29a0bca4af4be3421398da00295e58e6d7de38cb492214754cb6a47507dd6f8e";

/** `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`. */
export const EIP712_DOMAIN_TYPEHASH =
  "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";

/** `keccak256("ERC4337")` — EntryPoint v0.8.0 `DOMAIN_NAME`. */
export const EIP712_DOMAIN_NAME_HASH =
  "0x364da28a5c92bcc87fe97c8813a6c6b8a3a049b0ea0a328fcb0b4f0e00337586";

/** `keccak256("1")` — EntryPoint v0.8.0 `DOMAIN_VERSION`. */
export const EIP712_DOMAIN_VERSION_HASH =
  "0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6";

/** keccak-256 of `data` (0x-hex), as a 0x-hex digest. */
export function keccak256(data: string): string {
  return bytesToHex(keccak_256(hexToBytes(data)));
}

function asUint(value: string, what: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`userop: ${what} must be a 0x-hex quantity, got ${value}`);
  }
  return BigInt(value);
}

function requireRange(value: bigint, bits: number, what: string): void {
  if (value < 0n || value >= 1n << BigInt(bits)) {
    throw new Error(
      `userop: ${what} must fit in ${bits} unsigned bits, got ${value}`,
    );
  }
}

/**
 * Pack two 128-bit fields into one word, high then low — the inverse of
 * `UserOperationLib.unpackUints` (v0.8.0).
 */
export function packUints(high128: bigint, low128: bigint): string {
  requireRange(high128, 128, "high128");
  requireRange(low128, 128, "low128");
  return `0x${((high128 << 128n) | low128).toString(16).padStart(64, "0")}`;
}

/** Unpack a packed word into its high-128 and low-128 halves. */
export function unpackUints(packed: string): {
  high128: bigint;
  low128: bigint;
} {
  const word = asUint(packed, "packed uints");
  requireRange(word, 256, "packed uints");
  return { high128: word >> 128n, low128: word & ((1n << 128n) - 1n) };
}

/**
 * ERC-4337 semi-abstracted nonce: 192-bit key + 64-bit sequence
 * (`NonceManager.getNonce`: `sequence | (key << 64)`).
 */
export function packNonce(key192: bigint, sequence64: bigint): string {
  requireRange(key192, 192, "nonce key");
  requireRange(sequence64, 64, "nonce sequence");
  return `0x${((key192 << 64n) | sequence64).toString(16).padStart(64, "0")}`;
}

/** Split a nonce into its 192-bit key and 64-bit sequence. */
export function unpackNonce(nonce: string): {
  key192: bigint;
  sequence64: bigint;
} {
  const word = asUint(nonce, "nonce");
  return { key192: word >> 64n, sequence64: word & ((1n << 64n) - 1n) };
}

/** `accountGasLimits` = pack(verificationGasLimit, callGasLimit). */
export function packAccountGasLimits(fields: {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
}): string {
  return packUints(fields.verificationGasLimit, fields.callGasLimit);
}

/** `gasFees` = pack(maxPriorityFeePerGas, maxFeePerGas). */
export function packGasFees(fields: {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
}): string {
  return packUints(fields.maxPriorityFeePerGas, fields.maxFeePerGas);
}

/**
 * EIP-712 struct hash of the PackedUserOperation (`UserOperationLib.hash`).
 * `overrideInitCodeHash`, when non-zero, replaces `keccak256(initCode)`
 * (EIP-7702 senders — `Eip7702Support._getEip7702InitCodeHashOverride`).
 */
export function hashPackedUserOperation(
  userOp: Pick<
    PackedUserOperation,
    | "sender"
    | "nonce"
    | "initCode"
    | "callData"
    | "accountGasLimits"
    | "preVerificationGas"
    | "gasFees"
    | "paymasterAndData"
  >,
  overrideInitCodeHash?: string,
): string {
  const initCodeHash =
    overrideInitCodeHash !== undefined &&
    overrideInitCodeHash !==
      "0x0000000000000000000000000000000000000000000000000000000000000000"
      ? overrideInitCodeHash
      : keccak256(userOp.initCode);
  return keccak256(
    abiEncode([
      { kind: "bytes32", value: PACKED_USEROP_TYPEHASH },
      { kind: "address", value: userOp.sender },
      { kind: "uint", value: asUint(userOp.nonce, "nonce") },
      { kind: "bytes32", value: initCodeHash },
      { kind: "bytes32", value: keccak256(userOp.callData) },
      { kind: "bytes32", value: userOp.accountGasLimits },
      {
        kind: "uint",
        value: asUint(userOp.preVerificationGas, "preVerificationGas"),
      },
      { kind: "bytes32", value: userOp.gasFees },
      { kind: "bytes32", value: keccak256(userOp.paymasterAndData) },
    ]),
  );
}

/** EIP-712 domain separator of an EntryPoint v0.8 (`getDomainSeparatorV4`). */
export function eip712DomainSeparator(
  entryPoint: string,
  chainId: bigint,
): string {
  return keccak256(
    abiEncode([
      { kind: "bytes32", value: EIP712_DOMAIN_TYPEHASH },
      { kind: "bytes32", value: EIP712_DOMAIN_NAME_HASH },
      { kind: "bytes32", value: EIP712_DOMAIN_VERSION_HASH },
      { kind: "uint", value: chainId },
      { kind: "address", value: entryPoint },
    ]),
  );
}

/** `MessageHashUtils.toTypedDataHash`: keccak256(0x1901 ‖ separator ‖ structHash). */
export function toTypedDataHash(
  domainSeparator: string,
  structHash: string,
): string {
  return keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}`);
}

/**
 * Whether `initCode` is an EIP-7702 marker (`0x7702` as a bytes20 value, i.e.
 * `0x7702` followed by 18 zero bytes; shorter payloads are zero-padded exactly
 * as `Eip7702Support._isEip7702InitCode` does with `calldataload`).
 */
export function isEip7702InitCode(initCode: string): boolean {
  if (!/^0x[0-9a-fA-F]*$/.test(initCode) || (initCode.length - 2) % 2 !== 0) {
    throw new Error(
      `userop: initCode must be even-length 0x-hex, got ${initCode}`,
    );
  }
  const body = initCode.slice(2).toLowerCase();
  if (body.length < 4) {
    return false;
  }
  const first20Bytes = (body + "0".repeat(40)).slice(0, 40);
  return first20Bytes === "7702" + "0".repeat(36);
}

/**
 * Compute the hash the EntryPoint v0.8 passes to `validateUserOp`:
 * `keccak256(0x1901 ‖ domainSeparator ‖ structHash)` over this operation.
 *
 * For EIP-7702 senders pass `eip7702Delegate` (the address from the sender's
 * delegation designator); the override hash is then
 * `keccak256(delegate ‖ initCode[20:])` per `Eip7702Support` (or
 * `keccak256(delegate)` when `initCode` is exactly the 20-byte marker).
 * Fresh factory-deployed Kernels never hit that path.
 */
export function getUserOpHash(
  userOp: Parameters<typeof hashPackedUserOperation>[0],
  entryPoint: string,
  chainId: bigint,
  options?: { eip7702Delegate?: string },
): string {
  let overrideInitCodeHash: string | undefined;
  if (isEip7702InitCode(userOp.initCode)) {
    const delegate = options?.eip7702Delegate;
    if (delegate === undefined) {
      throw new Error(
        "userop: EIP-7702 initCode needs its delegate-based initCode hash " +
          "(Eip7702Support._getEip7702InitCodeHashOverride); pass " +
          "eip7702Delegate to getUserOpHash",
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(delegate)) {
      throw new Error(
        `userop: eip7702Delegate must be a 20-byte address, got ${delegate}`,
      );
    }
    const initCodeBody = userOp.initCode.slice(2).toLowerCase();
    overrideInitCodeHash =
      initCodeBody.length <= 40
        ? keccak256(delegate)
        : keccak256(`${delegate}${initCodeBody.slice(40)}`);
  }
  const structHash = hashPackedUserOperation(userOp, overrideInitCodeHash);
  return toTypedDataHash(
    eip712DomainSeparator(entryPoint, chainId),
    structHash,
  );
}
