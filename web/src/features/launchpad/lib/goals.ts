/**
 * A project's goals: one main goal in the founder's words with how everyone will know it was reached, and shorter goals
 * under it (this quarter, this month, this week). The founder sets each one's state: open, reached, missed or changed.
 *
 * Every change is its own small signed update record from the founder, carrying the whole goal as it then stood:
 *
 *   goal          the goal's id (the same on every record about that goal)
 *   goal-level    primary | quarter | month | week
 *   goal-text     the goal, in the founder's words
 *   goal-how      how we'll know
 *   goal-state    open | reached | missed | changed
 *   goal-reason   one line: why it was missed or changed
 *   goal-under    the main goal a shorter goal was set under
 *
 * Nothing is edited in place, so nothing is erased: the newest record is the goal as it stands, and the older ones are
 * its history. A goal that was ever marked missed stays counted as missed, whatever it was marked afterwards. The
 * record's body says the same in plain words, so an app that only knows updates still shows something readable.
 *
 * Only the founder's records count. They are read with the project's other update records, for that project alone.
 *
 * Pure and alias-free: `goals.test.mjs` drives it under `node --test`.
 */

const GOAL_LEVELS = ["primary", "quarter", "month", "week"] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];

export const GOAL_STATES = ["open", "reached", "missed", "changed"] as const;
export type GoalState = (typeof GOAL_STATES)[number];

export const GOAL_LEVEL_LABEL: Record<GoalLevel, string> = {
  primary: "Goal",
  quarter: "This quarter",
  month: "This month",
  week: "This week",
};

export const GOAL_STATE_LABEL: Record<GoalState, string> = {
  open: "Open",
  reached: "Reached",
  missed: "Missed",
  changed: "Changed",
};

/** The longest each field may be: a goal is a sentence, not a plan. */
export const GOAL_LIMITS = { text: 200, how: 200, reason: 200 } as const;

const TAG_GOAL = "goal";
const TAG_LEVEL = "goal-level";
const TAG_TEXT = "goal-text";
const TAG_HOW = "goal-how";
const TAG_STATE = "goal-state";
const TAG_REASON = "goal-reason";
const TAG_UNDER = "goal-under";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

type Tags = readonly (readonly string[])[];

interface EventLike {
  id: string;
  pubkey: string;
  created_at: number;
  tags: Tags;
}

/** One record about a goal: the goal as it stood when the record was signed. */
export interface GoalVersion {
  eventId: string;
  author: string;
  at: number;
  id: string;
  level: GoalLevel;
  text: string;
  how: string;
  state: GoalState;
  reason: string;
  /** The main goal a shorter goal was set under, or empty. */
  under: string;
}

