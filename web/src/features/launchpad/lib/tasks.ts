/**
 * Tasks with a finish line: work a project hands to one helper, with what "done" means written down before anyone
 * starts, the evidence the helper hands in, and a check by someone who did not do the work.
 *
 * Every step is one signed update record that names the project (`a`), carries the label `l` = `creaton-task` (so a
 * project's or a person's task records can be read on their own) and says which step it is in `task-part`:
 *
 *   task       the team makes the task: who it is with (`p`, `task-helper`), the request's words (`task-what`),
 *              "Done means" (`task-done`), the size (`task-size`), an optional due date (`task-due`), and the update
 *              and offer it came from (`task-update`, `task-offer`). The record's own id is the task's id, so its
 *              words can never be swapped later.
 *   accept     the helper agrees to a task that was given to them without an offer
 *   evidence   the helper hands work in: words (the body), links (`task-link`) and files by fingerprint (`task-file`)
 *   send-back  the team returns one handed-in piece (`task-evidence`) with a reason
 *   confirm    a team member who is not the helper accepts one handed-in piece (`task-evidence`)
 *   more-time  the helper asks for more time, with a reason and the date they ask for
 *   grant      the team answers one such ask (`task-ask`) with the new date
 *   give-up    the helper stops
 *   cancel     the team stops the task, with a reason
 *
 * Every step after the first names the task in `e` and `task`.
 *
 * What a task's state is gets decided here, when reading, from who signed what:
 * - a record only counts when the right party signed it (the team, or the helper the task names);
 * - nothing is ordered by the time a record carries, because its signer picks that time. A send-back or a
 *   confirmation names the exact piece of evidence it answers, so "which came first" never has to be guessed;
 * - the person who did the work can never confirm it, and neither can an agent or the person who runs the helper;
 * - answers that disagree (one team member confirmed what another sent back) are both shown, and the work is not
 *   counted as accepted;
 * - nobody is on a task they did not agree to: a task counts as agreed only when the helper offered, accepted or
 *   handed work in.
 *
 * Nothing here carries an amount of Shares or money.
 *
 * Pure and alias-free: `tasks.test.mjs` drives it under `node --test`.
 */

import {
  type AgentClaim,
  type AgentMark,
  agentClaim,
  verifiedAgent,
} from "./agent-label.ts";
import { HELP_SIZES, type HelpSize } from "./weekly-update.ts";

/** The `l` label every task record carries. */
export const TASK_LABEL = "creaton-task";
/** The kind every task record is: an update record. */
const KIND_UPDATE = 47003;

const TAG_PART = "task-part";
const TAG_TASK = "task";
const TAG_HELPER = "task-helper";
const TAG_WHAT = "task-what";
const TAG_DONE = "task-done";
const TAG_SIZE = "task-size";
const TAG_DUE = "task-due";
const TAG_UPDATE = "task-update";
const TAG_OFFER = "task-offer";
const TAG_EVIDENCE = "task-evidence";
const TAG_LINK = "task-link";
const TAG_FILE = "task-file";
const TAG_ASK = "task-ask";

const TASK_PARTS = [
  "task",
  "accept",
  "evidence",
  "send-back",
  "confirm",
  "more-time",
  "grant",
  "give-up",
  "cancel",
] as const;
export type TaskPart = (typeof TASK_PARTS)[number];

export const TASK_LIMITS = {
  what: 500,
  done: 500,
  note: 1000,
  links: 5,
  files: 5,
  link: 500,
  fileName: 120,
} as const;

/** The one line said wherever a task is accepted or confirmed. */
export const REWARDS_LINE =
  "Rewards are decided separately, by the project's own rules.";

const ID_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Tags = readonly (readonly string[])[];

interface EventLike {
  id: string;
  pubkey: string;
  created_at: number;
  tags: Tags;
  content: string;
}

/** A file handed in as evidence: its SHA-256 fingerprint, and its name and address when given. */
export interface TaskFile {
  hash: string;
  name: string;
  url: string;
}

/** One task record, as read. Who signed it is `author`; whether that gives it any weight is decided later. */
export interface TaskRecord {
  id: string;
  part: TaskPart;
  author: string;
  at: number;
  /** The project the record names. */
  coordinate: string;
  /** The task a later step names. For the task record itself, its own id. */
  taskId: string;
  note: string;
  helper: string | null;
  what: string;
  done: string;
  size: HelpSize | null;
  /** A date, `YYYY-MM-DD`, or null. */
  due: string | null;
  updateId: string | null;
  offerId: string | null;
  /** The evidence a send-back or a confirmation answers. */
  evidenceId: string | null;
  /** The ask for more time a grant answers. */
  askId: string | null;
  links: string[];
  files: TaskFile[];
  agent: AgentClaim | null;
}

