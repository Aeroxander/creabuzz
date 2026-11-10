/**
 * What "Your projects" and Home's next step read: the projects a person started, helps and follows, how each stands,
 * and what in them needs the person now (`lib/project-state.ts`).
 *
 * Every read is bounded and by who signed the records: a project's state comes from what its team signed about it,
 * the steps of the helpers its tasks name, and the offers on its open requests; a person's tasks start from the steps
 * they signed themselves and the task records that name them. A read that hit its bound leaves the number it would
 * have given unknown, and the page says so. A failed read is a failure, never an empty list.
 *
 * No state is kept outside React and the query cache: nothing here outlives a change of community.
 */

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { projectProgress } from "@/features/feed/lib/project-progress";
import { useLaunchFollows } from "@/features/feed/use-launch-follows";
import { LAUNCH_UPDATE_LABEL } from "@/features/social/lib/launch-update";
import {
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
  KIND_TEXT_NOTE,
} from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { listedHere } from "./lib/contributor-only";
import { isGoalRecordTags } from "./lib/goals";
import { isHelpSignalTags, parseHelpSignal, teamOf } from "./lib/help-request";
import { launchRemovals } from "./lib/launch-removals";
import { raisesOffered } from "./lib/raises-offered";
import {
  type Need,
  orderNeeds,
  type ProjectState,
  projectState,
  stateNeeds,
  taskNeeds,
} from "./lib/project-state";
import { readPersonTasks } from "./lib/task-reads";
import {
  isTaskRecordTags,
  parseTaskRecord,
  projectTasks,
  TASK_LABEL,
  type TaskRecord,
  type TaskView,
} from "./lib/tasks";
import { isTeamAnswerTags } from "./lib/team";
import {
  launchCoordinate,
  type LaunchRecord,
  parseLaunchRecord,
  parseLaunchUpdate,
} from "./models";
import { helpQueryKey } from "./use-help-requests";
import { useRemovedLaunchIds } from "./use-launches";
import { useMyTeams } from "./use-team";

/** One read's bound. */
const PAGE = 500;
/** How many posts marked as updates are read for one project: enough to find its newest. */
const POSTS = 50;
/** The most team accounts, helpers and open requests one project's state is read for. */
const TEAM_READ = 20;
const HELPERS_READ = 50;
const REQUESTS_READ = 20;
/** The most projects a person started, follows or is offered a task on that are read here. */
const OWN_READ = 200;
const FOLLOWED_READ = 50;
const OFFERED_PROJECTS = 20;
/** How many projects' states Home's next step reads: each costs a few reads. */
export const NEXT_STEP_PROJECTS = 3;

type Read = (
  filter: Parameters<typeof queryEvents>[1],
) => Promise<NostrEvent[]>;

const tasksOf = (events: readonly NostrEvent[]): TaskRecord[] =>
  events.flatMap((event) => {
    if (event.kind !== KIND_LAUNCH_UPDATE) return [];
    const record = parseTaskRecord(event);
    return record ? [record] : [];
  });

/** The newest record of each project in `events`, by coordinate, leaving out the ones `removed` names. */
function newestRecords(
  events: readonly NostrEvent[],
  removed: ReadonlyMap<string, number> = new Map(),
): Map<string, LaunchRecord> {
  const out = new Map<string, LaunchRecord>();
  for (const event of events) {
    const record = parseLaunchRecord(event);
    if (!record) continue;
    const coordinate = launchCoordinate(record.author, record.id);
    const at = removed.get(coordinate);
    if (at !== undefined && record.createdAt <= at) continue;
    const was = out.get(coordinate);
    if (!was || record.createdAt >= was.createdAt) out.set(coordinate, record);
  }
  return out;
}

/** Project records by coordinate, in one bounded read, with their removals applied. */
async function readRecords(
  read: Read,
  coordinates: readonly string[],
): Promise<{ records: Map<string, LaunchRecord>; cut: boolean }> {
  const wanted = coordinates.flatMap((coordinate) => {
    const [kind, author, ...rest] = coordinate.split(":");
    const id = rest.join(":");
    return kind === String(KIND_LAUNCH_RECORD) && author && id
      ? [{ coordinate, author, id }]
      : [];
  });
  if (wanted.length === 0) return { records: new Map(), cut: false };
  const [events, removals] = await Promise.all([
    read({
      kinds: [KIND_LAUNCH_RECORD],
      authors: [...new Set(wanted.map((w) => w.author))],
      "#d": [...new Set(wanted.map((w) => w.id))],
      limit: PAGE,
    }),
    read({ kinds: [5], "#a": wanted.map((w) => w.coordinate), limit: PAGE }),
  ]);
  const all = newestRecords(events, launchRemovals(removals));
  const records = new Map<string, LaunchRecord>();
  for (const { coordinate } of wanted) {
    const record = all.get(coordinate);
    if (record) records.set(coordinate, record);
  }
  return {
    records,
    cut: events.length >= PAGE || removals.length >= PAGE,
  };
}

