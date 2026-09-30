/**
 * WebAuthn assertion → smart-account signature wrapping.
 *
 * Two real, cited conventions ship here:
 *
 * 1. `WebAuthnAuth` (authenticatorData, clientDataJSON, challengeIndex,
 *    typeIndex, r, s) — the solady/Daimo ERC-7579 WebAuthn validator
 *    convention, taken verbatim from the vendored solady source
 *    (`dao-launchpad:contracts/lib/solady/src/utils/WebAuthn.sol`, "modified
 *    from https://github.com/daimo-eth/webauthn-sol"):
 *    at `challengeIndex` the JSON must hold `"challenge":"<base64url(hash)>"`,
 *    at `typeIndex` `"type":"webauthn.get"`, and the P-256 signature
 *    (r, s) covers `sha256(authenticatorData ‖ sha256(clientDataJSON))`.
 *
 * 2. `ZeroDevWebAuthnSignature` (authenticatorData, clientDataJSON,
 *    responseTypeLocation, r, s, usePrecompiled) — the signature tuple of
 *    ZeroDev's live WebAuthnValidator for Kernel,
 *    https://github.com/zerodevapp/kernel-7579-plugins (master):
 *    `src/validators/WebAuthnValidator.sol` `_verifySignature` abi.decodes
 *    exactly this tuple and calls `src/utils/WebAuthn.sol verifySignature`
 *    with a **fixed** `CHALLENGE_LOCATION = 23` (i.e. `"challenge":"` must
 *    start at byte 23 — canonical Chrome clientDataJSON ordering) plus the
 *    caller-supplied `responseTypeLocation` of `"type":"webauthn.get"`.
 *    Here r and s are **uint256** values (not bytes32 words).
 *
 * The passkey assertion (`PasskeyAssertion` in `passkey.ts`) carries the
 * authenticator's ES256 DER signature over `authenticatorData ‖
 * SHA-256(clientDataJSON)` as raw bytes (WebAuthn §6.3). `derToRs` converts
 * it to the fixed 64-byte `r ‖ s` both conventions expect.
 *
 * Everything here is pure and golden-tested in `webauthn-auth.test.mjs`
 * (including an independent `node:crypto` verify of the parsed `r ‖ s`).
 */
import type { PasskeyAssertion } from "./passkey.ts";
import { b64urlEncode } from "./passkey.ts";
import { abiEncode, bytesToHex, hexToBytes } from "./userop-abi.ts";

/**
 * Upper bound on clientDataJSON accepted here. Real clientDataJSON is a few
 * hundred bytes; this only exists so hostile/buggy input cannot blow up the
 * index scan or the ABI encoder (Review-Proven Rule 4: bound everything).
 */
export const MAX_CLIENT_DATA_JSON_BYTES = 4096;

/**
 * `WebAuthnValidator.CHALLENGE_LOCATION` (kernel-7579-plugins) — the byte
 * index at which `"challenge":"` must start for the ZeroDev validator.
 */
export const ZERODEV_CHALLENGE_LOCATION = 23;

/**
 * `type(uint256).max` in `responseTypeLocation` marks a dummy (gas
 * estimation) signature for the ZeroDev validator
 * (`WebAuthn.sol` lines 155-158).
 */
export const ZERODEV_DUMMY_RESPONSE_TYPE_LOCATION = (1n << 256n) - 1n;

const CHALLENGE_KEY = '"challenge":"';
const TYPE_KEY = '"type":"webauthn.get"';

/** Raw bytes or their 0x-hex form, depending on field (see encoder docs). */
export type BytesOrHex = Uint8Array | string;

/** solady/Daimo `WebAuthnAuth` tuple. */
export interface WebAuthnAuth {
  /** authenticatorData bytes (0x-hex). */
  authenticatorData: string;
  /** clientDataJSON as the JSON text (the ABI field is `string`). */
  clientDataJSON: string;
  challengeIndex: number;
  typeIndex: number;
  /** 32-byte r, 0x-hex. */
  r: string;
  /** 32-byte s, 0x-hex. */
  s: string;
}