/** Whether a record's tags mark it as a task record (so it is never listed as an update). */
export function isTaskRecordTags(tags: Tags): boolean {
  return tags.some((tag) => tag[0] === TAG_PART);
}

const first = (tags: Tags, name: string): string | null => {
  const value = tags.find((tag) => tag[0] === name)?.[1];
  return typeof value === "string" ? value : null;
};

/** A real calendar date written `YYYY-MM-DD`, or null. */
export function validDate(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !DATE_RE.test(value)) return null;
  const at = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  return new Date(at).toISOString().slice(0, 10) === value ? value : null;
}

/** A web link as evidence may carry it: http or https, of a sane length. Null for anything else. */
export function validLink(value: string): string | null {
  const text = value.trim();
  if (text === "" || text.length > TASK_LIMITS.link) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? text : null;
  } catch {
    return null;
  }
}

function isSize(value: unknown): value is HelpSize {
  return (HELP_SIZES as readonly string[]).includes(value as string);
}

/** The task record an update record is, or null when it is not one or cannot be read as one. */
export function parseTaskRecord(event: EventLike): TaskRecord | null {
  const parts = event.tags.filter((tag) => tag[0] === TAG_PART);
  // Exactly one step: a record that claims to be two things is neither.
  if (parts.length !== 1) return null;
  const part = parts[0][1] as TaskPart;
  if (!TASK_PARTS.includes(part)) return null;
  const coordinate = first(event.tags, "a");
  if (!coordinate) return null;
  let note = "";
  try {
    const body: unknown = JSON.parse(event.content);
    if (body && typeof body === "object") {
      const text = (body as { note?: unknown }).note;
      if (typeof text === "string")
        note = text.trim().slice(0, TASK_LIMITS.note);
    }
  } catch {
    // Words that cannot be read are no words; the step itself is in the tags.
  }
  const record: TaskRecord = {
    id: event.id,
    part,
    author: event.pubkey,
    at: event.created_at,
    coordinate,
    taskId: event.id,
    note,
    helper: null,
    what: "",
    done: "",
    size: null,
    due: validDate(first(event.tags, TAG_DUE)),
    updateId: null,
    offerId: null,
    evidenceId: null,
    askId: null,
    links: [],
    files: [],
    agent: agentClaim(event),
  };
  if (part === "task") {
    const helper = first(event.tags, TAG_HELPER);
    const what = (first(event.tags, TAG_WHAT) ?? "").trim();
    const done = (first(event.tags, TAG_DONE) ?? "").trim();
    const size = first(event.tags, TAG_SIZE);
    // A task without a helper, its words or its finish line is not a task.
    if (!helper || !ID_RE.test(helper) || !what || !done || !isSize(size))
      return null;
    const update = first(event.tags, TAG_UPDATE);
    const offer = first(event.tags, TAG_OFFER);
    return {
      ...record,
      helper,
      what: what.slice(0, TASK_LIMITS.what),
      done: done.slice(0, TASK_LIMITS.done),
      size,
      updateId: update && ID_RE.test(update) ? update : null,
      offerId: offer && ID_RE.test(offer) ? offer : null,
    };
  }
  const taskId = first(event.tags, TAG_TASK);
  if (!taskId || !ID_RE.test(taskId)) return null;
  record.taskId = taskId;
  if (part === "evidence") {
    const links: string[] = [];
    const files: TaskFile[] = [];
    for (const tag of event.tags) {
      if (tag[0] === TAG_LINK && links.length < TASK_LIMITS.links) {
        const link = typeof tag[1] === "string" ? validLink(tag[1]) : null;
        if (link && !links.includes(link)) links.push(link);
      }
      if (
        tag[0] === TAG_FILE &&
        files.length < TASK_LIMITS.files &&
        typeof tag[1] === "string" &&
        ID_RE.test(tag[1]) &&
        !files.some((file) => file.hash === tag[1])
      )
        files.push({
          hash: tag[1],
          name: (typeof tag[2] === "string" ? tag[2] : "")
            .trim()
            .slice(0, TASK_LIMITS.fileName),
          url: (typeof tag[3] === "string" && validLink(tag[3])) || "",
        });
    }
    // Evidence is something handed in: a record with no words, link or file hands in nothing.
    if (links.length === 0 && files.length === 0 && note === "") return null;
    record.links = links;
    record.files = files;
  }
  if (part === "send-back" || part === "confirm") {
    const evidence = first(event.tags, TAG_EVIDENCE);
    if (!evidence || !ID_RE.test(evidence)) return null;
    // Work is sent back for a reason the helper can act on.
    if (part === "send-back" && note === "") return null;
    record.evidenceId = evidence;
  }
  if (part === "more-time" && note === "") return null;
  if (part === "cancel" && note === "") return null;
  if (part === "grant") {
    const ask = first(event.tags, TAG_ASK);
    if (!ask || !ID_RE.test(ask) || !record.due) return null;
    record.askId = ask;
  }
  return record;
}

