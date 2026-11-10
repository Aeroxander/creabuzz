/**
 * Reading and sending tasks (`lib/tasks.ts`): a project's tasks, each step a person can take on one, the notices
 * those steps make, and a person's track record.
 *
 * Task records are read by who signed them (`lib/task-reads.ts`): a project's from its team and the helpers its tasks
 * name, a person's from the steps they signed. A read by tag alone could be filled with a stranger's junk. Every
 * read is paged up to a bound and says when it did not reach the end; nothing cut short is shown as the whole story.
 *
 * A step is signed once and kept in the browser's storage before it is sent (`lib/send-once.ts`), so a send whose
 * answer was lost is carried on, not made twice. No state is kept outside React, the query cache and that storage,
 * which is keyed by server: nothing here outlives a change of community.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
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
import { agentClaim, verifiedAgent } from "./lib/agent-label";
import { isHelpSignalTags, teamOf } from "./lib/help-request";
import {
  deletionsFilter,
  type RemovedRecords,
  removedRecords,
} from "./lib/removed-records";
import { sendOnce, type SendStore } from "./lib/send-once";
import {
  nextFirstSeen,
  type TaskNotice,
  taskNotices,
} from "./lib/task-notices";
import { readPersonTasks, readProjectTasks } from "./lib/task-reads";
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
/** How many team members one step names, so each is told: the task's maker first, then the founder and the rest. */
const TEAM_TOLD = 12;

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

interface ProjectTasksRead {
  records: TaskRecord[];
  /** Everything that is counted (the team's and the helpers' records) was read to the end. */
  complete: boolean;
  /** Answers from people who are not on the team could not all be read. They are never counted. */
  othersCut: boolean;
}

/**
 * One project's tasks, read for that project alone and by who signed them (`lib/task-reads.ts`). `tasks` is null
 * until the read answers; `complete` is false when there is more than could be read, and the page then says a task
 * or a step may be missing.
 */
