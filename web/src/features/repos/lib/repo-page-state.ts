/**
 * What a repository page shows. A failed read is its own state with a way to try again: it is never shown as
 * "Repository not found" or "No code yet", which would tell the reader the code is gone when the server only did not
 * answer.
 */
export type RepoPageState = "loading" | "error" | "missing" | "ready";

export function repoPageState({
  isLoading,
  error,
  found,
}: {
  isLoading: boolean;
  error: unknown;
  found: boolean;
}): RepoPageState {
  if (isLoading) return "loading";
  // A repository already read stays on screen when a later refresh fails.
  if (found) return "ready";
  return error ? "error" : "missing";
}

/** Shown when the clipboard refuses a copy: what happened and what to do instead. */
export const COPY_FAILED_TEXT =
  "Couldn't copy. Select the text and copy it yourself.";
