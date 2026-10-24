import { Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { launchCoord, LaunchVoteCard } from "@/features/feed/ui/LaunchVoteCard";
import { EMPTY_TALLY, sortByMode } from "@/features/feed/lib/ranking";
import { useFeedNotes, useVoteTallies } from "@/features/feed/use-feed";
import { useLaunches } from "@/features/launchpad/use-launches";

import { useSuggestedUsers, useTrending } from "../use-discovery";
import { usePeople } from "../use-people";
import { HashtagRow } from "./HashtagRow";
import { PersonRow } from "./PersonRow";

export function SearchBox({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  const navigate = useNavigate();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        if (q) void navigate({ to: "/social/search", search: { q } });
      }}
    >
      <label className="sr-only" htmlFor="social-search-input">
        Search posts and people
      </label>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-black/50 dark:text-white/50"
        />
        <input
          className="h-10 w-full rounded-full border border-transparent bg-black/5 pl-10 pr-4 text-sm text-black outline-none placeholder:text-black/50 focus:border-primary focus:bg-white dark:bg-white/10 dark:text-white dark:placeholder:text-white/50 dark:focus:bg-black"
          data-testid="social-search-input"
          id="social-search-input"
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search"
          type="search"
          value={value}
        />
      </div>
    </form>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="glass overflow-hidden rounded-2xl border">
      <h2 className="px-4 pb-1 pt-3 text-lg font-bold text-black dark:text-white">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The launches drawing the most weighted support right now, with how much is being said about each. */
function TrendingLaunchesCard() {
  const launches = useLaunches();
  const notes = useFeedNotes();
  const { tallies } = useVoteTallies();
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
  const postsPerLaunch = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of notes.data ?? []) {
      for (const coord of note.launches) {
        counts.set(coord, (counts.get(coord) ?? 0) + 1);
      }
    }
    return counts;
  }, [notes.data]);
  if (trending.length === 0) return null;
  return (
    <section
      aria-labelledby="trending-launches-title"
      className="glass overflow-hidden rounded-2xl border"
    >
      <h2
        className="px-4 pb-1 pt-3 text-lg font-bold text-black dark:text-white"
        id="trending-launches-title"
      >
        Trending projects
      </h2>
      <ul
        className="flex flex-col gap-2 p-3 pt-1"
        data-testid="trending-launches"
      >
        {trending.map((launch) => {
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
        })}
      </ul>
    </section>
  );
}

function TrendingCard() {
  const hashtags = useTrending().data?.hashtags.slice(0, 5) ?? [];
  if (hashtags.length === 0) return null;
  return (
    <Card title="Trending">
      <ul data-testid="social-rail-trending">
        {hashtags.map(({ tag, count }) => (
          <li key={tag}>
            <HashtagRow compact count={count} tag={tag} />
          </li>
        ))}
      </ul>
      <Link
        className="block px-4 py-3 text-sm text-sky-700 hover:bg-black/5 dark:text-sky-400 dark:hover:bg-white/10"
        to="/social/explore"
      >
        Show more
      </Link>
    </Card>
  );
}

function WhoToFollowCard() {
  const suggested = useSuggestedUsers(3).data ?? [];
  const people = usePeople(suggested.map((s) => s.pubkey));
  if (suggested.length === 0) return null;
  return (
    <Card title="Who to follow">
      <div data-testid="social-rail-people">
        {suggested.map((s) => (
          <PersonRow
            key={s.pubkey}
            profile={people[s.pubkey]}
            pubkey={s.pubkey}
          />
        ))}
      </div>
      <Link
        className="block px-4 py-3 text-sm text-sky-700 hover:bg-black/5 dark:text-sky-400 dark:hover:bg-white/10"
        search={undefined}
        to="/social/explore"
      >
        Show more
      </Link>
    </Card>
  );
}

/** The right rail: trending launches and hashtags, and people worth following. Search is in the top bar, which is always on screen when this is. */
export function RightRail() {
  return (
    <div className="flex flex-col gap-4">
      <TrendingLaunchesCard />
      <TrendingCard />
      <WhoToFollowCard />
    </div>
  );
}
