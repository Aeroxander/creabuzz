import { Link, useSearch } from "@tanstack/react-router";
import { Hash } from "lucide-react";
import { useState } from "react";

import { parseEntity } from "@/shared/lib/nip19";
import { useUserSearch, usePostSearch } from "../use-discover";
import { useProfiles, useViewerPubkey } from "../use-feed";
import { FeedShell } from "./FeedShell";
import { Message } from "./Message";
import { PersonRow } from "./PersonRow";
import { SearchBox } from "./RightRail";
import { TabBar } from "./TabBar";
import { PostList, TimelineSkeleton } from "./Timeline";

type Tab = "posts" | "people";

const TABS: { id: Tab; label: string }[] = [
  { id: "posts", label: "Posts" },
  { id: "people", label: "People" },
];

function PostResults({ q, viewer }: { q: string; viewer: string | null }) {
  const results = usePostSearch(q);
  if (results.isLoading) return <TimelineSkeleton />;
  if (results.isError)
    return <Message title="Search failed" body={results.error.message} />;
  if (!results.data?.length) {
    return (
      <Message
        title={`No posts for “${q}”`}
        body="Try a different word, or search people."
      />
    );
  }
  return (
    <>
      <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">
        Searching the latest posts on this relay.
      </p>
      <PostList posts={results.data} viewer={viewer} />
    </>
  );
}

function PeopleResults({ q, viewer }: { q: string; viewer: string | null }) {
  const direct = parseEntity(q);
  const results = useUserSearch(q);
  const pubkeys = [
    ...(direct?.type === "pubkey" ? [direct.pubkey] : []),
    ...(results.data ?? []).map((p) => p.pubkey),
  ];
  const profiles = useProfiles(pubkeys).data;
  if (results.isLoading) return <TimelineSkeleton />;
  const unique = [...new Set(pubkeys)];
  if (unique.length === 0) {
    return (
      <Message
        title={`No people for “${q}”`}
        body="Search by name, or paste an npub."
      />
    );
  }
  return (
    <div className="divide-y">
      {unique.map((pubkey) => (
        <PersonRow
          key={pubkey}
          pubkey={pubkey}
          profile={
            profiles?.get(pubkey) ??
            results.data?.find((p) => p.pubkey === pubkey)
          }
          viewer={viewer}
          showBio
        />
      ))}
    </div>
  );
}

export function SearchPage() {
  const { q } = useSearch({ from: "/search" });
  const [tab, setTab] = useState<Tab>("posts");
  const viewer = useViewerPubkey();
  const term = q ?? "";
  const hashtag = term.startsWith("#") ? term.slice(1).toLowerCase() : null;

  return (
    <FeedShell>
      <div className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
        <div className="px-4 py-2">
          <SearchBox key={term} initial={term} />
        </div>
        <TabBar tabs={TABS} value={tab} onChange={setTab} />
      </div>
      {term.trim() === "" ? (
        <Message
          title="Search"
          body="Find posts and people on this community."
        />
      ) : (
        <>
          {hashtag && (
            <Link
              to="/tag/$tag"
              params={{ tag: hashtag }}
              className="flex items-center gap-3 border-b px-4 py-3 text-[15px] font-bold hover:bg-foreground/[0.04]"
            >
              <Hash className="h-5 w-5" />
              Go to #{hashtag}
            </Link>
          )}
          {tab === "posts" ? (
            <PostResults q={term} viewer={viewer} />
          ) : (
            <PeopleResults q={term} viewer={viewer} />
          )}
        </>
      )}
    </FeedShell>
  );
}
