/**
 * What the bell's list says for the state of its poll. A poll that failed before anything was read is a failure with
 * a retry, never "Nothing new"; a failed later poll keeps the last good list and says it may be out of date. Pure and
 * alias-free: `bell-state.test.mjs` drives it under `node --test`.
 */

export type BellView = "loading" | "error" | "empty" | "list";

export function bellState(poll: {
  data: readonly unknown[] | undefined;
  error: unknown;
  isLoading: boolean;
}): { view: BellView; stale: boolean } {
  if (poll.data !== undefined) {
    return {
      view: poll.data.length === 0 ? "empty" : "list",
      stale: Boolean(poll.error),
    };
  }
  if (poll.error) return { view: "error", stale: false };
  return { view: poll.isLoading ? "loading" : "empty", stale: false };
}