export interface TaskEvent {
  content: { title: string; body: string; note?: string };
  tags: string[][];
}

const clip = (value: string, max: number) => value.trim().slice(0, max);

/** The team makes a task. `what` is the request's words; `done` is what finished looks like. */
export function taskEvent(input: {
  helper: string;
  what: string;
  done: string;
  size: HelpSize;
  due?: string | null;
  updateId?: string | null;
  offerId?: string | null;
}): TaskEvent {
  const what = clip(input.what, TASK_LIMITS.what);
  const done = clip(input.done, TASK_LIMITS.done);
  const due = validDate(input.due);
  return {
    content: {
      title: "Task",
      body: `${what}\n\nDone means: ${done}${due ? `\n\nDue ${due}` : ""}`,
    },
    tags: [
      ["l", TASK_LABEL],
      [TAG_PART, "task"],
      ["p", input.helper],
      [TAG_HELPER, input.helper],
      [TAG_WHAT, what],
      [TAG_DONE, done],
      [TAG_SIZE, input.size],
      ...(due ? [[TAG_DUE, due]] : []),
      ...(input.updateId ? [[TAG_UPDATE, input.updateId]] : []),
      ...(input.offerId ? [[TAG_OFFER, input.offerId]] : []),
    ],
  };
}

const TITLES: Record<Exclude<TaskPart, "task">, string> = {
  accept: "Task accepted",
  evidence: "Work handed in",
  "send-back": "Work sent back",
  confirm: "Work confirmed",
  "more-time": "More time asked",
  grant: "More time given",
  "give-up": "Task given up",
  cancel: "Task cancelled",
};

/**
 * Any step after the first. `tell` are the people the step is for (the helper for a team's step; whoever made the
 * task, and the founder, for a helper's step), so their notifications find it.
 */
export function taskStepEvent(input: {
  part: Exclude<TaskPart, "task">;
  taskId: string;
  tell: readonly string[];
  note?: string;
  evidenceId?: string;
  askId?: string;
  due?: string | null;
  links?: readonly string[];
  files?: readonly TaskFile[];
}): TaskEvent {
  const note = clip(input.note ?? "", TASK_LIMITS.note);
  const due = validDate(input.due);
  const links = (input.links ?? [])
    .flatMap((link) => validLink(link) ?? [])
    .filter((link, i, all) => all.indexOf(link) === i)
    .slice(0, TASK_LIMITS.links);
  const files = (input.files ?? [])
    .filter((file) => ID_RE.test(file.hash))
    .slice(0, TASK_LIMITS.files);
  const tell = [...new Set(input.tell)].filter((key) => ID_RE.test(key));
  return {
    content: {
      title: TITLES[input.part],
      body: [note, ...links].filter(Boolean).join("\n"),
      ...(note ? { note } : {}),
    },
    tags: [
      ["l", TASK_LABEL],
      [TAG_PART, input.part],
      ["e", input.taskId],
      [TAG_TASK, input.taskId],
      ...tell.map((key) => ["p", key]),
      ...(input.evidenceId ? [[TAG_EVIDENCE, input.evidenceId]] : []),
      ...(input.askId ? [[TAG_ASK, input.askId]] : []),
      ...(due ? [[TAG_DUE, due]] : []),
      ...links.map((link) => [TAG_LINK, link]),
      ...files.map((file) => [
        TAG_FILE,
        file.hash,
        clip(file.name, TASK_LIMITS.fileName),
        validLink(file.url) ?? "",
      ]),
    ],
  };
}

