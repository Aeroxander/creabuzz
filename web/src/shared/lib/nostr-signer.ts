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
};

declare global {
  interface Window {
    nostr?: Nip07Provider;
  }
}

export class Nip07UnavailableError extends Error {
  constructor() {
    super(
      "A Nostr signer browser extension is required to join in the browser.",
    );
    this.name = "Nip07UnavailableError";
  }
}

/**
 * The one sentence a registered-but-locked passkey answers with.
 *
 * Shared as a constant because every surface that renders it also has to
 * render the recovery beside it (Review-Proven Rule 6), and that check has to
 * survive message wrapping (`PitchPublishError` prefixes it, mutation layers
 * re-throw it) — see `isSigningBlockedError`.
 */
export const SIGNING_BLOCKED_MESSAGE =
  "Unlock your passkey before this browser can sign.";

/**
 * Thrown when the durable identity exists but is not usable right now — the
 * registered passkey has not been unlocked this session.
 *
 * A typed error so callers can tell "this reader cannot sign *yet*, here is
 * the unlock action" apart from "the relay refused this" without matching on
 * prose. The fall-through it prevents stays real: signing as a fresh key here
 * would mint a second durable identity while the passkey is who the reader is.
 */
export class SigningBlockedError extends Error {
  constructor(reason: string = SIGNING_BLOCKED_MESSAGE) {
    super(reason);
    this.name = "SigningBlockedError";
  }
}

/**
 * True when `error` means "the passkey identity is locked", however it was
 * wrapped on the way up (`instanceof` fails across message boundaries and
 * after `Error` subclass re-wrapping, so the prose is a second signal).
 */
export function isSigningBlockedError(error: unknown): boolean {
  if (error instanceof SigningBlockedError) return true;
  if (!(error instanceof Error)) return false;
  return error.message.includes(SIGNING_BLOCKED_MESSAGE);
}

let ephemeralSecretKey: Uint8Array | null = null;

/**
 * Optional user-signer override (e.g. the PRF passkey signer). Returns a
 * signed event, or null to mean "fall through to the normal identity path".
 */
let userSignerOverride:
  | ((template: UnsignedNostrEvent) => Promise<SignedNostrEvent | null>)
  | null = null;

export function setUserSignerOverride(
  fn:
    | ((template: UnsignedNostrEvent) => Promise<SignedNostrEvent | null>)
    | null,
): void {
  userSignerOverride = fn;
}

export function getUserSignerOverride(): typeof userSignerOverride {
  return userSignerOverride;
}

/**
 * Optional pubkey override: who the app *is*, when that is not the stored nsec.
 *
 * A passkey identity derived from the credential (PRF mode) is a different key
 * from anything in `buzz.identity.nsec`, and it is the one signatures carry. Any
 * accessor that answers "who am I" — the `#p` filters, "is this my message", the
 * board's "mine" — must answer with the same key, or the app filters by one
 * identity while signing as another (the relay's p-gate then refuses those
 * reads). Registered by the passkey module so this file keeps no dependency on
 * it.
 */
let userPubkeyOverride: (() => string | null) | null = null;

export function setUserPubkeyOverride(fn: (() => string | null) | null): void {
  userPubkeyOverride = fn;
}

export function getUserPubkeyOverride(): (() => string | null) | null {
  return userPubkeyOverride;
}

/**
 * Optional reason why signing must fail instead of falling through.
 *
 * The identity precedence is passkey, then a NIP-07 extension, then the stored
 * nsec — and the last step *creates* a key when none exists. That is right for a
 * first-time reader, and wrong for someone whose identity is a passkey that is
 * not unlocked this session: falling through mints a second, durable identity
 * and signs with it, so the app would be a different person depending on when
 * the query ran. Registered by the passkey module.
 */
let userSigningBlockedReason: (() => string | null) | null = null;

export function setUserSigningBlockedReason(
  fn: (() => string | null) | null,
): void {
  userSigningBlockedReason = fn;
}

export function getUserSigningBlockedReason(): string | null {
  return userSigningBlockedReason?.() ?? null;
}

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
  if (userSignerOverride) {
    const override = await userSignerOverride(unsigned);
    if (override) return override;
  }
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
      throw new Error("The signer extension returned an invalid signature.");
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
