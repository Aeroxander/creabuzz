import { Link, useSearch } from "@tanstack/react-router";
import { Hash } from "lucide-react";
import { useState } from "react";

import { useBoardSearch } from "../../board/use-board-search";
import { parseEntity } from "../lib/entity";
import { mixChronological } from "../lib/mixed-timeline";
import { usePostSearch, useUserSearch } from "../use-discovery";
import { usePeople } from "../use-people";
import { PersonRow } from "./PersonRow";
import { PostList } from "./PostList";
import { SearchBox } from "./RightRail";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, TimelineSkeleton } from "./Status";
import { TabStrip } from "./TabStrip";

type Tab = "posts" | "people";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "posts", label: "Posts" },
  { id: "people", label: "People" },
];

/** Short posts and board posts with the words searched for, newest first. */
function PostResults({ q }: { q: string }) {
  const results = usePostSearch(q);
  const board = useBoardSearch(q);
  if (results.isLoading || board.isLoading) return <TimelineSkeleton />;
  const items = mixChronological(results.data ?? [], board.posts, true);
  const boardsFailed = board.error ? (
    <p
      className="border-b border-black/10 px-4 py-2 text-xs text-amber-700 dark:border-white/10 dark:text-amber-300"
      data-testid="social-search-boards-failed"
      role="status"
    >
      Board posts could not be searched right now; these are short posts only.
    </p>
  ) : null;
  if (items.length === 0 && !board.error) {
    return (
      <EmptyState title={`No posts for "${q}"`}>
        Try another word, or look for people.
      </EmptyState>
    );
  }
  return (
    <>
      <p className="border-b border-black/10 px-4 py-2 text-xs text-black/60 dark:border-white/10 dark:text-white/60">
        Showing matches from the latest posts and board posts on this server.
      </p>
      {boardsFailed}
      <PostList
        boards={{ names: board.boards, add: board.add }}
        items={items}
      />
    </>
  );
}

function PeopleResults({ q }: { q: string }) {
  const direct = parseEntity(q);
  const found = useUserSearch(q);
  const pubkeys = [
    ...new Set([
      ...(direct?.type === "pubkey" ? [direct.pubkey] : []),
      ...Object.keys(found.data ?? {}),
    ]),
  ];
  const people = usePeople(pubkeys);
  if (found.isLoading) return <TimelineSkeleton />;
  if (pubkeys.length === 0) {
    return (
      <EmptyState title={`No people for "${q}"`}>
        Search by name, or paste someone's public key.
      </EmptyState>
    );
  }
  return (
    <div
      className="divide-y divide-black/10 dark:divide-white/10"
      data-testid="social-search-people"
    >
      {pubkeys.map((pubkey) => (
        <PersonRow
          key={pubkey}
          profile={people[pubkey] ?? found.data?.[pubkey]}
          pubkey={pubkey}
          showBio
        />
      ))}
    </div>
  );
}

/** Search posts (recent) and people (by name or pasted key). */
export function SearchPage() {
  const { q } = useSearch({ from: "/social/search" });
  const [tab, setTab] = useState<Tab>("posts");
  const term = q ?? "";
  const hashtag = term.startsWith("#") ? term.slice(1).toLowerCase() : null;

  return (
    <SocialShell>
      <PageBar title="Search">
        <div className="px-4 pb-2">
          <SearchBox initial={term} key={term} />
        </div>
        <TabStrip
          label="Search results"
          onChange={setTab}
          tabs={TABS}
          value={tab}
        />
      </PageBar>
      {term.trim() === "" ? (
        <EmptyState title="Search">
          Find posts and people on this server.
        </EmptyState>
      ) : (
        <>
          {hashtag ? (
            <Link
              className="flex items-center gap-3 border-b border-black/10 px-4 py-3 text-sm font-bold text-black hover:bg-black/[0.03] dark:border-white/10 dark:text-white dark:hover:bg-white/[0.04]"
              params={{ tag: hashtag }}
              to="/social/tag/$tag"
            >
              <Hash aria-hidden className="h-5 w-5" />
              Go to #{hashtag}
            </Link>
          ) : null}
          {tab === "posts" ? (
            <PostResults q={term} />
          ) : (
            <PeopleResults q={term} />
          )}
        </>
      )}
    </SocialShell>
  );
}
