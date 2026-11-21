/**
 * The posts this person reported, kept on this phone so they stop showing for them at once. A report goes to the people who
 * run the server and is not shown back to anyone, so there is no list to read it from again: this is the only record, and it
 * is said so where it is used ("hidden for you on this phone"). Kept per account in this browser's storage, every access
 * inside `try` (with no storage the post simply shows again), newest last, and never more than {@link MAX_REPORTED}.
 */
import { createLocalIdSet, useLocalIdSet } from "../../lib/local-id-set";

/** The most reported posts kept per account; the oldest make way. */
export const MAX_REPORTED = 500;

const HEX64 = /^[0-9a-f]{64}$/;
const set = createLocalIdSet({
  prefix: "creaton.reported.",
  max: MAX_REPORTED,
  valid: (id) => HEX64.test(id),
});

/** The ids of the posts `me` reported. */
export const reportedBy = set.of;

/** Remember that `me` reported the post `id`. */
export const rememberReported = set.add;

/** Show a reported post again for `me`. */
export const forgetReportedPost = set.remove;

/** Drops what this browser kept, so the next person to sign in on it never inherits it. Called when signing out. */
export const forgetAllReported = set.clearAll;

/** The posts the signed-in person reported, and the two ways to change it. */
export function useReported() {
  const { ids, add, remove } = useLocalIdSet(set);
  return { reported: ids, add, undo: remove };
}
