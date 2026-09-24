/**
 * Desktop↔web passkey contract — types and error shapes mirror
 * `web/src/features/identity/lib/passkey.ts` EXACTLY so the desktop web layer
 * can share call shapes with the web app. The ceremony runs in Rust
 * (`desktop/src-tauri/src/commands/passkey.rs`), so bytes cross the IPC
 * boundary as JSON number arrays and are converted back to `Uint8Array` here.
 *
 * Only public material ever crosses this module's storage boundary — secrets
 * (`nostrSecretKey`, PRF outputs) stay in memory, per
 * `docs/identity-token-architecture.md` (secrets live in memory + TSS).
 */

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

/** Thrown when the environment cannot run a passkey ceremony at all. */
export class PasskeyEnvironmentError extends PasskeyError {
  constructor(message: string, created?: CreatedPasskeyRef) {
    super(message, created);
    this.name = "PasskeyEnvironmentError";
  }
}

/** Thrown when the platform passkey cannot provide PRF outputs. */
export class PrfUnavailableError extends PasskeyError {
  constructor(created?: CreatedPasskeyRef) {
    super(
      "This platform did not provide a PRF output for the passkey — passkey identity needs PRF support (Windows Hello / Google Password Manager).",
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

/**
 * Desktop-only: this build cannot run the ceremony (e.g. the native
 * AuthenticationServices bridge is not wired — see the platform ledger in
 * `desktop/src-tauri/src/commands/passkey.rs`). Nothing was created.
 */
export class PasskeyUnsupportedPlatformError extends PasskeyError {
  readonly detail: string;

  constructor(message: string, detail: string, created?: CreatedPasskeyRef) {
    super(message, created);
    this.name = "PasskeyUnsupportedPlatformError";
    this.detail = detail;
  }
}

export interface CreatePasskeyOptions {
  /** Relying-party display name shown by the platform prompt. */
  rpName: string;
  /** Relying-party id; defaults to the configured associated domain. */
  rpId?: string;
  /** Credential user label shown by the platform prompt. */
  userLabel: string;
  /**
   * PRF `eval.first` salt (random 32 bytes when omitted). Persist it — it is
   * non-secret and is what makes re-derivation deterministic.
   */
  prfSalt?: Uint8Array;
}

/**
 * Ceremony provenance recorded with each created identity (desktop extension
 * of web's `CreatedPasskey`).
 *
 * Coupling contract (wave 4b): the in-contract WebAuthn validator that later
 * verifies this identity's assertions must use `expectedRPID === rpId` and an
 * `expectedOrigin` containing `origin` — exactly the pair this ceremony
 * bound. A mismatch must reject the UserOp.
 */
export interface CeremonyProvenance {
  /** The RP id the ceremony ran under (web `rp.id`). */
  rpId: string;
  /** `clientDataJSON.origin` as the platform reported it. */
  origin: string;
}

export interface CreatedPasskey {
  credentialId: string;
  prfSalt: Uint8Array;
  /** Both public roots. */
  identity: PasskeyIdentity;
  /**
   * The Nostr secret key — kept in memory only, never persisted.
   * Wipe it on sign-out.
   */
  nostrSecretKey: Uint8Array;
  /** The RP id/origin this ceremony bound — see {@link CeremonyProvenance}. */
  ceremony: CeremonyProvenance;
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

/** What the desktop can honestly do with passkeys right now. */
export interface PasskeyCapability {
  platform: string;
  /** Which native ceremony backend this platform has. */
  ceremonyBackend: string;
  /** Native PRF support (macOS 15.0+ — see the Rust platform ledger). */
  prfSupported: boolean;
  prfMinOs?: string | null;
  /** The associated domain the ceremonies would use as RP id. */
  rpId?: string | null;
  available: boolean;
  /** Why ceremonies cannot run here, in words a person can act on. */
  blocker?: string | null;
}

// ---------------------------------------------------------------------------
// IPC wire shapes (bytes as JSON number arrays, camelCase like the web types).
// ---------------------------------------------------------------------------

export interface RawCreatedPasskey {
  credentialId: string;
  prfSalt: number[];
  identity: PasskeyIdentity;
  nostrSecretKey: number[];
  ceremony: CeremonyProvenance;
}

export interface RawPasskeyAssertion {
  credentialId: string;
  signature: number[];
  authenticatorData: number[];
  clientDataJSON: number[];
  prfOutput?: number[] | null;
}

export interface RawPasskeyCommandError {
  code?: string;
  message?: string;
  detail?: string;
  created?: CreatedPasskeyRef;
}

function toBytes(value: number[] | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

function optionalBytes(
  value: number[] | Uint8Array | null | undefined,
): Uint8Array | undefined {
  return value == null ? undefined : toBytes(value);
}

/** Wire → typed `CreatedPasskey` (web's shape, `Uint8Array` bytes). */
export function rawCreatedToTyped(raw: RawCreatedPasskey): CreatedPasskey {
  return {
    credentialId: raw.credentialId,
    prfSalt: toBytes(raw.prfSalt),
    identity: raw.identity,
    nostrSecretKey: toBytes(raw.nostrSecretKey),
    ceremony: raw.ceremony,
  };
}

/** Wire → typed `PasskeyAssertion` (web's shape, `Uint8Array` bytes). */
export function rawAssertionToTyped(
  raw: RawPasskeyAssertion,
): PasskeyAssertion {
  return {
    credentialId: raw.credentialId,
    signature: toBytes(raw.signature),
    authenticatorData: toBytes(raw.authenticatorData),
    clientDataJSON: toBytes(raw.clientDataJSON),
    prfOutput: optionalBytes(raw.prfOutput),
  };
}

/** Typed options → wire options (JSON number arrays). */
export function createOptionsToWire(
  options: CreatePasskeyOptions,
): Record<string, unknown> {
  return {
    rpName: options.rpName,
    rpId: options.rpId ?? null,
    userLabel: options.userLabel,
    prfSalt: options.prfSalt ? Array.from(options.prfSalt) : null,
  };
}

/** Typed options → wire options (JSON number arrays). */
export function assertionOptionsToWire(
  options: GetPasskeyAssertionOptions,
): Record<string, unknown> {
  return {
    credentialId: options.credentialId,
    prfSalt: options.prfSalt ? Array.from(options.prfSalt) : null,
    rpId: options.rpId ?? null,
    challenge: options.challenge ? Array.from(options.challenge) : null,
  };
}

/**
 * Wire error → web's typed error classes (codes are the stable contract of
 * `PasskeyCommandError` in the Rust module). Unknown shapes degrade to the
 * base `PasskeyError` — never a fake success.
 */
export function mapCommandError(error: unknown): PasskeyError {
  if (error instanceof PasskeyError) return error;
  if (typeof error === "string") return new PasskeyError(error);
  const raw = (error ?? {}) as RawPasskeyCommandError;
  const message = raw.message ?? String(error);
  const created = raw.created;
  switch (raw.code) {
    case "environment":
      return new PasskeyEnvironmentError(message, created);
    case "prf_unavailable":
      return new PrfUnavailableError(created);
    case "attestation":
      return new PasskeyAttestationError(message, created);
    case "unsupported_platform":
      return new PasskeyUnsupportedPlatformError(
        message,
        raw.detail ?? "",
        created,
      );
    default:
      return new PasskeyError(message, created);
  }
}

/**
 * Map any ceremony failure to copy a person can act on — desktop mirror of
 * web `explainPasskeyError` (same copy for the shared failure classes; the
 * desktop-only unavailability class explains itself).
 */
export function explainPasskeyError(error: unknown): string {
  if (
    error instanceof PasskeyEnvironmentError ||
    error instanceof PrfUnavailableError ||
    error instanceof PasskeyAttestationError ||
    error instanceof PasskeyUnsupportedPlatformError
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
