/** The software passkey the tests share (plain JavaScript in core), given the type it has. */
// @ts-expect-error the software passkey is JavaScript without a declaration file
import { installFakeWebAuthn as install } from "../../../packages/creaton-core/src/test-support/fake-webauthn.mjs";

export const installFakeWebAuthn: (options?: { prf?: boolean }) => {
  /** How many credentials were made and how many assertions (passkey prompts) were given. */
  calls: { create: number; get: number };
  credentials: Map<string, unknown>;
  /** Forget every credential, as if the passkey was deleted from the keychain. */
  forgetAll(): void;
} = install;
