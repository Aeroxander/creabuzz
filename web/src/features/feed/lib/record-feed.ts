/**
 * Home's feed of project records: what the projects in view put on the record, newest first.
 *
 * One item per signed record, and only from the party entitled to sign it: an update from the project's founder or
 * a team member who said yes (with the founder's answers to earlier promises, and the help it asks for), a goal the founder marked reached,
 * missed or changed, and work the team accepted (worked out with the same rules as the project's own page:
 * `projectTasks`). Anything else that names a project is not an item, whoever signed it.
 *
 * Order is by the time each record says it was signed, never later than now: the server takes no record dated more
 * than a quarter of an hour ahead, and a record dated ahead is shown as signed now, not above everything for good.
 *
 * Pure and alias-free: `record-feed.test.mjs` drives it under `node --test`.
 */

import {
  type GoalState,
  isGoalRecordTags,
  parseGoalVersion,
} from "../../launchpad/lib/goals.ts";
import { isHelpSignalTags } from "../../launchpad/lib/help-request.ts";
import type { KnownAgents } from "../../launchpad/lib/task-own-check.ts";
import {
  isTaskRecordTags,
  projectTasks,
  type TaskRecord,
} from "../../launchpad/lib/tasks.ts";
import { isTeamAnswerTags } from "../../launchpad/lib/team.ts";
import type { HelpAsk } from "../../launchpad/lib/weekly-update.ts";
import {
  type LaunchUpdate,
  parseLaunchUpdate,
} from "../../launchpad/models.ts";

/** Records read per page of the feed, and at most this many pages. */
export const FEED_PAGE = 100;
export const FEED_MAX_PAGES = 10;
/** The most projects one feed follows, and the most accounts (their teams) one page names. */
export const FEED_PROJECTS = 40;
export const FEED_AUTHORS = 200;

/** A project's start counts as news for this long: an older start is no longer announced. */
const STARTED_NEWS_DAYS = 30;
const DAY = 86_400;

export interface FeedProject {
  coordinate: string;
  founder: string;
  /**
   * When the project was first published (`LaunchRecord.startedAt`), in seconds. Without it nothing is said about a
   * project's start: neither "just started" nor "first update" can be told from what was read.
   */
  startedAt?: number;
  /** False when its founder chose "Not listed yet": nothing is announced about a project nobody can find. */
  listed?: boolean;
  /** The founder and everyone on the founder's record: who the server lets make and check the project's tasks. */
  team: ReadonlySet<string>;
  /**
   * Whose updates speak for the project, and until when (`projectVoices` in `team.ts`): the founder and the members
   * who said yes, with no end (null); someone who left, until they left. Someone the founder added who has not said
   * yes is on `team` and not here: the server lets them post, and what they post is not the project's update.
   */
  voices: ReadonlyMap<string, number | null>;
}

interface FeedEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface ItemBase {
  /** Unique in the feed. */
  id: string;
  /** When it was signed, never later than now. */
  at: number;
  coordinate: string;
  author: string;
}

export interface UpdateItem extends ItemBase {
  kind: "update";
  /** The update as the project's page reads it (its help request is answered through this). */
  update: LaunchUpdate;
  help: HelpAsk | null;
  /** The founder's answers to earlier promises in this update; all zero for anyone else's update. */
  answers: { kept: number; missed: number; changed: number };
  /** The promises this update makes (the founder's only). */
  promises: string[];
  /**
   * The project's first update: the oldest one on its record, and the read is known to reach back to the project's
   * start, so nothing older can be missing. False when that cannot be told.
   */
  first: boolean;
}

/** A project's start, from the founder's signed first open goal. Cheered with "Good luck". */
interface StartedItem extends ItemBase {
  kind: "started";
  /** The goal in the founder's words, and how everyone will know it was reached. */
  text: string;
  how: string;
}

interface GoalItem extends ItemBase {
  kind: "goal";
  state: Exclude<GoalState, "open">;
  text: string;
  reason: string;
}

interface WorkItem extends ItemBase {
  kind: "work";
  taskId: string;
  what: string;
  helper: string;
  /** Only the project's founder checked it, and it was their own work (or their agent's): not accepted by anyone else. */
  selfChecked: boolean;
}

export type FeedItem = UpdateItem | GoalItem | WorkItem | StartedItem;

/**
 * The feed's items from the records read. `events` are update records naming the projects in view; `taskRecords` are
 * the tasks (and their steps) that the confirmations among them name.
 */
