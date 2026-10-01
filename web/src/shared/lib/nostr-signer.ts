import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

export type UnsignedNostrEvent = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export type SignedNostrEvent = UnsignedNostrEvent & {
  id: string;
  pubkey: string;
  sig: string;
};

type Nip07Provider = {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
};

declare global {
  interface Window {
    nostr?: Nip07Provider;
  }
}

export class Nip07UnavailableError extends Error {
  constructor() {
    super("A NIP-07 browser extension is required to join in the browser.");
    this.name = "Nip07UnavailableError";
  }
}

let ephemeralSecretKey: Uint8Array | null = null;

function getEphemeralSecretKey(): Uint8Array {
  if (!ephemeralSecretKey) {
    ephemeralSecretKey = generateSecretKey();
  }
  return ephemeralSecretKey;
}

export function hasNip07Provider(): boolean {
  return typeof window !== "undefined" && window.nostr != null;
}

function sameUnsignedEvent(
  expected: UnsignedNostrEvent,
  actual: SignedNostrEvent,
): boolean {
  return (
    actual.kind === expected.kind &&
    actual.created_at === expected.created_at &&
    actual.content === expected.content &&
    JSON.stringify(actual.tags) === JSON.stringify(expected.tags)
  );
}

/**
 * Sign with NIP-07 when available, otherwise use a page-lifetime key.
 *
 * The ephemeral fallback preserves anonymous browsing on open relays. Flows
 * that create durable membership must set `requireNip07` so a reload cannot
 * orphan a relay-membership row.
 */
export async function signNostrEvent(
  template: Omit<UnsignedNostrEvent, "created_at"> & {
    created_at?: number;
  },
  options?: { requireNip07?: boolean },
): Promise<SignedNostrEvent> {
  const unsigned: UnsignedNostrEvent = {
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  };
  const provider = typeof window === "undefined" ? undefined : window.nostr;

  if (provider) {
    const expectedPubkey = await provider.getPublicKey();
    const signed = await provider.signEvent(unsigned);
    if (
      signed.pubkey !== expectedPubkey ||
      !sameUnsignedEvent(unsigned, signed) ||
      typeof signed.id !== "string" ||
      typeof signed.sig !== "string"
    ) {
      throw new Error("The NIP-07 extension returned an invalid signed event.");
    }
    return signed;
  }

  if (options?.requireNip07) {
    throw new Nip07UnavailableError();
  }

  const secretKey = getEphemeralSecretKey();
  const signed = finalizeEvent(unsigned, secretKey);
  if (signed.pubkey !== getPublicKey(secretKey)) {
    throw new Error("Failed to create the ephemeral browser identity.");
  }
  return signed;
}

export class Nip44UnavailableError extends Error {
  constructor() {
    super("Your signer doesn't support NIP-44 encryption.");
    this.name = "Nip44UnavailableError";
  }
}

function requireNip44(): NonNullable<Nip07Provider["nip44"]> {
  const provider = typeof window === "undefined" ? undefined : window.nostr;
  if (!provider?.nip44) throw new Nip44UnavailableError();
  return provider.nip44;
}

/** NIP-44 encrypt to `peer` with the active signer (the key never leaves it). */
export function nip44Encrypt(peer: string, plaintext: string): Promise<string> {
  return requireNip44().encrypt(peer, plaintext);
}

/** NIP-44 decrypt a payload from `peer` with the active signer. */
export function nip44Decrypt(
  peer: string,
  ciphertext: string,
): Promise<string> {
  return requireNip44().decrypt(peer, ciphertext);
}

/** Encrypt a private payload to yourself (NIP-44) with the active signer. */
export async function nip44EncryptToSelf(plaintext: string): Promise<string> {
  const provider = typeof window === "undefined" ? undefined : window.nostr;
  if (!provider) throw new Nip44UnavailableError();
  return nip44Encrypt(await provider.getPublicKey(), plaintext);
}

/** Decrypt a payload that was encrypted to yourself (NIP-44) with the active signer. */
export async function nip44DecryptFromSelf(
  ciphertext: string,
): Promise<string> {
  const provider = typeof window === "undefined" ? undefined : window.nostr;
  if (!provider) throw new Nip44UnavailableError();
  return nip44Decrypt(await provider.getPublicKey(), ciphertext);
}

/** Everything gift-wrapped DMs need from a signer; a NIP-07 / passkey signer provides it. */
export interface DirectMessageSigner {
  pubkey: string;
  signEvent(
    template: Omit<UnsignedNostrEvent, "created_at"> & { created_at?: number },
  ): Promise<SignedNostrEvent>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
}

/** The active browser signer, or throws when there is no real identity or no NIP-44. */
export async function getDirectMessageSigner(): Promise<DirectMessageSigner> {
  const provider = typeof window === "undefined" ? undefined : window.nostr;
  if (!provider) throw new Nip07UnavailableError();
  requireNip44();
  return {
    pubkey: await provider.getPublicKey(),
    signEvent: (template) => signNostrEvent(template, { requireNip07: true }),
    nip44Encrypt,
    nip44Decrypt,
  };
}
