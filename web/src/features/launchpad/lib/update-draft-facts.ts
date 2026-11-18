/**
 * What the update dialog gives the AI draft (`@creaton/core/launchpad/updateAi.ts`), and where the draft may go once it
 * comes back.
 *
 * The facts are the project's own record and nothing else: the work accepted since the last update that the founder
 * has not taken off, last week's promises with the marks chosen so far, the goals and the help still wanted.
 *
 * The draft is put only where the founder has written nothing of their own. A box that is empty, or still holds exactly
 * the last draft, takes the new one; a box the founder typed in, or changed while the AI was writing, is left alone.
 * "What's next" is never part of it.
 *
 * Pure and alias-free: `update-draft-facts.test.mjs` drives it under `node --test`.
 */

import type { UpdateDraftFacts } from "@creaton/core/launchpad/updateAi.ts";

import type { GoalLevel, GoalState } from "./goals.ts";
import type { MarkState } from "./promises.ts";

/** The boxes a draft can fill. */
export interface DraftFields {
  done: string;
  help: string;
  line: string;
}

const FIELDS = ["done", "help", "line"] as const;
export type DraftField = (typeof FIELDS)[number];

/** The record, as the draft may use it. */
export function draftFacts(input: {
  /** Work accepted since the last update, minus what the founder took off. */
  accepted: readonly { what: string }[];
  /** The promises last week made that are still to answer, and the marks chosen for them in the dialog so far. */
  promises: readonly { id: string; text: string }[];
  marks: Readonly<Record<string, { state: MarkState; note: string }>>;
  /** The goals as they stand: the main one, then the shorter ones that are open. */
  goals: readonly {
    level: GoalLevel;
    text: string;
    how: string;
    state: GoalState;
  }[];
  /** The words of each help request nobody has marked found. */
  help: readonly string[];
}): UpdateDraftFacts {
  return {
    accepted: input.accepted.map((task) => ({ what: task.what })),
    promises: input.promises.map((promise) => {
      const mark = input.marks[promise.id];
      return {
        text: promise.text,
        mark: mark ? mark.state : null,
        note: mark ? mark.note : "",
      };
    }),
    goals: input.goals.map((goal) => ({
      level: goal.level,
      text: goal.text,
      how: goal.how,
      state: goal.state,
    })),
    help: input.help.map((text) => ({ text })),
  };
}

/**
 * Where a draft goes. `atClick` is what the boxes held when the founder asked, `now` what they hold as the answer
 * arrives, and `last` what the previous draft put in them. A box takes the draft only when it was empty or held the
 * previous draft untouched at the click, and is still as it was now. `kept` names the boxes the draft had something
 * for that were left as the founder has them.
 */
export function placeDraft(input: {
  draft: DraftFields;
  atClick: DraftFields;
  now: DraftFields;
  last: DraftFields | null;
}): { next: DraftFields; kept: DraftField[]; filled: DraftField[] } {
  const next: DraftFields = { ...input.now };
  const kept: DraftField[] = [];
  const filled: DraftField[] = [];
  for (const field of FIELDS) {
    const drafted = input.draft[field];
    if (drafted === "") continue;
    const open =
      input.atClick[field].trim() === "" ||
      input.atClick[field] === input.last?.[field];
    if (open && input.now[field] === input.atClick[field]) {
      next[field] = drafted;
      filled.push(field);
    } else kept.push(field);
  }
  return { next, kept, filled };
}