export type TaskState =
  /** Given to someone who has not agreed yet. */
  | "offered"
  | "in-progress"
  /** Work was handed in and waits for a check. */
  | "submitted"
  | "sent-back"
  | "confirmed"
  | "given-up"
  | "cancelled";

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  offered: "Waiting for a yes",
  "in-progress": "In progress",
  submitted: "Waiting for a check",
  "sent-back": "Sent back",
  confirmed: "Work accepted",
  "given-up": "Given up",
  cancelled: "Cancelled",
};

interface Answer {
  id: string;
  by: string;
  at: number;
  note: string;
}

/** One piece of work handed in, with what the team said about it. */
export interface TaskEvidence {
  id: string;
  at: number;
  note: string;
  links: string[];
  files: TaskFile[];
  sentBack: Answer[];
  confirmed: Answer[];
}

interface MoreTimeAsk {
  id: string;
  at: number;
  reason: string;
  /** The date the helper asked for, when they named one. */
  wanted: string | null;
  /** The team's answer, when there is one. */
  granted: { id: string; by: string; at: number; due: string } | null;
}

export interface TaskView {
  id: string;
  coordinate: string;
  /** The team member who made the task. */
  madeBy: string;
  madeAt: number;
  helper: string;
  what: string;
  done: string;
  size: HelpSize;
  /** The date it is due now: the latest of the first date and any the team gave since. Null when none was set. */
  due: string | null;
  updateId: string | null;
  offerId: string | null;
  state: TaskState;
  /** Open, past its date, and the helper's move. */
  late: boolean;
  /** How the helper agreed, or null while they have not. */
  agreed: "self" | "offer" | "accept" | "work" | null;
  /** Everything handed in, oldest first by the helper's own dates. */
  evidence: TaskEvidence[];
  /** The piece that was accepted, when the task is confirmed. */
  accepted: (TaskEvidence & { by: string; confirmedAt: number }) | null;
  /** The piece waiting for a check, when there is one. */
  waiting: TaskEvidence | null;
  /** A confirmation names evidence that is not on the server (removed, or not read). */
  confirmedWithoutEvidence: boolean;
  /** One team member confirmed a piece that another sent back: both stand, and the work is not counted. */
  disagreement: boolean;
  /** A confirmation was signed by someone who may not confirm (the helper, an agent, or whoever runs the helper). */
  ignoredConfirmation: boolean;
  moreTime: MoreTimeAsk[];
  gaveUp: Answer | null;
  cancelled: Answer | null;
  /** Set when the helper's records say an agent signed them. */
  helperAgent: AgentMark | null;
}

const byTime = <T extends { at: number; id: string }>(a: T, b: T) =>
  a.at - b.at || (a.id < b.id ? -1 : 1);

const answer = (record: TaskRecord): Answer => ({
  id: record.id,
  by: record.author,
  at: record.at,
  note: record.note,
});

/** `YYYY-MM-DD` for a time, in UTC. */
function dayOf(at: number): string {
  return new Date(at * 1000).toISOString().slice(0, 10);
}

/** How many of a helper's proofs of who runs them are checked for one task: each is one signature. */
const PROOFS_CHECKED = 3;

/**
 * Every task of one project, from its task records. `records` may hold anything: other projects' records, steps by
 * the wrong people, duplicates. `offers` says who signed each offer a task names (and is still on the server).
 */