export function feedItems(input: {
  events: readonly FeedEvent[];
  projects: ReadonlyMap<string, FeedProject>;
  taskRecords: readonly TaskRecord[];
  /** Accounts known to be agents, so a founder's own check is worded as theirs here too. */
  agents?: KnownAgents;
  /** Now, in seconds. */
  now: number;
  /**
   * How far back the records read reach: `null` when the read ran to the end, otherwise the signing time of the oldest
   * record read. Left out, nothing is known about how far back it went. A start or a first update is told only when
   * the read reaches back to the project's own start, so an older record that was not read cannot make it wrong.
   */
  readBack?: number | null;
}): FeedItem[] {
  const { projects, now } = input;
  const out = new Map<string, FeedItem>();
  // The earliest open primary goal each founder signed, and the earliest update each project's voices signed.
  const starts = new Map<string, StartedItem>();
  const firsts = new Map<string, UpdateItem>();
  const reaches = (project: FeedProject): boolean =>
    project.startedAt !== undefined &&
    input.readBack !== undefined &&
    (input.readBack === null || input.readBack <= project.startedAt);
  const earlier = (a: ItemBase, b: ItemBase) =>
    a.at < b.at || (a.at === b.at && a.id < b.id);
  for (const event of input.events) {
    if (event.kind !== 47003 || out.has(event.id)) continue;
    const coordinate = event.tags.find(
      (tag) => tag[0] === "a" && projects.has(tag[1]),
    )?.[1];
    const project = coordinate ? projects.get(coordinate) : undefined;
    if (!coordinate || !project) continue;
    const base = {
      id: event.id,
      at: Math.min(event.created_at, now),
      coordinate,
      author: event.pubkey,
    };
    if (isGoalRecordTags(event.tags)) {
      // A goal is the founder's alone.
      if (event.pubkey !== project.founder) continue;
      const goal = parseGoalVersion(event);
      if (!goal) continue;
      if (goal.state === "open") {
        // Not an item of its own (an edit of an open goal is not news); the first one is the project's start.
        if (goal.level === "primary") {
          const start: StartedItem = {
            ...base,
            kind: "started",
            text: goal.text,
            how: goal.how,
          };
          const was = starts.get(coordinate);
          if (!was || earlier(start, was)) starts.set(coordinate, start);
        }
        continue;
      }
      out.set(event.id, {
        ...base,
        kind: "goal",
        state: goal.state,
        text: goal.text,
        reason: goal.reason,
      });
      continue;
    }
    // Work accepted comes from the task records below; an offer, a reply or a team answer is not news.
    if (
      isTaskRecordTags(event.tags) ||
      isHelpSignalTags(event.tags) ||
      isTeamAnswerTags(event.tags)
    )
      continue;
    // Only the founder and the members who said yes speak as the project; someone who left, only until they left.
    const until = project.voices.get(event.pubkey);
    if (until === undefined) continue;
    if (until !== null && event.created_at > until) continue;
    const update = parseLaunchUpdate(event);
    // Submitted work and check notes are shown with the work, not as news.
    if (!update || update.claim || update.checkNote) continue;
    const byFounder = event.pubkey === project.founder;
    const marks = byFounder ? (update.marks ?? []) : [];
    const item: UpdateItem = {
      ...base,
      kind: "update",
      update,
      help: update.help ?? null,
      answers: {
        kept: marks.filter((m) => m.state === "done").length,
        missed: marks.filter((m) => m.state === "not-done").length,
        changed: marks.filter((m) => m.state === "changed").length,
      },
      promises: byFounder ? (update.promises ?? []).map((p) => p.text) : [],
      first: false,
    };
    out.set(event.id, item);
    const was = firsts.get(coordinate);
    if (!was || earlier(item, was)) firsts.set(coordinate, item);
  }
  for (const [coordinate, item] of firsts) {
    const project = projects.get(coordinate);
    if (project && reaches(project)) item.first = true;
  }
  for (const [coordinate, start] of starts) {
    const project = projects.get(coordinate);
    if (!project || project.listed === false || !reaches(project)) continue;
    // A start is news for a while; a year-old project's start is just its history.
    if (now - start.at > STARTED_NEWS_DAYS * DAY) continue;
    out.set(start.id, start);
  }
  for (const project of projects.values()) {
    const tasks = projectTasks({
      records: input.taskRecords,
      coordinate: project.coordinate,
      team: project.team,
      now,
      agents: input.agents,
    });
    for (const task of tasks) {
      if (task.state !== "confirmed" || !task.accepted) continue;
      out.set(`work:${task.id}`, {
        id: `work:${task.id}`,
        kind: "work",
        at: Math.min(task.accepted.confirmedAt, now),
        coordinate: project.coordinate,
        author: task.accepted.by,
        taskId: task.id,
        what: task.what,
        helper: task.helper,
        selfChecked: task.selfChecked,
      });
    }
  }
  return [...out.values()].sort(
    (a, b) => b.at - a.at || (a.id < b.id ? -1 : 1),
  );
}

/** The ids of the tasks the confirmations in `events` name: the ones whose records the feed reads next. */
export function confirmedTaskIds(events: readonly FeedEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (!event.tags.some((t) => t[0] === "task-part" && t[1] === "confirm"))
      continue;
    const id = event.tags.find((t) => t[0] === "task")?.[1];
    if (id && /^[0-9a-f]{64}$/.test(id)) ids.add(id);
  }
  return [...ids].sort();
}

/** What an item is, in two or three words, for its card. */
export function itemLabel(item: FeedItem): string {
  switch (item.kind) {
    case "goal":
      return item.state === "reached"
        ? "Goal reached"
        : item.state === "missed"
          ? "Goal missed"
          : "Goal changed";
    case "work":
      return item.selfChecked ? "Work done alone" : "Work accepted";
    case "started":
      return "Just started";
    case "update":
      return item.help ? "Help wanted" : item.first ? "First update" : "Update";
  }
}

/** "2 kept, 1 missed, 1 changed" for the answers an update gives, leaving out what there is none of. Null for none. */
export function answersLine(answers: UpdateItem["answers"]): string | null {
  const parts = [
    answers.kept > 0 ? `${answers.kept} kept` : null,
    answers.missed > 0 ? `${answers.missed} missed` : null,
    answers.changed > 0 ? `${answers.changed} changed` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `Promises: ${parts.join(", ")}` : null;
}
