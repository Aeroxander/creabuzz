/**
 * How one project stands, and what in it needs one person now: for "Your projects" and Home's next step.
 *
 * Everything here is worked out from records read by who signed them (`use-project-state.ts`): the team's own records
 * about the project, the steps signed by the helpers its tasks name, and the offers on its open requests. Each number
 * is given only when the read it rests on reached its end; otherwise it is null and the page says it is not known.
 *
 * Pure and alias-free: `project-state.test.mjs` drives it under `node --test`.
 */

import { type HelpSignal, helpRequest } from "./help-request.ts";
import {
  type PromiseTotals,
  promiseRecord,
  promiseTotals,
  type RecordUpdate,
} from "./promises.ts";
import {
  confirmRule,
  projectTasks,
  type TaskRecord,
  type TaskView,
} from "./tasks.ts";
import {
  daysSince,
  founderNudge,
  type HelpAsk,
  weeksInARow,
} from "./weekly-update.ts";

/** A task is "due soon" from this many days before its date. */
const DUE_SOON_DAYS = 3;
const DAY = 86_400;

/** An update of the team's, as far as this needs it. */
interface StateUpdate extends RecordUpdate {
  help?: HelpAsk | null;
}

export interface ProjectStateInput {
  coordinate: string;
  founder: string;
  /** The founder and everyone on the founder's record. */
  team: ReadonlySet<string>;
  /** The team's update records about this project (not goals, tasks, help answers or team answers). */
  updates: readonly StateUpdate[];
  /** When the newest update in either form (a record, or a post marked as one) was posted, or null. */
  latestAt: number | null;
  /** Offers, replies and "Help found" marks read for this project. */
  signals: readonly HelpSignal[];
  /** Task records read for this project: the team's, and its helpers' steps. */
  tasks: readonly TaskRecord[];
  /** Which reads reached their end. */
  complete: {
    team: boolean;
    offers: boolean;
    helpers: boolean;
    posts: boolean;
  };
  viewer: string | null;
  /** Now, in seconds. */
  now: number;
}

interface OffersWaiting {
  updateId: string;
  /** Offers on this request nobody on the team replied to or made a task from. */
  count: number;
}

export interface ProjectState {
  coordinate: string;
  /** When the team last posted an update, or null when it never did. Meaningful only with `updatesKnown`. */
  lastUpdateAt: number | null;
  /** The newest update read is the newest there is (or there is none). */
  updatesKnown: boolean;
  /**
   * Weeks in a row with a weekly update from the team, dated no later than now; null when not all of the team's
   * updates were read.
   */
  streak: number | null;
  /** The founder's promises, totalled; null when not all of the founder's updates were read. */
  promises: PromiseTotals | null;
  /** How many requests for help are open; null when that is not known. */
  openHelp: number | null;
  /** The project's tasks; `tasksKnown` false when they could not all be read. */
  tasks: TaskView[];
  tasksKnown: boolean;
  /** For a viewer on the team: handed-in work they may check. */
  checks: TaskView[];
  /** For a viewer on the team: open requests with offers nobody answered. */
  offers: OffersWaiting[];
  /** For the founder: whole days since the last update when one is due (null: never posted), else undefined. */
  updateDue: { days: number | null } | undefined;
}

export function projectState(input: ProjectStateInput): ProjectState {
  const { coordinate, founder, team, viewer, now, complete } = input;
  const teamUpdates = input.updates.filter((u) => team.has(u.author));
  const updatesKnown = complete.team && complete.posts;
  const lastUpdateAt = input.latestAt;

  const promises = complete.team
    ? promiseTotals(
        promiseRecord(
          teamUpdates.filter((u) => u.author === founder),
          founder,
        ),
      )
    : null;

  const tasks = projectTasks({
    records: input.tasks,
    coordinate,
    team,
    now,
  });
  const tasksKnown = complete.team && complete.helpers;
  const onTeam = viewer !== null && team.has(viewer);

  const views = teamUpdates.flatMap((update) => {
    const view = helpRequest({
      update,
      signals: input.signals,
      team,
      viewer,
    });
    return view ? [view] : [];
  });
  const open = views.filter((view) => view.open);
  // An offer a task was made from was answered, with a task.
  const taskOffers = new Set(
    tasks.flatMap((task) => (task.offerId ? [task.offerId] : [])),
  );
  const offers: OffersWaiting[] =
    onTeam && complete.team && complete.offers
      ? open.flatMap((view) => {
          const count = view.offers.filter(
            (offer) =>
              offer.replies.length === 0 &&
              !taskOffers.has(offer.id) &&
              !team.has(offer.author),
          ).length;
          return count > 0 ? [{ updateId: view.updateId, count }] : [];
        })
      : [];

  const checks =
    onTeam && tasksKnown
      ? tasks.filter(
          (task) =>
            task.state === "submitted" &&
            task.waiting.length > 0 &&
            confirmRule(task, team, viewer).may,
        )
      : [];

  const nudge = founderNudge(lastUpdateAt, now);
  return {
    coordinate,
    lastUpdateAt,
    updatesKnown,
    streak: complete.team
      ? weeksInARow(
          teamUpdates.filter((u) => u.weekly).map((u) => u.createdAt),
          now,
        )
      : null,
    promises,
    openHelp: complete.team ? open.length : null,
    tasks,
    tasksKnown,
    checks,
    offers,
    updateDue:
      viewer === founder && updatesKnown && nudge.due
        ? {
            days: lastUpdateAt === null ? null : daysSince(lastUpdateAt, now),
          }
        : undefined,
  };
}

