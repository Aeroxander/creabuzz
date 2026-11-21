/**
 * The sentences of the named helper's agree step (plan section 5.8, C35). Pure. They say what is so and what to do next and
 * name no event, code or contract.
 */

/** What the helper reads on a task made for them. */
export const agreeWords = (passkey: boolean) =>
  passkey
    ? "This task is for you. Say yes and your account is where you will be paid. Nothing is paid or moved by this."
    : "This task is for you. Say yes and the wallet you connect is where you will be paid. Nothing is paid or moved by this.";

export const agreePress = (passkey: boolean) =>
  passkey ? "Agree and name my account" : "Agree and name my wallet";

export const AGREE_DONE = "Saved. The team can plan your pay now.";

export const AGREE_FAILED =
  "Your yes was not saved. Check your connection and try again.";

/** The wallet could not be connected (closed, refused or missing), or the passkey account not read: nothing was written. */
export const agreeNoWallet = (passkey: boolean) =>
  passkey
    ? "Your account could not be read, so nothing was saved. Try again."
    : "The wallet could not be connected, so nothing was saved. Open your wallet and try again.";
