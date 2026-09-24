/**
 * Pure-derivation and parse tests for the passkey dual-root layer.
 *
 * Vectors:
 * - HKDF is checked against RFC 5869 Appendix A, Test Case 3 (external
 *   truth). Our HKDF uses an all-zero 32-byte salt; for HMAC-based HKDF that
 *   is byte-identical to the RFC's zero-length salt (both pad to the same
 *   HMAC key block), so Test Case 3's OKM applies verbatim.
 * - The PRF→Nostr pins were computed once from the production chain on
 *   2026-09-24 for the fixed PRF input below — a derivation change must fail
 *   this file.
 * - The attestation vector is constructed (the web-passkey branch ships no
 *   vectors): `authenticatorData` per WebAuthen §6.1 (rpIdHash =
 *   SHA-256("localhost"), flags 0x45 = UP|UV|AT, zero AAGUID,
 *   credentialId 000102…0f, COSE key in CTAP2 canonical order 1,3,-1,-2,-3 —
 *   RFC 9052 §7.1.1), wrapped in the `attestationObject` map of WebAuthn
 *   §8.2 ({fmt:"none", attStmt:{}, authData}). x‖y is the NIST P-256 base
 *   point (FIPS 186-4 appendix D.1.2.3), so the expected 04‖x‖y is external
 *   truth, not a self-pin. The same construction is exercised against a real
 *   Chrome virtual authenticator in tests/e2e/passkey.spec.ts.
 * - The r1 address pin is anchored by the keccak-256("") constant in the
 *   sibling test (the Ethereum keccak, not SHA3-256).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { hexToBytes } from "@noble/hashes/utils.js";

import {
  coseP256Uncompressed,
  createPasskey,
  deriveNostrSecretKey,
  derivePasskeyIdentity,
  explainPasskeyError,
  getPasskeyAssertion,
  hkdfSha256,
  nostrPubkeyHex,
  parseAttestationAuthData,
  parseAttestedCredentialData,
  PasskeyAttestationError,
  PasskeyEnvironmentError,
  PrfUnavailableError,
  r1AddressPreview,
} from "./passkey.ts";

// NIST P-256 base point (FIPS 186-4 appendix D.1.2.3).
const GX = hexToBytes(
  "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
);
const GY = hexToBytes(
  "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
);
const G_UNCOMPRESSED_HEX = `04${Buffer.from(GX).toString("hex")}${Buffer.from(GY).toString("hex")}`;

// Canonical CTAP2-ordered COSE EC2/P-256 key of the base point:
// {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}.
const COSE_G =
  "a5010203262001215820" +
  Buffer.from(GX).toString("hex") +
  "225820" +
  Buffer.from(GY).toString("hex");

// Constructed WebAuthn registration attestation (see header) carrying COSE_G.
const ATTESTATION_HEX =
  "a363666d74646e6f6e65" + // {"fmt":"none"
  "6761747453746d74a0" + //  "attStmt":{}
  "6861757468446174615894" + //  "authData": h'148 bytes'
  "49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763" + // rpIdHash(SHA-256("localhost"))
  "45" + // flags: UP | UV | AT
  "00000000" + // signCount
  "00000000000000000000000000000000" + // aaguid
  "0010" + // credentialIdLength = 16
  "000102030405060708090a0b0c0d0e0f" + // credentialId
  COSE_G;

const FIXED_PRF_HEX =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
// Production-chain pins (2026-09-24) for FIXED_PRF_HEX → HKDF → secp256k1.
const EXPECTED_NOSTR_SK_HEX =
  "35430cd334f6fe898d7b37886f33a3612edea16fce04fe8bceb92f863e309bf6";
const EXPECTED_NOSTR_PUB_HEX =
  "489e1b47933dfababa9842058b3a19e2f15cc7f6da0c6f1983688aabe66c2353";
// keccak-256(Gx‖Gy)[12:] — anchored by the keccak-256("") constant below.
const EXPECTED_G_ADDRESS = "0xd3a9f047ad43d7e2e4e7e491f1fe2e657a2651b6";

function hex(u8) {
  return Buffer.from(u8).toString("hex");
}

test("hkdfSha256 matches RFC 5869 Appendix A, Test Case 3", async () => {
  // IKM = 0x0b × 22, salt = zero-length (≡ all-zero HashLen salt), info = "".
  const okm = await hkdfSha256(
    new Uint8Array(22).fill(0x0b),
    new Uint8Array(0),
  );
  // First 32 of the RFC's 42-byte OKM:
  // 8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d…
  assert.equal(
    hex(okm),
    "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d",
  );
});

test("a fixed PRF output derives the pinned Nostr key", async () => {
  const prf = hexToBytes(FIXED_PRF_HEX);
  const sk = await deriveNostrSecretKey(prf);
  assert.equal(hex(sk), EXPECTED_NOSTR_SK_HEX);
  assert.equal(nostrPubkeyHex(sk), EXPECTED_NOSTR_PUB_HEX);
  // Deterministic: same credential + salt anywhere re-derives the same key.
  const again = await deriveNostrSecretKey(hexToBytes(FIXED_PRF_HEX));
  assert.equal(hex(again), EXPECTED_NOSTR_SK_HEX);
  // A different PRF output must not collide into the same key.
  const other = await deriveNostrSecretKey(new Uint8Array(32).fill(0x11));
  assert.notEqual(hex(other), EXPECTED_NOSTR_SK_HEX);
});

test("the r1 address preview is keccak (Ethereum), pinned on the base point", async () => {
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  // External anchor: keccak-256("") — the Ethereum keccak, not SHA3-256.
  assert.equal(
    hex(keccak_256(new Uint8Array(0))),
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  const g = hexToBytes(G_UNCOMPRESSED_HEX);
  assert.equal(r1AddressPreview(g), EXPECTED_G_ADDRESS);
});

test("the attestation vector yields both identity roots", async () => {
  const authData = parseAttestationAuthData(hexToBytes(ATTESTATION_HEX));
  const attested = parseAttestedCredentialData(authData);
  assert.equal(hex(attested.credentialId), "000102030405060708090a0b0c0d0e0f");
  assert.equal(hex(attested.aaguid), "00".repeat(16));
  assert.equal(hex(attested.coseKey), COSE_G);

  const r1 = coseP256Uncompressed(attested.coseKey);
  assert.equal(hex(r1), G_UNCOMPRESSED_HEX);

  const identity = await derivePasskeyIdentity(hexToBytes(FIXED_PRF_HEX), r1);
  assert.deepEqual(identity, {
    nostr: { pubkeyHex: EXPECTED_NOSTR_PUB_HEX },
    evmOwner: {
      r1UncompressedHex: G_UNCOMPRESSED_HEX,
      addressPreview: EXPECTED_G_ADDRESS,
    },
  });
});

test("malformed attestations fail loudly instead of guessing a key", () => {
  // COSE key variants: start from the valid base-point key and break one field.
  const cases = [
    {
      name: "non-EC2 kty (RSA credential)",
      cose: `a50103${COSE_G.slice(6)}`,
      error: /EC2/,
    },
    {
      name: "non-ES256 alg",
      cose: `a501020327${COSE_G.slice(10)}`,
      error: /ES256/,
    },
    {
      name: "non-P-256 curve",
      cose: `a5010203262002${COSE_G.slice(14)}`,
      error: /P-256/,
    },
    {
      name: "short x coordinate",
      cose: `a501020326200121581f${"ab".repeat(31)}225820${Buffer.from(GY).toString("hex")}`,
      error: /32-byte/,
    },
    {
      name: "empty key map",
      cose: "a0",
      error: /EC2/,
    },
    {
      name: "non-map key",
      cose: "4100",
      error: /COSE_Key/,
    },
    {
      name: "trailing bytes after the key",
      cose: `${COSE_G}00`,
      error: /trailing bytes/,
    },
    {
      name: "truncated key",
      cose: COSE_G.slice(0, -4),
      error: /truncated/,
    },
  ];
  for (const c of cases) {
    assert.throws(
      () => coseP256Uncompressed(hexToBytes(c.cose)),
      (e) => e instanceof PasskeyAttestationError && c.error.test(e.message),
      c.name,
    );
  }

  // authData without the AT flag carries no credential key at all.
  const noAt = new Uint8Array(37);
  noAt[32] = 0x05; // UP | UV, no AT
  assert.throws(
    () => parseAttestedCredentialData(noAt),
    /no attested credential data/,
  );
  assert.throws(
    () => parseAttestedCredentialData(new Uint8Array(20)),
    /truncated/,
  );
  // AT set but the attested credential data is cut short.
  const cut = new Uint8Array(45);
  cut[32] = 0x45;
  assert.throws(() => parseAttestedCredentialData(cut), /truncated/);

  // attestationObject shape failures.
  assert.throws(
    () => parseAttestationAuthData(hexToBytes("4100")),
    /not a CBOR map/,
  );
  assert.throws(
    () => parseAttestationAuthData(hexToBytes("a163666d74646e6f6e65")),
    /no authData/,
  );
  assert.throws(
    () => parseAttestationAuthData(hexToBytes(ATTESTATION_HEX).slice(0, 100)),
    /truncated/,
  );
});

test("an environment without WebAuthn gets an honest explanation", async () => {
  // node has no navigator.credentials — exactly the "no WebAuthn here" case.
  for (const run of [
    () => createPasskey({ rpName: "Creaton", userLabel: "Test" }),
    () => getPasskeyAssertion({ credentialId: "abc" }),
  ]) {
    await assert.rejects(run, (e) => {
      assert.ok(e instanceof PasskeyEnvironmentError, String(e));
      const message = explainPasskeyError(e);
      assert.match(message, /WebAuthn/);
      assert.match(message, /secure context/);
      assert.match(message, /https/);
      assert.match(message, /localhost/);
      return true;
    });
  }
});

test("explainPasskeyError maps ceremony failures to honest copy", () => {
  const table = [
    {
      error: new DOMException("gone", "NotAllowedError"),
      expect: /dismissed or timed out/,
    },
    {
      error: new DOMException("dup", "InvalidStateError"),
      expect: /sign in instead/,
    },
    {
      error: new DOMException("rp", "SecurityError"),
      expect: /bound to their domain.*secure context/s,
    },
    {
      error: new DOMException("alg", "NotSupportedError"),
      expect: /ES256/,
    },
    {
      error: new DOMException("uv", "ConstraintError"),
      expect: /platform attachment/,
    },
    { error: new Error("low-level detail"), expect: /low-level detail/ },
    { error: "string failure", expect: /string failure/ },
    {
      error: new PrfUnavailableError(),
      expect: /PRF support/,
    },
    {
      error: new PasskeyAttestationError("no P-256 key here"),
      expect: /no P-256 key here/,
    },
  ];
  for (const c of table) {
    assert.match(explainPasskeyError(c.error), c.expect);
  }
});