function tagOf(tags: Tags, name: string): string {
  const tag = tags.find((t) => t[0] === name);
  return typeof tag?.[1] === "string" ? tag[1] : "";
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function isLevel(value: string): value is GoalLevel {
  return (GOAL_LEVELS as readonly string[]).includes(value);
}

function isState(value: string): value is GoalState {
  return (GOAL_STATES as readonly string[]).includes(value);
}

/** Whether a record's tags mark it as a goal record (so it is never listed as a weekly update). */
export function isGoalRecordTags(tags: Tags): boolean {
  return tags.some((tag) => tag[0] === TAG_GOAL);
}

/** The goal record an update record is, or null when it is not one or cannot be read as one. */
export function parseGoalVersion(event: EventLike): GoalVersion | null {
  const id = tagOf(event.tags, TAG_GOAL);
  const level = tagOf(event.tags, TAG_LEVEL);
  const state = tagOf(event.tags, TAG_STATE);
  const text = clip(tagOf(event.tags, TAG_TEXT), GOAL_LIMITS.text);
  if (!ID_RE.test(id) || !isLevel(level) || !isState(state) || text === "")
    return null;
  const under = tagOf(event.tags, TAG_UNDER);
  return {
    eventId: event.id,
    author: event.pubkey,
    at: event.created_at,
    id,
    level,
    text,
    how: clip(tagOf(event.tags, TAG_HOW), GOAL_LIMITS.how),
    state,
    reason: clip(tagOf(event.tags, TAG_REASON), GOAL_LIMITS.reason),
    under: ID_RE.test(under) ? under : "",
  };
}

/** A new goal's id: short, random, and only ever compared for equality. */
export function newGoalId(random: () => number = Math.random): string {
  let out = "g";
  for (let i = 0; i < 10; i += 1) out += Math.floor(random() * 36).toString(36);
  return out;
}

export interface GoalInput {
  id: string;
  level: GoalLevel;
  text: string;
  how: string;
  state: GoalState;
  reason: string;
  under?: string;
}

/** The field a goal's problem is about, so the form can point at it. */
export type GoalField = "text" | "how" | "reason";

/**
 * Why a goal cannot be saved yet and which field it is about, or null when it can. `previous` is the goal as it
 * stands, when there is one: marking it missed or changed, or rewording it, needs a one-line reason.
 */
export function goalProblem(
  input: GoalInput,
  previous: Pick<GoalVersion, "text" | "how"> | null = null,
): { field: GoalField; message: string } | null {
  const text = input.text.trim();
  if (text.length < 3)
    return { field: "text", message: "Say what the goal is." };
  if (text.length > GOAL_LIMITS.text)
    return {
      field: "text",
      message: `Keep the goal under ${GOAL_LIMITS.text} characters.`,
    };
  const how = input.how.trim();
  if (how.length < 3)
    return { field: "how", message: "Say how we'll know it was reached." };
  if (how.length > GOAL_LIMITS.how)
    return {
      field: "how",
      message: `Keep "How we'll know" under ${GOAL_LIMITS.how} characters.`,
    };
  const reason = input.reason.trim();
  if (reason.length > GOAL_LIMITS.reason)
    return {
      field: "reason",
      message: `Keep the reason under ${GOAL_LIMITS.reason} characters.`,
    };
  if (input.state === "missed" && reason === "")
    return { field: "reason", message: "Say in one line why it was missed." };
  const reworded =
    previous !== null && (previous.text !== text || previous.how !== how);
  if ((input.state === "changed" || reworded) && reason === "")
    return { field: "reason", message: "Say in one line why it changed." };
  return null;
}

/** {@link goalProblem}'s words alone. */
export function goalIssue(
  input: GoalInput,
  previous: Pick<GoalVersion, "text" | "how"> | null = null,
): string | null {
  return goalProblem(input, previous)?.message ?? null;
}

const STATE_TITLE: Record<GoalState, string> = {
  open: "Goal",
  reached: "Goal reached",
  missed: "Goal missed",
  changed: "Goal changed",
};

/** The update record's content and tags for a goal as it now stands. */
export function goalEvent(input: GoalInput): {
  content: { title: string; body: string };
  tags: string[][];
} {
  const text = clip(input.text, GOAL_LIMITS.text);
  const how = clip(input.how, GOAL_LIMITS.how);
  const reason = clip(input.reason, GOAL_LIMITS.reason);
  const tags: string[][] = [
    [TAG_GOAL, input.id],
    [TAG_LEVEL, input.level],
    [TAG_TEXT, text],
    [TAG_HOW, how],
    [TAG_STATE, input.state],
  ];
  if (reason) tags.push([TAG_REASON, reason]);
  if (input.under && input.level !== "primary")
    tags.push([TAG_UNDER, input.under]);
  const lines = [
    input.level === "primary"
      ? text
      : `${GOAL_LEVEL_LABEL[input.level]}: ${text}`,
    `How we'll know: ${how}`,
    ...(reason ? [`Why: ${reason}`] : []),
  ];
  return {
    content: { title: STATE_TITLE[input.state], body: lines.join("\n") },
    tags,
  };
}

type GoalStep = "set" | "reached" | "missed" | "changed" | "reopened";

/** One thing that happened to a goal. */
interface GoalHistoryEntry {
  at: number;
  step: GoalStep;
  /** The goal's words after this step. */
  text: string;
  how: string;
  /** The words before this step, when the step changed them: what the goal was. */
  was: { text: string; how: string } | null;
  reason: string;
}

/** A goal as the page shows it: how it stands, and everything that happened to it, oldest first. */
export interface GoalView {
  id: string;
  level: GoalLevel;
  text: string;
  how: string;
  state: GoalState;
  /** Why it stands as missed or changed, or why its words last changed. */
  reason: string;
  setAt: number;
  /** When it last changed. */
  at: number;
  history: GoalHistoryEntry[];
}

const byTime = (a: GoalVersion, b: GoalVersion) =>
  a.at - b.at || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);

function viewOf(versions: GoalVersion[]): GoalView {
  const ordered = [...versions].sort(byTime);
  const first = ordered[0];
  const history: GoalHistoryEntry[] = [
    {
      at: first.at,
      step: first.state === "open" ? "set" : first.state,
      text: first.text,
      how: first.how,
      was: null,
      reason: first.reason,
    },
  ];
  let prev = first;
  for (const next of ordered.slice(1)) {
    const reworded = next.text !== prev.text || next.how !== prev.how;
    const moved = next.state !== prev.state;
    // The same goal sent twice (a retried send) is not a second step.
    if (reworded || moved)
      history.push({
        at: next.at,
        step: moved
          ? next.state === "open"
            ? "reopened"
            : next.state
          : "changed",
        text: next.text,
        how: next.how,
        was: reworded ? { text: prev.text, how: prev.how } : null,
        reason: next.reason,
      });
    prev = next;
  }
  return {
    id: first.id,
    // A goal keeps the level it was set at.
    level: first.level,
    text: prev.text,
    how: prev.how,
    state: prev.state,
    reason: history[history.length - 1].reason,
    setAt: first.at,
    at: history[history.length - 1].at,
    history,
  };
}

