/**
 * Agreeing to the server's terms again when they change.
 *
 * Sign-up keeps which version of the terms and privacy note was agreed to, and for which server, in this browser. The
 * server's `version` is a hash of the terms text, the privacy text (each carries its own "Last updated" line) and
 * whether it asks for the age box, so any change to what a person read or ticked gives a new version. When a signed-in
 * person's remembered version is not the served one, the app asks them to agree again before they can post or act.
 *
 * Page-lifetime state here (`sessionAgreed`, the listeners) belongs to the one community the page shows: switching
 * community reloads the page, which clears it. The desktop app's `resetCommunityState` does not apply to this client.
 *
 * Alias-free: `policy-acceptance.test.mjs` drives it under `node --test`.
 */

import { type PolicyState, policyRequirements } from "./join-policy.ts";

export const ACCEPTED_KEY = "creaton.joinPolicy.accepted";

/** The part of `localStorage` used here, so a test can stand in for it. */
type Store = Pick<Storage, "getItem" | "setItem">;

function browserStore(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** What this visit agreed to when the browser would not keep it (so a refusing browser is not asked in a loop). */
let sessionAgreed: { version: string; host: string } | null = null;
/** Set when this visit made an account without agreeing to any terms: an older record in the browser must not count. */
let sessionUnagreed = false;
const listeners = new Set<() => void>();

/** Forget this visit's page-lifetime state (tests, and nothing else: a reload does this in the app). */
export function resetAcceptanceState(): void {
  sessionAgreed = null;
  sessionUnagreed = false;
  listeners.clear();
}

/** Be told, in this tab, whenever a version is agreed to. Returns how to stop. */
export function subscribeAcceptance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Keep which version was agreed to, for which server, and when. Returns false when the browser would not keep it: the
 * agreement still counts for this visit, and the person is asked again next time.
 */
export function rememberAcceptance(
  version: string,
  host: string,
  at = Date.now(),
  store: Store | undefined = browserStore(),
): boolean {
  sessionAgreed = { version, host };
  sessionUnagreed = false;
  let kept = true;
  try {
    if (!store) throw new Error("no storage");
    store.setItem(ACCEPTED_KEY, JSON.stringify({ version, at, host }));
  } catch {
    kept = false;
  }
  for (const listener of [...listeners]) listener();
  return kept;
}

/**
 * Keep the fact that an account was made without agreeing to any terms (they could not be loaded, or the server had
 * none). It replaces an older agreement in this browser, which belonged to an earlier account, so the first time the
 * server answers with terms the person is asked as a first agreement. Returns false when the browser would not keep
 * it: the record still counts for this visit.
 */
export function rememberNoAgreement(
  host: string,
  at = Date.now(),
  store: Store | undefined = browserStore(),
): boolean {
  sessionAgreed = null;
  sessionUnagreed = true;
  let kept = true;
  try {
    if (!store) throw new Error("no storage");
    store.setItem(
      ACCEPTED_KEY,
      JSON.stringify({ version: null, agreed: false, at, host }),
    );
  } catch {
    kept = false;
  }
  for (const listener of [...listeners]) listener();
  return kept;
}

/**
 * What sign-up records once an account exists: the version agreed to when the terms were shown, otherwise the fact
 * that none were. Every way of making or restoring an account calls this, with the state the person saw.
 */
export function recordSignUpTerms(
  state: PolicyState,
  host: string,
  at = Date.now(),
  store: Store | undefined = browserStore(),
): boolean {
  return state.status === "ready"
    ? rememberAcceptance(state.policy.version, host, at, store)
    : rememberNoAgreement(host, at, store);
}

/**
 * The version of the terms agreed to for the server `host`, or null when none was. A record from before servers were
 * kept (no host) is taken for any server: its version only matches when the text is the same.
 */
export function acceptedVersion(
  host: string,
  store: Store | undefined = browserStore(),
): string | null {
  if (sessionUnagreed) return null;
  try {
    const raw = store?.getItem(ACCEPTED_KEY);
    if (raw) {
      const record: unknown = JSON.parse(raw);
      if (record !== null && typeof record === "object") {
        const { version, host: recordHost } = record as Record<string, unknown>;
        if (
          typeof version === "string" &&
          (recordHost === undefined || recordHost === host)
        )
          return version;
      }
    }
  } catch {
    // Unreadable or refused: fall through to what this visit agreed to.
  }
  return sessionAgreed?.host === host ? sessionAgreed.version : null;
}

/** What the signed-in person should see about the terms. */
export type Reaccept =
  | { kind: "none" }
  /** Ask them to agree; `changed` is false when they never agreed to any version here. */
  | { kind: "ask"; changed: boolean }
  /** The server did not answer: say so, offer a retry, and block nothing. */
  | { kind: "unavailable" };

export function reacceptCheck({
  signedIn,
  state,
  accepted,
}: {
  signedIn: boolean;
  state: PolicyState;
  accepted: string | null;
}): Reaccept {
  if (!signedIn) return { kind: "none" };
  if (state.status === "unavailable") return { kind: "unavailable" };
  if (state.status !== "ready") return { kind: "none" };
  const needs = policyRequirements(state);
  if (!needs.agreement && !needs.age) return { kind: "none" };
  if (accepted === state.policy.version) return { kind: "none" };
  return { kind: "ask", changed: accepted !== null };
}
