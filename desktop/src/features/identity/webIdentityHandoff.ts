/**
 * "Sign in with browser" — the browser → desktop account handoff.
 *
 * The desktop starts a one-time sign-in request (a throwaway keypair plus a
 * nonce, Rust: `identity_link`), the user finishes signing in on the web,
 * and the browser hands the account back through a `creaton://identity`
 * deep link. This module is the UI state machine for that flow: start the
 * request, wait for its result, show the linked account — fenced so a stale
 * or stray result never applies to a newer request (Review-Proven Rule 2).
 *
 * Nothing here ever sees or stores a key: the payload is decrypted and
 * committed entirely inside Rust, through the existing keyring-first
 * identity storage. This surface only carries the request id, the link URL,
 * and the linked account's public identifier.
 */

import type { IdentityLinkResult } from "@/shared/api/tauriIdentity";

export type WebIdentityHandoffState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting"; requestId: string; linkUrl: string }
  | { phase: "linked"; npub: string }
  | { phase: "error"; message: string };

export type WebIdentityHandoffDeps = {
  /** Start a one-time request and open the browser (Rust does both). */
  start: () => Promise<{ id: string; url: string }>;
  /** Abandon any outstanding request. */
  cancel: () => void | Promise<void>;
  /** Subscribe to identity-link results; returns an unsubscribe function. */
  results: (listener: (result: IdentityLinkResult) => void) => () => void;
  /** Post-link re-scope (relay disconnect + identity query rekey). */
  onLinked: (npub: string) => void;
};

export type WebIdentityHandoff = {
  getState: () => WebIdentityHandoffState;
  subscribe: (listener: () => void) => () => void;
  /** Begin the browser sign-in. Ignored while one is already running. */
  start: () => Promise<void>;
  /** Abandon the flow and reset to idle. */
  cancel: () => void;
  /**
   * Feed a result (the live event, or one picked up on mount via
   * `take_identity_link_result`). Only a result matching the current
   * request id is ever applied.
   */
  handleResult: (result: IdentityLinkResult) => void;
  /** Release the result subscription. */
  dispose: () => void;
};

/** User-facing copy. Kept here (not inline) so the wording is testable. */
export const WEB_IDENTITY_HANDOFF_COPY = {
  title: "Use my web account",
  intro:
    "Sign in on the web and this device joins that account automatically — there is no key to copy.",
  replacesWarning:
    "This replaces the account on this device. Back up the current key first if you haven't.",
  openButton: "Sign in with browser",
  onboardingHint: "Use your Creaton account from the web",
  starting: "Opening your browser…",
  waiting:
    "Finish signing in in your browser — this window links up automatically.",
  cancelButton: "Cancel",
  tryAgainButton: "Try again",
  closeLabel: "Done",
  linked: (npub: string) => `This device now signs as ${npub}.`,
  technicalTitle: "Technical details",
  technical:
    "The web app encrypts your account key to a one-time device key and sends it back over a single-use link that expires after 5 minutes. The link response is validated and stored on this device only, and is never logged.",
  startError: (message: string) => `Couldn't start sign-in: ${message}`,
  fallbackError: "Sign-in didn't complete. Try again.",
} as const;

/** Plain-language copy for each rejection reason Rust can report. */
const REJECTED_COPY: Record<string, string> = {
  "nonce-mismatch":
    "That sign-in response didn't match this request. Try signing in again.",
  expired: "That sign-in link expired. Try signing in again from the browser.",
  "sender-mismatch":
    "That sign-in response didn't come from the account it carried. Try signing in again from the browser.",
  "no-pending-request":
    "That sign-in link was already used or isn't active. Start sign-in again.",
  malformed:
    "That sign-in response couldn't be read. Try signing in again from the browser.",
  storage:
    "Your account key couldn't be saved on this device. Check your keychain, then try again.",
};

export function rejectedCopy(reason: string | null | undefined): string {
  if (reason && REJECTED_COPY[reason]) return REJECTED_COPY[reason];
  return WEB_IDENTITY_HANDOFF_COPY.fallbackError;
}

/**
 * Create the handoff controller. Async results are fenced twice: by
 * generation (a `cancel()` or newer `start()` invalidates whatever was in
 * flight) and by request id (a deep-link result only applies to the exact
 * request it belongs to).
 */
export function createWebIdentityHandoff(
  deps: WebIdentityHandoffDeps,
): WebIdentityHandoff {
  let state: WebIdentityHandoffState = { phase: "idle" };
  let generation = 0;
  // A result that arrives before `start()` resolves is held briefly and
  // applied once the matching request is registered.
  let bufferedResult: IdentityLinkResult | null = null;
  const listeners = new Set<() => void>();

  const setState = (next: WebIdentityHandoffState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const handleResult = (result: IdentityLinkResult) => {
    const current = state;
    if (current.phase === "starting") {
      bufferedResult = result;
      return;
    }
    if (current.phase !== "waiting") return;
    // Fence by request id: a stale result from a previous request — or a
    // stray payload addressed to no live request — must not apply here.
    if (result.id !== current.requestId) return;
    if (result.status === "linked") {
      if (!result.npub) return;
      deps.onLinked(result.npub);
      setState({ phase: "linked", npub: result.npub });
      return;
    }
    setState({ phase: "error", message: rejectedCopy(result.reason) });
  };

  const unlistenResults = deps.results(handleResult);

  return {
    getState: () => state,

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start() {
      const current = state;
      if (current.phase === "starting" || current.phase === "waiting") return;
      const candidateGeneration = ++generation;
      bufferedResult = null;
      setState({ phase: "starting" });
      try {
        const started = await deps.start();
        if (candidateGeneration !== generation) return;
        setState({
          phase: "waiting",
          requestId: started.id,
          linkUrl: started.url,
        });
        if (bufferedResult) {
          const buffered = bufferedResult;
          bufferedResult = null;
          handleResult(buffered);
        }
      } catch (error) {
        if (candidateGeneration !== generation) return;
        setState({
          phase: "error",
          message: WEB_IDENTITY_HANDOFF_COPY.startError(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
    },

    cancel() {
      generation += 1;
      bufferedResult = null;
      void deps.cancel();
      setState({ phase: "idle" });
    },

    handleResult,

    dispose() {
      unlistenResults();
    },
  };
}
