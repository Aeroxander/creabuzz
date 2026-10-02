import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { APP_NAME } from "@/shared/constants/brand";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";

import { PostComposer } from "./PostComposer";
import { PostList } from "./PostList";
import { EmptyState, TimelineSkeleton } from "./Status";
import { PageBar, SocialShell } from "./SocialShell";
import { TabStrip } from "./TabStrip";
import { useLaunchUpdates } from "../use-launch-updates";
import { useRankedRows } from "../use-ranking";
import { useFollowing, useNotesById, useTimeline } from "../use-social-data";

type Tab = "creaton" | "updates" | "following";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "creaton", label: APP_NAME },
  { id: "updates", label: "Launch Updates" },
  { id: "following", label: "Following" },
];

/**
 * The social home: every post on this relay (the community feed), or just the
 * people you follow, with a composer on top.
 */
export function SocialHomePage() {
  const me = existingUserPubkey();
  const [tab, setTab] = useState<Tab>("creaton");
  const following = useFollowing(me);

  const authors =
    tab === "following"
      ? [...(following.data ?? []), ...(me ? [me] : [])]
      : null;
  const timeline = useTimeline({
    key: [tab, authors ? [...authors].sort().join(",") : "all"],
    authors,
    reposts: true,
    enabled: tab === "creaton" || (tab === "following" && following.isSuccess),
  });
  // Updates: the teams' official launch updates, newest first.
  const launchUpdates = useLaunchUpdates();
  const updateRows = useNotesById(
    launchUpdates.updates.slice(0, 50).map((u) => u.id),
  );
  const loaded = timeline.data?.pages.flatMap((p) => p.rows) ?? [];
  // Creaton: recency lifted by trust-weighted engagement. Following stays
  // strictly chronological.
  const rows = useRankedRows(loaded, tab === "creaton");

  return (
    <SocialShell>
      <PageBar title="Feed">
        <TabStrip label="Timeline" onChange={setTab} tabs={TABS} value={tab} />
      </PageBar>
      <PostComposer />
      {tab === "updates" ? (
        launchUpdates.isLoading || updateRows.isLoading ? (
          <TimelineSkeleton />
        ) : (updateRows.data?.length ?? 0) === 0 ? (
          <EmptyState
            testId="social-updates-empty"
            title="No launch updates yet"
          >
            When a launch's team posts an update, it appears here — and for
            launches you follow, it also reaches your notifications.
          </EmptyState>
        ) : (
          <PostList rows={updateRows.data ?? []} />
        )
      ) : tab === "following" && !me ? (
        <EmptyState title="Sign in to see who you follow">
          Create your identity to follow people and see their posts here.
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