/** How one project stands for `viewer`, from a few bounded reads by who signed (see the file's note). */
export async function readProjectState(
  relay: string,
  record: LaunchRecord,
  viewer: string | null,
): Promise<ProjectState> {
  const read: Read = (filter) => queryEvents(relay, filter);
  const coordinate = launchCoordinate(record.author, record.id);
  const everyone = [...teamOf(record)];
  const team = everyone.slice(0, TEAM_READ);
  const [signed, posts] = await Promise.all([
    read({
      kinds: [KIND_LAUNCH_UPDATE],
      authors: team,
      "#a": [coordinate],
      limit: PAGE,
    }),
    read({
      kinds: [KIND_TEXT_NOTE],
      "#a": [coordinate],
      "#l": [LAUNCH_UPDATE_LABEL],
      limit: POSTS,
    }),
  ]);
  // What comes back is checked again: only what a team member signed about this project.
  const own = signed.filter(
    (event) =>
      team.includes(event.pubkey) &&
      event.tags.some((tag) => tag[0] === "a" && tag[1] === coordinate),
  );
  const updates = own.flatMap((event) => {
    if (
      isHelpSignalTags(event.tags) ||
      isGoalRecordTags(event.tags) ||
      isTaskRecordTags(event.tags) ||
      isTeamAnswerTags(event.tags)
    )
      return [];
    const update = parseLaunchUpdate(event);
    return update ? [update] : [];
  });
  const teamSignals = own.flatMap((event) => {
    const signal = parseHelpSignal(event);
    return signal ? [signal] : [];
  });
  const teamTasks = tasksOf(own);

  // The requests still open, by the team's own "Help found" marks, and the offers on them (anyone may offer).
  const found = new Set(
    teamSignals.filter((s) => s.kind === "found").map((s) => s.target),
  );
  const asking = updates
    .filter((update) => update.help && !found.has(update.id))
    .map((update) => update.id);
  const helpers = [
    ...new Set(
      teamTasks.flatMap((task) =>
        task.part === "task" && task.helper && !team.includes(task.helper)
          ? [task.helper]
          : [],
      ),
    ),
  ].sort();
  const [offers, helperSteps] = await Promise.all([
    asking.length > 0
      ? read({
          kinds: [KIND_LAUNCH_UPDATE],
          "#a": [coordinate],
          "#e": asking.slice(0, REQUESTS_READ),
          limit: PAGE,
        })
      : Promise.resolve([]),
    helpers.length > 0
      ? read({
          kinds: [KIND_LAUNCH_UPDATE],
          authors: helpers.slice(0, HELPERS_READ),
          "#a": [coordinate],
          "#l": [TASK_LABEL],
          limit: PAGE,
        })
      : Promise.resolve([]),
  ]);
  const offerSignals = offers.flatMap((event) => {
    const signal = parseHelpSignal(event);
    return signal && signal.kind === "offer" ? [signal] : [];
  });
  const progress = projectProgress([{ record, updates }], posts).filter(
    (item) => !item.evidence,
  );
  const latestAt = progress[0]?.at ?? null;
  const postsCut = posts.length >= POSTS;
  const oldestPost =
    posts.length > 0 ? Math.min(...posts.map((p) => p.created_at)) : null;
  return projectState({
    coordinate,
    founder: record.author,
    team: new Set(everyone),
    updates,
    latestAt,
    signals: [...teamSignals, ...offerSignals],
    tasks: [
      ...teamTasks,
      ...tasksOf(helperSteps).filter((r) => helpers.includes(r.author)),
    ],
    complete: {
      team: signed.length < PAGE && everyone.length <= TEAM_READ,
      offers: offers.length < PAGE && asking.length <= REQUESTS_READ,
      helpers: helperSteps.length < PAGE && helpers.length <= HELPERS_READ,
      // A marked post older than the oldest one read may exist when that read was cut: then the newest update known
      // is the newest only if it is not older than that.
      posts:
        !postsCut ||
        (latestAt !== null && oldestPost !== null && latestAt >= oldestPost),
    },
    viewer,
    now: Math.floor(Date.now() / 1000),
  });
}

const stateKey = (relay: string, record: LaunchRecord, me: string | null) => [
  ...helpQueryKey,
  "state",
  relay,
  launchCoordinate(record.author, record.id),
  // The team decides whose records are read.
  record.eventId,
  me,
];

