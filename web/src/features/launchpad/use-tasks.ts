/**
 * Reading and sending tasks (`lib/tasks.ts`): a project's tasks, each step a person can take on one, the notices
 * those steps make, and a person's track record.
 *
 * Task records carry their own label, so they are read on their own: a project's by its `a` tag, a person's by `p`
 * and by author. Every read is paged up to a bound and says when it did not reach the end; nothing cut short is
 * shown as the whole story.
 *
 * A step is signed once and kept in the browser's storage before it is sent (`lib/send-once.ts`), so a send whose
 * answer was lost is carried on, not made twice. No state is kept outside React, the query cache and that storage,
 * which is keyed by server: nothing here outlives a change of community.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
} from "@/shared/constants/kinds";
import { existingUserPubkey, signAsUser } from "@/shared/lib/identity";
import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  EVIDENCE_QUERY_LIMIT,
  readAuthorUpdates,
  readPaged,
} from "./lib/evidence-query";
import { isGoalRecordTags } from "./lib/goals";
import { isHelpSignalTags, parseHelpSignal, teamOf } from "./lib/help-request";
import {
  deletionsFilter,
  type RemovedRecords,
  removedRecords,
} from "./lib/removed-records";
import { sendOnce, type SendStore } from "./lib/send-once";
import { type TaskNotice, taskNotices } from "./lib/task-notices";
import {
  isTaskRecordTags,
  parseTaskRecord,
  projectTasks,
  TASK_LABEL,
  type TaskEvent,
  type TaskFile,
  type TaskRecord,
  type TaskView,
  taskEvent,
  taskStepEvent,
} from "./lib/tasks";
import {
  type FounderRecord,
  founderRecord,
  type HelperRecord,
  helperRecord,
} from "./lib/track-record";
import type { HelpSize } from "./lib/weekly-update";
import {
  launchCoordinate,
  type Launch,
  parseLaunchRecord,
  parseLaunchUpdate,
} from "./models";
import { helpQueryKey } from "./use-help-requests";
import { useLaunches } from "./use-launches";

type Project = Launch["record"];

/** Every task read is cached under this, so one send refreshes the page, the notices and a profile. */
const tasksQueryKey = ["launchpad", "tasks"] as const;

/** How many records are asked for by id in one read. */
const BY_ID_CHUNK = 200;
/** How many task records naming the viewer Notifications reads. */
const NOTICE_READ_LIMIT = 200;
/** How many team members one step names, so each is told: the task's maker first, then the founder and the rest. */
const TEAM_TOLD = 12;
/** How many projects a track record reads the team of. */
const TRACK_PROJECTS = 40;

const read = (filter: Parameters<typeof queryEvents>[1]) =>
  queryEvents(relayWsUrl(), filter);

function taskRecordsOf(events: readonly NostrEvent[]): TaskRecord[] {
  return events.flatMap((event) => {
    if (event.kind !== KIND_LAUNCH_UPDATE) return [];
    const record = parseTaskRecord(event);
    return record ? [record] : [];
  });
}

/** Update records by id, a bounded chunk at a time. */
async function readByIds(ids: readonly string[]): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  for (let i = 0; i < ids.length; i += BY_ID_CHUNK) {
    const chunk = ids.slice(i, i + BY_ID_CHUNK);
    out.push(
      ...(await read({
        kinds: [KIND_LAUNCH_UPDATE],
        ids: chunk,
        limit: chunk.length,
      })),
    );
  }
  return out;
}

/** Who signed each offer the tasks name, for the offers still on the server. */
async function readOffers(
  records: readonly TaskRecord[],
): Promise<Array<[string, string]>> {
  const ids = [
    ...new Set(records.flatMap((record) => record.offerId ?? [])),
  ].slice(0, BY_ID_CHUNK * 5);
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  return (await readByIds(ids)).flatMap((event): Array<[string, string]> => {
    // What comes back is checked again: only an offer, and only one that was asked for.
    if (!wanted.has(event.id)) return [];
    return parseHelpSignal(event)?.kind === "offer"
      ? [[event.id, event.pubkey]]
      : [];
  });
}

interface ProjectTasksRead {
  records: TaskRecord[];
  offers: Array<[string, string]>;
  /** The project's task records were read to the end. */
  complete: boolean;
}

/**
 * One project's tasks, read for that project alone. `tasks` is null until the read answers; `complete` is false when
 * the project has more task records than could be read, and the page then says a task or a step may be missing.
 */
