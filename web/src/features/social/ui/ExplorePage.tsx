import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useSuggestedUsers, useTrending } from "../use-discovery";
import { usePeople } from "../use-people";
import { useNotesById } from "../use-social-data";
import { PersonRow } from "./PersonRow";
import { PostList } from "./PostList";
import { SearchBox } from "./RightRail";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, TimelineSkeleton } from "./Status";
import { TabStrip } from "./TabStrip";

type Tab = "posts" | "people" | "hashtags";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "posts", label: "Trending" },
  { id: "people", label: "People" },
  { id: "hashtags", label: "Hashtags" },
];

function TrendingPosts() {
  const trending = useTrending();
  const notes = useNotesById(trending.data?.ids ?? []);
  if (trending.isLoading || (trending.data?.ids.length && notes.isLoading)) {
    return <TimelineSkeleton />;
  }
  if (!notes.data?.length) {
    return (
      <EmptyState
        testId="social-trending-empty"
        title="Nothing is trending yet"
      >
        Posts that get likes, reposts and replies show up here.
      </EmptyState>
    );
  }
  return <PostList rows={notes.data} />;
}

function People() {
  const suggested = useSuggestedUsers(20);
  const people = usePeople((suggested.data ?? []).map((s) => s.pubkey));
  if (suggested.isLoading) return <TimelineSkeleton />;
  if (!suggested.data?.length) {
    return (
      <EmptyState title="No suggestions yet">
        Follow a few people and check back.
      </EmptyState>
    );
  }
  return (
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
  );
}

function Hashtags() {
  const hashtags = useTrending().data?.hashtags ?? [];
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
          <Link
            className="block px-4 py-3 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            params={{ tag }}
            to="/social/tag/$tag"
          >
            <span className="block text-base font-bold text-black dark:text-white">
              #{tag}
            </span>
            <span className="text-xs text-black/60 dark:text-white/60">
              {count} {count === 1 ? "person" : "people"} posting
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Discovery: what's trending, people worth following, and hashtags in use. */
export function ExplorePage() {
  const [tab, setTab] = useState<Tab>("posts");
  return (
    <SocialShell>
      <PageBar title="Explore">
        <div className="px-4 pb-2 xl:hidden">
          <SearchBox />
        </div>
        <TabStrip label="Explore" onChange={setTab} tabs={TABS} value={tab} />
      </PageBar>
      {tab === "posts" ? <TrendingPosts /> : null}
      {tab === "people" ? <People /> : null}
      {tab === "hashtags" ? <Hashtags /> : null}
    </SocialShell>
  );
}
