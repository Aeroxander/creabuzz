/**
 * Reading Home's feed of project records (`lib/record-feed.ts`).
 *
 * Whose records: for someone signed in, the projects they started, help or follow; for a visitor, or someone tied to
 * no project yet, every listed project (the newest ones). Never both: the page says which it is showing.
 *
 * The feed is read a page at a time, newest first, by who signed the records: only the teams of the projects in view
 * are asked for, so nobody else's records about those projects can fill a page. The tasks that the confirmations in
 * a page name are read with their steps, and "work accepted" is worked out from them by the project page's own rules.
 * A later page that fails keeps what was read; a read that hit a bound is said.
 *
 * No state is kept outside React and the query cache: nothing here outlives a change of community.
 */

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { teamOf } from "@/features/launchpad/lib/help-request";
import {
  joinProjectPages,
  nextProjectPage,
  projectListCut,
} from "@/features/launchpad/lib/launch-query";
import { listedProject } from "@/features/launchpad/lib/listing";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import {
  parseTaskRecord,
  TASK_LABEL,
  type TaskRecord,
} from "@/features/launchpad/lib/tasks";
import {
  effectiveStage,
  launchCoordinate,
  type LaunchRecord,
} from "@/features/launchpad/models";
import { useLaunches } from "@/features/launchpad/use-launches";
import { useMyProjects } from "@/features/launchpad/use-my-projects";
import { readProjectVoices } from "@/features/launchpad/use-team";
import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  confirmedTaskIds,
  FEED_AUTHORS,
  FEED_MAX_PAGES,
  FEED_PAGE,
  FEED_PROJECTS,
  type FeedProject,
  feedItems,
} from "./lib/record-feed";

/** How many tasks' records one page reads, and how many of their steps. */
const TASKS_PER_PAGE = 100;
const STEPS_LIMIT = 500;

export interface FeedScope {
  /** `yours`: the reader's own projects. `everyone`: every listed project. */
  mode: "yours" | "everyone";
  projects: LaunchRecord[];
  /** There are more projects than the feed follows at once. */
  cut: boolean;
}

/** Which projects the feed is about, or why that is not known yet. */
export function useFeedScope(): {
  scope: FeedScope | null;
  loading: boolean;
  failed: boolean;
  retry: () => void;
  /** Who the reader follows could not be read: the projects they follow are not in the feed. */
  followsFailed: boolean;
  retryFollows: () => void;
} {
  const me = existingUserPubkey();
  const mine = useMyProjects();
  const launches = useLaunches();
  const yours = useMemo(() => {
    if (!mine.data) return null;
    const seen = new Set<string>();
    const out: LaunchRecord[] = [];
    for (const record of [
      ...mine.data.started,
      ...mine.data.helping.map((h) => h.record),
      ...mine.data.following,
    ]) {
      const coordinate = launchCoordinate(record.author, record.id);
      if (seen.has(coordinate)) continue;
      seen.add(coordinate);
      out.push(record);
    }
    return out;
  }, [mine.data]);
  const listed = useMemo(() => {
    if (!launches.data) return null;
    const raises = raisesOffered();
    return launches.data
      .filter((l) => listedProject(l.record, effectiveStage(l), raises))
      .map((l) => l.record);
  }, [launches.data]);

  const follows = {
    followsFailed: me !== null && mine.followsFailed,
    retryFollows: mine.retryFollows,
  };
  // Signed in, and not yet known whether anything is theirs: wait, never show everyone's in the meantime.
  if (me !== null && yours === null)
    return {
      scope: null,
      loading: !mine.failed,
      failed: mine.failed,
      retry: mine.retry,
      ...follows,
    };
  if (yours !== null && yours.length > 0)
    return {
      scope: {
        mode: "yours",
        projects: yours.slice(0, FEED_PROJECTS),
        // (A failed read of who they follow is said on its own, with its retry.)
        cut: yours.length > FEED_PROJECTS || (mine.cut && !mine.followsFailed),
      },
      loading: false,
      failed: false,
      retry: mine.retry,
      ...follows,
    };
  if (listed === null)
    return {
      scope: null,
      loading: launches.isLoading,
      failed: launches.isError,
      retry: () => void launches.refetch(),
      ...follows,
    };
  return {
    scope: {
      mode: "everyone",
      projects: listed.slice(0, FEED_PROJECTS),
      cut: listed.length > FEED_PROJECTS || launches.hasMore || launches.cut,
    },
    loading: false,
    failed: false,
    retry: () => void launches.refetch(),
    ...follows,
  };
}

interface FeedPage {
  events: NostrEvent[];
  taskRecords: TaskRecord[];
  /** The tasks or steps behind this page's confirmations could not all be read: accepted work may be missing. */
  workCut: boolean;
}

const tasksOf = (events: readonly NostrEvent[]): TaskRecord[] =>
  events.flatMap((event) => {
    if (event.kind !== KIND_LAUNCH_UPDATE) return [];
    const record = parseTaskRecord(event);
    return record ? [record] : [];
  });

