/**
 * Asking to join a project, and the founder's list of who asked (`lib/join.ts`).
 *
 * - A person asks with one signed record of their own (`useAskToJoin`); it also holds their yes, so the founder's
 *   Accept (`useAcceptJoin` in `use-team.ts`) is the only step left.
 * - A person's own ask on a project is read by who signed it (`useMyAsk`), so "Asked to join" is shown after a reload.
 * - The founder's page reads the project's asks by their label, a page of them, and says when it hit its bound
 *   (`useProjectAsks`); Notifications reads the asks that name the founder, then the founder's own project records
 *   for who is already on each (`useAsksToMe`).
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
  parseJoinAsk,
  pendingAsks,
} from "./lib/join";
import { launchRemovals } from "./lib/launch-removals";
import { founderOfCoordinate } from "./lib/tasks";
import {
  launchCoordinate,
  type LaunchRecord,
  parseLaunchRecord,
} from "./models";
import { publishMirror } from "./use-launches";

/** Every ask read is cached under this, so one send or one accept refreshes the page, the card and Notifications. */
export const joinQueryKey = ["launchpad", "join"] as const;

/** How many asks one read asks for. A server holds at most three from one person for one project. */
const ASKS_LIMIT = 200;
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
 * The asks the founder can still accept on this project. Read for the founder only (`enabled`); `cut` says the read
 * was full, so more asks may be waiting.
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
      const events = await queryEvents(relay, {
        kinds: [KIND_LAUNCH_UPDATE],
        "#a": [coordinate],
        "#l": [JOIN_LABEL],
        limit: ASKS_LIMIT,
      });
      return { asks: asksOf(events), cut: events.length >= ASKS_LIMIT };
    },
  });
  const asks = read.data?.asks;
  return {
    pending: asks
      ? pendingAsks(asks, {
          author: project.author,
          coordinate,
          team: project.team,
          formerTeam: project.formerTeam,
        })
      : [],
    ready: read.data !== undefined,
    failed: read.isError && !read.data,
    cut: read.data?.cut ?? false,
    retry: () => void read.refetch(),
  };
}

/** A project of the signed-in founder with the asks still waiting on it. */
interface ProjectAsks {
  record: LaunchRecord;
  asks: JoinAsk[];
}

/**
 * Every ask that names the signed-in person as founder and is still waiting, by project. The records that name the
 * person are read by their `p` tag (a stranger can sign one, so the read is bounded and says so); each project is read
 * again from the person's own record, which is what says who is on the team now. Projects the founder removed are left
 * out.
 */
async function readAsksToMe(relay: string, me: string) {
  const events = await queryEvents(relay, {
    kinds: [KIND_LAUNCH_UPDATE],
    "#p": [me],
    "#l": [JOIN_LABEL],
    limit: ASKS_LIMIT,
  });
  const asks = asksOf(events).filter(
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
  const cut = events.length >= ASKS_LIMIT;
  if (ids.length === 0) return { projects: [] as ProjectAsks[], cut };
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
  for (const record of newest.values()) {
    const coordinate = launchCoordinate(me, record.id);
    const waiting = pendingAsks(asks, {
      author: me,
      coordinate,
      team: record.team,
      formerTeam: record.formerTeam,
    });
    if (waiting.length > 0) projects.push({ record, asks: waiting });
  }
  projects.sort(
    (a, b) =>
      a.record.name.localeCompare(b.record.name) ||
      (a.record.id < b.record.id ? -1 : 1),
  );
  return { projects, cut: cut || records.length >= PROJECTS_LIMIT * 2 };
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
