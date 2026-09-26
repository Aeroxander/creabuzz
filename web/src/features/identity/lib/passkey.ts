/**
 * WebAuthn passkey identity primitives — one ceremony, two identity roots.
 *
 * A single platform-passkey registration serves both roots from
 * `docs/identity-token-architecture.md`:
 *
 * 1. Nostr root — the PRF (HMAC-Secret) output for a random salt, expanded
 *    with HKDF-SHA256 into a secp256k1 secret key. The key exists only in
 *    page memory and is identical for the same credential + salt (e.g. across
 *    a synced ecosystem). Derivation is exactly the `web-passkey` branch's
 *    shipped chain: HKDF-SHA256 with an all-zero salt and info
 *    `"buzz-nostr-v1"`, 256 output bits as the secp256k1 secret.
 * 2. Smart-wallet root — the passkey's own secp256r1 (P-256) public key,
 *    parsed out of the registration attestation's `authenticatorData /
 *    attestedCredentialData` (COSE_Key). That key is the future ZeroDev
 *    Kernel / ERC-7579 WebAuthn-validator owner; this module never sees its
 *    private half (it never leaves the authenticator).
 *
 * Registration evaluates the PRF at create time (`extensions.prf.eval.first`);
 * `getPasskeyAssertion` performs the follow-up evaluation for re-derivation
 * and returns the signed assertion the in-contract verifier will check. Both
 * ceremonies request `eval.first` with the persisted salt — per the WebAuthn
 * PRF extension the two `eval` slots compute the same function, so a second
 * evaluation of the first slot's salt is the re-derivation output.
 *
 * Error posture (no silent success): every failure either propagates or is
 * thrown as a typed error with a human explanation (`explainPasskeyError`),
 * and a PRF failure after a successful registration carries the created
 * credential so callers can fall back without orphaning it.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "nostr-tools/pure";

/** HKDF info of the Nostr derivation — the branch's shipped value. */
export const HKDF_INFO = new TextEncoder().encode("buzz-nostr-v1");

/** The two public roots of one passkey registration. */
export interface PasskeyIdentity {
  /** Nostr root: secp256k1 pubkey derived from the PRF output. */
  nostr: { pubkeyHex: string };
  /** Smart-wallet root: the passkey's own secp256r1 key (wave 4b owner). */
  evmOwner: { r1UncompressedHex: string; addressPreview?: string };
}

/** Credential reference carried by errors raised after creation succeeded. */
export interface CreatedPasskeyRef {
  credentialId: string;
  r1UncompressedHex?: string;
}

/** Base error: a passkey ceremony or derivation failure with a plain reason. */
export class PasskeyError extends Error {
  readonly created?: CreatedPasskeyRef;

  constructor(message: string, created?: CreatedPasskeyRef) {
    super(message);
    this.name = "PasskeyError";
    this.created = created;
  }
}

/** Thrown when the page cannot run a WebAuthn ceremony at all. */
export class PasskeyEnvironmentError extends PasskeyError {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyEnvironmentError";
  }
}

/** Thrown when the platform passkey cannot provide PRF outputs. */
export class PrfUnavailableError extends PasskeyError {
  constructor(created?: CreatedPasskeyRef) {
    super(
      "This platform did not provide a PRF output for the passkey. On macOS, Safari and Chrome support PRF through the platform authenticator — Firefox generally doesn't — and Windows Hello or Google Password Manager support it elsewhere. This browser can't run the PRF ceremony, so try Safari or Chrome.",
      created,
    );
    this.name = "PrfUnavailableError";
  }
}

/** Thrown when the attestation cannot yield the secp256r1 owner key. */
export class PasskeyAttestationError extends PasskeyError {
  constructor(message: string, created?: CreatedPasskeyRef) {
    super(message, created);
    this.name = "PasskeyAttestationError";
  }
}

/** Copy to an ArrayBuffer-backed view (WebCrypto BufferSource requirement). */
function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.slice().buffer;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * RP id for ceremonies (branch-shipped mapping).
 *
 * WebAuthn RP IDs must be domains; browsers reject IP literals (including
 * 127.0.0.1). localhost is the sanctioned loopback id for dev, and the same
 * RP id must be used for both registration and assertion.
 */
export function rpId(): string {
  if (typeof window === "undefined") return "localhost";
  const host = window.location.hostname || "localhost";
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  ) {
    return "localhost";
  }
  return host;
}

