/**
 * WebAuthn signature wrapping — golden + negative vectors.
 *
 * Derivations:
 * - DER vectors are hand-built byte sequences (RFC 5480 ECDSA-Sig-Value
 *   profile) exercising the strict parser; each is annotated.
 * - The real-signature fixture is signed with `node:crypto` (P-256,
 *   `crypto.sign("sha256", message, key)` = ECDSA over SHA-256 of
 *   `authenticatorData ‖ sha256(clientDataJSON)`, the WebAuthn §6.3 scheme)
 *   and the parsed `r ‖ s` is verified **independently** with
 *   `crypto.verify(..., { dsaEncoding: "ieee-p1363" })` — a parser drift that
 *   flips any bit fails this file.
 * - Tuple encodings match `cast abi-encode` vectors (commands inline).
 * - clientDataJSON index fixtures follow `passkey.test.mjs`'s constructed
 *   vector style (canonical Chrome field order puts `"challenge":"` at byte 23
 *   — the ZeroDev validator's hard-coded CHALLENGE_LOCATION).
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";
import { b64urlEncode } from "./passkey.ts";
import {
  MAX_CLIENT_DATA_JSON_BYTES,
  ZERODEV_CHALLENGE_LOCATION,
  ZERODEV_DUMMY_RESPONSE_TYPE_LOCATION,
  derToRs,
  encodeWebAuthnAuth,
  encodeZeroDevWebAuthnSignature,
  locateClientDataField,
  wrapPasskeyAssertionAsWebAuthnAuth,
  wrapPasskeyAssertionForZeroDevValidator,
} from "./webauthn-auth.ts";

test("derToRs parses minimal DER and pads scalars to 32 bytes", () => {
  // 30 06 | 02 01 01 | 02 01 02  — SEQUENCE { INTEGER 1, INTEGER 2 }
  assert.deepEqual(derToRs("0x3006020101020102"), {
    r: `0x${"00".repeat(31)}01`,
    s: `0x${"00".repeat(31)}02`,
  });
  // 30 07 | 02 02 00 80 | 02 01 02 — r = 0x80 with one sign byte, stripped.
  assert.deepEqual(derToRs("0x300702020080020102"), {
    r: `0x${"00".repeat(31)}80`,
    s: `0x${"00".repeat(31)}02`,
  });
});

test("derToRs normalizes high-s to the low-s form (P256.verifySignature rejects s > n/2)", () => {
  // s = n − 1 (high-s), r = 1 — both INTEGERs carry the DER sign byte.
  const n = BigInt(
    "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
  );
  const rInt = "020101";
  const sInt = `022100${(n - 1n).toString(16).padStart(64, "0")}`;
  const body = rInt + sInt;
  const der = `0x30${(body.length / 2).toString(16).padStart(2, "0")}${body}`;
  const parsed = derToRs(der);
  assert.equal(parsed.r, `0x${"00".repeat(31)}01`);
  // Low-s twin of n − 1 is 1.
  assert.equal(parsed.s, `0x${"00".repeat(31)}01`);
});

test("derToRs rejects malformed DER loudly", () => {
  // Negative INTEGER (high bit set without sign byte).
  assert.throws(() => derToRs("0x3006020181020102"), /negative/);
  // Non-minimal padding: 0x00 sign byte on a value < 0x80.
  assert.throws(() => derToRs("0x300702020001020102"), /non-minimal padding/);
  // Zero scalar.
  assert.throws(() => derToRs("0x3006020100020102"), /is zero/);
  // Below the 8-byte floor (truncation lands here first).
  assert.throws(() => derToRs("0x30"), /out of range/);
  assert.throws(() => derToRs("0x300602010102"), /out of range/);
  // Long-form length byte is never needed under 128 bytes — rejected.
  assert.throws(() => derToRs("0x308106020101020102"), /does not cover/);
  // Trailing bytes inside the SEQUENCE.
  assert.throws(() => derToRs("0x3008020101020102ffff"), /trailing bytes/);
  // 34-byte INTEGER: 02 22 00 80 ‖ 32×0x11, then s — exceeds 32 after stripping.
  const oversized = `0x30${(0x27).toString(16)}02220080${"11".repeat(32)}020102`;
  assert.throws(() => derToRs(oversized), /exceeds 32/);
  // Truncated below the 8-byte floor vs. inside the range.
  assert.throws(() => derToRs("0x30060201010201"), /out of range/);
  assert.throws(() => derToRs("0x3007020200800201"), /does not cover/);
  // Odd-length hex and non-hex input.
  assert.throws(() => derToRs("0x300"), /even-length|even number/);
  assert.throws(() => derToRs("zz"), /hex/);
});

test("locateClientDataField finds byte offsets in canonical clientDataJSON", () => {
  // `{"type":"webauthn.get",` is 23 bytes, so `"challenge":"` starts at 23 —
  // exactly WebAuthnValidator.CHALLENGE_LOCATION (kernel-7579-plugins).
  const canonical =
    '{"type":"webauthn.get","challenge":"AAAA","origin":"https://example.com","crossOrigin":false}';
  assert.equal(locateClientDataField(canonical, "challenge"), 23);
  assert.equal(locateClientDataField(canonical, "type"), 1);
  assert.equal(ZERODEV_CHALLENGE_LOCATION, 23);
  // Off-order JSON is located honestly instead of assumed.
  const reordered = '{"challenge":"AAAA","type":"webauthn.get"}';
  assert.equal(locateClientDataField(reordered, "challenge"), 1);
  assert.equal(locateClientDataField(reordered, "type"), 20);
});

test("locateClientDataField fails loudly on missing, duplicate, and oversized JSON", () => {
  assert.throws(
    () => locateClientDataField('{"type":"webauthn.get"}', "challenge"),
    /missing the "challenge" field/,
  );
  assert.throws(
    () => locateClientDataField('{"challenge":"AAAA"}', "type"),
    /missing the "type" field/,
  );
  assert.throws(
    () =>
      locateClientDataField(
        '{"challenge":"A","challenge":"B","type":"webauthn.get"}',
        "challenge",
      ),
    /2 "challenge" fields/,
  );
  const oversized = `{"pad":"${"a".repeat(MAX_CLIENT_DATA_JSON_BYTES)}"}`;
  assert.throws(
    () => locateClientDataField(oversized, "challenge"),
    /over the/,
  );
  // Right at the bound is still accepted.
  const exact = `{"challenge":"A","pad":"${"a".repeat(MAX_CLIENT_DATA_JSON_BYTES - 30)}"}`;
  assert.ok(exact.length <= MAX_CLIENT_DATA_JSON_BYTES + 30);
  assert.equal(typeof locateClientDataField(exact, "challenge"), "number");
});

/** Constructed assertion fixture (passkey.test.mjs style) with a real P-256 signature. */
function makeFixture(options = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const challengeHex =
    options.challengeHex ??
    `0x${"d6cacc8eda8775806acb23b07822677a113e5a7bb8fb41e1e840f11f6331d67a"}`;
  const challengeB64 = b64urlEncode(
    Uint8Array.from(Buffer.from(challengeHex.slice(2), "hex")),
  );
  const flags = options.flags ?? 0x05; // UP | UV
  const rpIdHash = createHash("sha256").update("localhost").digest();
  const authenticatorData = Buffer.concat([
    rpIdHash,
    Buffer.from([flags]),
    Buffer.alloc(4, 0),
    ...(options.extraAuthData
      ? [Buffer.from(options.extraAuthData, "hex")]
      : []),
  ]);
  const clientDataJSON =
    options.clientDataJSON ??
    `{"type":"webauthn.get","challenge":"${challengeB64}","origin":"https://example.com","crossOrigin":false}`;
  const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
  const message = Buffer.concat([authenticatorData, clientDataHash]);
  const der = sign("sha256", message, privateKey);
  return {
    assertion: {
      credentialId: "0x0102",
      signature: der,
      authenticatorData,
      clientDataJSON: Buffer.from(clientDataJSON),
    },
    challengeHex,
    message,
    publicKey,
  };
}