export function useProjectTasks(project: Project): {
  tasks: TaskView[] | null;
  complete: boolean;
  failed: boolean;
  stale: boolean;
  fetching: boolean;
  retry: () => void;
} {
  const coordinate = launchCoordinate(project.author, project.id);
  const relay = relayWsUrl();
  const query = useQuery({
    queryKey: [...tasksQueryKey, "project", relay, coordinate],
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<ProjectTasksRead> => {
      const page = await readPaged(read, () => ({
        kinds: [KIND_LAUNCH_UPDATE],
        "#a": [coordinate],
        "#l": [TASK_LABEL],
        limit: EVIDENCE_QUERY_LIMIT,
      }));
      const records = taskRecordsOf(page.events);
      return {
        records,
        offers: await readOffers(records),
        complete: page.complete,
      };
    },
  });
  const { data, refetch } = query;
  const tasks = useMemo(() => {
    if (!data) return null;
    return projectTasks({
      records: data.records,
      coordinate,
      team: teamOf(project),
      offers: new Map(data.offers),
      now: Math.floor(Date.now() / 1000),
    });
  }, [data, coordinate, project]);
  return {
    tasks,
    complete: data?.complete ?? false,
    failed: query.isError && !data,
    stale: query.isError && Boolean(data),
    fetching: query.isFetching,
    retry: () => void refetch(),
  };
}

/** How many team members (besides the founder) have their removals read for one project. */
const TEAM_REMOVALS_READ = 5;

export interface TeamRemovals {
  /** Each team member read who has removed something, or whose removals could not all be read. */
  members: Array<{ pubkey: string; removed: RemovedRecords }>;
  /** Team members whose removals were not read at all (the team is larger than is read here). */
  unchecked: number;
}

/**
 * The update records a project's other team members have deleted. A team member can delete a confirmation, a
 * send-back or a task they signed, and the server then stops serving it: the page cannot show what is gone, so it
 * says how many each has removed. (The founder's own removals are read with the project's record.) Read by author,
 * a page at a time; a count is of that person's removals on this server, whatever project they were about.
 */
export function useTeamRemovals(project: Project): TeamRemovals | null {
  const relay = relayWsUrl();
  const members = useMemo(
    () => [...teamOf(project)].filter((m) => m !== project.author).sort(),
    [project],
  );
  const data = useQuery({
    queryKey: [...tasksQueryKey, "removals", relay, members],
    enabled: members.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () =>
      Promise.all(
        members.slice(0, TEAM_REMOVALS_READ).map(async (pubkey) => {
          const page = await readPaged(read, () => deletionsFilter(pubkey));
          return {
            pubkey,
            removed: removedRecords(page.events, pubkey, page.complete),
          };
        }),
      ),
  }).data;
  return useMemo(
    () =>
      data
        ? {
            members: data.filter(
              ({ removed }) =>
                removed.count + removed.unnamed > 0 || !removed.complete,
            ),
            unchecked: Math.max(0, members.length - TEAM_REMOVALS_READ),
          }
        : null,
    [data, members],
  );
}

/** The browser's storage, under a name that holds the server: another community's kept sends are never found. */
function sendStore(): SendStore {
  const prefix = `creaton.task-send.v1:${relayWsUrl()}:`;
  return {
    get: (key) => localStorage.getItem(prefix + key),
    set: (key, value) => localStorage.setItem(prefix + key, value),
    remove: (key) => localStorage.removeItem(prefix + key),
  };
}

/** Thrown when the work a confirmation or a send-back names is no longer on the server. */
export class EvidenceGoneError extends Error {
  constructor() {
    super("evidence gone");
    this.name = "EvidenceGoneError";
  }
}

export interface TaskSent {
  /** An earlier try had already gone through, so nothing new was sent. */
  adopted: boolean;
  /** That earlier try was made with different words than these. */
  changed: boolean;
}

async function sendTaskRecord(
  project: Pick<Project, "author" | "id">,
  key: string,
  event: TaskEvent,
): Promise<TaskSent> {
  const me = existingUserPubkey();
  if (!me) throw new Error("Sign in first.");
  const relay = relayWsUrl();
  const coordinate = launchCoordinate(project.author, project.id);
  const { adopted, changed } = await sendOnce({
    key: `${coordinate}:${key}`,
    signer: me,
    template: {
      kind: KIND_LAUNCH_UPDATE,
      tags: [["a", coordinate], ...event.tags],
      content: JSON.stringify(event.content),
    },
    store: sendStore(),
    sign: (template) => signAsUser(template),
    publish: (signed) => publishEvent(relay, signed, { signAuth: signAsUser }),
    exists: async (id) =>
      (await readByIds([id])).some((found) => found.id === id),
  });
  return { adopted, changed };
}

type TaskRef = Pick<TaskView, "id" | "helper" | "madeBy">;