/**
 * HKDF-SHA256 (RFC 5869) via Web Crypto. Expand `prfOutput` into exactly 32
 * bytes. Salt is all zeros — for HMAC-based HKDF that equals the default
 * (HashLen zeros) salt — matching the branch's shipped derivation exactly.
 */
export async function hkdfSha256(
  prfOutput: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toAB(prfOutput),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toAB(new Uint8Array(32)),
      info: toAB(info),
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** The Nostr secret key: HKDF-SHA256(PRF output, "buzz-nostr-v1") → 32 bytes. */
export async function deriveNostrSecretKey(
  prfOutput: Uint8Array,
): Promise<Uint8Array> {
  return hkdfSha256(prfOutput, HKDF_INFO);
}

/** secp256k1 pubkey (hex) of a Nostr secret key. */
export function nostrPubkeyHex(secretKey: Uint8Array): string {
  return getPublicKey(secretKey);
}

/** Both public roots from the in-memory Nostr secret + the attested r1 key. */
export function passkeyIdentityFrom(
  nostrSecretKey: Uint8Array,
  r1Uncompressed: Uint8Array,
): PasskeyIdentity {
  return {
    nostr: { pubkeyHex: getPublicKey(nostrSecretKey) },
    evmOwner: evmOwnerFromR1(r1Uncompressed),
  };
}

/** Both public roots from a PRF output and the attested r1 key. */
export async function derivePasskeyIdentity(
  prfOutput: Uint8Array,
  r1Uncompressed: Uint8Array,
): Promise<PasskeyIdentity> {
  return passkeyIdentityFrom(
    await deriveNostrSecretKey(prfOutput),
    r1Uncompressed,
  );
}

/** Public owner-key view of a 65-byte uncompressed secp256r1 key. */
export function evmOwnerFromR1(r1Uncompressed: Uint8Array): {
  r1UncompressedHex: string;
  addressPreview?: string;
} {
  return {
    r1UncompressedHex: bytesToHex(r1Uncompressed),
    addressPreview: r1AddressPreview(r1Uncompressed),
  };
}

/**
 * Preview of the EOA-style address owning the future Kernel: keccak-256 of the
 * 64-byte affine encoding (x‖y), last 20 bytes — the conventional P-256 key
 * address. Display only: the deployed Kernel account address is assigned by
 * the factory (wave 4b), not derived here.
 */
export function r1AddressPreview(r1Uncompressed: Uint8Array): string {
  if (r1Uncompressed.length !== 65 || r1Uncompressed[0] !== 0x04) {
    throw new PasskeyAttestationError(
      "expected a 65-byte uncompressed secp256r1 public key (0x04‖x‖y)",
    );
  }
  const digest = keccak_256(r1Uncompressed.slice(1));
  return `0x${bytesToHex(digest.slice(12))}`;
}

// ---------------------------------------------------------------------------
// Minimal CBOR / COSE parse (registration attestation)
//
// Just enough canonical CBOR to walk a WebAuthn attestation object down to
// the attested credential's COSE_Key. Everything outside the supported subset
// (tags, floats, indefinite lengths, absurd sizes) is rejected loudly.
// ---------------------------------------------------------------------------

const CBOR_MAX_DEPTH = 8;
const CBOR_MAX_ITEMS = 256;
const CBOR_MAX_BSTR = 65_536;

interface CborDecode {
  value: unknown;
  end: number;
}

function cborFail(reason: string): never {
  throw new PasskeyAttestationError(`attestation CBOR: ${reason}`);
}

function decodeCbor(bytes: Uint8Array, start = 0, depth = 0): CborDecode {
  if (depth > CBOR_MAX_DEPTH) cborFail("nesting too deep");
  if (start >= bytes.length) cborFail("truncated");
  const initial = bytes[start];
  const major = initial >> 5;
  const info = initial & 0x1f;
  let arg = 0;
  let pos = start + 1;
  if (info < 24) {
    arg = info;
  } else if (info === 24) {
    if (pos + 1 > bytes.length) cborFail("truncated");
    arg = bytes[pos];
    pos += 1;
  } else if (info === 25) {
    if (pos + 2 > bytes.length) cborFail("truncated");
    arg = (bytes[pos] << 8) | bytes[pos + 1];
    pos += 2;
  } else if (info === 26) {
    if (pos + 4 > bytes.length) cborFail("truncated");
    arg =
      ((bytes[pos] << 24) |
        (bytes[pos + 1] << 16) |
        (bytes[pos + 2] << 8) |
        bytes[pos + 3]) >>>
      0;
    pos += 4;
  } else if (info === 27) {
    cborFail("64-bit numbers are not expected in WebAuthn attestation CBOR");
  } else if (info === 31) {
    cborFail("indefinite-length items are not canonical CBOR");
  } else {
    cborFail("reserved additional information");
  }

  switch (major) {
    case 0:
      return { value: arg, end: pos };
    case 1:
      return { value: -1 - arg, end: pos };
    case 2: {
      if (arg > CBOR_MAX_BSTR) cborFail("byte string too large");
      if (pos + arg > bytes.length) cborFail("truncated");
      return { value: bytes.slice(pos, pos + arg), end: pos + arg };
    }
    case 3: {
      if (arg > CBOR_MAX_BSTR) cborFail("text string too large");
      if (pos + arg > bytes.length) cborFail("truncated");
      return {
        value: new TextDecoder().decode(bytes.slice(pos, pos + arg)),
        end: pos + arg,
      };
    }
    case 4: {
      if (arg > CBOR_MAX_ITEMS) cborFail("array too large");
      const items: unknown[] = [];
      let offset = pos;
      for (let i = 0; i < arg; i++) {
        const item = decodeCbor(bytes, offset, depth + 1);
        items.push(item.value);
        offset = item.end;
      }
      return { value: items, end: offset };
    }
    case 5: {
      if (arg > CBOR_MAX_ITEMS) cborFail("map too large");
      const map = new Map<unknown, unknown>();
      let offset = pos;
      for (let i = 0; i < arg; i++) {
        const key = decodeCbor(bytes, offset, depth + 1);
        const val = decodeCbor(bytes, key.end, depth + 1);
        map.set(key.value, val.value);
        offset = val.end;
      }
      return { value: map, end: offset };
    }
    case 6:
      return cborFail(
        "CBOR tags are not expected in WebAuthn attestation CBOR",
      );
    case 7: {
      if (arg === 20) return { value: false, end: pos };
      if (arg === 21) return { value: true, end: pos };
      if (arg === 22) return { value: null, end: pos };
      return cborFail("floats and exotic simple values are not expected");
    }
    default:
      return cborFail("unsupported major type");
  }
}

/**
 * `authenticatorData` out of a WebAuthn `attestationObject` (CBOR map with
 * `fmt` / `attStmt` / `authData`). Works for any `fmt`, including `"none"`,
 * which still carries the attested credential data.
 */
export function parseAttestationAuthData(
  attestationObject: Uint8Array,
): Uint8Array {
  const { value } = decodeCbor(attestationObject, 0);
  if (!(value instanceof Map)) {
    throw new PasskeyAttestationError("attestation object is not a CBOR map");
  }
  const authData = value.get("authData");
  if (!(authData instanceof Uint8Array)) {
    throw new PasskeyAttestationError(
      "attestation object has no authData byte string",
    );
  }
  return authData;
}

export interface AttestedCredentialData {
  aaguid: Uint8Array;
  credentialId: Uint8Array;
  /** CBOR-encoded COSE_Key of the new credential. */
  coseKey: Uint8Array;
}

/**
 * Split `authenticatorData` (WebAuthn §6.1: rpIdHash ‖ flags ‖ signCount ‖
 * attestedCredentialData ‖ extensions) down to the attested COSE key.
 * Throws when the AT flag is unset or the buffer is malformed/truncated.
 */
export function parseAttestedCredentialData(
  authData: Uint8Array,
): AttestedCredentialData {
  if (authData.length < 37) {
    throw new PasskeyAttestationError("authenticator data is truncated");
  }
  const flags = authData[32];
  if ((flags & 0x40) === 0) {
    throw new PasskeyAttestationError(
      "the registration response carries no attested credential data (AT flag unset) — the secp256r1 owner key cannot be extracted",
    );
  }
  let offset = 37;
  const need = (n: number): void => {
    if (offset + n > authData.length) {
      throw new PasskeyAttestationError(
        "attested credential data is truncated",
      );
    }
  };
  need(18);
  const aaguid = authData.slice(offset, offset + 16);
  offset += 16;
  const credentialIdLength = (authData[offset] << 8) | authData[offset + 1];
  offset += 2;
  need(credentialIdLength);
  const credentialId = authData.slice(offset, offset + credentialIdLength);
  offset += credentialIdLength;
  const cose = decodeCbor(authData, offset);
  if (!(cose.value instanceof Map)) {
    throw new PasskeyAttestationError(
      "the credential public key is not a CBOR map (COSE_Key)",
    );
  }
  return {
    aaguid,
    credentialId,
    coseKey: authData.slice(offset, cose.end),
  };
}

/**
 * COSE_Key (RFC 9052) → 65-byte uncompressed secp256r1 point (0x04‖x‖y).
 * Only ES256 (EC2 / P-256) keys pass — the wave-4b WebAuthn validator
 * verifies P-256 signatures in-contract (EIP-7212).
 */
export function coseP256Uncompressed(coseKey: Uint8Array): Uint8Array {
  const { value, end } = decodeCbor(coseKey, 0);
  if (end !== coseKey.length) {
    throw new PasskeyAttestationError("trailing bytes after the COSE key");
  }
  if (!(value instanceof Map)) {
    throw new PasskeyAttestationError(
      "the credential public key is not a CBOR map (COSE_Key)",
    );
  }
  const kty = value.get(1);
  const alg = value.get(3);
  const crv = value.get(-1);
  const x = value.get(-2);
  const y = value.get(-3);
  if (kty !== 2) {
    throw new PasskeyAttestationError(
      `this passkey's public key is not an EC2 (elliptic-curve) key (kty ${String(kty)}) — only ES256/secp256r1 credentials can own the smart wallet`,
    );
  }
  if (alg !== -7) {
    throw new PasskeyAttestationError(
      `this passkey's public key is not ES256 (alg ${String(alg)}) — only ES256/secp256r1 credentials can own the smart wallet`,
    );
  }
  if (crv !== 1) {
    throw new PasskeyAttestationError(
      `this passkey's public key is not on P-256 (crv ${String(crv)})`,
    );
  }
  if (
    !(x instanceof Uint8Array) ||
    x.length !== 32 ||
    !(y instanceof Uint8Array) ||
    y.length !== 32
  ) {
    throw new PasskeyAttestationError(
      "the P-256 public key coordinates are not 32-byte strings",
    );
  }
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 33);
  return out;
}

