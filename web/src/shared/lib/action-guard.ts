/**
 * Whether this page may send anything as the signed-in person right now.
 *
 * When the server's terms or privacy note have changed and the person has not yet agreed to the new text, they stay
 * signed in and can read, save their recovery key and sign out, but cannot post or act. The terms notice
 * (`PolicyReacceptHost`) switches this on and off; every send goes through `assertMayAct` first (`publish-event.ts`).
 *
 * Page-lifetime state: switching community reloads the page, which clears it. It is only ever set from the live
 * policy check of the community being shown.
 *
 * Alias-free: `action-guard.test.mjs` drives it under `node --test`.
 */

/** The refusal shown to a person who has not agreed to changed terms. */
export class TermsNotAgreedError extends Error {
  constructor() {
    super(
      "The terms of use or privacy note have changed, and you have not agreed to them yet. Open the notice on this page, read the text and tick the box to agree. Then try again.",
    );
    this.name = "TermsNotAgreedError";
  }
}

let blocked = false;

/** Block (or allow again) everything that sends as the person. */
export function setActionsBlocked(value: boolean): void {
  blocked = value;
}

/** Throws {@link TermsNotAgreedError} while changed terms are not agreed to. */
export function assertMayAct(): void {
  if (blocked) throw new TermsNotAgreedError();
}
