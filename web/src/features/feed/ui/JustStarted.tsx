/**
 * "Just started": the projects that began less than a week ago and have not posted yet, as a quiet strip at the top of
 * Home's Updates tab. Each says when it started and can be followed. It gives a new server something true to show
 * before anyone has posted a week of updates. Nothing here is a price, a rank or a count of money.
 *
 * Not the reader's own project, not one set to "Not listed yet", and not one the feed already announces with its own
 * "Just started" card (`lib/just-started.ts`).
 */

import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import {
  needAccountTo,
  SIGN_UP_EVENT,
} from "@/features/identity/lib/account-copy";
import { launchCoordinate } from "@/features/launchpad/models";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";

import { justStarted } from "../lib/just-started";
import { useListedLaunches } from "../use-listed-launches";
import { FollowButton } from "./FollowButton";
import { ProjectMark } from "./MovingNow";

export function JustStarted({
  announced,
}: {
  /** The coordinates of the projects the feed announces already. */
  announced: ReadonlySet<string>;
}) {
  const me = existingUserPubkey();
  const { listed, newsFresh } = useListedLaunches();
  const picks = useMemo(
    () =>
      listed && newsFresh
        ? justStarted(listed, {
            now: Math.floor(Date.now() / 1000),
            me,
            announced,
            coordinate: (record) => launchCoordinate(record.author, record.id),
          })
        : [],
    [listed, newsFresh, me, announced],
  );
  if (picks.length === 0) return null;
  return (
    <section
      aria-labelledby="just-started-title"
      className="glass rounded-2xl border p-4"
      data-testid="just-started"
    >
      <h3 className="text-sm font-bold" id="just-started-title">
        Just started
      </h3>
      <p className="text-xs text-muted-foreground">
        New this week, with no update yet.
        {me === null ? ` ${needAccountTo("follow one")}` : ""}
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {picks.map(({ record }) => (
          <li
            className="flex items-center gap-3"
            data-testid="just-started-item"
            key={`${record.author}:${record.id}`}
          >
            <ProjectMark image={record.image} name={record.name} />
            <span className="min-w-0 flex-1">
              <Link
                className="block truncate text-sm font-bold hover:underline max-sm:min-h-11 max-sm:leading-[2.75rem]"
                params={{ launchId: record.id }}
                search={{ author: record.author }}
                to="/launchpad/$launchId"
              >
                {record.name}
              </Link>
              <span className="block truncate text-xs text-muted-foreground">
                Started {relativeTime(record.startedAt)}
                {record.pitch ? ` · ${record.pitch}` : ""}
              </span>
            </span>
            {me === null ? (
              <Button
                aria-label={`Follow ${record.name}`}
                className="max-sm:h-11"
                onClick={() => window.dispatchEvent(new Event(SIGN_UP_EVENT))}
                size="sm"
                type="button"
              >
                Follow
              </Button>
            ) : (
              <FollowButton
                label={record.name}
                launchCoord={launchCoordinate(record.author, record.id)}
                testId="just-started-follow"
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
