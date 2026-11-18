/**
 * A software authenticator behind `navigator.credentials`, for `node --test`.
 *
 * The passkey module's own ceremony stand-in only exists in the dev server (it is dead code in every build, and off
 * under node), so tests drive the production `navigator.credentials` path instead, the way the browser specs use
 * Chrome's virtual authenticator: a real P-256 key per credential, a `none` attestation whose COSE key the module
 * parses, ES256 assertions (DER, as browsers return them) and a PRF output that depends only on the credential and the
 * salt. `prf: false` is a platform without PRF (the iCloud Keychain case, which makes an unlock-mode passkey).
 *
 * Not a test file itself (no `.test.mjs`), so `pnpm test` does not run it on its own.
 */

import { createHash, webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

// --- minimal CBOR (only what an attestation object needs) ---

function head(major, length) {
  if (length < 24) return [(major << 5) | length];
  if (length < 0x100) return [(major << 5) | 24, length];
  if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff];
  throw new Error("fake-webauthn: CBOR item too long");
}

function cbor(value) {
  if (typeof value === "number") {
    return value >= 0
      ? Uint8Array.from(head(0, value))
      : Uint8Array.from(head(1, -1 - value));
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(Uint8Array.from(head(3, bytes.length)), bytes);
  }
  if (value instanceof Uint8Array) {
    return concat(Uint8Array.from(head(2, value.length)), value);
  }
  if (value instanceof Map) {
    const parts = [Uint8Array.from(head(5, value.size))];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return concat(...parts);
  }
  throw new Error(`fake-webauthn: cannot encode ${typeof value}`);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length);
const bytes = (source) =>
  source instanceof Uint8Array
    ? source
    : ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : new Uint8Array(source);
const sha256 = (u8) => new Uint8Array(createHash("sha256").update(u8).digest());

/** IEEE P1363 r‖s (what WebCrypto signs) → ASN.1 DER (what WebAuthn returns). */
function derSignature(raw) {
  const int = (half) => {
    let i = 0;
    while (i < half.length - 1 && half[i] === 0) i += 1;
    const trimmed = half.slice(i);
    const body =
      trimmed[0] & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
    return concat(Uint8Array.of(0x02, body.length), body);
  };
  const seq = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, seq.length), seq);
}

function notAllowed(message) {
  const error = new Error(message);
  error.name = "NotAllowedError";
  return error;
}

/**
 * Install the authenticator as `globalThis.navigator.credentials` (and a `localhost` location when the test made a
 * `window` without one). Returns counters and the stored credentials so tests can assert the real path ran.
 */
export function installFakeWebAuthn({ prf = true } = {}) {
  /** credential id (hex) → { keys, prfSecret } */
  const credentials = new Map();
  const calls = { create: 0, get: 0 };

  const prfOutput = async (prfSecret, salt) => {
    const key = await subtle.importKey(
      "raw",
      prfSecret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(await subtle.sign("HMAC", key, toAB(bytes(salt))));
  };

  const extensionResults = async (record, requested) => {
    const salt = requested?.prf?.eval?.first;
    if (!prf) return { prf: { enabled: false } };
    if (!salt) return { prf: { enabled: true } };
    const first = await prfOutput(record.prfSecret, salt);
    return { prf: { enabled: true, results: { first: toAB(first) } } };
  };

  const api = {
    async create({ publicKey }) {
      calls.create += 1;
      const keys = await subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const raw = new Uint8Array(await subtle.exportKey("raw", keys.publicKey));
      const id = webcrypto.getRandomValues(new Uint8Array(16));
      const record = {
        keys,
        prfSecret: webcrypto.getRandomValues(new Uint8Array(32)),
        rpId: publicKey.rp?.id ?? "localhost",
      };
      credentials.set(Buffer.from(id).toString("hex"), record);
      const coseKey = cbor(
        new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, raw.slice(1, 33)],
          [-3, raw.slice(33, 65)],
        ]),
      );
      const authData = concat(
        sha256(new TextEncoder().encode(record.rpId)),
        Uint8Array.of(0x45), // UP | UV | AT
        new Uint8Array(4), // signCount
        new Uint8Array(16), // aaguid
        Uint8Array.of(0, id.length),
        id,
        coseKey,
      );
      const attestationObject = cbor(
        new Map([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      const results = await extensionResults(record, publicKey.extensions);
      return {
        rawId: toAB(id),
        response: { attestationObject: toAB(attestationObject) },
        getClientExtensionResults: () => results,
      };
    },

    async get({ publicKey }) {
      calls.get += 1;
      const allowed = (publicKey.allowCredentials ?? []).map((c) =>
        Buffer.from(bytes(c.id)).toString("hex"),
      );
      const id = allowed.find((hex) => credentials.has(hex));
      if (!id) throw notAllowed("fake-webauthn: no such credential here");
      const record = credentials.get(id);
      const authenticatorData = concat(
        sha256(new TextEncoder().encode(publicKey.rpId ?? record.rpId)),
        Uint8Array.of(0x05), // UP | UV
        Uint8Array.of(0, 0, 0, 1),
      );
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: "webauthn.get",
          challenge: Buffer.from(bytes(publicKey.challenge)).toString(
            "base64url",
          ),
          origin: "http://localhost",
        }),
      );
      const raw = new Uint8Array(
        await subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          record.keys.privateKey,
          toAB(concat(authenticatorData, sha256(clientDataJSON))),
        ),
      );
      const results = await extensionResults(record, publicKey.extensions);
      return {
        rawId: toAB(Buffer.from(id, "hex")),
        response: {
          authenticatorData: toAB(authenticatorData),
          clientDataJSON: toAB(clientDataJSON),
          signature: toAB(derSignature(raw)),
        },
        getClientExtensionResults: () => results,
      };
    },
  };

  Object.defineProperty(globalThis, "navigator", {
    value: { credentials: api },
    configurable: true,
    writable: true,
  });
  if (globalThis.window && !globalThis.window.location) {
    globalThis.window.location = {
      hostname: "localhost",
      origin: "http://localhost",
    };
  }
  return {
    calls,
    credentials,
    /** Forget every credential, as if the passkey was deleted from the keychain. */
    forgetAll: () => credentials.clear(),
  };
}
