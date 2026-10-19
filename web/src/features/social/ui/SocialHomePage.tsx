import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

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
import { useRankedRows } from "../use-ranking";
import { useFollowing, useTimeline } from "../use-social-data";
import { needAccountTo } from "@/features/identity/lib/account-copy";

type Tab = "everyone" | "following" | "boards" | "projects";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "everyone", label: "Everyone" },
  { id: "following", label: "Following" },
  { id: "boards", label: "Boards" },
  { id: "projects", label: "Projects" },
];

const BoardFeed = lazy(() =>
  import("@/features/board/ui/BoardFeed").then((m) => ({
    default: m.BoardFeed,
  })),
);
const HotOnBoards = lazy(() =>
  import("@/features/board/ui/HotOnBoards").then((m) => ({
    default: m.HotOnBoards,
  })),
);

/**
 * Home: every post on this server (ranked by recency and trust-weighted likes), or just the people you follow, or the
 * boards' long-form discussions with up and down votes, or the projects' own progress reports, with one composer on top.
 * Everyone also shows the hottest board posts above the short posts, so the boards are part of the feed. Above it, for someone signed in, what is waiting on them and
 * their organizations; for a visitor, what this place is for.
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
  const timeline = useTimeline({
    key: [tab, authors ? [...authors].sort().join(",") : "all"],
    authors,
    reposts: true,
    enabled: tab === "everyone" || (tab === "following" && following.isSuccess),
  });
  const loaded = timeline.data?.pages.flatMap((p) => p.rows) ?? [];
  // Everyone: recency lifted by trust-weighted engagement. Following stays
  // strictly chronological.
  const rows = useRankedRows(loaded, tab === "everyone");

  return (
    <SocialShell>
      <PageBar title="Home">
        <TabStrip label="Timeline" onChange={setTab} tabs={TABS} value={tab} />
      </PageBar>
      <div className="flex flex-col gap-3 px-3 pt-3" data-testid="home-top">
        {me ? <HomeYours me={me} /> : null}
        <HomeHero />
      </div>
      {tab === "boards" ? null : <PostComposer />}
      {tab === "everyone" ? (
        <Suspense fallback={null}>
          <HotOnBoards onSeeAll={() => setTab("boards")} />
        </Suspense>
      ) : null}
      {tab === "boards" ? (
        <Suspense fallback={<TimelineSkeleton />}>
          <BoardFeed />
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
      ) : timeline.isError ? (
        <div className="p-4">
          <QueryError
            description="The server did not answer the feed query, so no posts can be shown."
            error={timeline.error}
            kinds={[KIND_TEXT_NOTE]}
            onRetry={() => void timeline.refetch()}
            relayUrl={relayWsUrl()}
            testId="social-feed-error"
            title="Couldn't load the feed"
          />
        </div>
      ) : timeline.isLoading || (tab === "following" && following.isLoading) ? (
        <TimelineSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState testId="social-feed-empty" title="Nothing here yet">
          Be the first to post.
        </EmptyState>
      ) : (
        <PostList
          hasMore={timeline.hasNextPage}
          loadingMore={timeline.isFetchingNextPage}
          onLoadMore={() => {
            if (!timeline.isFetchingNextPage) void timeline.fetchNextPage();
          }}
          rows={rows}
        />
      )}
    </SocialShell>
  );
}
