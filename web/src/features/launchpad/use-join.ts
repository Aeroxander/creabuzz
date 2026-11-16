/**
 * Asking to join a project, and the founder's list of who asked (`lib/join.ts`).
 *
 * - A person asks with one signed record of their own (`useAskToJoin`); it also holds their yes, so the founder's
 *   Accept (`useAcceptJoin` in `use-team.ts`) is the only step left.
 * - A person's own ask on a project is read by who signed it (`useMyAsk`), so "Asked to join" is shown after a reload.
 * - The founder's page reads the project's asks by their label, page after page up to a bound, and says when it hit
 *   its bound (`useProjectAsks`); Notifications reads the asks that name the founder, then the founder's own project
 *   records for who is already on each (`useAsksToMe`).
 * - The founder may turn an ask away with one record of their own (`useDeclineJoin`): the ask is left out of both lists,
 *   so a flood of asks from strangers can be cleared one by one without putting anyone on the team.
 *
 * Every read is bounded and says when it hit its bound. No state is kept outside React and the query cache.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
} from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  hasWaitingAsk,
  JOIN_LABEL,
  type JoinAsk,
  joinAskEvent,
  joinDeclineEvent,
  MAX_PENDING_ASKS,
  parseJoinAsk,
  parseJoinDecline,
  waitingAsks,
} from "./lib/join";
import { launchRemovals } from "./lib/launch-removals";
import { readPages } from "./lib/read-pages";
import { founderOfCoordinate } from "./lib/tasks";
import {
  launchCoordinate,
  type LaunchRecord,
  parseLaunchRecord,
} from "./models";
import { publishMirror } from "./use-launches";

/** Every ask read is cached under this, so one send or one accept refreshes the page, the card and Notifications. */
export const joinQueryKey = ["launchpad", "join"] as const;

/** How many asks one page of a read asks for. A server holds at most three from one person for one project. */
const ASKS_LIMIT = 200;
/**
 * How many pages of asks are read before the list says it was cut. A stranger can ask for nothing with a fresh key, so
 * the newest page alone could be all junk; the founder's real ask is found by reading on, to this depth.
 */
const ASKS_PAGES = 5;
/** How many of a person's own asks are read to find the one on this project. */
const MINE_LIMIT = 50;
/** How many projects' records Notifications reads for the asks that name the founder. */
const PROJECTS_LIMIT = 100;

type Project = Pick<LaunchRecord, "author" | "id">;

const asksOf = (events: readonly Parameters<typeof parseJoinAsk>[0][]) =>
  events.flatMap((event) => {
    const ask = parseJoinAsk(event);
    return ask ? [ask] : [];
  });

const declinesOf = (
  events: readonly Parameters<typeof parseJoinDecline>[0][],
) =>
  events.flatMap((event) => {
    const decline = parseJoinDecline(event);
    return decline ? [decline] : [];
  });

/**
 * The signed-in person's own asks on this project, and whether one is still waiting (they asked and are not on the
 * record). Not read for a visitor with no account.
 */
export function useMyAsk(project: LaunchRecord) {
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  const coordinate = launchCoordinate(project.author, project.id);
  const read = useQuery({
    queryKey: [...joinQueryKey, "mine", relay, coordinate, me],
    enabled: me !== null,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    queryFn: async () =>
      asksOf(
        await queryEvents(relay, {
          kinds: [KIND_LAUNCH_UPDATE],
          authors: [me as string],
          "#a": [coordinate],
          "#l": [JOIN_LABEL],
          limit: MINE_LIMIT,
        }),
      ).filter((ask) => ask.author === me && ask.coordinate === coordinate),
  });
  return {
    /** The read is known: until then nobody is told they have not asked. */
    ready: me === null || read.data !== undefined,
    waiting:
      me !== null &&
      read.data !== undefined &&
      hasWaitingAsk(read.data, me, {
        author: project.author,
        coordinate,
        team: project.team,
        formerTeam: project.formerTeam,
      }),
  };
}

/** Ask to join: one record signed by the person, naming the project and its founder. */
export function useAskToJoin(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      const { content, tags } = joinAskEvent({ founder: project.author });
      return publishMirror({
        kind: KIND_LAUNCH_UPDATE,
        tags: [["a", launchCoordinate(project.author, project.id)], ...tags],
        content,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: joinQueryKey }),
  });
}

/**
 * The asks the founder can still accept on this project, the first {@link MAX_PENDING_ASKS} of them (`hidden` counts
 * the rest). Read for the founder only (`enabled`); `cut` says the read stopped before the end of the list, so more
 * asks may be waiting.
 */
