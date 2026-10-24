import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";

import {
  FEED_PERIOD_LABELS,
  type FeedPeriod,
} from "@/features/board/lib/board-feed";

import { HomeHero } from "@/features/feed/ui/HomeHero";
import { HomeYours } from "@/features/feed/ui/HomeYours";
import { ProjectProgressFeed } from "@/features/feed/ui/ProjectProgressFeed";
import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";

import { PostComposer } from "./PostComposer";
import { PostList } from "./PostList";
import { EmptyState, TimelineSkeleton } from "./Status";
import { PageBar, SocialShell } from "./SocialShell";
import { TabStrip } from "./TabStrip";
import { type TimelineSort, useMixedTimeline } from "../use-mixed-timeline";
import { useFollowing } from "../use-social-data";
import { needAccountTo } from "@/features/identity/lib/account-copy";

type Tab = "everyone" | "following" | "boards" | "projects";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "everyone", label: "Everyone" },
  { id: "following", label: "Following" },
  { id: "boards", label: "Boards" },
  { id: "projects", label: "Projects" },
];

const BoardDirectory = lazy(() =>
  import("@/features/board/ui/BoardDirectory").then((m) => ({
    default: m.BoardDirectory,
  })),
);

/**
 * Home. Everyone is the General board: every post on this server, short posts and board posts together, ranked by
 * recency lifted by votes. Following is the people you follow, from General and every board, newest first. Boards
 * lists the boards to browse and join, and Projects the projects' own progress reports. One composer on top posts to
 * General or a board. Above it, for someone signed in, what is waiting on them and their organizations; for a visitor,
 * what this place is for.
 */
export function SocialHomePage() {
  const me = existingUserPubkey();
  const search = useSearch({ from: "/" });
  const tab: Tab = search.tab ?? "everyone";
  const navigate = useNavigate();
  const setTab = (next: Tab) =>
    void navigate({
      to: "/",
      search: next === "everyone" ? {} : { tab: next },
      replace: true,
    });
  const following = useFollowing(me);

  const authors =
    tab === "following"
      ? [...(following.data ?? []), ...(me ? [me] : [])]
      : null;
  const [sort, setSort] = useState<TimelineSort>("hot");
  const [period, setPeriod] = useState<FeedPeriod>("week");
  const timeline = useMixedTimeline({
    tab: tab === "following" ? "following" : "everyone",
    authors,
    sort,
    period,
    enabled: tab === "everyone" || (tab === "following" && following.isSuccess),
  });

  return (
    <SocialShell>
      <PageBar title="Home">
        <TabStrip label="Timeline" onChange={setTab} tabs={TABS} value={tab} />
      </PageBar>
      <div className="flex flex-col gap-3 px-3 pt-3" data-testid="home-top">
        {me ? <HomeYours me={me} /> : null}
        <HomeHero />
      </div>
      {/* Signed out, the welcome above already offers the account: no second offer right under it. */}
      {tab === "boards" || !me ? null : <PostComposer postTo />}
      {tab === "everyone" ? (
        <SortBar
          onPeriod={setPeriod}
          onSort={setSort}
          period={period}
          sort={sort}
        />
      ) : null}
      {tab === "boards" ? (
        <Suspense fallback={<TimelineSkeleton />}>
          <BoardDirectory />
        </Suspense>
      ) : tab === "projects" ? (
        <div className="p-3">
          <ProjectProgressFeed />
        </div>
      ) : tab === "following" && !me ? (
        <EmptyState title="Sign in to see who you follow">
          {needAccountTo("follow people and see their posts here")}
        </EmptyState>
      ) : tab === "following" &&
        following.isSuccess &&
        (following.data?.length ?? 0) === 0 ? (
        <EmptyState
          testId="social-following-empty"
          title="Your timeline is quiet"
        >
          Follow people and their posts show up here.{" "}
          <Link
            className="text-sky-700 underline dark:text-sky-400"
            to="/social/explore"
          >
            Find people to follow
          </Link>
          .
        </EmptyState>
      ) : timeline.error ? (
        <div className="p-4">
          <QueryError
            description="The server did not answer the feed query, so no posts can be shown."
            error={timeline.error}
            kinds={[KIND_TEXT_NOTE]}
            onRetry={timeline.refetch}
            relayUrl={relayWsUrl()}
            testId="social-feed-error"
            title="Couldn't load the feed"
          />
        </div>
      ) : timeline.isLoading || (tab === "following" && following.isLoading) ? (
        <TimelineSkeleton />
      ) : timeline.items.length === 0 ? (
        <EmptyState testId="social-feed-empty" title="Nothing here yet">
          Be the first to post.
        </EmptyState>
      ) : (
        <PostList
          boards={timeline.boards}
          hasMore={timeline.hasMore}
          items={timeline.items}
          loadingMore={timeline.loadingMore}
          onLoadMore={timeline.loadMore}
        />
      )}
    </SocialShell>
  );
}

const SORT_LABELS: Record<TimelineSort, string> = {
  hot: "Hot",
  new: "New",
  top: "Top",
};

/** Everyone's order: Hot (newer and better voted first), New, or Top for a period. */
function SortBar({
  sort,
  period,
  onSort,
  onPeriod,
}: {
  sort: TimelineSort;
  period: FeedPeriod;
  onSort: (sort: TimelineSort) => void;
  onPeriod: (period: FeedPeriod) => void;
}) {
  return (
    <div
      className="flex items-center gap-2 border-b border-black/10 px-4 py-2 dark:border-white/10"
      data-testid="home-sort"
    >
      <fieldset className="m-0 flex min-w-0 rounded-full border border-black/10 p-0.5 dark:border-white/15">
        <legend className="sr-only">Order posts by</legend>
        {(Object.keys(SORT_LABELS) as TimelineSort[]).map((key) => (
          <button
            aria-pressed={sort === key}
            className={`rounded-full px-3 py-0.5 text-xs font-semibold ${
              sort === key
                ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
            }`}
            data-testid={`home-sort-${key}`}
            key={key}
            onClick={() => onSort(key)}
            type="button"
          >
            {SORT_LABELS[key]}
          </button>
        ))}
      </fieldset>
      {sort === "top" ? (
        <label className="text-xs">
          <span className="sr-only">Top posts from</span>
          <select
            className="rounded-full border border-black/10 bg-transparent px-2 py-0.5 text-xs dark:border-white/15"
            data-testid="home-sort-period"
            onChange={(e) => onPeriod(e.target.value as FeedPeriod)}
            value={period}
          >
            {(Object.keys(FEED_PERIOD_LABELS) as FeedPeriod[]).map((key) => (
              <option key={key} value={key}>
                {FEED_PERIOD_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
