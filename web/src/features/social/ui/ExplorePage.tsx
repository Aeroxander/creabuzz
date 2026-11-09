import { useNavigate, useSearch } from "@tanstack/react-router";

import {
  KIND_CONTACT_LIST,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";

import { firstError, listView, partialError } from "../lib/read-view";
import { useSuggestedUsers, useTrending } from "../use-discovery";
import { usePeople } from "../use-people";
import { useFollowing, useNotesById } from "../use-social-data";
import { HashtagRow } from "./HashtagRow";
import { PersonRow } from "./PersonRow";
import { PostList } from "./PostList";
import { SearchBox } from "./RightRail";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, PartialFailure, TimelineSkeleton } from "./Status";
import { TabStrip, tabPanelProps } from "./TabStrip";

type Tab = "posts" | "people" | "hashtags";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "posts", label: "Trending posts" },
  { id: "people", label: "People to follow" },
  { id: "hashtags", label: "Hashtags" },
];

/** Explore's reads failed: say so, with a retry, never "nothing yet". */
function ExploreError({
  error,
  kinds,
  onRetry,
  testId,
  title,
}: {
  error: unknown;
  kinds: readonly number[];
  onRetry: () => void;
  testId: string;
  title: string;
}) {
  return (
    <div className="p-4">
      <QueryError
        description="The server did not answer, so this list can't be shown. It is not known to be empty."
        error={error}
        kinds={kinds}
        onRetry={onRetry}
        relayUrl={relayWsUrl()}
        testId={testId}
        title={title}
      />
    </div>
  );
}

function TrendingPosts() {
  const trending = useTrending();
  const notes = useNotesById(trending.data?.ids ?? []);
  const error = firstError(trending.error, notes.error);
  const view = listView({
    count: notes.data?.length ?? 0,
    error,
    loading:
      trending.isLoading ||
      Boolean(trending.data?.ids.length && notes.isLoading),
  });
  const retry = () => {
    void trending.refetch();
    if (notes.error) void notes.refetch();
  };
  if (view === "loading") return <TimelineSkeleton />;
  if (view === "error") {
    return (
      <ExploreError
        error={error}
        kinds={[KIND_REACTION, KIND_REPOST, KIND_TEXT_NOTE]}
        onRetry={retry}
        testId="social-trending-error"
        title="Couldn't load what's trending"
      />
    );
  }
  if (view === "empty") {
    return (
      <EmptyState
        testId="social-trending-empty"
        title="Nothing is trending yet"
      >
        Posts that get likes, reposts and replies show up here.
      </EmptyState>
    );
  }
  return (
    <>
      {partialError(view, error) ? (
        <PartialFailure onRetry={retry} testId="social-trending-partial-error">
          What's trending couldn't be checked again, so this list may be out of
          date.
        </PartialFailure>
      ) : null}
      <PostList rows={notes.data} />
    </>
  );
}

function People() {
  const suggested = useSuggestedUsers(20);
  const people = usePeople((suggested.data ?? []).map((s) => s.pubkey));
  // Suggestions wait for who you follow: if that read failed they never come, which is a failure, not "no suggestions".
  const following = useFollowing(existingUserPubkey());
  const error = firstError(suggested.error, following.error);
  const view = listView({
    count: suggested.data?.length ?? 0,
    error,
    loading: suggested.isLoading || following.isLoading,
  });
  const retry = () => {
    if (following.error) void following.refetch();
    void suggested.refetch();
  };
  if (view === "loading") return <TimelineSkeleton />;
  if (view === "error") {
    return (
      <ExploreError
        error={error}
        kinds={[KIND_CONTACT_LIST]}
        onRetry={retry}
        testId="social-people-error"
        title="Couldn't load suggestions"
      />
    );
  }
  if (!suggested.data?.length) {
    return (
      <EmptyState title="No suggestions yet">
        Follow a few people and check back.
      </EmptyState>
    );
  }
  return (
    <>
      {partialError(view, error) ? (
        <PartialFailure onRetry={retry} testId="social-people-partial-error">
          Suggestions couldn't be checked again, so this list may be out of
          date.
        </PartialFailure>
      ) : null}
      <div
        className="divide-y divide-black/10 dark:divide-white/10"
        data-testid="social-people-list"
      >
        {suggested.data.map((s) => (
          <PersonRow
            detail={`${s.followers} ${s.followers === 1 ? "follower" : "followers"}`}
            key={s.pubkey}
            profile={people[s.pubkey]}
            pubkey={s.pubkey}
            showBio
          />
        ))}
      </div>
    </>
  );
}

function Hashtags() {
  const trending = useTrending();
  const hashtags = trending.data?.hashtags ?? [];
  const view = listView({
    count: hashtags.length,
    error: trending.error,
    loading: trending.isLoading,
  });
  if (view === "loading") return <TimelineSkeleton />;
  if (view === "error") {
    return (
      <ExploreError
        error={trending.error}
        kinds={[KIND_TEXT_NOTE]}
        onRetry={() => void trending.refetch()}
        testId="social-hashtags-error"
        title="Couldn't load hashtags"
      />
    );
  }
  if (hashtags.length === 0) {
    return (
      <EmptyState title="No hashtags yet">
        Hashtags people use show up here.
      </EmptyState>
    );
  }
  return (
    <ul
      className="divide-y divide-black/10 dark:divide-white/10"
      data-testid="social-hashtag-list"
    >
      {hashtags.map(({ tag, count }) => (
        <li key={tag}>
          <HashtagRow count={count} tag={tag} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The full lists behind the rail's "See all" links: trending posts, people worth following and hashtags in use. The tab
 * is kept in the address, so each link opens its own list and Back returns to it.
 */
export function ExplorePage() {
  const tab: Tab = useSearch({ from: "/social/explore" }).tab ?? "posts";
  const navigate = useNavigate();
  const setTab = (next: Tab) =>
    void navigate({
      to: "/social/explore",
      search: next === "posts" ? {} : { tab: next },
      replace: true,
    });
  return (
    <SocialShell>
      <PageBar title="Explore">
        <div className="px-4 pb-2 xl:hidden">
          <SearchBox />
        </div>
        <TabStrip
          idBase="explore-tabs"
          label="Explore"
          onChange={setTab}
          tabs={TABS}
          value={tab}
        />
      </PageBar>
      <div {...tabPanelProps("explore-tabs", tab)}>
        {tab === "posts" ? <TrendingPosts /> : null}
        {tab === "people" ? <People /> : null}
        {tab === "hashtags" ? <Hashtags /> : null}
      </div>
    </SocialShell>
  );
}