async function fetchFeedPage(
  relay: string,
  coordinates: readonly string[],
  authors: readonly string[],
  until: number | null,
): Promise<FeedPage> {
  const events = await queryEvents(relay, {
    kinds: [KIND_LAUNCH_UPDATE],
    authors: [...authors],
    "#a": [...coordinates],
    limit: FEED_PAGE,
    ...(until === null ? {} : { until }),
  });
  // Checked again: only what one of those accounts signed.
  const signed = events.filter((event) => authors.includes(event.pubkey));
  const taskIds = confirmedTaskIds(signed);
  if (taskIds.length === 0)
    return { events: signed, taskRecords: [], workCut: false };
  const ids = taskIds.slice(0, TASKS_PER_PAGE);
  const tasks = tasksOf(
    await queryEvents(relay, {
      kinds: [KIND_LAUNCH_UPDATE],
      ids,
      limit: ids.length,
    }),
  ).filter((r) => r.part === "task" && authors.includes(r.author));
  // The steps count from the teams and from the helpers those tasks name.
  const signers = [
    ...new Set([
      ...authors,
      ...tasks.flatMap((task) => (task.helper ? [task.helper] : [])),
    ]),
  ];
  const steps = await queryEvents(relay, {
    kinds: [KIND_LAUNCH_UPDATE],
    authors: signers,
    "#e": tasks.map((task) => task.id),
    "#l": [TASK_LABEL],
    limit: STEPS_LIMIT,
  });
  return {
    events: signed,
    taskRecords: [
      ...tasks,
      ...tasksOf(steps).filter((r) => signers.includes(r.author)),
    ],
    workCut: taskIds.length > TASKS_PER_PAGE || steps.length >= STEPS_LIMIT,
  };
}

/** The feed for a scope: its items, newest first, and how to read further back. */
export function useRecordFeed(scope: FeedScope | null) {
  const relay = relayWsUrl();
  const records = scope?.projects;
  // Who said yes on each project, from their own signed answers: whose updates are the project's.
  const said = useQuery({
    queryKey: [
      "launchpad",
      "team",
      "voices",
      relay,
      (records ?? []).map((r) => r.eventId),
    ],
    queryFn: () => readProjectVoices(relay, records ?? []),
    enabled: (records?.length ?? 0) > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const voices = said.data?.voices;
  const projects = useMemo(() => {
    const map = new Map<string, FeedProject>();
    if (!voices) return map;
    for (const record of records ?? []) {
      const coordinate = launchCoordinate(record.author, record.id);
      map.set(coordinate, {
        coordinate,
        founder: record.author,
        team: teamOf(record),
        voices: voices.get(coordinate) ?? new Map([[record.author, null]]),
      });
    }
    return map;
  }, [records, voices]);
  const coordinates = useMemo(() => [...projects.keys()].sort(), [projects]);
  // Asked for: the teams (their task steps count) and everyone who speaks or spoke for a project.
  const everyone = useMemo(
    () =>
      [
        ...new Set(
          [...projects.values()].flatMap((p) => [
            ...p.team,
            ...p.voices.keys(),
          ]),
        ),
      ].sort(),
    [projects],
  );
  const authors = useMemo(() => everyone.slice(0, FEED_AUTHORS), [everyone]);
  const query = useInfiniteQuery({
    queryKey: ["launchpad", "help", "feed", relay, coordinates, authors],
    queryFn: ({ pageParam }) =>
      fetchFeedPage(relay, coordinates, authors, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (_last, pages) =>
      nextProjectPage(pages, FEED_PAGE, FEED_MAX_PAGES),
    enabled: coordinates.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const pages = query.data?.pages;
  const items = useMemo(
    () =>
      pages
        ? feedItems({
            events: joinProjectPages(pages),
            projects,
            taskRecords: pages.flatMap((page) => page.taskRecords),
            now: Math.floor(Date.now() / 1000),
          })
        : [],
    [pages, projects],
  );
  const { fetchNextPage, refetch } = query;
  return {
    items,
    /** Nothing was asked for: the scope has no project. */
    idle: (records?.length ?? 0) === 0,
    loading: said.isLoading || query.isLoading,
    /** A first read failed: there is nothing to show. */
    error:
      (said.data ? null : said.error) ??
      (query.isFetchNextPageError || pages ? null : query.error),
    refetch: () => {
      if (said.isError) void said.refetch();
      void refetch();
    },
    hasMore: query.hasNextPage,
    loadMore: () => void fetchNextPage(),
    loadingMore: query.isFetchingNextPage,
    moreError: query.isFetchNextPageError ? query.error : null,
    /** Older records exist that no further page can reach. */
    cut: pages ? projectListCut(pages, FEED_PAGE, FEED_MAX_PAGES) : false,
    /** Accepted work behind some confirmations could not be read. */
    workCut:
      (pages?.some((page) => page.workCut) ?? false) ||
      // Not every answer was read: an update by someone who said yes may be missing.
      Boolean(said.data?.cut),
    /** The teams in view are more accounts than one read names: some teams' records are not in the feed. */
    authorsCut: everyone.length > FEED_AUTHORS,
  };
}
