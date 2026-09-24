/**
 * Wire↔typed mapping and error-copy tests for the desktop passkey contract
 * (`./passkeyContract.ts`), mirroring the error-copy table of
 * `web/src/features/identity/lib/passkey.test.mjs` (`explainPasskeyError`).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertionOptionsToWire,
  createOptionsToWire,
  explainPasskeyError,
  mapCommandError,
  PasskeyAttestationError,
  PasskeyEnvironmentError,
  PasskeyError,
  PasskeyUnsupportedPlatformError,
  PrfUnavailableError,
  rawAssertionToTyped,
  rawCreatedToTyped,
} from "./passkeyContract.ts";

// Pinned identity — the web parity vector (see passkey_derive tests).
const G_UNCOMPRESSED_HEX =
  "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
const EXPECTED_NOSTR_PUB_HEX =
  "489e1b47933dfababa9842058b3a19e2f15cc7f6da0c6f1983688aabe66c2353";
const EXPECTED_G_ADDRESS = "0xd3a9f047ad43d7e2e4e7e491f1fe2e657a2651b6";

test("rawCreatedToTyped restores web's Uint8Array shapes", () => {
  const typed = rawCreatedToTyped({
    credentialId: "AAECAwQFBgcICQoLDA0ODw",
    prfSalt: [42, 42],
    identity: {
      nostr: { pubkeyHex: EXPECTED_NOSTR_PUB_HEX },
      evmOwner: {
        r1UncompressedHex: G_UNCOMPRESSED_HEX,
        addressPreview: EXPECTED_G_ADDRESS,
      },
    },
    nostrSecretKey: [1, 2, 3],
    ceremony: { rpId: "app.buzz.example", origin: "https://app.buzz.example" },
  });
  assert.equal(typed.credentialId, "AAECAwQFBgcICQoLDA0ODw");
  assert.deepEqual([...typed.prfSalt], [42, 42]);
  assert.deepEqual([...typed.nostrSecretKey], [1, 2, 3]);
  assert.deepEqual(typed.identity, {
    nostr: { pubkeyHex: EXPECTED_NOSTR_PUB_HEX },
    evmOwner: {
      r1UncompressedHex: G_UNCOMPRESSED_HEX,
      addressPreview: EXPECTED_G_ADDRESS,
    },
  });
});

test("the ceremony provenance record crosses the wire with stable names", () => {
  // Fixture is exactly the JSON `CeremonyProvenance` serializes to in Rust
  // (`desktop/src-tauri/src/commands/passkey.rs`, `rename_all = "camelCase"`).
  // The in-contract WebAuthn validator reads this record for
  // expectedRPID/expectedOrigin (the coupling contract), so the wire names
  // are part of the contract — the Rust test `created_passkey_wire_names_are_stable`
  // locks the other side of this pair.
  const typed = rawCreatedToTyped({
    credentialId: "AAECAwQFBgcICQoLDA0ODw",
    prfSalt: [42, 42],
    identity: {
      nostr: { pubkeyHex: EXPECTED_NOSTR_PUB_HEX },
      evmOwner: {
        r1UncompressedHex: G_UNCOMPRESSED_HEX,
        addressPreview: EXPECTED_G_ADDRESS,
      },
    },
    nostrSecretKey: [1, 2, 3],
    ceremony: { rpId: "app.buzz.example", origin: "https://app.buzz.example" },
  });
  assert.deepEqual(typed.ceremony, {
    rpId: "app.buzz.example",
    origin: "https://app.buzz.example",
  });
});

test("rawAssertionToTyped keeps prfOutput conditional", () => {
  const base = {
    credentialId: "abc",
    signature: [0x30],
    authenticatorData: [0],
    clientDataJSON: [123, 125],
  };
  assert.equal(rawAssertionToTyped(base).prfOutput, undefined);
  const withPrf = rawAssertionToTyped({ ...base, prfOutput: [9, 9] });
  assert.deepEqual([...withPrf.prfOutput], [9, 9]);
});

test("options cross the IPC boundary as JSON number arrays", () => {
  const wire = createOptionsToWire({
    rpName: "Buzz",
    userLabel: "Test",
    prfSalt: new Uint8Array([1, 2]),
  });
  assert.deepEqual(wire, {
    rpName: "Buzz",
    rpId: null,
    userLabel: "Test",
    prfSalt: [1, 2],
  });
  const assertionWire = assertionOptionsToWire({
    credentialId: "abc",
    prfSalt: new Uint8Array([3]),
  });
  assert.deepEqual(assertionWire, {
    credentialId: "abc",
    prfSalt: [3],
    rpId: null,
    challenge: null,
  });
});

test("mapCommandError restores the web error classes from stable codes", () => {
  const cases = [
    {
      wire: { code: "environment", message: "no ceremony here" },
      instance: PasskeyEnvironmentError,
    },
    {
      wire: {
        code: "prf_unavailable",
        message: "prf gone",
        created: { credentialId: "abc" },
      },
      instance: PrfUnavailableError,
    },
    {
      wire: { code: "attestation", message: "no P-256 key here" },
      instance: PasskeyAttestationError,
    },
    {
      wire: {
        code: "unsupported_platform",
        message: "not wired",
        detail: "ledger",
      },
      instance: PasskeyUnsupportedPlatformError,
    },
    { wire: { code: "failed", message: "cancelled" }, instance: PasskeyError },
  ];
  for (const c of cases) {
    const mapped = mapCommandError(c.wire);
    assert.ok(mapped instanceof c.instance, `${c.wire.code}: ${mapped.name}`);
    if (c.wire.code === "prf_unavailable") {
      assert.equal(mapped.created?.credentialId, "abc");
      assert.match(mapped.message, /PRF support/);
    }
    if (c.wire.code === "unsupported_platform") {
      assert.equal(mapped.detail, "ledger");
    }
  }
  // Unknown shapes never masquerade as success or as a typed class.
  const unknown = mapCommandError("string failure");
  assert.ok(unknown instanceof PasskeyError);
  assert.equal(unknown.message, "string failure");
});

test("explainPasskeyError maps failures to honest copy", () => {
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
    { error: new PrfUnavailableError(), expect: /PRF support/ },
    {
      error: new PasskeyAttestationError("no P-256 key here"),
      expect: /no P-256 key here/,
    },
    {
      error: mapCommandError({
        code: "unsupported_platform",
        message: "Passkey sign-in is not available in this desktop build yet",
      }),
      expect: /not available in this desktop build/,
    },
  ];
  for (const c of table) {
    assert.match(explainPasskeyError(c.error), c.expect);
  }
});
