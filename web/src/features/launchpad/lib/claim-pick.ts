/**
 * Which claim a dispute form has chosen.
 *
 * A form opened from a claim card ("freeze this one") names its target. If that claim stops being eligible before the
 * form loads (it was paid, frozen or closed in the meantime), quietly choosing the first other claim would put a
 * different claim's freeze in front of someone who meant this one. So an explicit target that is gone is reported as
 * gone, and nothing is chosen until the person picks again. Only a form opened with no target defaults to the first.
 *
 * "Defaults to the first" must not mean "follows whatever is first": the first option a form shows becomes its target
 * (`rememberShown`), so if it disappears on the next refresh the form says so instead of quietly showing the next one.
 *
 * Pure and alias-free: `claim-pick.test.mjs` drives it under `node --test`.
 */

export interface ClaimPick {
  /** The chosen option's key, or null when nothing is chosen. */
  key: string | null;
  /** The person asked for a particular claim and it is no longer there. */
  gone: boolean;
}

/**
 * @param keys the eligible options, as `mandate:claim` keys
 * @param requested the claim the form was opened for, if any
 * @param selected what the person picked in the form since ("" when they have not)
 */
export function resolvePick(
  keys: readonly string[],
  requested: string | null,
  selected: string,
): ClaimPick {
  const target = selected !== "" ? selected : (requested ?? "");
  if (target === "") return { key: keys[0] ?? null, gone: false };
  const match = keys.find((key) => key.toLowerCase() === target.toLowerCase());
  return match ? { key: match, gone: false } : { key: null, gone: true };
}

/**
 * The selection to keep once a pick has been shown: if nothing was picked yet and one is on screen, that is now the
 * choice, exactly as if the person had picked it. Anything already picked is left alone.
 */
export function rememberShown(selected: string, pick: ClaimPick): string {
  return selected === "" && pick.key !== null ? pick.key : selected;
}