test("derToRs output verifies independently via node:crypto ieee-p1363", () => {
  const { assertion, message, publicKey } = makeFixture();
  const { r, s } = derToRs(assertion.signature);
  const p1363 = Buffer.concat([
    Buffer.from(r.slice(2), "hex"),
    Buffer.from(s.slice(2), "hex"),
  ]);
  assert.equal(
    verify(
      "sha256",
      message,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      p1363,
    ),
    true,
  );
  // Flipping one bit of r must invalidate it (falsifiable).
  p1363[31] ^= 0x01;
  assert.equal(
    verify(
      "sha256",
      message,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      p1363,
    ),
    false,
  );
});

test("wrapPasskeyAssertionAsWebAuthnAuth locates both JSON offsets and validates the challenge", () => {
  const { assertion, challengeHex } = makeFixture();
  const wrapped = wrapPasskeyAssertionAsWebAuthnAuth(assertion, {
    challengeHex,
  });
  assert.equal(wrapped.challengeIndex, 23);
  assert.equal(wrapped.typeIndex, 1);
  assert.deepEqual(derToRs(assertion.signature), {
    r: wrapped.r,
    s: wrapped.s,
  });
  assert.equal(wrapped.encoded, encodeWebAuthnAuth(wrapped));
});

test("encodeWebAuthnAuth matches cast abi-encode (bytes,string,uint256,uint256,bytes32,bytes32)", () => {
  // $ cast abi-encode "f(bytes,string,uint256,uint256,bytes32,bytes32)" \
  //     0x1234 "hello" 3 4 0x...05 0x...06
  const expected =
    "0x00000000000000000000000000000000000000000000000000000000000000c0" +
    "0000000000000000000000000000000000000000000000000000000000000100" +
    "0000000000000000000000000000000000000000000000000000000000000003" +
    "0000000000000000000000000000000000000000000000000000000000000004" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "0000000000000000000000000000000000000000000000000000000000000006" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "1234000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "68656c6c6f000000000000000000000000000000000000000000000000000000";
  assert.equal(
    encodeWebAuthnAuth({
      authenticatorData: "0x1234",
      clientDataJSON: "hello",
      challengeIndex: 3,
      typeIndex: 4,
      r: `0x${"00".repeat(31)}05`,
      s: `0x${"00".repeat(31)}06`,
    }),
    expected,
  );
});

