import { useState } from "react";

import { useTrending, useSuggestedUsers } from "../use-discover";
import { usePostsByIds, useProfiles, useViewerPubkey } from "../use-feed";
import { FeedShell } from "./FeedShell";
import { Message } from "./Message";
import { PersonRow } from "./PersonRow";
import { SearchBox } from "./RightRail";
import { TabBar } from "./TabBar";
import { PostList, TimelineSkeleton } from "./Timeline";
import { Link } from "@tanstack/react-router";

type Tab = "posts" | "people" | "hashtags";

const TABS: { id: Tab; label: string }[] = [
  { id: "posts", label: "Trending" },
  { id: "people", label: "People" },
  { id: "hashtags", label: "Hashtags" },
];

function TrendingPosts({ viewer }: { viewer: string | null }) {
  const trending = useTrending();
  const posts = usePostsByIds(trending.data?.ids ?? []);
  if (trending.isLoading || posts.isLoading) return <TimelineSkeleton />;
  if (!posts.data?.length) {
    return (
      <Message
        title="Nothing trending yet"
        body="Posts that get likes, reposts and replies will show up here."
      />
    );
  }
  return <PostList posts={posts.data} viewer={viewer} />;
}

function People({ viewer }: { viewer: string | null }) {
  const suggested = useSuggestedUsers(viewer, 20);
  const profiles = useProfiles(
    (suggested.data ?? []).map((s) => s.pubkey),
  ).data;
  if (suggested.isLoading) return <TimelineSkeleton />;
  if (!suggested.data?.length) {
    return (
      <Message
        title="No suggestions yet"
        body="Follow a few people and check back."
      />
    );
  }
  return (
    <div className="divide-y">
      {suggested.data.map((s) => (
        <PersonRow
          key={s.pubkey}
          pubkey={s.pubkey}
          profile={profiles?.get(s.pubkey)}
          viewer={viewer}
          detail={`${s.followers} ${s.followers === 1 ? "follower" : "followers"}`}
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
      <Message
        title="No hashtags yet"
        body="Hashtags people use will show up here."
      />
    );
  }
  return (
    <ul className="divide-y">
      {hashtags.map(({ tag, count }) => (
        <li key={tag}>
          <Link
            to="/tag/$tag"
            params={{ tag }}
            className="block px-4 py-3 transition-colors hover:bg-foreground/[0.04]"
          >
            <div className="text-[17px] font-bold">#{tag}</div>
            <div className="text-[13px] text-muted-foreground">
              {count} {count === 1 ? "person" : "people"} posting
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ExplorePage() {
  const [tab, setTab] = useState<Tab>("posts");
  const viewer = useViewerPubkey();
  return (
    <FeedShell>
      <div className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
        <div className="px-4 pt-2 lg:hidden">
          <SearchBox />
        </div>
        <h1 className="sr-only">Explore</h1>
        <TabBar tabs={TABS} value={tab} onChange={setTab} />
      </div>
      {tab === "posts" && <TrendingPosts viewer={viewer} />}
      {tab === "people" && <People viewer={viewer} />}
      {tab === "hashtags" && <Hashtags />}
    </FeedShell>
  );
}
