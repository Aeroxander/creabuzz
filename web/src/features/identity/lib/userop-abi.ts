/**
 * Minimal Solidity ABI encoder/decoder for the ERC-4337 UserOperation core.
 *
 * Justification (why hand-rolled): the web bundle carries no ABI coder
 * dependency (see `web/src/features/launchpad/lib/bid-tx.ts`, which hand-rolls
 * calldata the same way), and the exact shapes needed here are small and fully
 * specified by the Solidity ABI spec. Every encoder below is golden-tested in
 * `userop-abi.test.mjs` and `userop.test.mjs` against `cast abi-encode` /
 * `cast calldata` vectors (the exact `cast` commands are recorded in those
 * test files' derivations).
 *
 * References:
 * - Solidity ABI spec (head/tail encoding):
 *   https://docs.soliditylang.org/en/latest/abi-spec.html
 * - eth-infinitism/account-abstraction v0.8.0 (PackedUserOperation shapes):
 *   https://github.com/eth-infinitism/account-abstraction/blob/v0.8.0/contracts/interfaces/PackedUserOperation.sol
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

const WORD_BYTES = 32;
const MAX_UINT256 = (1n << 256n) - 1n;

/** One ABI-encodable value. `tuple` mirrors `abi.encode` of a struct. */
export type AbiField =
  | { kind: "uint"; value: bigint }
  | { kind: "address"; value: string }
  | { kind: "bytes32"; value: string }
  | { kind: "bytes4"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "bytes"; value: string }
  | { kind: "string"; value: string }
  | { kind: "tuple"; fields: AbiField[] }
  | { kind: "tuple[]"; items: AbiField[][] };

function fail(message: string): never {
  throw new Error(`userop-abi: ${message}`);
}

function assertHex(value: string, what: string): string {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    fail(
      `${what} must be a 0x-prefixed hex string, got ${JSON.stringify(value)}`,
    );
  }
  return value.toLowerCase();
}