/** What a person can send about a task. Each is its own mutation, so one failing or pending never hides another. */
export function useTaskActions(project: Project) {
  const queryClient = useQueryClient();
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    void queryClient.invalidateQueries({ queryKey: helpQueryKey });
  };
  const options = { onSuccess: settle, onError: settle };
  /** The people a helper's step is for: whoever made the task and the rest of the team, so any of them can check. */
  const toTeam = (task: TaskRef) =>
    [task.madeBy, ...teamOf(project)].slice(0, TEAM_TOLD);
  /** The people a team's step is for: the helper, and whoever made the task. */
  const toHelper = (task: TaskRef) => [task.helper, task.madeBy];
  const step = (
    task: TaskRef,
    key: string,
    input: Omit<Parameters<typeof taskStepEvent>[0], "taskId" | "tell">,
    tell: readonly string[],
  ) => {
    const me = existingUserPubkey();
    return sendTaskRecord(
      project,
      key,
      taskStepEvent({
        ...input,
        taskId: task.id,
        tell: tell.filter((who) => who !== me),
      }),
    );
  };
  /** Asks the server whether a piece of work is still there before the team answers it. */
  const stillThere = async (evidenceId: string) => {
    if (!(await readByIds([evidenceId])).some((e) => e.id === evidenceId))
      throw new EvidenceGoneError();
  };

  const make = useMutation({
    mutationFn: (input: {
      helper: string;
      what: string;
      done: string;
      size: HelpSize;
      due: string | null;
      updateId?: string | null;
      offerId?: string | null;
    }) =>
      sendTaskRecord(
        project,
        input.offerId ? `make:${input.offerId}` : "make:direct",
        taskEvent(input),
      ),
    ...options,
  });
  const accept = useMutation({
    mutationFn: (task: TaskRef) =>
      step(task, `accept:${task.id}`, { part: "accept" }, toTeam(task)),
    ...options,
  });
  const evidence = useMutation({
    mutationFn: (input: {
      task: TaskRef;
      note: string;
      links: readonly string[];
      files: readonly TaskFile[];
    }) =>
      step(
        input.task,
        `evidence:${input.task.id}`,
        {
          part: "evidence",
          note: input.note,
          links: input.links,
          files: input.files,
        },
        toTeam(input.task),
      ),
    ...options,
  });
  const sendBack = useMutation({
    mutationFn: async (input: {
      task: TaskRef;
      evidenceId: string;
      note: string;
    }) => {
      await stillThere(input.evidenceId);
      return step(
        input.task,
        `send-back:${input.evidenceId}`,
        { part: "send-back", evidenceId: input.evidenceId, note: input.note },
        toHelper(input.task),
      );
    },
    ...options,
  });
  const confirm = useMutation({
    mutationFn: async (input: { task: TaskRef; evidenceId: string }) => {
      await stillThere(input.evidenceId);
      return step(
        input.task,
        `confirm:${input.evidenceId}`,
        { part: "confirm", evidenceId: input.evidenceId },
        toHelper(input.task),
      );
    },
    ...options,
  });
  const moreTime = useMutation({
    mutationFn: (input: { task: TaskRef; note: string; due: string | null }) =>
      step(
        input.task,
        `more-time:${input.task.id}`,
        { part: "more-time", note: input.note, due: input.due },
        toTeam(input.task),
      ),
    ...options,
  });
  const grant = useMutation({
    mutationFn: (input: { task: TaskRef; askId: string; due: string }) =>
      step(
        input.task,
        `grant:${input.askId}`,
        { part: "grant", askId: input.askId, due: input.due },
        toHelper(input.task),
      ),
    ...options,
  });
  const giveUp = useMutation({
    mutationFn: (input: { task: TaskRef; note: string }) =>
      step(
        input.task,
        `give-up:${input.task.id}`,
        { part: "give-up", note: input.note },
        toTeam(input.task),
      ),
    ...options,
  });
  const cancel = useMutation({
    mutationFn: (input: { task: TaskRef; note: string }) =>
      step(
        input.task,
        `cancel:${input.task.id}`,
        { part: "cancel", note: input.note },
        toHelper(input.task),
      ),
    ...options,
  });
  return {
    make,
    accept,
    evidence,
    sendBack,
    confirm,
    moreTime,
    grant,
    giveUp,
    cancel,
  };
}

const NO_NOTICES: TaskNotice[] = [];

/**
 * Task steps that need the viewer or answer them, newest first: the task records that name the viewer, read on their
 * own, with the tasks they are about. People in `muted` are left out before the list is cut.
 */
