/** Types for `fake-webauthn.mjs`, so TypeScript tests can use the software passkey. */
export function installFakeWebAuthn(options?: { prf?: boolean }): {
  /** How many credentials were made and how many assertions (passkey prompts) were given. */
  calls: { create: number; get: number };
  credentials: Map<string, unknown>;
  /** Forget every credential, as if the passkey was deleted from the keychain. */
  forgetAll(): void;
};