/** `viewer`'s own tasks on a project that need them: waiting for their yes, or theirs to do and due soon or late. */
export function myTaskNeeds(
  tasks: readonly TaskView[],
  viewer: string,
  now: number,
): {
  forYes: TaskView[];
  dueSoon: Array<{ task: TaskView; late: boolean }>;
  inProgress: TaskView[];
} {
  const mine = tasks.filter((task) => task.helper === viewer);
  const soon = new Date((now + DUE_SOON_DAYS * DAY) * 1000)
    .toISOString()
    .slice(0, 10);
  const doing = mine.filter(
    (task) => task.state === "in-progress" || task.state === "sent-back",
  );
  return {
    forYes: mine.filter((task) => task.state === "offered"),
    inProgress: doing,
    dueSoon: doing
      .filter((task) => task.due !== null && task.due <= soon)
      .map((task) => ({ task, late: task.late })),
  };
}

/** One thing that needs a person now, in one project. Every kind is a fact read from signed records. */
export type Need =
  | { kind: "check"; coordinate: string; taskId: string; what: string }
  | { kind: "offers"; coordinate: string; updateId: string; count: number }
  | { kind: "task-yes"; coordinate: string; taskId: string; what: string }
  | { kind: "invitation"; coordinate: string }
  | {
      kind: "task-due";
      coordinate: string;
      taskId: string;
      what: string;
      due: string;
      late: boolean;
    }
  | { kind: "update-due"; coordinate: string; days: number | null };

/** Other people wait on the first of these; the last only helps the person themselves. */
const ORDER: Record<Need["kind"], number> = {
  check: 0,
  offers: 1,
  "task-yes": 2,
  invitation: 3,
  "task-due": 4,
  "update-due": 5,
};

/** What a project's state needs from `viewer` (their own tasks on it come from {@link taskNeeds}). */
export function stateNeeds(state: ProjectState): Need[] {
  const { coordinate } = state;
  return [
    ...state.checks.map(
      (task): Need => ({
        kind: "check",
        coordinate,
        taskId: task.id,
        what: task.what,
      }),
    ),
    ...state.offers.map(
      (o): Need => ({
        kind: "offers",
        coordinate,
        updateId: o.updateId,
        count: o.count,
      }),
    ),
    ...(state.updateDue
      ? [
          {
            kind: "update-due",
            coordinate,
            days: state.updateDue.days,
          } as Need,
        ]
      : []),
  ];
}

/** What `viewer`'s own tasks need from them. */
export function taskNeeds(
  tasks: readonly TaskView[],
  viewer: string,
  now: number,
): Need[] {
  const mine = myTaskNeeds(tasks, viewer, now);
  return [
    ...mine.forYes.map(
      (task): Need => ({
        kind: "task-yes",
        coordinate: task.coordinate,
        taskId: task.id,
        what: task.what,
      }),
    ),
    ...mine.dueSoon.map(
      ({ task, late }): Need => ({
        kind: "task-due",
        coordinate: task.coordinate,
        taskId: task.id,
        what: task.what,
        due: task.due as string,
        late,
      }),
    ),
  ];
}

/** Needs in the order a person should meet them: what others wait on first; late before due soon; then by id. */
export function orderNeeds(needs: readonly Need[]): Need[] {
  const key = (need: Need) =>
    "taskId" in need
      ? need.taskId
      : "updateId" in need
        ? need.updateId
        : need.coordinate;
  const late = (need: Need) => (need.kind === "task-due" && need.late ? 0 : 1);
  return [...needs].sort(
    (a, b) =>
      ORDER[a.kind] - ORDER[b.kind] ||
      late(a) - late(b) ||
      (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0),
  );
}

const short = (text: string) =>
  text.length > 80 ? `${text.slice(0, 77)}…` : text;

/** A need as one sentence and the name of its one action. `project` is the project's name. */
export function needWords(
  need: Need,
  project: string,
): { text: string; action: string } {
  switch (need.kind) {
    case "check":
      return {
        text: `Work is waiting for your check in ${project}: ${short(need.what)}`,
        action: "Check the work",
      };
    case "offers":
      return {
        text:
          need.count === 1
            ? `An offer to help with ${project} is waiting for your reply.`
            : `${need.count} offers to help with ${project} are waiting for your reply.`,
        action: need.count === 1 ? "See the offer" : "See the offers",
      };
    case "task-yes":
      return {
        text: `${project} gave you a task to say yes or no to: ${short(need.what)}`,
        action: "See the task",
      };
    case "invitation":
      return {
        text: `${project} added you to its team. Say yes or no.`,
        action: "Answer",
      };
    case "task-due":
      return {
        text: need.late
          ? `Your task for ${project} is late: ${short(need.what)}`
          : `Your task for ${project} is due soon: ${short(need.what)}`,
        action: "Open the task",
      };
    case "update-due":
      return {
        text:
          need.days === null
            ? `${project} has no weekly update yet.`
            : `${project}'s last update was ${need.days} days ago.`,
        action: "Post an update",
      };
  }
}
