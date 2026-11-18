/**
 * Removing several of your own records.
 *
 * The server takes a removal that names exactly one record, so several records are several removals, sent one after
 * another. If one fails the rest are not sent: the error says how many went through and how many did not, and the
 * page reads the list again so "Try again" removes what is left. Nothing is reported as removed that was not.
 *
 * Pure and alias-free: `removals.test.mjs` drives it under `node --test`.
 */

import { restrictionOf } from "../../../shared/lib/refusal-text.ts";

/** Thrown when a removal stopped part way: some records were removed and the rest were not. */
export class PartialRemovalError extends Error {
  readonly removed: number;
  readonly total: number;
  constructor(removed: number, total: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : "removal failed");
    this.name = "PartialRemovalError";
    this.removed = removed;
    this.total = total;
  }
}

/** Remove each of `ids` with `send`, in order, stopping at the first that fails. */
export async function removeEach(
  ids: readonly string[],
  send: (id: string) => Promise<unknown>,
): Promise<void> {
  let removed = 0;
  for (const id of [...new Set(ids)]) {
    try {
      await send(id);
    } catch (error) {
      throw new PartialRemovalError(removed, new Set(ids).size, error);
    }
    removed += 1;
  }
}

/**
 * What to say when a removal did not (all) go through: `nothing` when none was removed; otherwise how many were and
 * were not. The server's reason follows when it gave one for people.
 */
export function removalFailedLine(error: unknown, nothing: string): string {
  const why = restrictionOf(error);
  const left =
    error instanceof PartialRemovalError ? error.total - error.removed : 0;
  const base =
    error instanceof PartialRemovalError && error.removed > 0
      ? `${error.removed} of ${error.total} records were removed and ${left} ${left === 1 ? "was" : "were"} not. Try again to remove the rest.`
      : nothing;
  return why ? `${base} ${why}` : base;
}

/** What failed, then the server's reason in plain words when it gave one (who may post this, and what to do). */
export function withReason(base: string, error: unknown): string {
  const why = restrictionOf(error);
  return why ? `${base} ${why}` : base;
}