// ---------------------------------------------------------------------------
// Ceremonies
// ---------------------------------------------------------------------------

export interface CreatePasskeyOptions {
  /** Relying-party display name shown by the platform prompt. */
  rpName: string;
  /** Relying-party id; defaults to the origin's effective domain. */
  rpId?: string;
  /** Credential user label shown by the platform prompt. */
  userLabel: string;
  /**
   * PRF `eval.first` salt (random 32 bytes when omitted). Persist it — it is
   * non-secret and is what makes re-derivation deterministic.
   */
  prfSalt?: Uint8Array;
}

export interface CreatedPasskey {
  credentialId: string;
  prfSalt: Uint8Array;
  /** Both public roots. */
  identity: PasskeyIdentity;
  /**
   * The Nostr secret key — kept in page memory only, never persisted.
   * Wipe it on sign-out (`clearPasskeySession`).
   */
  nostrSecretKey: Uint8Array;
}

export interface GetPasskeyAssertionOptions {
  /** base64url credential id from `createPasskey`. */
  credentialId: string;
  /**
   * PRF `eval.first` salt from registration. When passed, the result carries
   * the PRF output for re-derivation (throws `PrfUnavailableError` if the
   * platform withholds it); when omitted, a plain assertion is requested.
   */
  prfSalt?: Uint8Array;
  rpId?: string;
  challenge?: Uint8Array;
}