export function useProjectAsks(project: LaunchRecord, enabled: boolean) {
  const relay = relayWsUrl();
  const coordinate = launchCoordinate(project.author, project.id);
  const read = useQuery({
    queryKey: [...joinQueryKey, "project", relay, coordinate],
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const [asks, declines] = await Promise.all([
        readPages(
          ({ until, limit }) =>
            queryEvents(relay, {
              kinds: [KIND_LAUNCH_UPDATE],
              "#a": [coordinate],
              "#l": [JOIN_LABEL],
              limit,
              ...(until === undefined ? {} : { until }),
            }),
          { limit: ASKS_LIMIT, maxPages: ASKS_PAGES },
        ),
        // What the founder turned away: the founder's own records only.
        queryEvents(relay, {
          kinds: [KIND_LAUNCH_UPDATE],
          authors: [project.author],
          "#a": [coordinate],
          "#l": [JOIN_LABEL],
          limit: ASKS_LIMIT,
        }),
      ]);
      return {
        asks: asksOf(asks.events),
        declines: declinesOf(declines),
        cut: asks.cut || declines.length >= ASKS_LIMIT,
      };
    },
  });
  const waiting = read.data
    ? waitingAsks(
        read.data.asks,
        {
          author: project.author,
          coordinate,
          team: project.team,
          formerTeam: project.formerTeam,
        },
        read.data.declines,
      )
    : [];
  return {
    pending: waiting.slice(0, MAX_PENDING_ASKS),
    /** Asks waiting beyond the ones listed: they appear as the ones above are accepted or turned away. */
    hidden: Math.max(0, waiting.length - MAX_PENDING_ASKS),
    ready: read.data !== undefined,
    failed: read.isError && !read.data,
    cut: read.data?.cut ?? false,
    retry: () => void read.refetch(),
  };
}

/**
 * Turn one person's ask away: one record the founder signs, naming the project and the person. The person is not
 * told, and may ask again (a few times); the ask they sent stays on the server, but is no longer listed.
 */
export function useDeclineJoin(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (asker: string) => {
      const { content, tags } = joinDeclineEvent({ asker });
      return publishMirror({
        kind: KIND_LAUNCH_UPDATE,
        tags: [["a", launchCoordinate(project.author, project.id)], ...tags],
        content,
      });
    },
    // Sent or not, the lists are read again: a send whose answer was lost shows the ask gone.
    onSettled: () => queryClient.invalidateQueries({ queryKey: joinQueryKey }),
  });
}

/** A project of the signed-in founder with the asks still waiting on it. */
interface ProjectAsks {
  record: LaunchRecord;
  asks: JoinAsk[];
}

/**
 * Every ask that names the signed-in person as founder and is still waiting, by project. The server only stores an ask
 * whose `p` tag is its project's founder, but an ask can be about any of the founder's projects and a stranger can sign
 * many, so the records that name the person are read page after page up to a bound (and say so when cut), then
 * checked again here against the project they name. Each project is read again from the person's own record, which is
 * what says who is on the team now. What the person already turned away is left out. Projects the founder removed are
 * left out too.
 */
async function readAsksToMe(relay: string, me: string) {
  const [read, declined] = await Promise.all([
    readPages(
      ({ until, limit }) =>
        queryEvents(relay, {
          kinds: [KIND_LAUNCH_UPDATE],
          "#p": [me],
          "#l": [JOIN_LABEL],
          limit,
          ...(until === undefined ? {} : { until }),
        }),
      { limit: ASKS_LIMIT, maxPages: ASKS_PAGES },
    ),
    queryEvents(relay, {
      kinds: [KIND_LAUNCH_UPDATE],
      authors: [me],
      "#l": [JOIN_LABEL],
      limit: ASKS_LIMIT,
    }),
  ]);
  const declines = declinesOf(declined);
  const asks = asksOf(read.events).filter(
    (ask) => founderOfCoordinate(ask.coordinate) === me,
  );
  const ids = [
    ...new Set(
      asks.flatMap((ask) => {
        const id = ask.coordinate.split(":")[2];
        return id ? [id] : [];
      }),
    ),
  ].slice(0, PROJECTS_LIMIT);
  const cut = read.cut || declined.length >= ASKS_LIMIT;
  if (ids.length === 0)
    return { projects: [] as ProjectAsks[], cut, hidden: 0 };
  const [records, removals] = await Promise.all([
    queryEvents(relay, {
      kinds: [KIND_LAUNCH_RECORD],
      authors: [me],
      "#d": ids,
      limit: PROJECTS_LIMIT * 2,
    }),
    queryEvents(relay, {
      kinds: [5],
      authors: [me],
      "#a": ids.map((id) => launchCoordinate(me, id)),
      limit: 500,
    }),
  ]);
  const removed = launchRemovals(removals);
  const newest = new Map<string, LaunchRecord>();
  for (const event of records) {
    const record = parseLaunchRecord(event);
    if (!record || record.author !== me) continue;
    const gone = removed.get(launchCoordinate(me, record.id));
    if (gone !== undefined && record.createdAt <= gone) continue;
    const was = newest.get(record.id);
    if (!was || record.createdAt >= was.createdAt)
      newest.set(record.id, record);
  }
  const projects: ProjectAsks[] = [];
  let hidden = 0;
  for (const record of newest.values()) {
    const coordinate = launchCoordinate(me, record.id);
    const waiting = waitingAsks(
      asks,
      {
        author: me,
        coordinate,
        team: record.team,
        formerTeam: record.formerTeam,
      },
      declines,
    );
    hidden += Math.max(0, waiting.length - MAX_PENDING_ASKS);
    if (waiting.length > 0)
      projects.push({ record, asks: waiting.slice(0, MAX_PENDING_ASKS) });
  }
  projects.sort(
    (a, b) =>
      a.record.name.localeCompare(b.record.name) ||
      (a.record.id < b.record.id ? -1 : 1),
  );
  return {
    projects,
    cut: cut || records.length >= PROJECTS_LIMIT * 2,
    hidden,
  };
}

/** The asks waiting on the signed-in founder's projects. Not read for a visitor. */
export function useAsksToMe() {
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  return useQuery({
    queryKey: [...joinQueryKey, "to-me", relay, me],
    queryFn: () => readAsksToMe(relay, me as string),
    enabled: me !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
