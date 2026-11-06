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
  return `Create your account to ${action}.`;
}

/** Asks the account menu to open its sign-up dialog (it owns that flow). */
export const SIGN_UP_EVENT = "creaton:sign-up";

/** Asks the account menu to open its sign-in dialog (recovery key), as `SIGN_UP_EVENT` does for sign-up. */
export const SIGN_IN_EVENT = "creaton:sign-in";

/**
 * Shown at sign-up when the server's terms could not be loaded. Sign-up still works, because no server answers before
 * a first community. It says plainly that nothing was agreed to, and what happens next.
 */
export const TERMS_NOT_LOADED =
  "This server's terms could not be loaded, so you are not agreeing to any terms yet. You can still go on. The first time the server answers, you will be asked to agree, and until you do you cannot post or act.";
