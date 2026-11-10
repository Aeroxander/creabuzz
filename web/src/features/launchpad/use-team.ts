/**
 * Reading and changing a project's team (`lib/team.ts`).
 *
 * - The founder adds or removes a person on their own project record: read from the server first, merged, published
 *   once (`useChangeOwnRecord`).
 * - A person answers an invitation with one signed record of their own.
 * - A project's page reads the answers for that project alone, by their label; a person's invitations are found from
 *   the project records that name them.
 *
 * Every read is bounded and says when it hit its bound. No state is kept outside React and the query cache: nothing
 * here outlives a change of community.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
} from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { launchRemovals } from "./lib/launch-removals";
import {
  memberState,
  newInvite,
  parseTeamAnswer,
  TEAM_LABEL,
  type TeamAnswer,
  type TeamAnswerWord,
  teamAnswerEvent,
  type TeamMember,
  teamView,
  withMember,
  withoutMember,
} from "./lib/team";
import {
  launchCoordinate,
  type Launch,
  type LaunchRecord,
  parseLaunchRecord,
} from "./models";
import { launchesQueryKey, publishMirror } from "./use-launches";
import { useChangeOwnRecord } from "./use-own-record";

const teamQueryKey = ["launchpad", "team"] as const;

/** How many answers one read asks for: a team is at most twenty people, each answering an invitation once or twice. */
const ANSWERS_LIMIT = 200;
/** How many project records naming a person are read to find their invitations. */
const NAMING_LIMIT = 100;

const answersOf = (events: readonly NostrEvent[]): TeamAnswer[] =>
  events.flatMap((event) => {
    const answer = parseTeamAnswer(event);
    return answer ? [answer] : [];
  });

/**
 * One project's team as its page shows it: the people on the founder's record and where each stands, from the answers
 * read for this project. `cut` says the answers filled their read, so someone shown as not having answered may have.
 */
export function useProjectTeam(launch: Launch) {
  const { record } = launch;
  const coordinate = launchCoordinate(record.author, record.id);
  const relay = relayWsUrl();
  const authors = useMemo(
    () => record.team.map((member) => member.pubkey).sort(),
    [record.team],
  );
  const read = useQuery({
    queryKey: [...teamQueryKey, "project", relay, coordinate, authors],
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    // Nobody was added: there is nothing to read.
    enabled: authors.length > 0,
    queryFn: async () => {
      // By who signed them: only the people on the record can answer, so nobody else's records are in the read.
      const events = await queryEvents(relay, {
        kinds: [KIND_LAUNCH_UPDATE],
        authors,
        "#a": [coordinate],
        "#l": [TEAM_LABEL],
        limit: ANSWERS_LIMIT,
      });
      return {
        answers: answersOf(events).filter((a) => authors.includes(a.author)),
        cut: events.length >= ANSWERS_LIMIT,
      };
    },
  });
  const view = useMemo(
    () =>
      teamView(
        {
          author: record.author,
          coordinate,
          team: record.team,
          formerTeam: record.formerTeam,
        },
        read.data?.answers ?? [],
      ),
    [record, coordinate, read.data],
  );
  return {
    view,
    /** The answers are known: until then nobody is said to have answered or not. */
    ready: authors.length === 0 || read.data !== undefined,
    failed: read.isError && !read.data,
    cut: read.data?.cut ?? false,
    retry: () => void read.refetch(),
  };
}

/** The founder's two changes to the team. Each reads their record from the server, merges, and publishes once. */
export function useTeamChanges(launch: Launch) {
  const change = useChangeOwnRecord();
  const queryClient = useQueryClient();
  const id = launch.record.id;
  const done = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: teamQueryKey }),
      queryClient.invalidateQueries({ queryKey: launchesQueryKey }),
    ]);
  const add = useMutation({
    mutationFn: (pubkey: string) =>
      change(id, (own) => withMember(own, pubkey, newInvite())),
    onSuccess: done,
    // Sent or not, the record is read again: a send whose answer was lost shows the person as added.
    onError: done,
  });
  const remove = useMutation({
    mutationFn: (pubkey: string) =>
      change(id, (own) =>
        withoutMember(own, pubkey, Math.floor(Date.now() / 1000)),
      ),
    onSuccess: done,
    onError: done,
  });
  return { add, remove };
}