export function useProjectTasks(project: Project): {
  tasks: TaskView[] | null;
  complete: boolean;
  othersCut: boolean;
  failed: boolean;
  stale: boolean;
  fetching: boolean;
  retry: () => void;
} {
  const coordinate = launchCoordinate(project.author, project.id);
  const relay = relayWsUrl();
  const team = useMemo(() => [...teamOf(project)], [project]);
  const query = useQuery({
    queryKey: [...tasksQueryKey, "project", relay, coordinate, team],
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<ProjectTasksRead> => {
      const got = await readProjectTasks(read, { coordinate, team });
      return {
        records: taskRecordsOf(got.events),
        complete: got.complete,
        othersCut: got.othersCut,
      };
    },
  });
  const { data, refetch } = query;
  const tasks = useMemo(() => {
    if (!data) return null;
    return projectTasks({
      records: data.records,
      coordinate,
      team: new Set(team),
      now: Math.floor(Date.now() / 1000),
    });
  }, [data, coordinate, team]);
  return {
    tasks,
    complete: data?.complete ?? false,
    othersCut: data?.othersCut ?? false,
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

/** Thrown when more work was handed in on a task than the person answering has been shown. */
export class EvidenceChangedError extends Error {
  constructor() {
    super("evidence changed");
    this.name = "EvidenceChangedError";
  }
}

export interface TaskSent {
  /** An earlier try with these same words had already gone through, so nothing new was sent. */
  adopted: boolean;
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
  const { adopted } = await sendOnce({
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
  return { adopted };
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
  /**
   * Before the team answers a piece of work, the server is asked what the helper has handed in on the task now. The
   * piece must still be there, and nothing may have been handed in that the person answering has not been shown
   * (`seen`): an answer is to the work that was read, never to work that arrived meanwhile.
   */
  const stillAsRead = async (input: {
    task: TaskRef;
    evidenceId: string;
    seen: readonly string[];
  }) => {
    const now = taskRecordsOf(
      await read({
        kinds: [KIND_LAUNCH_UPDATE],
        authors: [input.task.helper],
        "#e": [input.task.id],
        "#l": [TASK_LABEL],
        limit: EVIDENCE_QUERY_LIMIT,
      }),
    ).filter(
      (r) =>
        r.part === "evidence" &&
        r.taskId === input.task.id &&
        r.author === input.task.helper,
    );
    if (!now.some((r) => r.id === input.evidenceId))
      throw new EvidenceGoneError();
    if (now.some((r) => !input.seen.includes(r.id)))
      throw new EvidenceChangedError();
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
      /** Every piece of work that was on the page when the answer was written. */
      seen: readonly string[];
      note: string;
    }) => {
      await stillAsRead(input);
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
    mutationFn: async (input: {
      task: TaskRef;
      evidenceId: string;
      /** Every piece of work that was on the page when the box was opened. */
      seen: readonly string[];
    }) => {
      await stillAsRead(input);
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

/** Where this browser keeps when it first saw each task notice: per server and account. */
const seenKey = (relay: string, me: string) =>
  `creaton.task-notices.seen.v1:${relay}:${me}`;

function readFirstSeen(key: string): Map<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (Array.isArray(raw))
      return new Map(
        raw.filter(
          (entry): entry is [string, number] =>
            Array.isArray(entry) &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "number",
        ),
      );
  } catch {
    // Unreadable: as if nothing was seen before.
  }
  return new Map();
}

/**
 * Task steps that need the viewer or answer them, newest first: the task records that name the viewer, read a page
 * at a time, with the tasks they are about. People in `muted` are left out before the list is cut. `cut` says the
 * records naming the viewer could not all be read (anyone can sign a record that names someone), so older notices
 * may be missing.
 */
export function useTaskNotices(muted?: ReadonlySet<string>): {
  notices: TaskNotice[];
  cut: boolean;
} {
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
      const page = await readPaged(read, () => ({
        kinds: [KIND_LAUNCH_UPDATE],
        "#p": [me as string],
        "#l": [TASK_LABEL],
        limit: EVIDENCE_QUERY_LIMIT,
      }));
      const naming = taskRecordsOf(page.events);
      const have = new Set(
        naming.filter((r) => r.part === "task").map((r) => r.id),
      );
      const missing = [
        ...new Set(
          naming.filter((r) => !have.has(r.taskId)).map((r) => r.taskId),
        ),
      ];
      return {
        naming,
        tasks:
          missing.length > 0
            ? taskRecordsOf(await readByIds(missing.slice(0, BY_ID_CHUNK)))
            : [],
        cut: !page.complete || missing.length > BY_ID_CHUNK,
      };
    },
  }).data;
  const storeKey = me ? seenKey(relay, me) : null;
  const notices = useMemo(
    () =>
      me && launches && data && storeKey
        ? taskNotices({
            naming: data.naming,
            tasks: data.tasks,
            projects: launches.map((launch) => launch.record),
            viewer: me,
            muted,
            now: Math.floor(Date.now() / 1000),
            firstSeen: readFirstSeen(storeKey),
          })
        : NO_NOTICES,
    [me, launches, data, muted, storeKey],
  );
  // Remember when each was first seen, so a record's own date can never date its notice later than that.
  useEffect(() => {
    if (!storeKey || notices.length === 0) return;
    const next = nextFirstSeen(
      readFirstSeen(storeKey),
      notices.map((notice) => notice.id),
      Math.floor(Date.now() / 1000),
    );
    if (!next) return;
    try {
      localStorage.setItem(storeKey, JSON.stringify([...next]));
    } catch {
      // Storage full or blocked: the notices still show, dated by now.
    }
  }, [storeKey, notices]);
  return { notices, cut: data?.cut ?? false };
}

/** How many of a person's own proofs of who runs them are checked, and how many owners' removals are read. */
const OWNER_PROOFS_CHECKED = 3;
const OWNERS_READ = 2;

export interface TrackRecord {
  helper: HelperRecord;
  founder: FounderRecord;
  removed: RemovedRecords;
  /** For an agent account: the removals of each person proven to run it. They can remove the agent's records. */
  ownersRemoved: Array<{ pubkey: string; removed: RemovedRecords }>;
  /** Everything the helper's numbers rest on was read to the end. */
  helperComplete: boolean;
  /** The person's tasks name more projects than are read here. */
  tooManyProjects: boolean;
  /** The person's own update records were read to the end (what the founder's numbers rest on). */
  founderComplete: boolean;
  /** Answers by people who are not on the teams could not all be read. They are never counted. */
  othersCut: boolean;
  /** Project names, by coordinate, for the projects that were read. */
  projects: Record<string, { id: string; author: string; name: string }>;
}

/**
 * One person's track record. The helper's side starts from the task steps they signed (`lib/task-reads.ts`); the
 * founder's side from their own update records. When a side's read did not reach its end, its numbers must not be
 * stated.
 */
export function useTrackRecord(person: string, enabled = true) {
  const relay = relayWsUrl();
  return useQuery({
    queryKey: [...tasksQueryKey, "person", relay, person],
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<TrackRecord> => {
      const [tasks, own, deletions] = await Promise.all([
        readPersonTasks(read, person, (event) => {
          const record = parseLaunchRecord(event);
          return record
            ? {
                coordinate: launchCoordinate(record.author, record.id),
                team: [...teamOf(record)],
              }
            : null;
        }),
        readAuthorUpdates(read, person),
        readPaged(read, () => deletionsFilter(person)),
      ]);
      const teams = new Map<string, Set<string>>();
      const projects: TrackRecord["projects"] = {};
      for (const event of tasks.projects) {
        const record = parseLaunchRecord(event);
        if (!record) continue;
        const coordinate = launchCoordinate(record.author, record.id);
        teams.set(coordinate, teamOf(record));
        projects[coordinate] = {
          id: record.id,
          author: record.author,
          name: record.name,
        };
      }
      // Whoever is proven to run this account can remove its records: their removals are read too.
      const owners = new Set<string>();
      const checked = new Set<string>();
      for (const event of tasks.events) {
        if (event.pubkey !== person || owners.size >= OWNERS_READ) continue;
        const claim = agentClaim(event);
        const sig = claim?.auth?.sig;
        if (!claim || !sig || checked.has(sig)) continue;
        if (checked.size >= OWNER_PROOFS_CHECKED) break;
        checked.add(sig);
        const owner = verifiedAgent(claim, KIND_LAUNCH_UPDATE).owner;
        if (owner) owners.add(owner);
      }
      const ownersRemoved = await Promise.all(
        [...owners].map(async (pubkey) => {
          const page = await readPaged(read, () => deletionsFilter(pubkey));
          return {
            pubkey,
            removed: removedRecords(page.events, pubkey, page.complete),
          };
        }),
      );
      const mine = own.events.filter((event) => event.pubkey === person);
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
      const removed = removedRecords(
        deletions.events,
        person,
        deletions.complete,
      );
      const some = (r: RemovedRecords) =>
        r.count + r.unnamed > 0 || !r.complete;
      return {
        helper: helperRecord({
          person,
          records: taskRecordsOf(tasks.events),
          teams,
          now: Math.floor(Date.now() / 1000),
          mayHaveRemoved:
            some(removed) || ownersRemoved.some((o) => some(o.removed)),
        }),
        founder: founderRecord(person, updates),
        removed,
        ownersRemoved,
        helperComplete: tasks.complete,
        tooManyProjects: tasks.tooManyProjects,
        founderComplete: own.complete,
        othersCut: tasks.othersCut,
        projects,
      };
    },
  });
}
