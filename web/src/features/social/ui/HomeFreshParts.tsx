import { ArrowUp } from "lucide-react";

import { freshLabel, freshOffered } from "../lib/home-fresh";

/**
 * The line between the posts that are new since the reader's last visit (above) and the ones they were shown then
 * (below), in Home's newest-first orders.
 */
export function LastVisitLine() {
  return (
    <div
      className="flex items-center gap-3 px-4 py-2 text-xs font-semibold text-sky-700 dark:text-sky-400"
      data-testid="home-last-visit"
    >
      <span
        aria-hidden
        className="h-px flex-1 bg-sky-700/30 dark:bg-sky-400/30"
      />
      <span className="flex items-center gap-1">
        <ArrowUp aria-hidden className="h-3.5 w-3.5" />
        New since your last visit
        <span className="sr-only">: the posts above</span>
      </span>
      <span
        aria-hidden
        className="h-px flex-1 bg-sky-700/30 dark:bg-sky-400/30"
      />
    </div>
  );
}

/**
 * "N new posts. Show", floating at the top of the timeline without taking room in it, so its arrival moves nothing.
 * It sits in a polite live region: a screen reader hears that new posts arrived, and, after Show, that they are on
 * top. A failed check says so and offers to check again instead of going quiet. `items-start`: the room is 0 high, and
 * a stretched pill would be squashed to it.
 */
export function NewPostsBar({
  fresh,
  failed,
  shown,
  onShow,
  onRetry,
}: {
  fresh: { count: number; capped: boolean };
  failed: boolean;
  /** What the last Show put on top, said once to a screen reader. */
  shown: string | null;
  onShow: () => void;
  onRetry: () => void;
}) {
  const pill =
    "pointer-events-auto mt-2 rounded-full border border-black/10 bg-background px-4 py-1.5 text-xs font-semibold text-sky-700 shadow-md hover:bg-sky-50 dark:border-white/15 dark:text-sky-400 dark:hover:bg-white/10";
  return (
    <div
      aria-live="polite"
      className="pointer-events-none sticky top-24 z-10 flex h-0 items-start justify-center max-md:top-36"
      data-testid="home-new-posts"
      role="status"
    >
      {freshOffered(fresh) ? (
        <button
          className={pill}
          data-testid="home-show-new"
          onClick={onShow}
          type="button"
        >
          {freshLabel(fresh)}. Show
        </button>
      ) : failed ? (
        <button
          className={pill}
          data-testid="home-new-retry"
          onClick={onRetry}
          type="button"
        >
          Couldn&apos;t check for new posts. Try again
        </button>
      ) : shown ? (
        <span className="sr-only">{shown}</span>
      ) : null}
    </div>
  );
}