export function useTaskNotices(muted?: ReadonlySet<string>): TaskNotice[] {
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  const launches = useLaunches().data;
  const data = useQuery({
    queryKey: [...tasksQueryKey, "notices", relay, me],
    enabled: me !== null,
    staleTime: 30_000,
    // The server does not push records by who they name, so polling is how these arrive.
    refetchInterval: 60_000,
    queryFn: async () => {
      const naming = taskRecordsOf(
        await read({
          kinds: [KIND_LAUNCH_UPDATE],
          "#p": [me as string],
          "#l": [TASK_LABEL],
          limit: NOTICE_READ_LIMIT,
        }),
      );
      const have = new Set(
        naming.filter((r) => r.part === "task").map((r) => r.id),
      );
      const missing = [
        ...new Set(
          naming.filter((r) => !have.has(r.taskId)).map((r) => r.taskId),
        ),
      ].slice(0, BY_ID_CHUNK);
      return {
        naming,
        tasks:
          missing.length > 0 ? taskRecordsOf(await readByIds(missing)) : [],
      };
    },
  }).data;
  return useMemo(
    () =>
      me && launches && data
        ? taskNotices({
            ...data,
            projects: launches.map((launch) => launch.record),
            viewer: me,
            muted,
            now: Math.floor(Date.now() / 1000),
          })
        : NO_NOTICES,
    [me, launches, data, muted],
  );
}

export interface TrackRecord {
  helper: HelperRecord;
  founder: FounderRecord;
  removed: RemovedRecords;
  /** The task records that name the person, and the person's own records, were each read to the end. */
  complete: boolean;
  /** Project names, by coordinate, for the projects that were read. */
  projects: Record<string, { id: string; author: string; name: string }>;
}

/**
 * One person's track record: read by who they are named by (`p`) and by what they signed, a page at a time, with the
 * record of each project their tasks name (for its team). `complete` false means the numbers must not be stated.
 */
export function useTrackRecord(person: string, enabled = true) {
  const relay = relayWsUrl();
  return useQuery({
    queryKey: [...tasksQueryKey, "person", relay, person],
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<TrackRecord> => {
      const [naming, own, deletions] = await Promise.all([
        readPaged(read, () => ({
          kinds: [KIND_LAUNCH_UPDATE],
          "#p": [person],
          "#l": [TASK_LABEL],
          limit: EVIDENCE_QUERY_LIMIT,
        })),
        readAuthorUpdates(read, person),
        readPaged(read, () => deletionsFilter(person)),
      ]);
      const mine = own.events.filter((event) => event.pubkey === person);
      const records = taskRecordsOf([...naming.events, ...mine]);
      // The projects the person's tasks name: each one's own record says who is on its team.
      const coordinates = [
        ...new Set(
          records
            .filter((r) => r.part === "task" && r.helper === person)
            .map((r) => r.coordinate),
        ),
      ]
        .sort()
        .slice(0, TRACK_PROJECTS);
      const wanted = coordinates.flatMap((coordinate) => {
        const [kind, author, ...rest] = coordinate.split(":");
        const id = rest.join(":");
        return kind === String(KIND_LAUNCH_RECORD) && author && id
          ? [{ coordinate, author, id }]
          : [];
      });
      const teams = new Map<string, Set<string>>();
      const projects: TrackRecord["projects"] = {};
      if (wanted.length > 0) {
        const found = await read({
          kinds: [KIND_LAUNCH_RECORD],
          authors: [...new Set(wanted.map((w) => w.author))],
          "#d": [...new Set(wanted.map((w) => w.id))],
          limit: EVIDENCE_QUERY_LIMIT,
        });
        const newest = new Map<string, Project>();
        for (const event of found) {
          const record = parseLaunchRecord(event);
          if (!record) continue;
          const coordinate = launchCoordinate(record.author, record.id);
          const prev = newest.get(coordinate);
          if (!prev || record.createdAt > prev.createdAt)
            newest.set(coordinate, record);
        }
        for (const { coordinate } of wanted) {
          const record = newest.get(coordinate);
          if (!record) continue;
          teams.set(coordinate, teamOf(record));
          projects[coordinate] = {
            id: record.id,
            author: record.author,
            name: record.name,
          };
        }
      }
      const updates = mine.flatMap((event) => {
        if (
          isHelpSignalTags(event.tags) ||
          isGoalRecordTags(event.tags) ||
          isTaskRecordTags(event.tags)
        )
          return [];
        const update = parseLaunchUpdate(event);
        return update ? [update] : [];
      });
      return {
        helper: helperRecord({
          person,
          records,
          teams,
          offers: new Map(await readOffers(records)),
          now: Math.floor(Date.now() / 1000),
        }),
        founder: founderRecord(person, updates),
        removed: removedRecords(deletions.events, person, deletions.complete),
        complete: naming.complete && own.complete,
        projects,
      };
    },
  });
}
