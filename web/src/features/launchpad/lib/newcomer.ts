/**
 * A newcomer's first week on a contributor project (CHECK-AND-NEWCOMER-PLAN.md): three steps, in order, each ticked from
 * what the person did rather than asked of them. Read the aim and Now (they say so), take on one small piece (their
 * first "taking this on" record here), then read the check note that comes after it. Shown only to someone signed in
 * who is not the founder and holds no Shares in the project, until the last two are done.
 *
 * Pure and alias-free: `newcomer.test.mjs` drives it under `node --test`.
 */

export type NewcomerStep = "read" | "take" | "check";

export function newcomerSteps(input: {
  me: string | null;
  founder: string;
  /** Null while the holdings are not read: nothing is shown until they are. */
  holdsShares: boolean | null;
  /** They said they read the aim and Now. */
  read: boolean;
  /** When each of their own "taking this on" records in this project was made. */
  myTakings: readonly number[];
  /** When each check note was published. */
  notes: readonly number[];
}): { show: boolean; done: Record<NewcomerStep, boolean> } {
  const firstTake = input.myTakings.length
    ? Math.min(...input.myTakings)
    : null;
  const done = {
    read: input.read,
    take: firstTake !== null,
    check: firstTake !== null && input.notes.some((at) => at > firstTake),
  };
  const show =
    input.me !== null &&
    input.me !== input.founder &&
    input.holdsShares === false &&
    !(done.take && done.check);
  return { show, done };
}