/** ZeroDev `WebAuthnValidator` signature fields. */
export interface ZeroDevWebAuthnSignature {
  authenticatorData: string;
  clientDataJSON: string;
  responseTypeLocation: bigint;
  r: bigint;
  s: bigint;
  usePrecompiled: boolean;
}

function fail(message: string): never {
  throw new Error(`webauthn-auth: ${message}`);
}

function toBytes(input: BytesOrHex): Uint8Array {
  return typeof input === "string" ? hexToBytes(input) : input;
}

function toClientDataText(input: BytesOrHex): {
  text: string;
  bytes: Uint8Array;
} {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  return { text: new TextDecoder().decode(bytes), bytes };
}

/**
 * Strict DER (X.690 §10; ECDSA-Sig-Value per RFC 5480 Appendix A) → fixed
 * 32-byte r and s. Accepts raw DER bytes or 0x-hex.
 *
 * Bounded and strict: SEQUENCE with one-byte length only (ECDSA signatures
 * over P-256 never exceed 72 bytes), two positive INTEGERs with minimal
 * encoding (at most one 0x00 sign byte), exact total length, no trailing
 * bytes. Anything else throws — a silently mis-parsed signature would look
 * "verified" while hashing different bytes on-chain.
 *
 * `s` is normalized to the low-s form (`s ≤ n/2`): kernel-7579-plugins
 * `P256.verifySignature` returns false for `s > P256_N_DIV_2`
 * (`src/utils/P256.sol` lines 34-44, anti-malleability), and authenticators
 * emit high-s about half the time. `(r, n − s)` is a valid ECDSA signature
 * over the same message, so this never changes what verifies — it only keeps
 * the on-chain check from rejecting it.
 */