export interface PasskeyAssertion {
  credentialId: string;
  /**
   * ES256 signature by the credential's secp256r1 key over
   * `authenticatorData ‖ SHA-256(clientDataJSON)` (WebAuthn format — the
   * in-contract verifier for wave 4b checks exactly this).
   */
  signature: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  /** PRF output for `prfSalt` — present iff `prfSalt` was passed. */
  prfOutput?: Uint8Array;
}

function requireWebAuthn(): void {
  const missing =
    typeof navigator === "undefined" || !navigator.credentials?.create;
  const insecure =
    typeof globalThis.isSecureContext === "boolean" &&
    !globalThis.isSecureContext;
  if (missing || insecure) {
    const origin =
      typeof window !== "undefined" && window.location
        ? window.location.origin
        : "an unknown origin";
    throw new PasskeyEnvironmentError(
      `Passkeys need the WebAuthn API in a secure context (https, or http://localhost in development) — this page is ${origin}, where ${
        insecure
          ? "the browser reports an insecure context"
          : "navigator.credentials is unavailable"
      }. Nothing was created.`,
    );
  }
}

/** Dev escape hatch (same flag as the web-passkey branch): any
 * `sessionStorage["buzz.passkey.mock"]` routes ceremonies to a deterministic
 * fake; `"noprf"` additionally simulates a platform without PRF (the
 * iCloud-Keychain unlock-mode path). */
