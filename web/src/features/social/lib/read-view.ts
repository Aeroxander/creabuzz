/**
 * What a list page shows for the state of its reads, and what the bottom of a scrolling list shows. A failed read is a
 * failure with a retry, never "Nothing here yet"; a failed older page is a "Couldn't load older posts" row with a
 * retry, never a quiet end of the list. What loaded before stays on screen when a later read fails (Review-Proven
 * Rules 1 and 6). Pure and alias-free: `read-view.test.mjs` drives it under `node --test`.
 */

export type ListView = "loading" | "error" | "empty" | "list";

/**
 * `count` is how many rows are ready to show; `error` is the first failure among the reads the list needs (null when
 * none failed); `loading` is true while a read the list needs has not answered yet.
 */
export function listView(read: {
  count: number;
  error: unknown;
  loading: boolean;
}): ListView {
  if (read.count > 0) return "list";
  if (read.error) return "error";
  if (read.loading) return "loading";
  return "empty";
}

/** The first failure among several reads, or null. */
export function firstError(...errors: unknown[]): unknown {
  return errors.find((error) => Boolean(error)) ?? null;
}

export type MoreState = "idle" | "loading" | "failed" | "end";

/**
 * The bottom of a scrolling list. "idle" may load the next page as it scrolls into view; "failed" waits for the
 * reader's "Try again" so a failing server is not asked again and again; "end" is the real end.
 */
export function moreState(list: {
  hasMore: boolean;
  loadingMore: boolean;
  failed: boolean;
}): MoreState {
  if (list.loadingMore) return "loading";
  if (list.failed) return "failed";
  return list.hasMore ? "idle" : "end";
}

/**
 * The failure of the last older page of an infinite read (TanStack's `isFetchNextPageError`), kept apart from a failed
 * first read or refresh, which the page shows in place of the list.
 */
export function olderPageError(read: {
  error: unknown;
  isFetchNextPageError?: boolean;
}): unknown {
  return read.isFetchNextPageError ? read.error : null;
}

/** A failed first read or refresh of an infinite read, without the older-page failure `olderPageError` reports. */
export function firstPageError(read: {
  error: unknown;
  isFetchNextPageError?: boolean;
}): unknown {
  return read.isFetchNextPageError ? null : (read.error ?? null);
}

/**
 * A read that failed while another one answered: the list shows what loaded, and this is the failure to say above it
 * with a retry, so a partial list is never taken for the whole one. Null when the list is whole or not on screen.
 */
export function partialError(view: ListView, error: unknown): unknown {
  return view === "list" && error ? error : null;
}
