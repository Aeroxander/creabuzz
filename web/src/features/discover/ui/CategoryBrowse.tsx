/**
 * Category browsing for Discover: a picker over the topic tags launches
 * carry. Picking one replaces the directory's one big pull with a bounded,
 * paged query — one page per step, never the whole relay — and each row is
 * the shared launch card.
 *
 * The chips are the fixed set Start offers (`lib/category-chips.ts`), shown whenever the server lists any project, so
 * "AI agent or tool" can be picked even when only some projects carry a category. The row is hidden while the server
 * lists no project at all, or when the list could not be read: a row of chips over nothing would claim browsing exists.
 *
 * Each card carries the stored one line of its project's newest weekly update and a plain count of promises kept
 * (`ProjectRecordLine`), read for the page's projects only.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { listedProject } from "@/features/launchpad/lib/listing";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import {
  buildLaunches,
  effectiveStage,
  parseLaunchRecord,
} from "@/features/launchpad/models";
import { KIND_LAUNCH_RECORD } from "@/shared/constants/kinds";
import { cn } from "@/shared/lib/cn";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";

import {
  CATEGORY_PAGE_SIZE,
  collectCategories,
  nextPageCursor,
} from "../lib/categories";
import { categoryChips, chipQuery, chipSlug } from "../lib/category-chips";
import { useLeaderboard } from "../use-leaderboard";
import { DiscoverLaunchCard } from "./DiscoverCards";
import { ProjectRecordLine } from "./ProjectRecordLine";

export function CategoryBrowse() {
  // A contributor-only build never lists a raise (`contributor-only.ts`), so a raise's topic is no chip there either.
  const raises = raisesOffered();
  const categories = useQuery({
    queryKey: ["discover", "categories", raises],
    queryFn: async () => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_LAUNCH_RECORD],
        limit: 200,
      });
      const listed = (event: (typeof events)[number]) => {
        const record = parseLaunchRecord(event);
        return record !== null && listedProject(record, record.stage, raises);
      };
      return {
        topics: collectCategories(events, listed),
        // The chips show whenever there is something to browse, whether or not a project carries a topic.
        anyListed: events.some(listed),
      };
    },
    staleTime: 60_000,
  });
  const chips = useMemo(
    () => categoryChips(categories.data?.topics ?? []),
    [categories.data],
  );
  // The chip's id, or null for all topics.
  const [category, setCategory] = useState<string | null>(null);
  const chip = chips.find((entry) => entry.id === category) ?? null;
  // A stack of page cursors: "Older" pushes, "Newer" pops. One page is ever
  // in flight (the query key names the cursor), so a slow page cannot chase
  // the reader past where they clicked.
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const cursor = cursors[cursors.length - 1];

  const page = useQuery({
    queryKey: ["discover", "category", chip?.topics, cursor],
    queryFn: () =>
      chip
        ? queryEvents(relayWsUrl(), chipQuery(chip, cursor))
        : Promise.resolve([]),
    enabled: chip !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const launches = useMemo(
    () =>
      buildLaunches(page.data ? [...page.data] : []).filter((launch) =>
        listedProject(launch.record, effectiveStage(launch), raises),
      ),
    [page.data, raises],
  );
  const board = useLeaderboard(launches);
  const nextCursor = page.data ? nextPageCursor(page.data) : null;
  const hasMore =
    (page.data?.length ?? 0) >= CATEGORY_PAGE_SIZE && nextCursor !== null;

  const pick = (id: string | null) => {
    setCategory(id);
    setCursors([null]);
  };

  if (!categories.data?.anyListed) return null;

  return (
    <section
      aria-label={
        raises ? "Browse launches by topic" : "Browse projects by topic"
      }
      className="mt-4"
      data-testid="category-browse"
    >
      <div
        aria-label={raises ? "Launch topics" : "Topics"}
        className="flex flex-wrap items-center gap-2"
        role="tablist"
      >
        <button
          aria-selected={category === null}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-medium max-sm:min-h-11",
            category === null
              ? "bg-black text-white dark:bg-white dark:text-black"
              : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10",
          )}
          data-testid="category-all"
          key="all"
          onClick={() => pick(null)}
          role="tab"
          type="button"
        >
          All topics
        </button>
        {chips.map((entry) => (
          <button
            aria-selected={category === entry.id}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium max-sm:min-h-11",
              category === entry.id
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10",
            )}
            data-testid={`category-${chipSlug(entry)}`}
            key={entry.id}
            onClick={() => pick(entry.id)}
            role="tab"
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>

      {category === null ? null : page.isLoading ? (
        <p
          className="mt-3 text-sm text-black/60 dark:text-white/60"
          role="status"
        >
          Loading this topic…
        </p>
      ) : page.isError ? (
        <div className="mt-3">
          <p className="text-sm text-black/60 dark:text-white/60">
            The server did not answer, so this topic can't be shown.
          </p>
          <Button
            className="mt-2"
            onClick={() => void page.refetch()}
            size="sm"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : (
        <>
          <ul
            className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2"
            data-testid="category-grid"
          >
            {launches.length === 0 ? (
              <li className="text-sm text-black/60 dark:text-white/60">
                Nothing filed under this topic yet. A founder picks one when
                they start a project.
              </li>
            ) : (
              launches.map((launch) => (
                <DiscoverLaunchCard
                  key={`${launch.record.author}:${launch.record.id}`}
                  launch={launch}
                  raises={raises}
                  summary={<ProjectRecordLine score={board.scoreOf(launch)} />}
                />
              ))
            )}
          </ul>
          <div className="mt-3 flex items-center gap-2">
            <Button
              disabled={cursors.length <= 1}
              onClick={() => setCursors((c) => c.slice(0, -1))}
              size="sm"
              variant="outline"
            >
              Newer
            </Button>
            <Button
              disabled={!hasMore}
              onClick={() => {
                if (nextCursor !== null) {
                  setCursors((c) => [...c, nextCursor]);
                }
              }}
              size="sm"
              variant="outline"
            >
              Older
            </Button>
            <span className="text-2xs text-black/70 dark:text-white/70">
              {launches.length} shown
            </span>
          </div>
        </>
      )}
    </section>
  );
}