export function derToRs(der: BytesOrHex): { r: string; s: string } {
  const bytes = toBytes(der);
  // 0x30 | len | 0x02 | rLen | r | 0x02 | sLen | s — min 8, max 72 bytes.
  if (bytes.length < 8 || bytes.length > 72) {
    fail(`DER signature length ${bytes.length} out of range [8, 72]`);
  }
  if (bytes[0] !== 0x30) {
    fail(
      `DER signature must start with SEQUENCE (0x30), got 0x${bytes[0].toString(16)}`,
    );
  }
  if (bytes[1] !== bytes.length - 2) {
    fail(
      `DER SEQUENCE length ${bytes[1]} does not cover ${bytes.length - 2} bytes`,
    );
  }
  let offset = 2;
  const readInt = (what: "r" | "s"): Uint8Array => {
    if (bytes[offset] !== 0x02) {
      fail(`${what} must be an INTEGER (0x02) at offset ${offset}`);
    }
    const length = bytes[offset + 1];
    if (length === 0 || offset + 2 + length > bytes.length) {
      fail(`${what} INTEGER length ${length} invalid at offset ${offset}`);
    }
    let value = bytes.slice(offset + 2, offset + 2 + length);
    offset += 2 + length;
    if (value[0] === 0x00) {
      if (value.length === 1) {
        fail(`${what} INTEGER is zero`);
      }
      if (value[1] < 0x80) {
        fail(`${what} INTEGER has non-minimal padding`);
      }
      value = value.slice(1);
    } else if (value[0] >= 0x80) {
      fail(`${what} INTEGER is negative (high bit set without padding)`);
    }
    if (value.length > 32) {
      fail(`${what} INTEGER is ${value.length} bytes, exceeds 32`);
    }
    let allZero = true;
    for (const byte of value) {
      if (byte !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      fail(`${what} INTEGER is zero`);
    }
    return value;
  };
  const r = readInt("r");
  const s = readInt("s");
  if (offset !== bytes.length) {
    fail(`DER signature has ${bytes.length - offset} trailing bytes`);
  }
  const leftPad = (value: Uint8Array): string => {
    let hex = "";
    for (const byte of value) {
      hex += byte.toString(16).padStart(2, "0");
    }
    return `0x${hex.padStart(64, "0")}`;
  };
  // Low-s normalization (see this function's doc): kernel-7579-plugins
  // P256.verifySignature rejects s > n/2.
  const P256_N = BigInt(
    "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
  );
  const P256_N_DIV_2 = P256_N >> 1n;
  let sHex = leftPad(s);
  const sValue = BigInt(sHex);
  if (sValue > P256_N_DIV_2) {
    sHex = `0x${(P256_N - sValue).toString(16).padStart(64, "0")}`;
  }
  return { r: leftPad(r), s: sHex };
}

function findOccurrences(haystack: Uint8Array, needle: string): number[] {
  const token = new TextEncoder().encode(needle);
  const hits: number[] = [];
  for (let i = 0; i + token.length <= haystack.length; i += 1) {
    let match = true;
    for (let j = 0; j < token.length; j += 1) {
      if (haystack[i + j] !== token[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      hits.push(i);
    }
  }
  return hits;
}

/**
 * Byte offset in clientDataJSON where the field's key token starts
 * (`"challenge":"` or `"type":"webauthn.get"` — the offsets both validator
 * conventions index with). Accepts the JSON as text or raw UTF-8 bytes.
 * Throws when the field is absent or ambiguous.
 */
export function locateClientDataField(
  clientDataJSON: BytesOrHex,
  field: "challenge" | "type",
): number {
  const bytes = toClientDataText(clientDataJSON).bytes;
  if (bytes.length > MAX_CLIENT_DATA_JSON_BYTES) {
    fail(
      `clientDataJSON is ${bytes.length} bytes, over the ${MAX_CLIENT_DATA_JSON_BYTES}-byte bound`,
    );
  }
  const token = field === "challenge" ? CHALLENGE_KEY : TYPE_KEY;
  const hits = findOccurrences(bytes, token);
  if (hits.length === 0) {
    fail(`clientDataJSON is missing the ${JSON.stringify(field)} field`);
  }
  if (hits.length > 1) {
    fail(`clientDataJSON has ${hits.length} ${JSON.stringify(field)} fields`);
  }
  return hits[0];
}

function requireChallengeAt(
  clientDataJSON: Uint8Array,
  expected: { hashHex: string },
  at: number,
): void {
  const challengeB64 = b64urlEncode(hexToBytes(expected.hashHex));
  const wanted = new TextEncoder().encode(`${CHALLENGE_KEY}${challengeB64}"`);
  if (at + wanted.length > clientDataJSON.length) {
    fail(`challenge field truncated at byte ${at}`);
  }
  for (let i = 0; i < wanted.length; i += 1) {
    if (clientDataJSON[at + i] !== wanted[i]) {
      fail(
        `clientDataJSON challenge at byte ${at} is not the expected ` +
          `"challenge":"${challengeB64}" (assertion signed a different hash)`,
      );
    }
  }
}

function requireUserPresence(authenticatorData: Uint8Array): void {
  // WebAuthn §6.1: rpIdHash(32) ‖ flags(1) ‖ signCount(4).
  if (authenticatorData.length < 37) {
    fail(
      `authenticatorData is ${authenticatorData.length} bytes, needs at least 37`,
    );
  }
  const flags = authenticatorData[32];
  // kernel-7579-plugins `checkAuthFlags` (requireUserVerification = true):
  // UP (bit 0) and UV (bit 2) must be set; BS (bit 4) only when BE (bit 3).
  if ((flags & 0x01) === 0) {
    fail("authenticatorData flags: user-present (UP) bit not set");
  }
  if ((flags & 0x04) === 0) {
    fail("authenticatorData flags: user-verification (UV) bit not set");
  }
  if ((flags & 0x08) === 0 && (flags & 0x10) !== 0) {
    fail("authenticatorData flags: BS set without BE");
  }
}

/**
 * Build the solady/Daimo `WebAuthnAuth` from a passkey assertion over
 * `challengeHex` (the 32-byte userOpHash), with both JSON field offsets
 * located and validated.
 */
export function wrapPasskeyAssertionAsWebAuthnAuth(
  assertion: PasskeyAssertion,
  options: { challengeHex: string },
): WebAuthnAuth & { encoded: string } {
  requireUserPresence(assertion.authenticatorData);
  const { text: clientDataText, bytes: clientDataBytes } = toClientDataText(
    assertion.clientDataJSON,
  );
  const challengeIndex = locateClientDataField(clientDataBytes, "challenge");
  const typeIndex = locateClientDataField(clientDataBytes, "type");
  requireChallengeAt(
    clientDataBytes,
    { hashHex: options.challengeHex },
    challengeIndex,
  );
  const { r, s } = derToRs(assertion.signature);
  const auth: WebAuthnAuth = {
    authenticatorData: bytesToHex(assertion.authenticatorData),
    clientDataJSON: clientDataText,
    challengeIndex,
    typeIndex,
    r,
    s,
  };
  return { ...auth, encoded: encodeWebAuthnAuth(auth) };
}

/** `abi.encode(WebAuthnAuth)` as solady's `verifySignature` decodes it. */
export function encodeWebAuthnAuth(auth: WebAuthnAuth): string {
  return abiEncode([
    { kind: "bytes", value: auth.authenticatorData },
    { kind: "string", value: auth.clientDataJSON },
    { kind: "uint", value: BigInt(auth.challengeIndex) },
    { kind: "uint", value: BigInt(auth.typeIndex) },
    { kind: "bytes32", value: auth.r },
    { kind: "bytes32", value: auth.s },
  ]);
}

/**
 * Build the ZeroDev `WebAuthnValidator` signature from a passkey assertion.
 * Throws when `"challenge":"` is not at the validator's fixed offset 23 —
 * such an assertion can never verify on-chain, so failing here (with the
 * actual offset) is strictly better than submitting a doomed UserOp.
 */
export function wrapPasskeyAssertionForZeroDevValidator(
  assertion: PasskeyAssertion,
  options: { challengeHex: string; usePrecompiled: boolean },
): ZeroDevWebAuthnSignature & { encoded: string } {
  requireUserPresence(assertion.authenticatorData);
  const { text: clientDataText, bytes: clientDataBytes } = toClientDataText(
    assertion.clientDataJSON,
  );
  const challengeIndex = locateClientDataField(clientDataBytes, "challenge");
  if (challengeIndex !== ZERODEV_CHALLENGE_LOCATION) {
    fail(
      `challenge field starts at byte ${challengeIndex}; the ZeroDev ` +
        `WebAuthnValidator requires ${ZERODEV_CHALLENGE_LOCATION} ` +
        "(canonical clientDataJSON field order)",
    );
  }
  requireChallengeAt(
    clientDataBytes,
    { hashHex: options.challengeHex },
    challengeIndex,
  );
  const responseTypeLocation = BigInt(
    locateClientDataField(clientDataBytes, "type"),
  );
  const { r, s } = derToRs(assertion.signature);
  const signature: ZeroDevWebAuthnSignature = {
    authenticatorData: bytesToHex(assertion.authenticatorData),
    clientDataJSON: clientDataText,
    responseTypeLocation,
    r: BigInt(r),
    s: BigInt(s),
    usePrecompiled: options.usePrecompiled,
  };
  return { ...signature, encoded: encodeZeroDevWebAuthnSignature(signature) };
}

/** `abi.encode` of the ZeroDev validator's signature tuple (r, s as uint256). */
export function encodeZeroDevWebAuthnSignature(
  signature: ZeroDevWebAuthnSignature,
): string {
  return abiEncode([
    { kind: "bytes", value: signature.authenticatorData },
    { kind: "string", value: signature.clientDataJSON },
    { kind: "uint", value: signature.responseTypeLocation },
    { kind: "uint", value: signature.r },
    { kind: "uint", value: signature.s },
    { kind: "bool", value: signature.usePrecompiled },
  ]);
}

/** Re-exported for callers building WebAuthn challenges from raw bytes. */
export { b64urlEncode };
