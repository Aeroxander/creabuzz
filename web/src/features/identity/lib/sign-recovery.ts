/**
 * What a gated action offers when this browser cannot sign *yet*.
 *
 * The passkey identity blocks signing until the credential is unlocked this
 * session (`SIGNING_BLOCKED_MESSAGE`). Every surface that can demand a
 * signature has to offer the way out beside the refusal — Review-Proven Rule 6:
 * a guard that hides the only recovery affordance is a functional failure, and
 * "Unlock your passkey before this browser can sign." with no button under it
 * is exactly that. The decision is a pure function so the table is testable
 * without a component tree.
 */

/** The action the reader can take right now. */
export type SignRecoveryAction = "signin" | "create";

export interface SignRecovery {
  action: SignRecoveryAction;
  /** What is wrong, in one sentence (the blocked reason when there is one). */
  headline: string;
  /** Button label. */
  cta: string;
  /** One line under the headline explaining what the button will do. */
  helper: string;
}

export interface SignRecoveryState {
  /** A passkey credential is registered on this browser. */
  registered: boolean;
  /** Its key is in memory this session (signed in / unlocked). */
  active: boolean;
  /** The signer's own refusal, when signing is blocked right now. */
  blockedReason: string | null;
}

const DEFAULT_BLOCKED =
  "This browser cannot sign until its passkey is unlocked.";

/**
 * The recovery to render for a given identity state — or `null` when there is
 * nothing to recover from (signed in, or an ordinary browser key that signs
 * without ceremony).
 *
 * | registered | active | blocked | result |
 * |-----------|--------|---------|--------|
 * | any       | true   | any     | `null` — signing works |
 * | true      | false  | any     | `signin` — the credential exists, unlock it |
 * | false     | false  | set     | `create` — blocked with nothing to unlock |
 * | false     | false  | null    | `null` — ordinary key, signing works |
 *
 * The third row is the defensive one: a signing block with no registered
 * credential would otherwise be a dead end with nothing to press.
 */
export function deriveSignRecovery(
  state: SignRecoveryState,
): SignRecovery | null {
  if (state.active) return null;
  if (state.registered) {
    return {
      action: "signin",
      headline: state.blockedReason ?? DEFAULT_BLOCKED,
      cta: "Sign in with passkey",
      helper:
        "Unlock the passkey this browser is signed in with — your action continues where you left off.",
    };
  }
  if (state.blockedReason) {
    return {
      action: "create",
      headline: state.blockedReason,
      cta: "Create a passkey",
      helper:
        "This browser has no passkey to unlock — create one so signing has a key it can open.",
    };
  }
  return null;
}
