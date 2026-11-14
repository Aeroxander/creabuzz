/**
 * The evidence a team member has typed for a milestone, kept across a reload or a cancelled wallet prompt, so a long
 * piece of writing is never lost to a closed tab. It is per wallet and per milestone of one lock, and it is cleared once
 * the milestone has been published.
 *
 * Pure and alias-free: `challenge-draft.test.mjs` drives it under `node --test`.
 */

const PREFIX = "buzz.launchpad.challenge-draft:";

export function challengeDraftKey(
  lock: string,
  wallet: string,
  index: number,
): string {
  return `${PREFIX}${lock.toLowerCase()}:${wallet.toLowerCase()}:${index}`;
}

export function loadChallengeDraft(
  key: string,
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): string {
  try {
    const text = storage?.getItem(key);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

/** Keeps `text`, or forgets the draft when there is nothing in it. */
export function saveChallengeDraft(
  key: string,
  text: string,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage(),
): void {
  try {
    if (text.trim() === "") storage?.removeItem(key);
    else storage?.setItem(key, text);
  } catch {
    // Storage unavailable: the draft just does not survive a reload.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
