import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";

import { useTimeline } from "../use-social-data";
import { PostList } from "./PostList";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, TimelineSkeleton } from "./Status";

export function BackLink({ to, label }: { to: "/social"; label: string }) {
  return (
    <Link
      aria-label={label}
      className="-ml-2 flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
      to={to}
    >
      <ArrowLeft aria-hidden className="h-5 w-5" />
    </Link>
  );
}

/** Every post carrying one hashtag. */
export function HashtagPage() {
  const { tag } = useParams({ from: "/social/tag/$tag" });
  const lower = tag.toLowerCase();
  const timeline = useTimeline({
    key: ["tag", lower],
    filter: { "#t": [lower] },
    select: () => true,
  });
  const rows = timeline.data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <SocialShell>
      <PageBar
        back={<BackLink label="Back to the feed" to="/social" />}
        title={`#${lower}`}
      />
      {timeline.isError ? (
        <div className="p-4">
          <QueryError
            description="The server did not answer, so no posts can be shown."
            error={timeline.error}
            kinds={[KIND_TEXT_NOTE]}
            onRetry={() => void timeline.refetch()}
            relayUrl={relayWsUrl()}
            testId="social-tag-error"
            title="Couldn't load this hashtag"
          />
        </div>
      ) : timeline.isLoading ? (
        <TimelineSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState title={`Nothing for #${lower} yet`}>
          Post with this hashtag and it appears here.
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
