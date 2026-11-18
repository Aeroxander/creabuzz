/**
 * "This week on Creaton": plain counts of what the signed records say happened in the last seven days (updates posted,
 * promises kept and missed, work accepted, new projects), worked out in the browser from the same records the feed
 * shows (`lib/week-in-review.ts`). It appears from the server's second week, and never as an empty week.
 *
 * It reads every listed project, not only the reader's own, so its words are about the whole server whoever is looking.
 * When the read stopped before it reached back a whole week, the counts say "at least".
 */

import { useMemo } from "react";

import { type FeedScope, useRecordFeed } from "../use-record-feed";
import { FEED_PROJECTS } from "../lib/record-feed";
import { weekInReview, weekInReviewLines } from "../lib/week-in-review";
import { useListedLaunches } from "../use-listed-launches";

const WEEK = 7 * 86_400;

export function WeekInReview() {
  const { listed } = useListedLaunches();
  // The server's age gates the read: a first week is not summed up, so nothing more is asked for then.
  const shown = useMemo(() => {
    if (!listed || listed.length === 0) return null;
    const starts = listed.map((l) => l.record.startedAt);
    if (Math.floor(Date.now() / 1000) - Math.min(...starts) < WEEK) return null;
    return {
      starts,
      scope: {
        mode: "everyone",
        projects: listed.slice(0, FEED_PROJECTS).map((l) => l.record),
        cut: listed.length > FEED_PROJECTS,
      } satisfies FeedScope,
    };
  }, [listed]);
  return shown ? <Review scope={shown.scope} starts={shown.starts} /> : null;
}

function Review({
  scope,
  starts,
}: {
  scope: FeedScope;
  starts: readonly number[];
}) {
  const feed = useRecordFeed(scope);
  const counts = useMemo(
    () =>
      feed.loading || feed.error
        ? null
        : weekInReview({
            items: feed.items,
            starts,
            now: Math.floor(Date.now() / 1000),
          }),
    [feed.loading, feed.error, feed.items, starts],
  );
  if (!counts) return null;
  // Counts of a read that did not reach everything are a floor, not a total.
  const atLeast =
    feed.hasMore || feed.cut || feed.workCut || feed.authorsCut || scope.cut;
  const lines = weekInReviewLines(counts, atLeast);
  return (
    <section
      aria-labelledby="week-in-review-title"
      className="glass rounded-2xl border p-4"
      data-testid="week-in-review"
    >
      <h3 className="text-sm font-bold" id="week-in-review-title">
        This week on Creaton
      </h3>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {lines.map((line) => (
          <li data-testid="week-in-review-line" key={line}>
            {line}
          </li>
        ))}
      </ul>
    </section>
  );
}
