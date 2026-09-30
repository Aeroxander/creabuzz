import { invokeTauri } from "@/shared/api/tauri";
import type { Identity, IdentityStorage } from "@/shared/api/types";

type RawIdentity = {
  pubkey: string;
  display_name: string;
  storage?: IdentityStorage;
  lost?: boolean;
  locked?: boolean;
  reset_failed?: boolean;
};

function fromRawIdentity(raw: RawIdentity): Identity {
  return {
    pubkey: raw.pubkey,
    displayName: raw.display_name,
    storage: raw.storage,
    lost: raw.lost === true,
    locked: raw.locked === true,
    resetFailed: raw.reset_failed === true,
  };
}

export async function getIdentity(): Promise<Identity> {
  return fromRawIdentity(await invokeTauri<RawIdentity>("get_identity"));
}

export async function getNsec(): Promise<string> {
  return invokeTauri<string>("get_nsec");
}

export async function importIdentity(
  nsec: string,
  password?: string,
  expectedCurrentNpub?: string,
): Promise<Identity> {
  return fromRawIdentity(
    await invokeTauri<RawIdentity>("import_identity", {
      nsec,
      password,
      expectedCurrentNpub,
    }),
  );
}

export type IdentityImportPreview = {
  /** Candidate identity derived from the pasted key (hex). */
  pubkey: string;
  /** Candidate identity as npub — what this device would sign as. */
  npub: string;
  /** The identity live on this device now (npub), for replace confirmation. */
  currentNpub: string;
  matchesCurrentIdentity: boolean;
};

/**
 * Parse and derive an import candidate WITHOUT importing it — the read-only
 * preview behind the "Use my web identity" replace confirmation. Uses the
 * same parser and derivation as `importIdentity` (Rust:
 * `preview_identity_import` in commands/identity.rs), so the identity shown
 * is the identity a confirmed import commits.
 */
export async function previewIdentityImport(
  nsec: string,
  password?: string,
): Promise<IdentityImportPreview> {
  return invokeTauri<IdentityImportPreview>("preview_identity_import", {
    nsec,
    password,
  });
}

export type IdentityLinkStart = {
  /** Id of the one-time sign-in request — fences later results. */
  id: string;
  /** The `link-device` URL the system browser opens. */
  url: string;
};

export type IdentityLinkResult = {
  /** Request this result belongs to; null when no request matched. */
  id: string | null;
  status: "linked" | "rejected";
  /** Linked account's public identifier (npub), on success. */
  npub?: string | null;
  /** Stable rejection reason code, on failure. */
  reason?: string | null;
};

/**
 * Begin the browser sign-in (Rust: `start_identity_link`): generates a
 * one-time device key + nonce, registers the single-use request, and opens
 * the system browser at the web app's link page. `fallbackOrigin` is the web
 * app to sign in against when no community is connected yet; a connected
 * community's relay-derived web app always wins.
 */
export async function startIdentityLink(options?: {
  fallbackOrigin?: string;
}): Promise<IdentityLinkStart> {
  return invokeTauri<IdentityLinkStart>("start_identity_link", {
    fallbackOrigin: options?.fallbackOrigin,
  });
}

/** Abandon any outstanding sign-in request (Rust: `cancel_identity_link`). */
export async function cancelIdentityLink(): Promise<void> {
  await invokeTauri("cancel_identity_link");
}

/**
 * Consume the queued sign-in result, if any (Rust:
 * `take_identity_link_result`) — picks up a result that raced the live
 * `deep-link-identity` event subscription.
 */
export async function takeIdentityLinkResult(): Promise<IdentityLinkResult | null> {
  return (
    (await invokeTauri<IdentityLinkResult | null>(
      "take_identity_link_result",
    )) ?? null
  );
}

export async function persistCurrentIdentity(): Promise<Identity> {
  return fromRawIdentity(
    await invokeTauri<RawIdentity>("persist_current_identity"),
  );
}

/**
 * Wipe all local Buzz state (keychain, App Support, WebKit, nest, OAuth cache,
 * CLI symlinks) and relaunch into first-run onboarding.
 *
 * The app restarts after this call completes. Callers should keep the pending
 * state until the process exits and only handle errors (e.g. display a toast).
 */
export async function signOut(): Promise<void> {
  await invokeTauri("sign_out");
}

export type GeneratePassphraseOptions = {
  /** Word count; Rust clamps to its allowed range (currently 3–10). */
  words?: number;
  /** Separator joined between words. Defaults to a space in Rust. */
  separator?: string;
};

/** Generate a word passphrase (EFF short wordlist, OS entropy) in Rust. */
export async function generateBackupPassphrase(
  options?: GeneratePassphraseOptions,
): Promise<string> {
  return invokeTauri<string>("generate_backup_passphrase", {
    words: options?.words,
    separator: options?.separator,
  });
}

/** Encrypt the current identity as an in-memory NIP-49 backup for native save. */
export async function createNcryptsecBackup(password: string): Promise<string> {
  return invokeTauri<string>("create_ncryptsec_backup", { password });
}

/** Save a portable backup copy. Returns null when the native dialog is cancelled. */
export async function saveNcryptsecCopy(
  ncryptsec: string,
): Promise<string | null> {
  return (
    (await invokeTauri<string | null>("save_ncryptsec_copy", { ncryptsec })) ??
    null
  );
}

export type BackupVerification = {
  pubkey: string;
  npub: string;
  matchesCurrentIdentity: boolean;
};

/** Decrypt locally and return only the backup's public identity and match state. */
export async function verifyNcryptsecBackup(
  ncryptsec: string,
  password: string,
): Promise<BackupVerification> {
  return invokeTauri<BackupVerification>("verify_ncryptsec_backup", {
    ncryptsec,
    password,
  });
}
