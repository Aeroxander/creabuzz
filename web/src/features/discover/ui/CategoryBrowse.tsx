/**
 * Category browsing for Discover: a picker over the topic tags launches
 * carry. Picking one replaces the directory's one big pull with a bounded,
 * paged query — one page per step, never the whole relay — and each row is
 * the shared launch card.
 *
 * The picker is hidden when no launch carries a topic yet: a category row
 * with no categories would claim browsing exists over nothing.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { buildLaunches } from "@/features/launchpad/models";
import { KIND_LAUNCH_RECORD } from "@/shared/constants/kinds";
import { cn } from "@/shared/lib/cn";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";

import {
  buildCategoryQuery,
  CATEGORY_PAGE_SIZE,
  collectCategories,
  nextPageCursor,
} from "../lib/categories";
import { DiscoverLaunchCard } from "./DiscoverCards";

export function CategoryBrowse() {
  const categories = useQuery({
    queryKey: ["discover", "categories"],
    queryFn: async () =>
      collectCategories(
        await queryEvents(relayWsUrl(), {
          kinds: [KIND_LAUNCH_RECORD],
          limit: 200,
        }),
      ),
    staleTime: 60_000,
  });
  const [category, setCategory] = useState<string | null>(null);
  // A stack of page cursors: "Older" pushes, "Newer" pops. One page is ever
  // in flight (the query key names the cursor), so a slow page cannot chase
  // the reader past where they clicked.
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const cursor = cursors[cursors.length - 1];

  const page = useQuery({
    queryKey: ["discover", "category", category, cursor],
    queryFn: () =>
      queryEvents(
        relayWsUrl(),
        buildCategoryQuery({ category, until: cursor }),
      ),
    enabled: category !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const launches = useMemo(
    () => buildLaunches(page.data ? [...page.data] : []),
    [page.data],
  );
  const nextCursor = page.data ? nextPageCursor(page.data) : null;
  const hasMore =
    (page.data?.length ?? 0) >= CATEGORY_PAGE_SIZE && nextCursor !== null;

  const pick = (topic: string | null) => {
    setCategory(topic);
    setCursors([null]);
  };

  const topics = categories.data ?? [];
  if (topics.length === 0) return null;

  return (
    <section
      aria-label="Browse launches by category"
      className="mt-4"
      data-testid="category-browse"
    >
      <div
        aria-label="Launch categories"
        className="flex flex-wrap items-center gap-2"
        role="tablist"
      >
        <button
          aria-selected={category === null}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-medium",
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
        {topics.map((topic) => (
          <button
            aria-selected={category === topic}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium",
              category === topic
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10",
            )}
            data-testid={`category-${topic}`}
            key={topic}
            onClick={() => pick(topic)}
            role="tab"
            type="button"
          >
            {topic}
          </button>
        ))}
      </div>

      {category === null ? null : page.isLoading ? (
        <p
          className="mt-3 text-sm text-black/60 dark:text-white/60"
          role="status"
        >
          Reading this category…
        </p>
      ) : page.isError ? (
        <div className="mt-3">
          <p className="text-sm text-black/60 dark:text-white/60">
            The server did not answer this category's page.
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
                Nothing filed under this topic yet.
              </li>
            ) : (
              launches.map((launch) => (
                <DiscoverLaunchCard
                  key={`${launch.record.author}:${launch.record.id}`}
                  launch={launch}
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
            <span className="text-2xs text-black/50 dark:text-white/50">
              {launches.length} shown
            </span>
          </div>
        </>
      )}
    </section>
  );
}
