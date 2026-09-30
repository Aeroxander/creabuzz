/**
 * Task planning: what the team should build next, and turning finished work
 * into credit.
 *
 * - **Rows merge field by field.** A task is many kind:44011 rows sharing a
 *   `d` tag. Status comes from the newest row, but a planning field (title,
 *   description, priority, due, labels, milestone, reward) comes from the
 *   newest row that WROTE it. A writer that omits a field — the fleet worker
 *   republishing `{title, status}` when an agent picks a task up, an older
 *   client — can no longer erase it. Clearing a field is an explicit `null`.
 *   Merging is order-independent, so rows arriving out of order (history
 *   after live) cannot resurrect a stale status.
 * - **Backing.** Members back a task with a `+` reaction naming the task's
 *   coordinate (`44011:<creator>:<d>`), so support survives task edits.
 *   Support is trust-weighted by the same rule as feed votes.
 * - **Next up.** Tasks nobody has started, ordered by support, then priority,
 *   then due date — the team's own answer to "what do we build next".
 * - **Claim as contribution.** A finished task becomes a kind:37013
 *   contribution record keyed by the done row's event id — the key the fleet
 *   worker and `buzz org contribute classify` use — so a task is credited at
 *   most once whichever surface files it. A reviewer accepts it as usual.
 *
 * Pure and alias-free: `task-planning.test.mjs` drives it under `node --test`.
 */

export const KIND_TASK = 44011;
export const KIND_TASK_REACTION = 7;
export const KIND_CONTRIBUTION = 37013;

/** Content fields that persist until a row writes them again. */
export const TASK_STICKY_FIELDS = [
  "title",
  "description",
  "priority",
  "due",
  "labels",
  "milestone",
  "reward",
] as const;

/** Rows kept per task — enough history to merge, bounded against floods. */
export const MAX_ROWS_PER_TASK = 100;

/** A kind:44011 row (or any event) as read from the relay. */
export interface TaskRowEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface MergedTask {
  /** The newest row, carrying the merged content — feed it to `parseTask`. */
  event: TaskRowEvent;
  /** Pubkey that created the task (the earliest row's signer). */
  creator: string;
  /** Id of the newest row, the target a backing reaction points at. */
  latestRowId: string;
  /**
   * Id of the row that marked the task done, when it is done now; the key a
   * contribution record for this task uses. Null for unfinished tasks.
   */
  doneRowId: string | null;
}

