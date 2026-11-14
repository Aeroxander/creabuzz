/**
 * Backing in Home's feed: a quiet group of one-line cards below the project records. They are the only place in the app
 * that may show a price line (and only on the card for a day's buys); they sit under updates and promises, in small muted
 * type, with nothing to press but the link to the project. Nothing renders when the build has investing off.
 */

import { Link } from "@tanstack/react-router";
import { Coins } from "lucide-react";
import { useState } from "react";

import { investingOffered } from "@/features/launchpad/lib/investing-offered";
import type { LaunchRecord } from "@/features/launchpad/models";
import { relativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";

import { backingFeedLine } from "../lib/backing-feed";
import { useBackingFeed } from "../use-backing-feed";
import type { FeedScope } from "../use-record-feed";

/** How many cards show before "Show more". */
const SHOWN = 5;

export function BackingFeed(props: {
  scope: FeedScope | null;
  byCoordinate: ReadonlyMap<string, LaunchRecord>;
}) {
  if (!investingOffered()) return null;
  return <BackingFeedBody {...props} />;
}

function BackingFeedBody({
  scope,
  byCoordinate,
}: {
  scope: FeedScope | null;
  byCoordinate: ReadonlyMap<string, LaunchRecord>;
}) {
  const feed = useBackingFeed(scope);
  const [all, setAll] = useState(false);
  const items = feed.items.filter((item) => byCoordinate.has(item.coordinate));
  if (items.length === 0 && feed.failed === 0 && !feed.cut) return null;
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <section
      aria-labelledby="backing-feed-heading"
      className="flex flex-col gap-1 border-t border-border/60 pt-3"
      data-testid="backing-feed"
    >
      <h3
        className="text-xs font-medium text-muted-foreground"
        id="backing-feed-heading"
      >
        Backing
      </h3>
      <ul className="flex flex-col gap-1">
        {shown.map((item) => {
          const record = byCoordinate.get(item.coordinate);
          if (!record) return null;
          return (
            <li
              className="flex items-start gap-2 text-sm text-muted-foreground"
              data-kind={item.card.kind}
              data-testid="backing-feed-card"
              key={item.id}
            >
              <Coins aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                <Link
                  className="underline-offset-2 hover:underline max-sm:inline-block max-sm:min-h-11 max-sm:py-2.5"
                  params={{ launchId: record.id }}
                  search={{ author: record.author }}
                  to="/launchpad/$launchId"
                >
                  {backingFeedLine(item, record.name)}
                </Link>{" "}
                <span className="text-xs">· {relativeTime(item.at)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {items.length > SHOWN && !all ? (
        <div>
          <Button
            className="max-sm:h-11"
            data-testid="backing-feed-more"
            onClick={() => setAll(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Show {items.length - SHOWN} more
          </Button>
        </div>
      ) : null}
      {feed.failed > 0 ? (
        <p className="text-xs" data-testid="backing-feed-failed" role="status">
          Couldn't read backing for {feed.failed}{" "}
          {feed.failed === 1 ? "project" : "projects"}, so it is missing here.{" "}
          <button
            className="underline max-sm:min-h-11"
            onClick={feed.retry}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : null}
      {feed.cut ? (
        <p className="text-xs" data-testid="backing-feed-cut" role="status">
          Backing is read for the newest projects only, so some projects'
          backing is not shown here.
        </p>
      ) : null}
    </section>
  );
}