function mockMode(): "off" | "prf" | "noprf" {
  try {
    if (typeof sessionStorage === "undefined") return "off";
    const flag = sessionStorage.getItem("buzz.passkey.mock");
    if (flag === null) return "off";
    return flag === "noprf" ? "noprf" : "prf";
  } catch {
    return "off";
  }
}

type PrfExtensionOutput = {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
};

function prfResult(credential: Credential): Uint8Array | undefined {
  const results = (
    credential as unknown as {
      getClientExtensionResults?: () => PrfExtensionOutput;
    }
  ).getClientExtensionResults?.();
  const first = results?.prf?.results?.first;
  return first ? new Uint8Array(first) : undefined;
}

interface CeremonyCreateResult {
  credentialId: string;
  okmAtCreate?: Uint8Array;
  /** 65-byte uncompressed secp256r1 key (parsed from attestedCredentialData). */
  r1Uncompressed: Uint8Array;
}

async function performCreate(
  options: CreatePasskeyOptions,
  prfSalt: Uint8Array,
): Promise<CeremonyCreateResult> {
  const mode = mockMode();
  if (mode !== "off") {
    // Deterministic fake: PRF = SHA-256(salt), r1 = two hashes shaped like a
    // P-256 point encoding (a fake, not a curve point — dev only).
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", toAB(prfSalt)),
    );
    const credentialId = `mock-${b64urlEncode(prfSalt).slice(0, 24)}`;
    const x = new Uint8Array(
      await crypto.subtle.digest("SHA-256", toAB(prfSalt)),
    );
    const y = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        toAB(new TextEncoder().encode(b64urlEncode(prfSalt))),
      ),
    );
    const r1Uncompressed = new Uint8Array(65);
    r1Uncompressed[0] = 0x04;
    r1Uncompressed.set(x, 1);
    r1Uncompressed.set(y, 33);
    return {
      credentialId,
      okmAtCreate: mode === "prf" ? digest : undefined,
      r1Uncompressed,
    };
  }
  requireWebAuthn();
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: toAB(randomBytes(32)),
      rp: { id: options.rpId ?? rpId(), name: options.rpName },
      user: {
        id: toAB(randomBytes(16)),
        name: options.userLabel,
        displayName: options.userLabel,
      },
      // ES256 only: the smart-wallet root IS the credential's secp256r1 key,
      // so an RSA credential cannot satisfy the dual-root contract. Platform
      // authenticators support ES256 (CTAP2 baseline).
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      attestation: "none",
      extensions: {
        prf: { eval: { first: toAB(prfSalt) } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("passkey registration cancelled");
  const credentialId = b64urlEncode(new Uint8Array(credential.rawId));
  const created: CreatedPasskeyRef = { credentialId };
  const attestation = credential.response as AuthenticatorAttestationResponse;
  let r1Uncompressed: Uint8Array;
  try {
    const authData = parseAttestationAuthData(
      new Uint8Array(attestation.attestationObject),
    );
    const attested = parseAttestedCredentialData(authData);
    r1Uncompressed = coseP256Uncompressed(attested.coseKey);
  } catch (error) {
    if (error instanceof PasskeyError) {
      throw new PasskeyAttestationError(error.message, created);
    }
    throw error;
  }
  return {
    credentialId,
    okmAtCreate: prfResult(credential),
    r1Uncompressed,
  };
}

async function performGet(
  options: GetPasskeyAssertionOptions,
): Promise<PasskeyAssertion> {
  const mode = mockMode();
  if (mode !== "off") {
    const prfOutput =
      options.prfSalt && mode === "prf"
        ? new Uint8Array(
            await crypto.subtle.digest("SHA-256", toAB(options.prfSalt)),
          )
        : undefined;
    return {
      credentialId: options.credentialId,
      signature: new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          toAB(new TextEncoder().encode(`assert-${options.credentialId}`)),
        ),
      ),
      authenticatorData: new Uint8Array(37),
      clientDataJSON: new TextEncoder().encode(
        '{"type":"webauthn.get","challenge":"mock"}',
      ),
      prfOutput,
    };
  }
  requireWebAuthn();
  const extensions: AuthenticationExtensionsClientInputs | undefined =
    options.prfSalt
      ? ({
          prf: { eval: { first: toAB(options.prfSalt) } },
        } as AuthenticationExtensionsClientInputs)
      : undefined;
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: toAB(options.challenge ?? randomBytes(32)),
      rpId: options.rpId ?? rpId(),
      allowCredentials: [
        { id: toAB(b64urlDecode(options.credentialId)), type: "public-key" },
      ],
      userVerification: "required",
      ...(extensions ? { extensions } : {}),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("passkey authentication cancelled");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    credentialId: options.credentialId,
    signature: new Uint8Array(response.signature),
    authenticatorData: new Uint8Array(response.authenticatorData),
    clientDataJSON: new Uint8Array(response.clientDataJSON),
    prfOutput: options.prfSalt ? prfResult(credential) : undefined,
  };
}

