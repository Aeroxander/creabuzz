/**
 * The records a founder may point a milestone at: one of the project's own public records, named by its event id. They
 * are the same three things the project's page treats as proof of progress: an update the founder signed, a goal the
 * founder marked as reached, and a piece of work the team accepted. Nothing else is offered, so a milestone can never
 * name a record that is not the project's own.
 *
 * Pure and alias-free: `backing-records.test.mjs` drives it under `node --test`.
 */

export type RecordKind = "update" | "goal" | "work";

export interface RecordChoice {
  /** The event id (64 hex characters): what the milestone stores. */
  id: string;
  kind: RecordKind;
  /** What the person picks by, in words. */
  label: string;
  /** When it was signed. */
  at: number;
}

/** The slices of the project's reads this needs. */
export interface ChoiceInput {
  founder: string;
  updates: readonly {
    id: string;
    author: string;
    createdAt: number;
    title: string;
    claim?: unknown;
    workArea?: unknown;
    checkNote?: unknown;
  }[];
  goals: readonly {
    eventId: string;
    author: string;
    at: number;
    state: string;
    text: string;
  }[];
  tasks:
    | readonly {
        state: string;
        what: string;
        accepted: { id: string; confirmedAt: number } | null;
      }[]
    | null;
  /** Now, in seconds: a record dated ahead of it is shown as signed now. */
  now: number;
  limit?: number;
}

export const KIND_WORD: Record<RecordKind, string> = {
  update: "Update",
  goal: "Goal reached",
  work: "Work accepted",
};

/** How many choices are offered: the newest. */
export const CHOICES_SHOWN = 40;

const ID_RE = /^[0-9a-f]{64}$/;

const clip = (text: string, max: number): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

export function milestoneChoices(input: ChoiceInput): RecordChoice[] {
  const out: RecordChoice[] = [];
  for (const update of input.updates) {
    if (update.author !== input.founder) continue;
    // Evidence for a claim, a work area's words and a check note are records of work in progress, not news.
    if (update.claim || update.workArea || update.checkNote) continue;
    if (!ID_RE.test(update.id)) continue;
    out.push({
      id: update.id,
      kind: "update",
      label: clip(update.title || "Update", 70),
      at: Math.min(update.createdAt, input.now),
    });
  }
  for (const goal of input.goals) {
    if (goal.author !== input.founder || goal.state !== "reached") continue;
    if (!ID_RE.test(goal.eventId)) continue;
    out.push({
      id: goal.eventId,
      kind: "goal",
      label: clip(goal.text, 70),
      at: Math.min(goal.at, input.now),
    });
  }
  for (const task of input.tasks ?? []) {
    if (task.state !== "confirmed" || !task.accepted) continue;
    if (!ID_RE.test(task.accepted.id)) continue;
    out.push({
      id: task.accepted.id,
      kind: "work",
      label: clip(task.what, 70),
      at: Math.min(task.accepted.confirmedAt, input.now),
    });
  }
  const seen = new Set<string>();
  return out
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    .filter((choice) => !seen.has(choice.id) && seen.add(choice.id))
    .slice(0, input.limit ?? CHOICES_SHOWN);
}