/** 0x-hex string → bytes (even digit count enforced). */
export function hexToBytes(value: string): Uint8Array {
  const body = assertHex(value, "hex").slice(2);
  if (body.length % 2 !== 0) {
    fail("hex must have an even number of digits");
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Bytes → 0x-hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function digitsToBytes(hexDigits: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hexDigits)) {
    fail(`bare hex digits invalid: ${JSON.stringify(hexDigits)}`);
  }
  // Internal numeric renderings may be odd-length (e.g. `0x120` → "120").
  const padded = hexDigits.length % 2 === 0 ? hexDigits : `0${hexDigits}`;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function byteLength(value: string, what: string): number {
  assertHex(value, what);
  const digits = value.length - 2;
  if (digits % 2 !== 0) {
    fail(`${what} must have an even number of hex digits`);
  }
  return digits / 2;
}

function padWord(hexDigits: string, side: "left" | "right"): Uint8Array {
  const out = new Uint8Array(WORD_BYTES);
  const bytes = digitsToBytes(hexDigits);
  if (bytes.length > WORD_BYTES) {
    fail("value does not fit in a 32-byte word");
  }
  if (side === "left") {
    out.set(bytes, WORD_BYTES - bytes.length);
  } else {
    out.set(bytes, 0);
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Hex of `value` as one 32-byte big-endian word. */
export function encodeWord(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_UINT256) {
    fail(`uint out of range for one word: ${value}`);
  }
  return padWord(value.toString(16).padStart(2, "0"), "left");
}

function isDynamic(field: AbiField): boolean {
  if (
    field.kind === "bytes" ||
    field.kind === "string" ||
    field.kind === "tuple[]"
  ) {
    return true;
  }
  if (field.kind === "tuple") {
    return field.fields.some(isDynamic);
  }
  return false;
}

function encodeStaticField(field: AbiField): Uint8Array {
  switch (field.kind) {
    case "uint":
      return encodeWord(field.value);
    case "bool":
      return encodeWord(field.value ? 1n : 0n);
    case "address": {
      assertHex(field.value, "address");
      if (byteLength(field.value, "address") !== 20) {
        fail(
          `address must be 20 bytes, got ${byteLength(field.value, "address")}`,
        );
      }
      return padWord(field.value.slice(2), "left");
    }
    case "bytes32": {
      if (byteLength(field.value, "bytes32") !== WORD_BYTES) {
        fail("bytes32 must be exactly 32 bytes");
      }
      return padWord(field.value.slice(2), "left");
    }
    case "bytes4": {
      if (byteLength(field.value, "bytes4") !== 4) {
        fail("bytes4 must be exactly 4 bytes");
      }
      // fixed-size bytesN are left-aligned and right-padded.
      return padWord(field.value.slice(2), "right");
    }
    default:
      return fail(`field kind ${field.kind} is not static`);
  }
}

function encodeBytesLike(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(
    Math.ceil(data.length / WORD_BYTES) * WORD_BYTES,
  );
  padded.set(data, 0);
  return concatBytes([encodeWord(BigInt(data.length)), padded]);
}

function encodeDynamicField(field: AbiField): Uint8Array {
  switch (field.kind) {
    case "bytes":
      return encodeBytesLike(hexToBytes(assertHex(field.value, "bytes")));
    case "string":
      return encodeBytesLike(new TextEncoder().encode(field.value));
    case "tuple":
      // Dynamic tuple: its members' offsets are relative to the tuple start.
      return encodeSequence(field.fields);
    case "tuple[]":
      // enc(X[]) = len ‖ enc((X1..Xn)); offsets inside are relative to the
      // start of enc((X1..Xn)) (Solidity ABI spec, "Encoding of a Tuple").
      return concatBytes([
        encodeWord(BigInt(field.items.length)),
        encodeSequence(
          field.items.map((fields) => ({ kind: "tuple", fields })),
        ),
      ]);
    default:
      return fail(`field kind ${field.kind} is not dynamic`);
  }
}

/**
 * Head/tail encoding of a sequence of fields, as used for function arguments
 * and for tuple members. Dynamic head slots hold offsets relative to the
 * start of the head area of this sequence.
 */
function encodeSequence(fields: AbiField[]): Uint8Array {
  const headChunks: Uint8Array[] = [];
  const tailChunks: Uint8Array[] = [];
  let headSize = 0;
  const dynamicSlots: number[] = [];
  for (const field of fields) {
    if (isDynamic(field)) {
      dynamicSlots.push(headChunks.length);
      headChunks.push(new Uint8Array(WORD_BYTES)); // offset placeholder
      headSize += WORD_BYTES;
    } else if (field.kind === "tuple") {
      const inline = encodeSequence(field.fields);
      headChunks.push(inline);
      headSize += inline.length;
    } else {
      const word = encodeStaticField(field);
      headChunks.push(word);
      headSize += word.length;
    }
  }
  let tailSize = 0;
  for (const slot of dynamicSlots) {
    headChunks[slot] = encodeWord(BigInt(headSize + tailSize));
    const tail = encodeDynamicField(fields[slot] as AbiField);
    tailChunks.push(tail);
    tailSize += tail.length;
  }
  return concatBytes([...headChunks, ...tailChunks]);
}

/** `abi.encode(fields)` for a (possibly empty) argument list. */
export function abiEncode(fields: AbiField[]): string {
  return bytesToHex(encodeSequence(fields));
}

/** keccak-256 of `signature`, first 4 bytes — the function selector. */
export function functionSelector(signature: string): string {
  const digest = keccak_256(new TextEncoder().encode(signature));
  return bytesToHex(digest.slice(0, 4));
}

/** `abi.encodeWithSelector(signature, fields)`; `signature` includes types. */
export function abiEncodeCall(signature: string, fields: AbiField[]): string {
  return `${functionSelector(signature)}${abiEncode(fields).slice(2)}`;
}

/**
 * Decode the first return word as an address (static-call results).
 * Throws when `returnData` is not a full word carrying a clean 12-byte prefix.
 */
export function decodeAddressWord(data: string): string {
  assertHex(data, "returnData");
  const bytes = hexToBytes(data);
  if (bytes.length < WORD_BYTES) {
    fail(`returnData too short for an address word: ${bytes.length} bytes`);
  }
  const word = bytes.slice(0, WORD_BYTES);
  for (let i = 0; i < 12; i += 1) {
    if (word[i] !== 0) {
      fail("address word has non-zero 12-byte prefix");
    }
  }
  return bytesToHex(word.slice(12));
}

/**
 * Decode a custom-error payload `ErrorName(address)` (e.g. the EntryPoint's
 * `SenderAddressResult`). Returns `null` when the selector does not match, and
 * throws when the selector matches but the payload is malformed.
 */
export function decodeAddressError(
  data: string,
  errorSignature: string,
): string | null {
  assertHex(data, "revert data");
  const selector = functionSelector(errorSignature);
  if (data.length < 10 || data.slice(0, 10) !== selector) {
    return null;
  }
  const payload = `0x${data.slice(10)}`;
  if (byteLength(payload, "error payload") !== WORD_BYTES) {
    fail(`${errorSignature} payload must be one word`);
  }
  return decodeAddressWord(payload);
}
