import { Home } from "lucide-react";
import { useMemo, useState } from "react";

import { useLaunches } from "@/features/launchpad/use-launches";
import { KIND_REACTION, KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";

import { followedLaunches, followedPeople } from "../lib/lists";
import { EMPTY_TALLY, type SortMode, sortByMode } from "../lib/ranking";
import { useFeedNotes, useMyLists, useVoteTallies } from "../use-feed";
import { Composer } from "./Composer";
import { launchCoord, LaunchVoteCard } from "./LaunchVoteCard";
import { ThreadList } from "./ThreadList";

type Tab = "for-you" | "hot" | "new";

const TABS: { id: Tab; label: string }[] = [
  { id: "for-you", label: "For you" },
  { id: "hot", label: "Hot" },
  { id: "new", label: "New" },
];

/**
 * Home: what people are saying about what gets built. Posts rank by
 * trust-weighted votes; "For you" narrows to people and launches you follow.
 * Beside it, the launches drawing the most weighted support right now.
 */
export function FeedPage() {
  const [tab, setTab] = useState<Tab>("hot");
  const notes = useFeedNotes();
  const lists = useMyLists();
  const launches = useLaunches();
  const { tallies } = useVoteTallies();

  const people = followedPeople(lists.data?.contacts ?? null);
  const watched = followedLaunches(lists.data?.bookmarks ?? null);
  const following = people.size + watched.size > 0;

  const visible = useMemo(() => {
    const all = notes.data ?? [];
    if (tab !== "for-you") return all;
    const rootsInScope = new Set(
      all
        .filter(
          (n) =>
            !n.rootId &&
            (people.has(n.author) || n.launches.some((c) => watched.has(c))),
        )
        .map((n) => n.id),
    );
    return all.filter((n) =>
      n.rootId ? rootsInScope.has(n.rootId) : rootsInScope.has(n.id),
    );
  }, [notes.data, tab, people, watched]);

  const postsPerLaunch = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of notes.data ?? []) {
      for (const coord of note.launches) {
        counts.set(coord, (counts.get(coord) ?? 0) + 1);
      }
    }
    return counts;
  }, [notes.data]);

  const trending = useMemo(
    () =>
      sortByMode(
        (launches.data ?? []).filter(
          (l) => l.record.stage !== "draft" && l.record.stage !== "failed",
        ),
        "hot",
        (l) => tallies.get(launchCoord(l.record))?.score ?? 0,
        (l) => l.record.createdAt,
      ).slice(0, 4),
    [launches.data, tallies],
  );

  const mode: SortMode = tab === "new" ? "new" : "hot";

  return (
    <div className="flex h-full w-full flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby="home-title" className="min-w-0">
          <h1
            className="flex items-center gap-2 text-xl font-semibold text-black dark:text-white"
            id="home-title"
          >
            <Home aria-hidden className="h-5 w-5" /> Home
          </h1>
          <div className="mt-3">
            <Composer />
          </div>
          <div
            aria-label="Sort posts"
            className="mt-4 flex gap-1"
            role="tablist"
          >
            {TABS.map((t) => (
              <button
                aria-selected={tab === t.id}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  tab === t.id
                    ? "bg-black text-white dark:bg-white dark:text-black"
                    : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
                }`}
                data-testid={`feed-tab-${t.id}`}
                key={t.id}
                onClick={() => setTab(t.id)}
                role="tab"
                type="button"
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="mt-3">
            {notes.isError ? (
              <QueryError
                description="The server did not answer the feed query, so no posts can be shown."
                error={notes.error}
                kinds={[KIND_TEXT_NOTE, KIND_REACTION]}
                onRetry={() => void notes.refetch()}
                relayUrl={relayWsUrl()}
                testId="feed-error"
                title="Couldn't load the feed"
              />
            ) : notes.isLoading ? (
              <p
                className="text-sm text-black/60 dark:text-white/60"
                role="status"
              >
                Loading posts…
              </p>
            ) : (
              <ThreadList
                empty={
                  <p
                    className="rounded-xl border border-dashed border-black/15 p-6 text-center text-sm text-black/60 dark:border-white/15 dark:text-white/60"
                    data-testid="feed-empty"
                  >
                    {tab === "for-you" && !following
                      ? "Follow people or launches and their posts show up here. Hot shows everything in the meantime."
                      : "No posts yet. Be the first to say what you're building."}
                  </p>
                }
                mode={mode}
                notes={visible}
                testId="feed-list"
              />
            )}
          </div>
        </section>
        <aside aria-labelledby="trending-title" className="min-w-0">
          <h2
            className="text-sm font-semibold text-black dark:text-white"
            id="trending-title"
          >
            Trending launches
          </h2>
          <ul
            className="mt-2 flex flex-col gap-2"
            data-testid="trending-launches"
          >
            {trending.length === 0 ? (
              <li className="text-sm text-black/60 dark:text-white/60">
                No launches to show yet.
              </li>
            ) : (
              trending.map((launch) => {
                const coord = launchCoord(launch.record);
                return (
                  <li key={coord}>
                    <LaunchVoteCard
                      comments={postsPerLaunch.get(coord) ?? 0}
                      record={launch.record}
                      tally={tallies.get(coord) ?? EMPTY_TALLY}
                    />
                  </li>
                );
              })
            )}
          </ul>
        </aside>
      </div>
    </div>
  );
}
