/**
 * Who may check a piece of handed-in work, and how checked work is counted.
 *
 * The rule is the server's (`launch_update_authority.rs`): the person who did the work never confirms it, and
 * neither does whoever runs the agent that did. The one exception is a project's founder with nobody else on the
 * team who could: they check their own work, and that check is worded and counted apart from work someone else
 * accepted, on every page.
 *
 * Pure and alias-free: `tasks.test.mjs` drives it under `node --test`.
 */

import { founderOfCoordinate, type TaskView } from "./tasks.ts";

export type ConfirmRule =
  /** `alone`: the viewer is the founder checking their own work (or their agent's) with nobody else to check it. */
  | { may: true; alone: boolean }
  | {
      may: false;
      /**
       * `helper`: the viewer did the work. `runs-helper`: the viewer runs the agent that did it. `not-team`: the
       * viewer is not on the project's team. `signed-out`: nobody is signed in.
       */
      why: "helper" | "runs-helper" | "not-team" | "signed-out";
      /** Whether anyone else on the team could confirm this task: a person who neither did the work nor runs it. */
      someoneCan: boolean;
    };

/**
 * Whether the founder of `task`'s project has nobody to check their own work: the work is the founder's, or an
 * agent's the founder runs, and the team holds no other person. `agents` are the team members known to be agent
 * accounts: an agent can never confirm, so a team of the founder and agents is still one person.
 */
export function founderWorksAlone(
  task: Pick<TaskView, "helper" | "helperAgent" | "coordinate">,
  team: ReadonlySet<string>,
  agents: ReadonlySet<string> = NO_AGENTS,
): boolean {
  const founder = founderOfCoordinate(task.coordinate);
  const owner = task.helperAgent?.owner ?? null;
  if (task.helper !== founder && owner !== founder) return false;
  return ![...team].some(
    (member) =>
      member !== founder && member !== task.helper && !agents.has(member),
  );
}

const NO_AGENTS: ReadonlySet<string> = new Set();

/**
 * Whether `viewer` may confirm work on `task`, and if not, whether anyone can. The same rule the server holds: the
 * person who did the work (or runs the agent that did) never confirms it, except the project's founder while nobody
 * else on the team could (`founderWorksAlone`).
 */
export function confirmRule(
  task: Pick<TaskView, "helper" | "helperAgent" | "coordinate">,
  team: ReadonlySet<string>,
  viewer: string | null,
  agents: ReadonlySet<string> = NO_AGENTS,
): ConfirmRule {
  const owner = task.helperAgent?.owner ?? null;
  const someoneCan = [...team].some(
    (member) =>
      member !== task.helper && member !== owner && !agents.has(member),
  );
  if (!viewer) return { may: false, why: "signed-out", someoneCan };
  const own = viewer === task.helper || viewer === owner;
  if (
    own &&
    viewer === founderOfCoordinate(task.coordinate) &&
    team.has(viewer) &&
    founderWorksAlone(task, team, agents)
  )
    return { may: true, alone: true };
  if (viewer === task.helper) return { may: false, why: "helper", someoneCan };
  if (!team.has(viewer)) return { may: false, why: "not-team", someoneCan };
  if (viewer === owner) return { may: false, why: "runs-helper", someoneCan };
  return { may: true, alone: false };
}

/** Finished tasks someone other than the person who did the work accepted: never the founder's own check. */
export function acceptedByOthers<
  T extends Pick<TaskView, "state" | "selfChecked">,
>(tasks: readonly T[]): T[] {
  return tasks.filter(
    (task) => task.state === "confirmed" && !task.selfChecked,
  );
}

/** Finished tasks only their project's founder checked, working alone. */
export function doneAlone<T extends Pick<TaskView, "state" | "selfChecked">>(
  tasks: readonly T[],
): T[] {
  return tasks.filter((task) => task.state === "confirmed" && task.selfChecked);
}

/** "2 pieces of work done alone, checked by the founder", or null for none. */
export function doneAloneLine(n: number): string | null {
  if (n <= 0) return null;
  return `${n} ${n === 1 ? "piece" : "pieces"} of work done alone, checked by the founder`;
}
