/**
 * "Use my web identity" — the interim identity handoff from web to desktop.
 *
 * The web app derives its Nostr key from the passkey (PRF) and offers a
 * one-time recovery nsec; desktop stores its own key in the keyring. This
 * module is the replace-confirmation state machine between the two: parse and
 * derive first (`previewIdentityImport`, read-only), show BOTH identities,
 * and only on explicit confirm call `importIdentity` — fenced to the npub the
 * user was shown, so a device identity that changed under review refuses the
 * swap instead of clobbering it (Rust: `import_identity_inner`).
 *
 * The pasted key never reaches any store from here: persistence is entirely
 * the existing keyring-first `identity_storage`/`secret_store` path inside
 * `import_identity`.
 *
 * HONESTY CONTRACT: this is the interim path. Passkey-native identity — the
 * same Touch ID on web and desktop — arrives with app signing activation, at
 * which point this handoff becomes unnecessary. Nothing here ever claims the
 * passkey was exported; keys never leave the authenticator.
 */

import type { IdentityImportPreview } from "@/shared/api/tauriIdentity";
import type { Identity } from "@/shared/api/types";

export type WebIdentityHandoffState =
  | { phase: "idle" }
  | { phase: "checking"; nsec: string }
  | { phase: "ready"; nsec: string; preview: IdentityImportPreview }
  | { phase: "replacing"; nsec: string; preview: IdentityImportPreview }
  | { phase: "replaced"; identity: Identity; npub: string }
  | { phase: "error"; stage: "check" | "replace"; message: string };

export type WebIdentityHandoffDeps = {
  /** Read-only parse + derive; must never mutate the stored identity. */
  preview: (nsec: string) => Promise<IdentityImportPreview>;
  /** Committed import; `expectedCurrentNpub` fences the replace. */
  importNsec: (nsec: string, expectedCurrentNpub: string) => Promise<Identity>;
  /** Post-commit re-scope (relay disconnect + identity query rekey). */
  onImported: (identity: Identity) => void;
};

export type WebIdentityHandoff = {
  getState: () => WebIdentityHandoffState;
  subscribe: (listener: () => void) => () => void;
  /** Validate the pasted key. Read-only — nothing is imported. */
  check: (nsec: string) => Promise<void>;
  /** Commit the replacement. Only valid from the reviewed `ready` state. */
  confirm: () => Promise<void>;
  /**
   * Drop the pending candidate and any in-flight result. The stored
   * identity is untouched: the mutating command is reachable only through
   * `confirm()` from `ready`.
   */
  cancel: () => void;
};

/**
 * Create the handoff controller. Async results are fenced by generation:
 * a `cancel()` (or a newer `check`) invalidates whatever was in flight, so a
 * slow preview can never land on top of a cancelled or newer state.
 */
export function createWebIdentityHandoff(
  deps: WebIdentityHandoffDeps,
): WebIdentityHandoff {
  let state: WebIdentityHandoffState = { phase: "idle" };
  let generation = 0;
  const listeners = new Set<() => void>();

  const setState = (next: WebIdentityHandoffState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const errorState = (
    stage: "check" | "replace",
    error: unknown,
  ): WebIdentityHandoffState => ({
    phase: "error",
    stage,
    message: error instanceof Error ? error.message : String(error),
  });

  return {
    getState: () => state,

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async check(nsec: string) {
      const candidateGeneration = ++generation;
      setState({ phase: "checking", nsec });
      try {
        const preview = await deps.preview(nsec);
        if (candidateGeneration !== generation) return;
        setState({ phase: "ready", nsec, preview });
      } catch (error) {
        if (candidateGeneration !== generation) return;
        setState(errorState("check", error));
      }
    },

    async confirm() {
      const reviewed = state;
      // A cancel (or edit) that landed first wins: never import a candidate
      // the user is no longer looking at.
      if (reviewed.phase !== "ready") return;
      const candidateGeneration = ++generation;
      setState({
        phase: "replacing",
        nsec: reviewed.nsec,
        preview: reviewed.preview,
      });
      try {
        const identity = await deps.importNsec(
          reviewed.nsec,
          reviewed.preview.currentNpub,
        );
        if (candidateGeneration !== generation) return;
        deps.onImported(identity);
        setState({ phase: "replaced", identity, npub: reviewed.preview.npub });
      } catch (error) {
        if (candidateGeneration !== generation) return;
        setState(errorState("replace", error));
      }
    },

    cancel() {
      generation += 1;
      setState({ phase: "idle" });
    },
  };
}

/** User-facing copy. Kept here (not inline) so the honesty contract is testable. */
export const WEB_IDENTITY_HANDOFF_COPY = {
  title: "Use my web identity",
  intro:
    "Paste the recovery key (nsec) from the web app to sign in here as the same account.",
  keyWarning:
    "Anyone with this key can sign as you — paste it only on your own devices.",
  interimNote:
    "Interim path: passkey-native identity — the same Touch ID on web and desktop — arrives with app signing activation.",
  notThePasskey:
    "Your passkey was not copied — keys never leave the authenticator. This reuses the account's recovery key instead, and this device signs with the key directly until passkey-native identity ships.",
  openButton: "Use my web identity",
  inputPlaceholder: "Paste your recovery key (nsec or hex)",
  checkButton: "Check key",
  replaceButton: "Replace this device's identity",
  cancelButton: "Cancel",
  backButton: "Edit key",
  closeLabel: "Close",
  checking: "Checking key…",
  replacing: "Replacing identity…",
  replacesLabel: (currentNpub: string) =>
    `This replaces the identity ${currentNpub} on this device. The current key is only recoverable if you backed it up — your web session is unaffected.`,
  wouldSignAs: (npub: string) => `This device would sign as ${npub}.`,
  replaced: (npub: string) => `This device now signs as ${npub}.`,
} as const;
