/**
 * The two records Start publishes, in this order: the project (kind 37001, the lightest kind there is: no Shares, no
 * money, nothing sent to the network), then its main goal (an update record, `@creaton/core/project/goals.ts`). The
 * same records web/'s three-answer Start makes, so either app reads the other's projects.
 */
import { KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE } from "@creaton/core/kinds.ts";
import {
  GOAL_LIMITS,
  goalEvent,
  newGoalId,
} from "@creaton/core/project/goals.ts";
import { projectCoordinate, slugFromName } from "../project/project-record";

export const NAME_MAX = 80;
export const PITCH_MAX = 140;
export { GOAL_LIMITS };

export interface StartDraft {
  name: string;
  goal: string;
  how: string;
}

export const EMPTY_START: StartDraft = { name: "", goal: "", how: "" };

/** What is wrong with a draft, field by field; empty when it can be sent. */
export function startProblems(
  draft: StartDraft,
): Partial<Record<keyof StartDraft, string>> {
  const out: Partial<Record<keyof StartDraft, string>> = {};
  if (draft.name.trim().length > NAME_MAX)
    out.name = `A name can be up to ${NAME_MAX} characters.`;
  if (draft.goal.trim().length > GOAL_LIMITS.text)
    out.goal = `A goal can be up to ${GOAL_LIMITS.text} characters.`;
  if (draft.how.trim().length > GOAL_LIMITS.how)
    out.how = `This can be up to ${GOAL_LIMITS.how} characters.`;
  return out;
}

export function startReady(draft: StartDraft): boolean {
  return (
    draft.name.trim() !== "" &&
    draft.goal.trim() !== "" &&
    draft.how.trim() !== "" &&
    Object.keys(startProblems(draft)).length === 0
  );
}

/** The project's line under its name: the goal's first words, cut at a word. */
export function pitchFromGoal(goal: string): string {
  const text = goal.trim().replace(/\s+/g, " ");
  if (text.length <= PITCH_MAX) return text;
  const cut = text.slice(0, PITCH_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** An id for the project: its name as a slug, with a few letters added when the founder already has one by that id. */
export function projectId(
  name: string,
  taken: (id: string) => boolean,
  random: () => number = Math.random,
): string {
  const base = slugFromName(name) || "project";
  if (!taken(base)) return base;
  for (let tries = 0; tries < 20; tries += 1) {
    const suffix = Array.from({ length: 4 }, () =>
      Math.floor(random() * 36).toString(36),
    ).join("");
    const id = `${base.slice(0, 59)}-${suffix}`;
    if (!taken(id)) return id;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}

/** The project record, as web/'s Start writes it. */
export function projectRecordTemplate(
  id: string,
  draft: StartDraft,
  now: number,
): { kind: number; tags: string[][]; content: string; created_at: number } {
  return {
    kind: KIND_LAUNCH_RECORD,
    tags: [
      ["d", id],
      ["name", draft.name.trim()],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
    ],
    content: JSON.stringify({
      pitch: pitchFromGoal(draft.goal),
      stage: "draft",
      started: now,
    }),
    created_at: now,
  };
}

/** The main goal's record, naming the project it belongs to. */
export function goalRecordTemplate(
  founder: string,
  id: string,
  draft: StartDraft,
  random: () => number = Math.random,
): { kind: number; tags: string[][]; content: string } {
  const { content, tags } = goalEvent({
    id: newGoalId(random),
    level: "primary",
    text: draft.goal.trim(),
    how: draft.how.trim(),
    state: "open",
    reason: "",
  });
  return {
    kind: KIND_LAUNCH_UPDATE,
    tags: [["a", projectCoordinate(founder, id)], ...tags],
    content: JSON.stringify(content),
  };
}
