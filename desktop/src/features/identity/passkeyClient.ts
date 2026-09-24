/**
 * Desktop passkey client — the Tauri command wrappers of the web module's
 * `createPasskey` / `getPasskeyAssertion` call shapes
 * (`web/src/features/identity/lib/passkey.ts`), so the desktop web layer can
 * drive the same ceremony UX. The ceremony itself runs in Rust
 * (`desktop/src-tauri/src/commands/passkey.rs`); in builds without a wired
 * platform bridge the calls reject with `PasskeyUnsupportedPlatformError` —
 * nothing is faked and nothing is created.
 */

import { invoke } from "@tauri-apps/api/core";

import {
  assertionOptionsToWire,
  createOptionsToWire,
  mapCommandError,
  rawAssertionToTyped,
  rawCreatedToTyped,
  type CreatedPasskey,
  type CreatePasskeyOptions,
  type GetPasskeyAssertionOptions,
  type PasskeyAssertion,
  type PasskeyCapability,
  type RawCreatedPasskey,
  type RawPasskeyAssertion,
} from "./passkeyContract";

/**
 * One registration ceremony, both identity roots: PRF(`eval.first`, salt) →
 * HKDF-SHA256 → secp256k1 Nostr key, plus the attested secp256r1 key as the
 * future smart-wallet owner. Mirrors web `createPasskey`.
 */
export async function createPasskey(
  options: CreatePasskeyOptions,
): Promise<CreatedPasskey> {
  try {
    const raw = await invoke<RawCreatedPasskey>("passkey_create", {
      options: createOptionsToWire(options),
    });
    return rawCreatedToTyped(raw);
  } catch (error) {
    throw mapCommandError(error);
  }
}

/**
 * Signed assertion by the passkey's secp256r1 key (the wave-4b UserOp /
 * WebAuthn-validator input), plus the second PRF evaluation of the
 * registration salt for deterministic re-derivation of the Nostr key.
 * Mirrors web `getPasskeyAssertion`.
 */
export async function getPasskeyAssertion(
  options: GetPasskeyAssertionOptions,
): Promise<PasskeyAssertion> {
  try {
    const raw = await invoke<RawPasskeyAssertion>("passkey_get", {
      options: assertionOptionsToWire(options),
    });
    return rawAssertionToTyped(raw);
  } catch (error) {
    throw mapCommandError(error);
  }
}

/** Honest capability probe (platform, PRF support, RP id, blocker). */
export async function passkeyCapability(): Promise<PasskeyCapability> {
  return invoke<PasskeyCapability>("passkey_capability");
}
