/** The earlier backers' claim page's own words: its states, what a grant is worth, and what it never says. */
import { waitWords } from "../pause/pause-words";
import { sharesWords } from "../pot/pot-words";

export const SIGN_IN = "Sign in to see whether this link is for your account.";
export const NOT_FOR_YOU =
  "This link is not for the account you are using. Open it with the account it was made for.";
export const NOT_OPEN = "Claims are not open yet.";
export const TEXTS_DIFFER =
  "This page and the network name different texts. Do not accept. Tell the person who sent you the link.";
export const ALREADY_CLAIMED =
  "This grant is already claimed. You can see it in Your Shares.";
export const CLAIMED = "Claimed. Your Team Shares unlock over time.";
export const READ_THE_TEXT = "Read the text";
export const MUST_READ_FIRST =
  "Open the text first. The claim is offered once you have.";
export const TAKING_OUT =
  "Taking Team Shares out pays only what the project holds above what backers put in. That can be nothing.";
export const COULD_NOT_READ =
  "The project's numbers or the network could not be read, so nothing can be shown here. Nothing was claimed. Try again.";

/** "Your grant: 1,000 Team Shares." */
export function yourGrant(amount: bigint): string {
  return `Your grant: ${sharesWords(amount)} Team Shares.`;
}

/** The vesting clock in plain words: days on a real network, a shorter span on a demo one. */
export function clockWords(seconds: number): string {
  const days = seconds / 86_400;
  return Number.isInteger(days) && days >= 2
    ? `${days} days`
    : waitWords(seconds);
}

/** "2 of 40 grants claimed." A total, never a name. */
export function claimedCount(claimed: number, rows: number): string {
  return `${claimed.toLocaleString("en-GB")} of ${rows.toLocaleString("en-GB")} grants claimed.`;
}

/** The fingerprint cut for reading: "0xc82128c7…7e5f". */
function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-4)}`;
}

export function fingerprintLine(hash: string): string {
  return `The text you accept has the fingerprint ${shortHash(hash)}.`;
}