const stateQuery = (
  relay: string,
  record: LaunchRecord,
  me: string | null,
) => ({
  queryKey: stateKey(relay, record, me),
  queryFn: () => readProjectState(relay, record, me),
  staleTime: 30_000,
  refetchOnWindowFocus: false,
});

/** One project's state, for a card. */
export function useProjectState(record: LaunchRecord) {
  const me = existingUserPubkey();
  return useQuery(stateQuery(relayWsUrl(), record, me));
}

export interface MyTasksOnProject {
  coordinate: string;
  /** The project, when its record could be read. */
  record: LaunchRecord | null;
  tasks: TaskView[];
}

/**
 * The signed-in person's own tasks, by project: the ones they took on (found from the steps they signed) and the ones
 * given to them that wait for their yes (found from the task records that name them).
 */
export function useMyTasks() {
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  return useQuery({
    queryKey: ["launchpad", "tasks", "mine", relay, me],
    enabled: me !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<{
      projects: MyTasksOnProject[];
      complete: boolean;
    }> => {
      const person = me as string;
      const read: Read = (filter) => queryEvents(relay, filter);
      const [signed, naming] = await Promise.all([
        readPersonTasks(read, person, (event) => {
          const record = parseLaunchRecord(event);
          return record
            ? {
                coordinate: launchCoordinate(record.author, record.id),
                team: [...teamOf(record)],
              }
            : null;
        }),
        read({
          kinds: [KIND_LAUNCH_UPDATE],
          "#p": [person],
          "#l": [TASK_LABEL],
          limit: PAGE,
        }),
      ]);
      const records = newestRecords(signed.projects);
      const all = tasksOf([...signed.events, ...naming]);
      const coordinates = [
        ...new Set(
          all
            .filter((r) => r.part === "task" && r.helper === person)
            .map((r) => r.coordinate),
        ),
      ].sort();
      const unread = coordinates.filter((c) => !records.has(c));
      const more = await readRecords(read, unread.slice(0, OFFERED_PROJECTS));
      for (const [coordinate, record] of more.records)
        records.set(coordinate, record);
      const now = Math.floor(Date.now() / 1000);
      return {
        projects: coordinates.flatMap((coordinate) => {
          const record = records.get(coordinate) ?? null;
          // Without the project's record its team is not known, and only its team makes its tasks: nothing is said.
          if (!record) return [];
          const tasks = projectTasks({
            records: all,
            coordinate,
            team: teamOf(record),
            now,
          }).filter((task) => task.helper === person);
          return tasks.length > 0 ? [{ coordinate, record, tasks }] : [];
        }),
        complete:
          signed.complete &&
          !signed.tooManyProjects &&
          naming.length < PAGE &&
          unread.length <= OFFERED_PROJECTS &&
          !more.cut,
      };
    },
  });
}

/** A person's projects, by what ties them to each. A project is in the first group that fits. */
export interface MyProjects {
  started: LaunchRecord[];
  /** On the team (they said yes), or with a task of their own on it. */
  helping: Array<{ record: LaunchRecord; tasks: TaskView[] }>;
  following: LaunchRecord[];
  /** Projects that added the person to their team and wait for a yes or no. */
  invitations: LaunchRecord[];
}

/**
 * The signed-in person's projects. `ready` once every list was read; `failed` when one could not be (with `retry`);
 * `cut` when a list hit its bound, so "that is all of them" must not be said.
 */
