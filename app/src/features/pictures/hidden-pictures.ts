/**
 * The pictures this person hid, kept on this phone (per account, capped, dropped on sign-out): a hidden picture shows as a
 * covered place with a press to show it again. Hiding is the reader's own and tells nobody. Kept by the picture's hash, so
 * the same picture is hidden wherever it appears.
 */
import { createLocalIdSet, useLocalIdSet } from "../../lib/local-id-set";

/** The most hidden pictures kept per account; the oldest make way. */
export const MAX_HIDDEN_PICTURES = 500;

const HEX64 = /^[0-9a-f]{64}$/;

/** The picture's hash in its address on the server (`/media/<hash>.jpg`), or null for any other address. */
export function pictureKey(url: string): string | null {
  return /\/media\/([0-9a-f]{64})(?:\.|$)/.exec(url)?.[1] ?? null;
}

const set = createLocalIdSet({
  prefix: "creaton.hiddenpics.",
  max: MAX_HIDDEN_PICTURES,
  valid: (id) => HEX64.test(id),
});

/** Drops what this browser kept, so the next person to sign in on it never inherits it. Called when signing out. */
export const forgetAllHiddenPictures = set.clearAll;

/** The pictures the signed-in person hid, and the two ways to change it. */
export function useHiddenPictures() {
  const { ids, add, remove } = useLocalIdSet(set);
  return { hidden: ids, hide: add, show: remove };
}