/** Answer an invitation: one record signed by the person invited. */
export function useAnswerInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      project: Pick<LaunchRecord, "author" | "id">;
      invite: string;
      answer: TeamAnswerWord;
    }) => {
      const { content, tags } = teamAnswerEvent(input);
      return publishMirror({
        kind: KIND_LAUNCH_UPDATE,
        tags: [
          ["a", launchCoordinate(input.project.author, input.project.id)],
          ...tags,
        ],
        content,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: teamQueryKey }),
  });
}

interface TeamInvitation {
  record: LaunchRecord;
  member: TeamMember;
}

/** A person's standing on the teams that name them. */
export interface MyTeams {
  /** Projects that added the person and wait for their yes or no. */
  invitations: TeamInvitation[];
  /** Projects whose team the person joined. */
  joined: LaunchRecord[];
  /** A read filled its bound: there may be more than is listed. */
  cut: boolean;
}

/**
 * The projects that name `me` on their team, and which of them still wait for an answer.
 *
 * Found from the project records carrying the person's `p` tag; each is then read again by its own id, because a
 * server that kept an older version of a record would otherwise show an invitation its founder took back. Projects
 * their founder removed are left out.
 */
async function readMyTeams(relay: string, me: string): Promise<MyTeams> {
  const naming = await queryEvents(relay, {
    kinds: [KIND_LAUNCH_RECORD],
    "#p": [me],
    limit: NAMING_LIMIT,
  });
  const wanted = new Map<string, { author: string; id: string }>();
  for (const event of naming) {
    const id = event.tags.find((tag) => tag[0] === "d")?.[1];
    if (id) wanted.set(`${event.pubkey}:${id}`, { author: event.pubkey, id });
  }
  if (wanted.size === 0)
    return { invitations: [], joined: [], cut: naming.length >= NAMING_LIMIT };
  const projects = [...wanted.values()];
  const coords = projects.map((p) => launchCoordinate(p.author, p.id));
  const [current, removals, mine] = await Promise.all([
    queryEvents(relay, {
      kinds: [KIND_LAUNCH_RECORD],
      authors: [...new Set(projects.map((p) => p.author))],
      "#d": [...new Set(projects.map((p) => p.id))],
      limit: 500,
    }),
    queryEvents(relay, { kinds: [5], "#a": coords, limit: 500 }),
    queryEvents(relay, {
      kinds: [KIND_LAUNCH_UPDATE],
      authors: [me],
      "#l": [TEAM_LABEL],
      limit: ANSWERS_LIMIT,
    }),
  ]);
  const removed = launchRemovals(removals);
  const newest = new Map<string, LaunchRecord>();
  for (const event of current) {
    const record = parseLaunchRecord(event);
    if (!record || !wanted.has(`${record.author}:${record.id}`)) continue;
    const at = removed.get(launchCoordinate(record.author, record.id));
    if (at !== undefined && record.createdAt <= at) continue;
    const was = newest.get(`${record.author}:${record.id}`);
    if (!was || record.createdAt >= was.createdAt)
      newest.set(`${record.author}:${record.id}`, record);
  }
  const answers = answersOf(mine).filter((a) => a.author === me);
  const invitations: TeamInvitation[] = [];
  const joined: LaunchRecord[] = [];
  for (const record of newest.values()) {
    const member = record.team.find((m) => m.pubkey === me);
    if (!member) continue;
    const state = memberState(
      member,
      launchCoordinate(record.author, record.id),
      answers,
    );
    if (state === "invited") invitations.push({ record, member });
    else if (state === "accepted") joined.push(record);
  }
  const byName = (a: LaunchRecord, b: LaunchRecord) =>
    a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);
  return {
    invitations: invitations.sort((a, b) => byName(a.record, b.record)),
    joined: joined.sort(byName),
    cut:
      naming.length >= NAMING_LIMIT ||
      current.length >= 500 ||
      removals.length >= 500 ||
      mine.length >= ANSWERS_LIMIT,
  };
}

/** The signed-in person's invitations and teams. Not read for a visitor. */
export function useMyTeams() {
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  return useQuery({
    queryKey: [...teamQueryKey, "mine", relay, me],
    queryFn: () => readMyTeams(relay, me as string),
    enabled: me !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