export interface ProjectGoals {
  /** The main goal: the newest one set, however it stands. Null when none was read. */
  primary: GoalView | null;
  /** Open shorter goals: this quarter, then this month, then this week, newest first within each. */
  shorter: GoalView[];
  /** Everything else: earlier main goals and shorter goals that are no longer open, newest change first. */
  earlier: GoalView[];
}

const LEVEL_ORDER: Record<GoalLevel, number> = {
  primary: 0,
  quarter: 1,
  month: 2,
  week: 3,
};

/** The project's goals from its goal records. Only `founder`'s records count. */
export function projectGoals(
  versions: readonly GoalVersion[],
  founder: string,
): ProjectGoals {
  const byId = new Map<string, GoalVersion[]>();
  for (const version of versions) {
    if (version.author !== founder) continue;
    const list = byId.get(version.id);
    if (list) list.push(version);
    else byId.set(version.id, [version]);
  }
  const views = [...byId.values()].map(viewOf);
  const primaries = views
    .filter((goal) => goal.level === "primary")
    .sort((a, b) => b.setAt - a.setAt || (a.id < b.id ? -1 : 1));
  const primary = primaries[0] ?? null;
  const rest = views.filter((goal) => goal !== primary);
  return {
    primary,
    shorter: rest
      .filter((goal) => goal.level !== "primary" && goal.state === "open")
      .sort(
        (a, b) =>
          LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
          b.setAt - a.setAt ||
          (a.id < b.id ? -1 : 1),
      ),
    earlier: rest
      .filter((goal) => goal.level === "primary" || goal.state !== "open")
      .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)),
  };
}

/** Every goal the page knows, main goal first. */
export function allGoals(goals: ProjectGoals): GoalView[] {
  return [
    ...(goals.primary ? [goals.primary] : []),
    ...goals.shorter,
    ...goals.earlier,
  ];
}

export interface GoalTotals {
  reached: number;
  missed: number;
  changed: number;
}

/**
 * How many goals were ever reached, ever missed and ever changed. "Ever" on purpose: a goal marked missed and later
 * marked something else is still a goal that was missed.
 */
export function goalTotals(goals: readonly GoalView[]): GoalTotals {
  const ever = (goal: GoalView, step: GoalStep) =>
    goal.history.some((entry) => entry.step === step);
  return {
    reached: goals.filter((goal) => ever(goal, "reached")).length,
    missed: goals.filter((goal) => ever(goal, "missed")).length,
    changed: goals.filter((goal) => ever(goal, "changed")).length,
  };
}

/** "2 goals reached, 1 missed, 1 changed", or null when no goal was ever any of them. */
export function goalTotalsLine(totals: GoalTotals): string | null {
  if (totals.reached + totals.missed + totals.changed === 0) return null;
  const goals = (n: number) => (n === 1 ? "1 goal" : `${n} goals`);
  return `${goals(totals.reached)} reached, ${totals.missed} missed, ${totals.changed} changed`;
}

const STEP_WORDS: Record<GoalStep, string> = {
  set: "Set",
  reached: "Reached",
  missed: "Missed",
  changed: "Changed",
  reopened: "Opened again",
};

/** "Missed", "Changed", "Set": the word a history line starts with. */
export function goalStepWord(step: GoalStep): string {
  return STEP_WORDS[step];
}

/** A goal's steps that belong on the project's record: reached, missed and changed, with when and why. */
export interface GoalRecordEntry {
  goalId: string;
  level: GoalLevel;
  step: "reached" | "missed" | "changed";
  at: number;
  text: string;
  was: { text: string; how: string } | null;
  reason: string;
}

/** Every time a goal was reached, missed or changed, newest first. */
export function goalRecordEntries(
  goals: readonly GoalView[],
): GoalRecordEntry[] {
  const out: GoalRecordEntry[] = [];
  for (const goal of goals)
    for (const entry of goal.history)
      if (
        entry.step === "reached" ||
        entry.step === "missed" ||
        entry.step === "changed"
      )
        out.push({
          goalId: goal.id,
          level: goal.level,
          step: entry.step,
          at: entry.at,
          text: entry.text,
          was: entry.was,
          reason: entry.reason,
        });
  return out.sort((a, b) => b.at - a.at || (a.goalId < b.goalId ? -1 : 1));
}
