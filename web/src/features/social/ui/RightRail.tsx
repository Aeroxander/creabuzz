import { Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { useLaunches } from "@/features/launchpad/use-launches";
import { resolveUserName } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";

import { RAIL_LIMITS, railBlurb, railProjects } from "../lib/rail";
import { firstError, listView } from "../lib/read-view";
import { useSuggestedUsers, useTrending } from "../use-discovery";
import { usePeople } from "../use-people";
import { useFollowing, useNotesById } from "../use-social-data";
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

const LINK_CLASS = "font-semibold text-sky-700 underline dark:text-sky-400";

/** One block of the rail: a heading, a short list and a "See all" link to the full page. */
function RailBlock({
  id,
  title,
  seeAll,
  children,
}: {
  id: string;
  title: string;
  seeAll: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="glass overflow-hidden rounded-2xl border"
      data-testid={`social-rail-block-${id}`}
    >
      <h2
        className="px-4 pb-1 pt-3 text-lg font-bold text-black dark:text-white"
        id={id}
      >
        {title}
      </h2>
      {children}
      {seeAll}
    </section>
  );
}

/** A line in a block that has no list to show: still reading, nothing yet, or the read failed (with a retry). */
function RailNote({
  children,
  onRetry,
  testId,
}: {
  children: ReactNode;
  onRetry?: () => void;
  testId: string;
}) {
  return (
    <p
      className="px-4 pb-3 text-sm text-black/60 dark:text-white/60"
      data-testid={testId}
      role="status"
    >
      {children}
      {onRetry ? (
        <>
          {" "}
          <button className={LINK_CLASS} onClick={onRetry} type="button">
            Try again
          </button>
        </>
      ) : null}
    </p>
  );
}

/** The Explore tabs a link names; the first one, trending posts, is the page's address with no tab. */
type ExploreTab = "people" | "hashtags";

/**
 * A block's link to its full page. The name starts with the visible words ("See all"), and says which list, so the
 * four links in the rail are told apart by a screen reader and matched by voice control.
 */
function SeeAll({
  label,
  testId,
  ...target
}: {
  label: string;
  testId: string;
} & (
  | { to: "/discover" }
  | { to: "/social/explore"; search: { tab?: ExploreTab } }
)) {
  return (
    <Link
      aria-label={`See all ${label}`}
      className="block px-4 py-3 text-sm text-sky-700 hover:bg-black/5 dark:text-sky-400 dark:hover:bg-white/10"
      data-testid={testId}
      {...target}
    >
      See all
    </Link>
  );
}

/** The newest projects people can open, from the launches Home already reads. */
function ProjectsBlock() {
  const launches = useLaunches();
  const raises = raisesOffered();
  const shown = useMemo(
    () => railProjects(launches.data ?? [], raises),
    [launches.data, raises],
  );
  const view = listView({
    count: shown.length,
    error: launches.error,
    loading: launches.isLoading,
  });
  return (
    <RailBlock
      id="rail-projects"
      seeAll={
        <SeeAll
          label="projects"
          testId="social-rail-projects-all"
          to="/discover"
        />
      }
      title="Projects"
    >
      {view === "loading" ? (
        <RailNote testId="social-rail-projects-loading">
          Loading projects…
        </RailNote>
      ) : view === "error" ? (
        <RailNote
          onRetry={() => void launches.refetch()}
          testId="social-rail-projects-error"
        >
          Couldn't load projects.
        </RailNote>
      ) : view === "empty" ? (
        <RailNote testId="social-rail-projects-empty">
          No projects on this server yet.{" "}
          <Link className={LINK_CLASS} to="/start">
            Start one
          </Link>
          .
        </RailNote>
      ) : (
        <ul data-testid="social-rail-projects">
          {shown.map(({ record }) => (
            <li key={`${record.author}:${record.id}`}>
              <Link
                className="block px-4 py-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                params={{ launchId: record.id }}
                to="/launchpad/$launchId"
              >
                <span className="block truncate text-sm font-bold text-black dark:text-white">
                  {record.name}
                </span>
                {record.pitch ? (
                  <span className="line-clamp-2 text-xs text-black/60 dark:text-white/60">
                    {record.pitch}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </RailBlock>
  );
}

function TrendingPostsBlock() {
  const trending = useTrending();
  // The same read the Explore page makes, so its cache serves the page after "See all".
  const notes = useNotesById(trending.data?.ids ?? []);
  const rows = (notes.data ?? []).slice(0, RAIL_LIMITS.posts);
  const people = usePeople(rows.map((row) => row.event.pubkey));
  const error = firstError(trending.error, notes.error);
  const view = listView({
    count: rows.length,
    error,
    loading:
      trending.isLoading ||
      Boolean(trending.data?.ids.length && notes.isLoading),
  });
  const retry = () => {
    void trending.refetch();
    if (notes.error) void notes.refetch();
  };
  return (
    <RailBlock
      id="rail-posts"
      seeAll={
        <SeeAll
          label="trending posts"
          search={{}}
          testId="social-rail-posts-all"
          to="/social/explore"
        />
      }
      title="Trending posts"
    >
      {view === "loading" ? (
        <RailNote testId="social-rail-posts-loading">Loading…</RailNote>
      ) : view === "error" ? (
        <RailNote onRetry={retry} testId="social-rail-posts-error">
          Couldn't load what's trending.
        </RailNote>
      ) : view === "empty" ? (
        <RailNote testId="social-rail-posts-empty">
          Nothing is trending yet.
        </RailNote>
      ) : (
        <ul data-testid="social-rail-posts">
          {rows.map(({ event }) => (
            <li key={event.id}>
              <Link
                className="block px-4 py-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                params={{ id: event.id }}
                to="/social/post/$id"
              >
                <span className="block truncate text-sm font-bold text-black dark:text-white">
                  {resolveUserName(people[event.pubkey], event.pubkey)}
                </span>
                <span className="line-clamp-2 text-xs text-black/60 dark:text-white/60">
                  {railBlurb(event.content) || "A post with a link or picture"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </RailBlock>
  );
}

function HashtagsBlock() {
  const trending = useTrending();
  const hashtags = trending.data?.hashtags.slice(0, RAIL_LIMITS.hashtags) ?? [];
  const view = listView({
    count: hashtags.length,
    error: trending.error,
    loading: trending.isLoading,
  });
  return (
    <RailBlock
      id="rail-hashtags"
      seeAll={
        <SeeAll
          label="hashtags"
          search={{ tab: "hashtags" }}
          testId="social-rail-hashtags-all"
          to="/social/explore"
        />
      }
      title="Hashtags"
    >
      {view === "loading" ? (
        <RailNote testId="social-rail-hashtags-loading">Loading…</RailNote>
      ) : view === "error" ? (
        <RailNote
          onRetry={() => void trending.refetch()}
          testId="social-rail-hashtags-error"
        >
          Couldn't load hashtags.
        </RailNote>
      ) : view === "empty" ? (
        <RailNote testId="social-rail-hashtags-empty">
          No hashtags yet.
        </RailNote>
      ) : (
        <ul data-testid="social-rail-trending">
          {hashtags.map(({ tag, count }) => (
            <li key={tag}>
              <HashtagRow compact count={count} tag={tag} />
            </li>
          ))}
        </ul>
      )}
    </RailBlock>
  );
}

function PeopleBlock() {
  const suggested = useSuggestedUsers(RAIL_LIMITS.people);
  const list = suggested.data ?? [];
  const people = usePeople(list.map((s) => s.pubkey));
  // Suggestions wait for who you follow: if that read failed they never come, which is a failure, not "no suggestions".
  const following = useFollowing(existingUserPubkey());
  const error = firstError(suggested.error, following.error);
  const view = listView({
    count: list.length,
    error,
    loading: suggested.isLoading || following.isLoading,
  });
  const retry = () => {
    if (following.error) void following.refetch();
    void suggested.refetch();
  };
  return (
    <RailBlock
      id="rail-people"
      seeAll={
        <SeeAll
          label="people to follow"
          search={{ tab: "people" }}
          testId="social-rail-people-all"
          to="/social/explore"
        />
      }
      title="People to follow"
    >
      {view === "loading" ? (
        <RailNote testId="social-rail-people-loading">Loading…</RailNote>
      ) : view === "error" ? (
        <RailNote onRetry={retry} testId="social-rail-people-error">
          Couldn't load suggestions.
        </RailNote>
      ) : view === "empty" ? (
        <RailNote testId="social-rail-people-empty">
          No suggestions yet. Follow a few people and check back.
        </RailNote>
      ) : (
        <div data-testid="social-rail-people">
          {list.map((s) => (
            <PersonRow
              key={s.pubkey}
              profile={people[s.pubkey]}
              pubkey={s.pubkey}
            />
          ))}
        </div>
      )}
    </RailBlock>
  );
}

/**
 * The rail beside the timeline (below it on narrower screens): the newest projects, what is trending, hashtags and
 * people worth following. Each is a short list that ends in a "See all" to its full page.
 */
export function RightRail() {
  return (
    <div className="flex flex-col gap-4">
      <ProjectsBlock />
      <TrendingPostsBlock />
      <HashtagsBlock />
      <PeopleBlock />
    </div>
  );
}