export function useMyProjects() {
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  const follows = useLaunchFollows();
  const removed = useRemovedLaunchIds(me);
  const teams = useMyTeams();
  const tasks = useMyTasks();
  const own = useQuery({
    queryKey: ["launchpad", "launches", "own-records", relay, me],
    enabled: me !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const events = await queryEvents(relay, {
        kinds: [KIND_LAUNCH_RECORD],
        authors: [me as string],
        limit: OWN_READ,
      });
      return {
        events: events.filter((event) => event.pubkey === me),
        cut: events.length >= OWN_READ,
      };
    },
  });
  const followed = useMemo(
    () => [...follows.followed].sort().slice(0, FOLLOWED_READ),
    [follows.followed],
  );
  const following = useQuery({
    queryKey: ["launchpad", "launches", "followed-records", relay, followed],
    enabled: me !== null && follows.ready,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      readRecords((filter) => queryEvents(relay, filter), followed),
  });

  const data = useMemo((): MyProjects | null => {
    if (!me || !own.data || !removed.data || !teams.data || !tasks.data)
      return null;
    if (!following.data) return null;
    const gone = new Set(removed.data);
    const started = [...newestRecords(own.data.events).values()]
      .filter((record) => !gone.has(record.id))
      .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
    const seen = new Set(started.map((r) => launchCoordinate(r.author, r.id)));
    const helping = new Map<
      string,
      { record: LaunchRecord; tasks: TaskView[] }
    >();
    for (const record of teams.data.joined) {
      const coordinate = launchCoordinate(record.author, record.id);
      if (!seen.has(coordinate)) helping.set(coordinate, { record, tasks: [] });
    }
    for (const { coordinate, record, tasks: mine } of tasks.data.projects) {
      if (!record || seen.has(coordinate)) continue;
      helping.set(coordinate, {
        record: helping.get(coordinate)?.record ?? record,
        tasks: mine,
      });
    }
    for (const coordinate of helping.keys()) seen.add(coordinate);
    // A contributor-only build never lists a raise, even one followed elsewhere.
    const raises = raisesOffered();
    const followedRecords = [...following.data.records]
      .filter(
        ([coordinate, record]) =>
          !seen.has(coordinate) && listedHere(record, raises),
      )
      .map(([, record]) => record)
      .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
    return {
      started,
      helping: [...helping.values()].sort(
        (a, b) =>
          a.record.name.localeCompare(b.record.name) ||
          (a.record.id < b.record.id ? -1 : 1),
      ),
      following: followedRecords,
      invitations: teams.data.invitations.map((i) => i.record),
    };
  }, [me, own.data, removed.data, teams.data, tasks.data, following.data]);

  const reads = [own, removed, teams, tasks, following];
  return {
    data,
    /** The person's own tasks on the projects they started, too (a founder can be their own helper). */
    myTasks: tasks.data?.projects ?? [],
    failed: data === null && reads.some((r) => r.isError),
    cut:
      Boolean(own.data?.cut) ||
      Boolean(teams.data?.cut) ||
      Boolean(following.data?.cut) ||
      (tasks.data ? !tasks.data.complete : false) ||
      follows.followed.size > FOLLOWED_READ,
    retry: () => {
      for (const r of reads) if (r.isError) void r.refetch();
    },
  };
}

/**
 * What needs the signed-in person now, across their projects, in the order to meet it (`orderNeeds`), with each
 * project's name. Reads the state of at most {@link NEXT_STEP_PROJECTS} projects they act for (started or joined);
 * `moreProjects` says there are others whose state was not read here.
 */
export function useMyNeeds() {
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  const mine = useMyProjects();
  const acted = useMemo(
    () =>
      mine.data
        ? [
            ...mine.data.started,
            ...mine.data.helping
              .filter((h) => h.record.team.some((m) => m.pubkey === me))
              .map((h) => h.record),
          ]
        : [],
    [mine.data, me],
  );
  const states = useQueries({
    queries: acted
      .slice(0, NEXT_STEP_PROJECTS)
      .map((record) => stateQuery(relay, record, me)),
  });
  const stateData = states.map((s) => s.data);
  // One word for "any of the states was read again": `states` is a new array on every render.
  const stamp = states.map((s) => s.dataUpdatedAt).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` stands for the states' contents
  const needs = useMemo((): Array<{ need: Need; project: LaunchRecord }> => {
    if (!me || !mine.data) return [];
    const projects = new Map<string, LaunchRecord>();
    for (const record of [
      ...mine.data.started,
      ...mine.data.helping.map((h) => h.record),
      ...mine.data.invitations,
    ])
      projects.set(launchCoordinate(record.author, record.id), record);
    const now = Math.floor(Date.now() / 1000);
    const all: Need[] = [
      ...stateData.flatMap((state) => (state ? stateNeeds(state) : [])),
      ...mine.myTasks.flatMap(({ tasks }) => taskNeeds(tasks, me, now)),
      ...mine.data.invitations.map(
        (record): Need => ({
          kind: "invitation",
          coordinate: launchCoordinate(record.author, record.id),
        }),
      ),
    ];
    for (const { record } of mine.myTasks)
      if (record)
        projects.set(launchCoordinate(record.author, record.id), record);
    return orderNeeds(all).flatMap((need) => {
      const project = projects.get(need.coordinate);
      return project ? [{ need, project }] : [];
    });
  }, [me, mine.data, mine.myTasks, stamp]);
  return {
    needs,
    /** Nothing ties the person to any project yet. */
    noProject:
      mine.data !== null &&
      mine.data.started.length === 0 &&
      mine.data.helping.length === 0 &&
      mine.data.invitations.length === 0,
    ready: mine.data !== null && states.every((s) => !s.isLoading),
    failed: mine.failed || states.some((s) => s.isError && !s.data),
    /** There is more than was read: nothing here may be read as "that is everything". */
    partial: mine.cut || acted.length > NEXT_STEP_PROJECTS,
    retry: () => {
      mine.retry();
      for (const s of states) if (s.isError) void s.refetch();
    },
  };
}
