/**
 * WebAuthn PRF (HMAC-Secret) passkey identity primitives — dependency-free.
 *
 * A passkey with the PRF extension deterministically computes an
 * authenticator-bound output for a given salt. HKDF-SHA256 expands that
 * output into the secp256k1 secret key used for Nostr signing. The key is
 * only ever present in page memory, is identical for the same credential +
 * salt (e.g. across a synced ecosystem), and requires no server.
 */

export interface PrfResult {
  /** 32-byte authenticator-bound PRF output (ArrayBuffer). */
  okm: ArrayBuffer;
}

/** Thrown when the platform passkey cannot provide PRF outputs. */
export class PrfUnavailableError extends Error {
  constructor() {
    super(
      "This platform did not provide a PRF output for the passkey — passkey identity needs PRF support (Windows Hello / Google Password Manager).",
    );
    this.name = "PrfUnavailableError";
  }
}

export type PrfProvider = {
  /** Register a platform passkey with the PRF extension for the given salt. */
  create(
    salt: Uint8Array,
    displayName: string,
  ): Promise<{ credentialId: string; okm?: ArrayBuffer }>;
  /** Authenticate the passkey with the PRF extension and return the output. */
  get(salt: Uint8Array, credentialId: string): Promise<PrfResult>;
  /** Plain assertion (no PRF) — passkey-unlock mode for platforms without
   * PRF (e.g. iCloud Keychain). */
  assert(credentialId: string): Promise<void>;
};

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Stable per-origin RP id (the app's host). */
function rpId(): string {
  const host = window.location.hostname || "localhost";
  // WebAuthn RP IDs must be domains; browsers reject IP literals (including
  // 127.0.0.1). localhost is the sanctioned loopback id for dev, and the
  // same RP id must be used for both registration and assertion.
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  ) {
    return "localhost";
  }
  return host;
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

/**
 * HKDF-SHA256 (RFC 5869) via Web Crypto. Expand `prfOutput` into exactly 32
 * bytes — the deterministic seed for the Nostr key.
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

function generateChallenge(): Uint8Array {
  return randomBytes(32);
}

/**
 * Native WebAuthn PRF implementation.
 *
 * Registration requests the PRF extension (output may be delayed to the
 * first assertion on some platforms, so the caller follows up with `get`).
 * Assertion returns the PRF output in `clientExtensionResults.prf`.
 */
export const webAuthnPrf: PrfProvider = {
  async create(salt, displayName) {
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: toAB(generateChallenge()),
        rp: { id: rpId(), name: "Creaton" },
        user: {
          id: toAB(randomBytes(16)),
          name: displayName,
          displayName,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "required",
          userVerification: "required",
        },
        attestation: "none",
        extensions: {
          prf: { eval: { first: toAB(salt) } },
        },
      },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("passkey registration cancelled");
    const prf = (
      credential as unknown as {
        clientExtensionResults?: {
          prf?: { results?: { first?: ArrayBuffer } };
        };
      }
    ).clientExtensionResults?.prf?.results?.first;
    return {
      credentialId: b64urlEncode(new Uint8Array(credential.rawId)),
      okm: prf ?? undefined,
    };
  },

  async get(salt, credentialId) {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: toAB(generateChallenge()),
        allowCredentials: [
          { id: toAB(b64urlDecode(credentialId)), type: "public-key" },
        ],
        userVerification: "required",
        extensions: {
          prf: { eval: { first: toAB(salt) } },
        },
      },
    })) as PublicKeyCredential | null;
    if (!assertion) throw new Error("passkey authentication cancelled");
    const prf = (
      assertion as unknown as {
        clientExtensionResults?: {
          prf?: { results?: { first?: ArrayBuffer } };
        };
      }
    ).clientExtensionResults?.prf?.results?.first;
    if (!prf) {
      throw new PrfUnavailableError();
    }
    return { okm: prf };
  },

  async assert(credentialId) {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: toAB(generateChallenge()),
        allowCredentials: [
          { id: toAB(b64urlDecode(credentialId)), type: "public-key" },
        ],
        userVerification: "required",
      },
    })) as PublicKeyCredential | null;
    if (!assertion) throw new Error("passkey authentication cancelled");
  },
};

/**
 * Deterministic dev/test provider: derives a fake-but-stable PRF output from
 * the salt, so identity flows can be exercised without an authenticator.
 * Activate with sessionStorage buzz.passkey.mock = "1".
 */
export const mockPrf: PrfProvider = {
  async create(salt) {
    const okm = await crypto.subtle.digest("SHA-256", toAB(salt));
    return {
      credentialId: "mock-" + b64urlEncode(salt).slice(0, 24),
      okm,
    };
  },
  async get(salt, _credentialId) {
    // '"buzz.passkey.mock=noprf"' simulates iCloud Keychain (no PRF output).
    try {
      if (sessionStorage.getItem("buzz.passkey.mock") === "noprf") {
        throw new PrfUnavailableError();
      }
    } catch {
      throw new PrfUnavailableError();
    }
    const digest = await crypto.subtle.digest("SHA-256", toAB(salt));
    return { okm: digest };
  },
  async assert() {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("assert-" + Date.now()),
    );
    void digest; // any success marks the touch complete in mock mode
  },
};

export function prfProvider(): PrfProvider {
  if (typeof sessionStorage !== "undefined") {
    try {
      // Any mock flag routes to the dev provider; mockPrf.get simulates the
      // "noprf" (iCloud Keychain) case internally.
      if (sessionStorage.getItem("buzz.passkey.mock") !== null) {
        return mockPrf;
      }
    } catch {
      // ignore
    }
  }
  return webAuthnPrf;
}

export { b64urlEncode, b64urlDecode, rpId };
