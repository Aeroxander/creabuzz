/**
 * Core of the SIWE (EIP-4361) login handshake.
 *
 * Deliberately free of `@/` imports so `node --test` can exercise it without a
 * module-resolution loader (`siwe-login.test.mjs`). `siwe.ts` wires it to the
 * wallet, the relay and the device signer.
 */

/** Challenge returned by `GET /auth/siwe/nonce`. */
export interface SiweLoginChallenge {
  nonce: string;
  /**
   * Domain the relay expects in the message. The relay compares against the
   * tenant host with the port stripped (`api/evm_auth.rs::host_domain`), so a
   * dev host such as `localhost:5173` must not be sent whole.
   */
  domain?: string;
  /**
   * Chain id the relay expects the message to claim
   * (`BUZZ_EVM_CHAIN_ID`); falls back to mainnet when the relay omits it.
   */
  chainId?: number;
}

/** Signed Nostr proof event (subset the caller needs back). */
export interface SiweProof {
  pubkey: string;
}

/** Everything one login attempt needs, before the relay call. */
export interface SiweLogin {
  message: string;
  signature: string;
  proof: SiweProof;
  address: string;
  /** npub (hex) named in the message — the pubkey of `proof`. */
  pubkey: string;
}

/**
 * Build the EIP-4361 message the relay parses (`buzz-evm-auth/src/siwe.rs`).
 *
 * EIP-4361's ABNF is
 * `address LF LF [statement LF] LF "URI: " uri LF ...`: a message WITHOUT a
 * statement — this one — therefore has TWO blank lines between the address and
 * `URI:`. With only one, the relay's statement loop swallows every remaining
 * line and the login is rejected. `test-fixtures/siwe/login-message.txt` pins
 * the exact bytes for fixed inputs; both this builder's test and the relay's
 * parser test read it.
 *
 * `now` is injectable so `Issued At` is deterministic under test.
 */
export function buildSiweMessage(
  input: {
    domain: string;
    address: string;
    uri: string;
    chainId: number;
    nonce: string;
    npub: string;
  },
  now: Date = new Date(),
): string {
  return [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    input.address,
    // No statement: `address LF LF LF URI` (two blank lines, EIP-4361 ABNF).
    "",
    "",
    `URI: ${input.uri}`,
    "Version: 1",
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${now.toISOString()}`,
    "Resources:",
    `- nostr:${input.npub}`,
  ].join("\n");
}

/** Domain for the SIWE message: relay-supplied first, else the bare hostname. */
export function siweDomain(
  challenge: SiweLoginChallenge,
  hostname: string,
): string {
  const fromRelay = challenge.domain?.trim();
  if (fromRelay) return fromRelay;
  return hostname.toLowerCase();
}

/**
 * Build the message and its wallet signature for one login attempt.
 *
 * The npub the message names comes from the proof the device just signed — not
 * from a separately resolved identity. The relay binds `nostr:<pubkey of the
 * proof>` and rejects every other value, and the active signer can be a passkey
 * override rather than the stored nsec identity, so resolving the npub from
 * storage produces a proof/ message mismatch.
 */
export async function buildSiweLogin(
  challenge: SiweLoginChallenge,
  deps: {
    address: string;
    origin: string;
    hostname: string;
    signProof: () => Promise<SiweProof>;
    personalSign: (message: string, address: string) => Promise<string>;
    /** Clock for `Issued At`; defaults to the current time. */
    now?: Date;
  },
): Promise<SiweLogin> {
  // The proof must be signed before the message is built: its pubkey is the
  // binding the relay checks, and the message has to name it.
  const proof = await deps.signProof();
  const npub = proof.pubkey;
  const message = buildSiweMessage(
    {
      domain: siweDomain(challenge, deps.hostname),
      address: deps.address,
      uri: deps.origin,
      chainId: challenge.chainId ?? 1,
      nonce: challenge.nonce,
      npub,
    },
    deps.now,
  );
  const signature = await deps.personalSign(message, deps.address);
  return { message, signature, proof, address: deps.address, pubkey: npub };
}

/** A wallet↔npub binding recorded by a successful SIWE registration. */
export interface WalletBinding {
  /** Lowercase EVM address that signed the SIWE message. */
  address: string;
  /** npub (hex) the address is bound to. */
  pubkey: string;
  boundAt: number;
}

/**
 * Parse a stored binding, or null when it is absent or malformed.
 *
 * Storage is user-writable and survives upgrades, so a bad value must read as
 * "no binding" rather than throw while rendering the profile menu.
 */
export function parseWalletBinding(raw: string | null): WalletBinding | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { address, pubkey, boundAt } = value as Record<string, unknown>;
  if (typeof address !== "string" || !/^0x[0-9a-f]{40}$/.test(address)) {
    return null;
  }
  if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey)) return null;
  return {
    address,
    pubkey,
    boundAt: typeof boundAt === "number" ? boundAt : 0,
  };
}

/**
 * Nostr proof template for `POST /auth/siwe/revoke`.
 *
 * The relay checks the proof's `u` tag, its freshness, and that its content is
 * the EVM address currently bound to the signing npub — the same shape as
 * registration with the revoke endpoint named.
 */
export function revokeProofTemplate(address: string): {
  kind: number;
  tags: string[][];
  content: string;
} {
  return {
    kind: 27235,
    tags: [
      ["u", "/auth/siwe/revoke"],
      ["method", "POST"],
    ],
    content: address,
  };
}
