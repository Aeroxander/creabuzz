/**
 * The plain line a project page says when agents do some of its work: who answers for them. An agent is a labelled
 * account (`agent-label.ts`); the person who runs it is named only when the record proves it. An agent on the team,
 * or one that took a recent task, counts.
 *
 * Pure and alias-free: `agent-work.test.mjs` drives it under `node --test`.
 */

/** An agent as the record shows it: who runs it, when that is proven. */
interface AgentLike {
  owner: string | null;
}

/** The part of a task this needs. */
interface TaskLike {
  helperAgent: AgentLike | null;
  /** The helper agreed to this task, by something they signed. */
  agreed: string | null;
  state: string;
  accepted: { confirmedAt: number } | null;
  cancelled: unknown;
}

const DAY = 86_400;
/** A task counts as recent while it is open, or when its work was accepted within this many days. */
export const RECENT_DAYS = 30;

/**
 * The agents behind a project's recent tasks: the helper's agent mark for every task the helper agreed to that is
 * still open, or was accepted in the last {@link RECENT_DAYS} days. A cancelled task counts for nobody.
 */
export function recentTaskAgents(
  tasks: readonly TaskLike[],
  now: number,
): AgentLike[] {
  return tasks.flatMap((task) => {
    if (!task.helperAgent || task.agreed === null || task.cancelled) return [];
    const open = task.state !== "confirmed";
    const recent =
      task.accepted !== null &&
      now - task.accepted.confirmedAt <= RECENT_DAYS * DAY;
    return open || recent ? [task.helperAgent] : [];
  });
}

/** The people proven to run the agents, each once, in the order first met. */
export function operatorsOf(agents: readonly AgentLike[]): string[] {
  const seen = new Set<string>();
  for (const agent of agents) if (agent.owner) seen.add(agent.owner);
  return [...seen];
}

/** "Sam", "Sam and Ola", "Sam, Ola and Kim". */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The line for a page: null when no agent works on the project. With a proven operator: who answers for the agents and
 * signs the promises. With none proven, it says only that the record does not say who runs them: it never names
 * someone it cannot show.
 */
export function agentWorkLine(
  agents: readonly AgentLike[],
  operatorNames: readonly string[],
): string | null {
  if (agents.length === 0) return null;
  const lead = "Some of this work is done by agents.";
  if (operatorNames.length === 0)
    return `${lead} Their records do not say who runs them.`;
  const plural = operatorNames.length > 1;
  return `${lead} ${listOf(operatorNames)} ${plural ? "answer" : "answers"} for them and ${plural ? "sign" : "signs"} the promises.`;
}
