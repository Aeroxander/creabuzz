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

export function buildSiweMessage(input: {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  npub: string;
}): string {
  return [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    input.address,
    "",
    `URI: ${input.uri}`,
    "Version: 1",
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
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
  },
): Promise<SiweLogin> {
  // The proof must be signed before the message is built: its pubkey is the
  // binding the relay checks, and the message has to name it.
  const proof = await deps.signProof();
  const npub = proof.pubkey;
  const message = buildSiweMessage({
    domain: siweDomain(challenge, deps.hostname),
    address: deps.address,
    uri: deps.origin,
    chainId: challenge.chainId ?? 1,
    nonce: challenge.nonce,
    npub,
  });
  const signature = await deps.personalSign(message, deps.address);
  return { message, signature, proof, address: deps.address, pubkey: npub };
}