/**
 * One registration ceremony, both identity roots: PRF(`eval.first`, salt) →
 * HKDF-SHA256 → secp256k1 Nostr key, plus the attested secp256r1 key as the
 * future smart-wallet owner.
 *
 * Some platforms defer the PRF result to the first assertion; one follow-up
 * assertion with the same salt covers that (the branch's posture). When the
 * platform provides no PRF at all this throws `PrfUnavailableError` carrying
 * the created credential, so callers can fall back (unlock mode) without
 * orphaning the passkey.
 */
export async function createPasskey(
  options: CreatePasskeyOptions,
): Promise<CreatedPasskey> {
  const prfSalt = options.prfSalt ?? randomBytes(32);
  const created = await performCreate(options, prfSalt);
  const createdRef: CreatedPasskeyRef = {
    credentialId: created.credentialId,
    r1UncompressedHex: bytesToHex(created.r1Uncompressed),
  };
  let prfOutput = created.okmAtCreate;
  if (!prfOutput) {
    prfOutput = (
      await performGet({
        credentialId: created.credentialId,
        prfSalt,
        rpId: options.rpId,
      })
    ).prfOutput;
  }
  if (!prfOutput) throw new PrfUnavailableError(createdRef);
  const nostrSecretKey = await deriveNostrSecretKey(prfOutput);
  return {
    credentialId: created.credentialId,
    prfSalt,
    identity: passkeyIdentityFrom(nostrSecretKey, created.r1Uncompressed),
    nostrSecretKey,
  };
}

/**
 * Signed assertion by the passkey's secp256r1 key (the wave-4b UserOp /
 * WebAuthn-validator input), plus the second PRF evaluation of the
 * registration salt for deterministic re-derivation of the Nostr key.
 */
export async function getPasskeyAssertion(
  options: GetPasskeyAssertionOptions,
): Promise<PasskeyAssertion> {
  const result = await performGet(options);
  if (options.prfSalt && !result.prfOutput) {
    throw new PrfUnavailableError();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Error explanations — a failed ceremony must say why, honestly.
// ---------------------------------------------------------------------------

/**
 * Map any ceremony failure to copy a person can act on: secure-context /
 * origin requirements, dismissed prompts, and PRF-less platforms all get a
 * distinct explanation instead of a raw `DOMException`.
 */
export function explainPasskeyError(error: unknown): string {
  if (
    error instanceof PasskeyEnvironmentError ||
    error instanceof PrfUnavailableError ||
    error instanceof PasskeyAttestationError
  ) {
    return error.message;
  }
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  switch (name) {
    case "NotAllowedError":
      return "The passkey prompt was dismissed or timed out — nothing was created. Try again and complete the touch.";
    case "InvalidStateError":
      return "This authenticator already holds this credential — sign in instead of registering.";
    case "SecurityError":
      return "The browser refused this ceremony for the current origin. Passkeys are bound to their domain and need a secure context — https, or http://localhost in development.";
    case "NotSupportedError":
      return "This browser or authenticator does not support the requested passkey (a platform ES256 passkey).";
    case "ConstraintError":
      return "The authenticator did not meet the passkey requirements (platform attachment, user verification).";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
