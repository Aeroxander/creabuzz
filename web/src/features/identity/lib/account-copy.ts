/**
 * What the app calls the thing a person makes to use it.
 *
 * Underneath it is a key pair that signs everything the person does, but the
 * people we are building for (filmmakers, musicians, founders) do not have a
 * word for that and should not need one: it is "your account", the secret
 * they save is a "recovery key", and the way in that needs nothing to
 * remember is "a passkey". Wording lives here so every screen says the same
 * thing.
 */

/** The button or link that starts sign-up. */
export const CREATE_ACCOUNT = "Create your account";

/** A sentence for the moment someone tries to do something that needs an account. */
export function needAccountTo(action: string): string {
  return `Create your account (top right) to ${action}.`;
}

/** The secret a person saves so they can get back into their account. */
export const RECOVERY_KEY = "recovery key";

/** Asks the account menu to open its sign-up dialog (it owns that flow). */
export const SIGN_UP_EVENT = "creaton:sign-up";
