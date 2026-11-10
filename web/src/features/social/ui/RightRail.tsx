import { Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { useStillOpen } from "@/features/launchpad/use-help-requests";
import { useLaunches } from "@/features/launchpad/use-launches";
import { resolveUserName } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";

import {
  RAIL_LIMITS,
  railBlurb,
  railPostIds,
  railPosts,
  railHelpCandidates,
  railProjects,
} from "../lib/rail";
import { firstError, listView, readUnknown } from "../lib/read-view";
import { useSuggestedUsers, useTrending } from "../use-discovery";
import { usePeople } from "../use-people";
import { useMutedPeople } from "../use-social-actions";
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

const NOBODY: ReadonlySet<string> = new Set();

const LINK_CLASS = "font-semibold text-sky-700 underline dark:text-sky-400";

/** One block of the rail: a heading, a short list and a "See all" link to the full page. */
function RailBlock({
  id,
  title,
  seeAll,
  busy = false,
  children,
}: {
  id: string;
  title: string;
  seeAll: ReactNode;
  /** True while the block's reads have not answered. */
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-busy={busy || undefined}
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

/**
 * A line in a block that has no list to show: still reading, nothing yet, or the read failed (with a retry). A failed
 * read is an alert, so a screen reader says it at once. "Still reading" and "nothing yet" are plain text: four blocks
 * loading together must not announce four times (the block says it is busy instead, see `RailBlock`).
 */
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
      role={onRetry ? "alert" : undefined}
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
  const candidates = useMemo(
    () => railHelpCandidates(launches.data ?? [], raises),
    [launches.data, raises],
  );
  const asking = useStillOpen(candidates, RAIL_LIMITS.helpRequests);
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
      busy={view === "loading"}
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
                // The author too, as every other project link sends it: two authors can share an id.
                search={{ author: record.author }}
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
      {view === "list" && asking.failed ? (
        <RailNote onRetry={asking.retry} testId="social-rail-help-error">
          Couldn't check who is asking for help.
        </RailNote>
      ) : null}
      {view === "list" && asking.requests.length > 0 ? (
        <div data-testid="social-rail-help">
          <h3 className="px-4 pt-2 text-xs font-bold text-black/60 dark:text-white/60">
            Asking for help
          </h3>
          <ul>
            {asking.requests.map(({ project, updateId, ask }) => (
              <li key={updateId}>
                <Link
                  className="block px-4 py-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                  hash={`update-${updateId}`}
                  params={{ launchId: project.id }}
                  search={{ author: project.author, tab: "updates" }}
                  to="/launchpad/$launchId"
                >
                  <span className="block truncate text-sm font-bold text-black dark:text-white">
                    {project.name}
                  </span>
                  <span className="line-clamp-2 text-xs text-black/60 dark:text-white/60">
                    {ask.text}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </RailBlock>
  );
}

function TrendingPostsBlock() {
  const trending = useTrending();
  // Only the top few ids (Explore reads all thirty): the rail is on every social page and shows three posts.
  const notes = useNotesById(railPostIds(trending.data?.ids));
  // A muted person's post stays out of the rail, as out of the timeline; wait for the mute list so it never flashes.
  // If the mute list could not be read, who to leave out is unknown: show no posts, only the failure and its retry.
  const mutedRead = useMutedPeople();
  const mutesUnknown = readUnknown(mutedRead);
  const rows = useMemo(
    () =>
      mutesUnknown ? [] : railPosts(notes.data ?? [], mutedRead.data ?? NOBODY),
    [notes.data, mutedRead.data, mutesUnknown],
  );
  const people = usePeople(rows.map((row) => row.event.pubkey));
  const error = firstError(
    trending.error,
    notes.error,
    mutesUnknown && mutedRead.error,
  );
  const view = listView({
    count: rows.length,
    error,
    loading:
      trending.isLoading ||
      mutedRead.isLoading ||
      Boolean(trending.data?.ids.length && notes.isLoading),
  });
  const retry = () => {
    if (mutedRead.error) void mutedRead.refetch();
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
      busy={view === "loading"}
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
      busy={view === "loading"}
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
  // The suggestions leave out people you muted, so they wait for the mute list too. If it could not be read, nobody is
  // suggested (a muted person could be among them): the block shows the failure and its retry.
  const mutedRead = useMutedPeople();
  const mutesUnknown = readUnknown(mutedRead);
  const list = mutesUnknown ? [] : (suggested.data ?? []);
  const people = usePeople(list.map((s) => s.pubkey));
  // Suggestions wait for who you follow: if that read failed they never come, which is a failure, not "no suggestions".
  const following = useFollowing(existingUserPubkey());
  const error = firstError(
    suggested.error,
    following.error,
    mutesUnknown && mutedRead.error,
  );
  const view = listView({
    count: list.length,
    error,
    loading: suggested.isLoading || following.isLoading || mutedRead.isLoading,
  });
  const retry = () => {
    if (following.error) void following.refetch();
    // Reading the mute list again starts the suggestions; asking for them now would be asking with no mutes.
    if (mutesUnknown) void mutedRead.refetch();
    else void suggested.refetch();
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
      busy={view === "loading"}
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