test("encodeZeroDevWebAuthnSignature matches cast abi-encode (bytes,string,uint256,uint256,uint256,bool)", () => {
  // $ cast abi-encode "f(bytes,string,uint256,uint256,uint256,bool)" \
  //     0x1234 "hello" 3 4 5 true
  const expected =
    "0x00000000000000000000000000000000000000000000000000000000000000c0" +
    "0000000000000000000000000000000000000000000000000000000000000100" +
    "0000000000000000000000000000000000000000000000000000000000000003" +
    "0000000000000000000000000000000000000000000000000000000000000004" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "1234000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "68656c6c6f000000000000000000000000000000000000000000000000000000";
  assert.equal(
    encodeZeroDevWebAuthnSignature({
      authenticatorData: "0x1234",
      clientDataJSON: "hello",
      responseTypeLocation: 3n,
      r: 4n,
      s: 5n,
      usePrecompiled: true,
    }),
    expected,
  );
  assert.equal(ZERODEV_DUMMY_RESPONSE_TYPE_LOCATION, (1n << 256n) - 1n);
});

test("wrapPasskeyAssertionForZeroDevValidator requires the challenge at byte 23", () => {
  const { assertion, challengeHex } = makeFixture();
  const wrapped = wrapPasskeyAssertionForZeroDevValidator(assertion, {
    challengeHex,
    usePrecompiled: false,
  });
  assert.equal(wrapped.responseTypeLocation, 1n);
  assert.equal(wrapped.usePrecompiled, false);
  assert.deepEqual(derToRs(assertion.signature), {
    r: `0x${wrapped.r.toString(16).padStart(64, "0")}`,
    s: `0x${wrapped.s.toString(16).padStart(64, "0")}`,
  });

  // Off-order JSON can never verify on the ZeroDev validator — fail with the
  // offset. The solady-style wrapper accepts it (it locates both offsets).
  const canonical = makeFixture();
  const b64 = canonical.assertion.clientDataJSON
    .toString()
    .split('"challenge":"')[1]
    .split('"')[0];
  const moved = makeFixture({
    clientDataJSON: `{"challenge":"${b64}","type":"webauthn.get","origin":"https://example.com"}`,
  });
  assert.throws(
    () =>
      wrapPasskeyAssertionForZeroDevValidator(moved.assertion, {
        challengeHex: moved.challengeHex,
        usePrecompiled: true,
      }),
    /requires 23/,
  );
  const located = wrapPasskeyAssertionAsWebAuthnAuth(moved.assertion, {
    challengeHex: moved.challengeHex,
  });
  assert.equal(located.challengeIndex, 1);
});

test("wrappers reject a mismatched challenge and weak authenticator flags", () => {
  const { assertion } = makeFixture();
  // The assertion signed challengeHex A; claiming hash B must throw.
  assert.throws(
    () =>
      wrapPasskeyAssertionAsWebAuthnAuth(assertion, {
        challengeHex: `0x${"11".repeat(32)}`,
      }),
    /different hash/,
  );
  // UV missing (flags 0x01 = UP only).
  const noUv = makeFixture({ flags: 0x01 });
  assert.throws(
    () =>
      wrapPasskeyAssertionAsWebAuthnAuth(noUv.assertion, {
        challengeHex: noUv.challengeHex,
      }),
    /UV/,
  );
  // BE/BS contradiction (BS without BE) — flags UP|UV|BS = 0x15.
  const badBs = makeFixture({ flags: 0x15 });
  assert.throws(
    () =>
      wrapPasskeyAssertionAsWebAuthnAuth(badBs.assertion, {
        challengeHex: badBs.challengeHex,
      }),
    /BS set without BE/,
  );
  // Short authenticatorData.
  const short = makeFixture();
  short.assertion.authenticatorData = Uint8Array.from(Buffer.alloc(36));
  assert.throws(
    () =>
      wrapPasskeyAssertionAsWebAuthnAuth(short.assertion, {
        challengeHex: short.challengeHex,
      }),
    /at least 37/,
  );
});
