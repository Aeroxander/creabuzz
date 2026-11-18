/**
 * What a failed wiki rename or delete says. A rename is two writes (the page saved under its new name, then the old
 * name deleted), so it can fail halfway: the new page is then live and the old one still there, and saying "nothing was
 * renamed" would be wrong. A refusal (a ban, a timeout, the request limit) is said in its plain words; anything else
 * (no answer, the server's internal failure) as what did not happen and to try again.
 *
 * Alias-free: `rename-failure.test.mjs` drives it under `node --test`.
 */
import { failureWords } from "../../../shared/lib/readable-error.ts";

/** The rename saved the page under its new name, but deleting the old name failed (`cause`). */
export class RenameIncompleteError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Saved under the new name, but the old name is still there.");
    this.name = "RenameIncompleteError";
    this.cause = cause;
  }
}

/** Save under the new name, then delete the old; a failed delete after a save is a {@link RenameIncompleteError}. */
export async function renameInTwoWrites(
  saveUnderNewName: () => Promise<unknown>,
  deleteOldName: () => Promise<unknown>,
): Promise<void> {
  await saveUnderNewName();
  try {
    await deleteOldName();
  } catch (error) {
    throw new RenameIncompleteError(error);
  }
}

export const RENAME_FAILED_TEXT =
  "The server didn't confirm it, so nothing was renamed. Try again.";
export const DELETE_FAILED_TEXT =
  "The server didn't confirm it, so the page was not deleted. Try again.";

/** A failed rename for the toast: halfway says so (and why the old name stayed); otherwise why nothing changed. */
export function renameFailureText(error: unknown): string {
  if (error instanceof RenameIncompleteError) {
    const why = failureWords(error.cause, "").text;
    return why ? `${error.message} ${why}` : error.message;
  }
  return failureWords(error, RENAME_FAILED_TEXT).text;
}

/** A failed delete for the toast. */
export function deleteFailureText(error: unknown): string {
  return failureWords(error, DELETE_FAILED_TEXT).text;
}