export function projectTasks(input: {
  records: readonly TaskRecord[];
  coordinate: string;
  team: ReadonlySet<string>;
  /** Offer id to its author, for the offers that are on the server. */
  offers?: ReadonlyMap<string, string>;
  /** Now, in seconds. */
  now: number;
}): TaskView[] {
  const { coordinate, team, offers, now } = input;
  const seen = new Set<string>();
  const records = input.records.filter((record) => {
    if (record.coordinate !== coordinate || seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
  const steps = new Map<string, TaskRecord[]>();
  for (const record of records) {
    if (record.part === "task") continue;
    const list = steps.get(record.taskId) ?? [];
    list.push(record);
    steps.set(record.taskId, list);
  }
  const today = dayOf(now);
  const out: TaskView[] = [];
  for (const task of records) {
    // Only the project's team can make one of its tasks.
    if (task.part !== "task" || !task.helper || !task.size) continue;
    if (!team.has(task.author)) continue;
    const helper = task.helper;
    const mine = steps.get(task.id) ?? [];
    const fromHelper = mine.filter((step) => step.author === helper);
    // The team's word on the helper's work comes from someone else on the team.
    const fromTeam = mine.filter(
      (step) => team.has(step.author) && step.author !== helper,
    );

    // Who runs the helper, when its records prove it: that person may not confirm either.
    const owners = new Set<string>();
    let helperAgent: AgentMark | null = null;
    const checked = new Set<string>();
    for (const step of fromHelper) {
      if (!step.agent) continue;
      if (step.agent.says && !helperAgent) helperAgent = { owner: null };
      const auth = step.agent.auth;
      if (!auth || checked.has(auth.sig) || checked.size >= PROOFS_CHECKED)
        continue;
      checked.add(auth.sig);
      const mark = verifiedAgent(step.agent, KIND_UPDATE);
      if (mark.owner) {
        owners.add(mark.owner);
        helperAgent = mark;
      }
    }

    const evidence: TaskEvidence[] = fromHelper
      .filter((step) => step.part === "evidence")
      .sort(byTime)
      .map((step) => ({
        id: step.id,
        at: step.at,
        note: step.note,
        links: step.links,
        files: step.files,
        sentBack: [],
        confirmed: [],
      }));
    const pieces = new Map(evidence.map((piece) => [piece.id, piece]));
    let confirmedWithoutEvidence = false;
    let ignoredConfirmation = false;
    for (const step of mine) {
      if (step.part !== "confirm") continue;
      // Nobody grades their own work: not the helper, not whoever runs the helper, and not an agent.
      const may =
        team.has(step.author) &&
        step.author !== helper &&
        !owners.has(step.author) &&
        step.agent === null;
      if (!may) {
        if (step.author === helper || team.has(step.author))
          ignoredConfirmation = true;
        continue;
      }
      const piece = step.evidenceId ? pieces.get(step.evidenceId) : undefined;
      if (piece) piece.confirmed.push(answer(step));
      else confirmedWithoutEvidence = true;
    }
    for (const step of fromTeam) {
      if (step.part !== "send-back" || !step.evidenceId) continue;
      pieces.get(step.evidenceId)?.sentBack.push(answer(step));
    }
    for (const piece of evidence) {
      piece.confirmed.sort(byTime);
      piece.sentBack.sort(byTime);
    }

    const asks: MoreTimeAsk[] = fromHelper
      .filter((step) => step.part === "more-time")
      .sort(byTime)
      .map((step) => ({
        id: step.id,
        at: step.at,
        reason: step.note,
        wanted: step.due,
        granted: null,
      }));
    let due = task.due;
    for (const step of fromTeam) {
      if (step.part !== "grant" || !step.due) continue;
      const ask = asks.find((a) => a.id === step.askId);
      if (!ask) continue;
      // Several answers to one ask: the later date stands.
      if (!ask.granted || step.due > ask.granted.due)
        ask.granted = {
          id: step.id,
          by: step.author,
          at: step.at,
          due: step.due,
        };
      if (due === null || step.due > due) due = step.due;
    }

    const gaveUpStep = fromHelper
      .filter((step) => step.part === "give-up")
      .sort(byTime)[0];
    const cancelStep = fromTeam
      .filter((step) => step.part === "cancel")
      .sort(byTime)[0];

    const agreed: TaskView["agreed"] =
      task.author === helper
        ? "self"
        : task.offerId && offers?.get(task.offerId) === helper
          ? "offer"
          : fromHelper.some((step) => step.part === "accept")
            ? "accept"
            : evidence.length > 0
              ? "work"
              : null;

    const good = evidence.find(
      (piece) => piece.confirmed.length > 0 && piece.sentBack.length === 0,
    );
    const disagreement = evidence.some(
      (piece) => piece.confirmed.length > 0 && piece.sentBack.length > 0,
    );
    // Newest of the pieces nobody has answered: what the team is asked to look at.
    const waiting =
      [...evidence]
        .reverse()
        .find(
          (piece) =>
            piece.confirmed.length === 0 && piece.sentBack.length === 0,
        ) ?? null;

    const state: TaskState = good
      ? "confirmed"
      : gaveUpStep
        ? "given-up"
        : cancelStep
          ? "cancelled"
          : agreed === null
            ? "offered"
            : waiting
              ? "submitted"
              : evidence.length > 0
                ? "sent-back"
                : "in-progress";

    out.push({
      id: task.id,
      coordinate,
      madeBy: task.author,
      madeAt: task.at,
      helper,
      what: task.what,
      done: task.done,
      size: task.size,
      due,
      updateId: task.updateId,
      offerId: task.offerId,
      state,
      late:
        (state === "in-progress" || state === "sent-back") &&
        due !== null &&
        today > due,
      agreed,
      evidence,
      accepted: good
        ? {
            ...good,
            by: good.confirmed[0].by,
            confirmedAt: good.confirmed[0].at,
          }
        : null,
      waiting: good ? null : waiting,
      confirmedWithoutEvidence: !good && confirmedWithoutEvidence,
      disagreement: !good && disagreement,
      ignoredConfirmation: !good && ignoredConfirmation,
      moreTime: asks,
      gaveUp: gaveUpStep ? answer(gaveUpStep) : null,
      cancelled: cancelStep ? answer(cancelStep) : null,
      helperAgent,
    });
  }
  return out;
}

const OPEN_STATES: readonly TaskState[] = [
  "offered",
  "in-progress",
  "submitted",
  "sent-back",
];

export function isOpenTask(task: Pick<TaskView, "state">): boolean {
  return OPEN_STATES.includes(task.state);
}

/**
 * A time for putting things in order, never later than now: a record dated in the future does not jump the list.
 */
export function orderTime(at: number, now: number): number {
  return Math.min(at, now);
}

/** Open tasks: late ones first, then by due date (soonest first, none last), then by id. Never by a signer's time. */
export function openTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter(isOpenTask).sort((a, b) => {
    if (a.late !== b.late) return a.late ? -1 : 1;
    if (a.due !== b.due) {
      if (a.due === null) return 1;
      if (b.due === null) return -1;
      return a.due < b.due ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });
}

/** Finished tasks, newest confirmation first. A confirmation dated in the future counts as now. */
export function acceptedTasks(
  tasks: readonly TaskView[],
  now: number,
): TaskView[] {
  return tasks
    .filter((task) => task.state === "confirmed" && task.accepted)
    .sort(
      (a, b) =>
        orderTime(b.accepted?.confirmedAt ?? 0, now) -
          orderTime(a.accepted?.confirmedAt ?? 0, now) ||
        (a.id < b.id ? -1 : 1),
    );
}

export type ConfirmRule =
  | { may: true }
  | {
      may: false;
      /**
       * `helper`: the viewer did the work. `runs-helper`: the viewer runs the agent that did it. `not-team`: the
       * viewer is not on the project's team. `signed-out`: nobody is signed in.
       */
      why: "helper" | "runs-helper" | "not-team" | "signed-out";
      /** Whether anyone on the team could confirm this task. False: the project needs another team member first. */
      someoneCan: boolean;
    };

/** Whether `viewer` may confirm work on `task`, and if not, whether anyone can. */
export function confirmRule(
  task: Pick<TaskView, "helper" | "helperAgent">,
  team: ReadonlySet<string>,
  viewer: string | null,
): ConfirmRule {
  const owner = task.helperAgent?.owner ?? null;
  const someoneCan = [...team].some(
    (member) => member !== task.helper && member !== owner,
  );
  if (!viewer) return { may: false, why: "signed-out", someoneCan };
  if (viewer === task.helper) return { may: false, why: "helper", someoneCan };
  if (!team.has(viewer)) return { may: false, why: "not-team", someoneCan };
  if (viewer === owner) return { may: false, why: "runs-helper", someoneCan };
  return { may: true };
}

/** "Due 3 Dec 2026", "Late: was due 3 Dec 2026", or null when no date was set. */
export function dueLine(
  task: Pick<TaskView, "due" | "late">,
  day: (date: string) => string,
): string | null {
  if (!task.due) return null;
  return task.late ? `Late: was due ${day(task.due)}` : `Due ${day(task.due)}`;
}

/** What a draft task still needs before it can be made, or null. */
export function taskProblem(input: {
  what: string;
  done: string;
  due: string;
  today: string;
}): { field: "what" | "done" | "due"; message: string } | null {
  if (input.what.trim() === "")
    return { field: "what", message: "Say what the task is." };
  if (input.done.trim() === "")
    return {
      field: "done",
      message: "Say what finished looks like, so the work can be checked.",
    };
  if (input.due !== "") {
    if (!validDate(input.due))
      return { field: "due", message: "Pick a real date." };
    if (input.due < input.today)
      return { field: "due", message: "Pick a date that has not passed." };
  }
  return null;
}

/** The links typed into an evidence box, one per line: the ones that are web links, and the lines that are not. */
export function readLinks(text: string): { links: string[]; bad: string[] } {
  const links: string[] = [];
  const bad: string[] = [];
  for (const line of text.split(/\s+/)) {
    if (line === "") continue;
    const link = validLink(line);
    if (!link) bad.push(line);
    else if (!links.includes(link)) links.push(link);
  }
  return { links, bad };
}