function jsonObject(content: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Whether a parsed row body wrote `field`. `in` (not `Object.hasOwn`, which
 * the web build's target predates): the fields asked about never live on
 * `Object.prototype`, so an inherited match is impossible.
 */
function has(body: Record<string, unknown>, field: string): boolean {
  return field in body;
}

function byAge(a: TaskRowEvent, b: TaskRowEvent): number {
  return (
    a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Newest-last, bounded to the most recent `MAX_ROWS_PER_TASK` rows. */
export function keepRecentRows(rows: readonly TaskRowEvent[]): TaskRowEvent[] {
  const seen = new Set<string>();
  const unique = rows.filter((r) => !seen.has(r.id) && seen.add(r.id));
  return unique.sort(byAge).slice(-MAX_ROWS_PER_TASK);
}

/**
 * Merge every row of one task (same `d`) into one view. Status, approver and
 * tags come from the newest row; each sticky field from the newest row that
 * wrote it. Returns null for an empty row set.
 */
export function mergeTaskRows(
  rows: readonly TaskRowEvent[],
): MergedTask | null {
  if (rows.length === 0) return null;
  const sorted = keepRecentRows(rows);
  const newest = sorted[sorted.length - 1];
  const merged: Record<string, unknown> = {};
  for (const row of sorted) {
    const body = jsonObject(row.content);
    for (const field of TASK_STICKY_FIELDS) {
      if (has(body, field)) merged[field] = body[field];
    }
  }
  const newestBody = jsonObject(newest.content);
  if (has(newestBody, "status")) merged.status = newestBody.status;
  if (has(newestBody, "approver")) {
    merged.approver = newestBody.approver;
  }
  const done = newestBody.status === "done" ? newest.id : null;
  return {
    event: { ...newest, content: JSON.stringify(merged) },
    creator: sorted[0].pubkey.toLowerCase(),
    latestRowId: newest.id,
    doneRowId: done,
  };
}

/** A task's reward in points, or null when it has none. */
export function readReward(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

/** A task's milestone label, or null. Trimmed, bounded to 120 characters. */
export function readMilestone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, 120);
}

/** The coordinate backing reactions count toward. */
export function taskCoordinate(creator: string, d: string): string {
  return `${KIND_TASK}:${creator.toLowerCase()}:${d}`;
}

/**
 * A reaction template (unsigned) that backs a task. A channel task's backing
 * carries the channel (`h`), because the relay keeps channel events off
 * global reads — the board reads backing per channel, like the tasks.
 */
export function buildTaskBacking(input: {
  d: string;
  creator: string;
  latestRowId: string;
  channelId?: string | null;
}): { kind: number; tags: string[][]; content: string } {
  const tags = [
    ["e", input.latestRowId],
    ["p", input.creator.toLowerCase()],
    ["k", String(KIND_TASK)],
    ["a", taskCoordinate(input.creator, input.d)],
  ];
  if (input.channelId) tags.push(["h", input.channelId]);
  return { kind: KIND_TASK_REACTION, tags, content: "+" };
}

export interface PlannableTask {
  /** `d` tag. */
  id: string;
  creator: string;
  status: string;
  priority: "low" | "normal" | "high" | "urgent";
  /** Due date, ms since epoch, or null. */
  due: number | null;
  updatedAt: number;
}

/** Statuses that count as "not started yet" for Next up. */
export const NEXT_UP_STATUSES = new Set(["open", "assigned"]);

const PRIORITY_RANK: Record<PlannableTask["priority"], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Unstarted tasks in the order the team should take them: most support
 * first, then priority, then earliest due date (none last), then most
 * recently touched.
 */
export function nextUpOrder<T extends PlannableTask>(
  tasks: readonly T[],
  supportOf: (task: T) => number,
): T[] {
  return tasks
    .filter((t) => NEXT_UP_STATUSES.has(t.status))
    .map((task) => ({ task, support: supportOf(task) }))
    .sort((a, b) => {
      if (b.support !== a.support) return b.support - a.support;
      const pa = PRIORITY_RANK[a.task.priority] ?? 2;
      const pb = PRIORITY_RANK[b.task.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      const da = a.task.due ?? Number.POSITIVE_INFINITY;
      const db = b.task.due ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return b.task.updatedAt - a.task.updatedAt;
    })
    .map(({ task }) => task);
}

/**
 * Who may claim a finished task as their contribution: its assignee, or its
 * creator when nobody was assigned. An agent's tasks are credited by the
 * fleet worker, so a person never claims someone else's work.
 */
export function canClaimTask(
  task: { assignee: string | null; creator: string },
  viewer: string | null,
): boolean {
  if (!viewer) return false;
  const who = viewer.toLowerCase();
  return task.assignee
    ? task.assignee.toLowerCase() === who
    : task.creator.toLowerCase() === who;
}

/**
 * The pending contribution record (unsigned) for a finished task, filed by
 * the person who did it. `amount` carries the task's reward so the reviewer
 * sees — and the royalty and participation math pays — exactly that.
 */
export function buildTaskContribution(input: {
  doneRowId: string;
  title: string;
  description: string;
  reward: number | null;
  milestone: string | null;
}): { kind: number; tags: string[][]; content: string } {
  const action = [input.title.trim(), input.description.trim()]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 2000);
  const tags: string[][] = [
    ["d", input.doneRowId],
    ["e", input.doneRowId],
    ["k", String(KIND_TASK)],
  ];
  // Contribution records are community-level (global-only): no `h` tag.
  const content: Record<string, unknown> = {
    v: 1,
    action: action || "Finished task",
    dimensions: {},
    evidence: [input.doneRowId],
    humanVsAi: { human: 1, ai: 0 },
    informedBy: [input.doneRowId],
    reviewStatus: "pending",
    appealHistory: [],
  };
  if (input.reward !== null) content.amount = input.reward;
  if (input.milestone) content.milestone = input.milestone;
  return { kind: KIND_CONTRIBUTION, tags, content: JSON.stringify(content) };
}
