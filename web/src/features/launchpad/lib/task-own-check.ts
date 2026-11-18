/**
 * Whether a confirmation is the founder's own check of their own work, and when a founder is alone on a project.
 *
 * The server holds this when a confirmation is written (`founder_alone` in `launch_update_authority.rs`): the founder
 * may confirm a task whose helper is the founder, or an agent the founder runs, while the project record lists no
 * other person. "Another person" is any team member who is neither the founder nor that helper and is not an agent
 * account (an agent can never confirm, so a team of the founder and agents is still one person). A reader cannot ask
 * the server's agent-owner records, so it works from what it can see: the helper's records (which can prove who runs
 * it), and the profiles of the team (which say who is an agent). Where it cannot tell, it counts a person.
 *
 * Pure and alias-free: `tasks.test.mjs` drives it under `node --test`.
 */

/** Accounts known to be agents, from their own profiles. An agent can never confirm work. */
export type KnownAgents = ReadonlySet<string>;

export const NO_KNOWN_AGENTS: KnownAgents = new Set();

/**
 * Whether the founder has nobody to check their work: no team member besides the founder and `helper` is a person.
 * `team` holds the founder and everyone on the project's record.
 */
export function founderIsAlone(input: {
  founder: string;
  helper: string;
  team: ReadonlySet<string>;
  agents?: KnownAgents;
}): boolean {
  const agents = input.agents ?? NO_KNOWN_AGENTS;
  return ![...input.team].some(
    (member) =>
      member !== input.founder &&
      member !== input.helper &&
      !agents.has(member),
  );
}

/**
 * Whether the work is the founder's own: they did it, or an agent they run did. `owners` are the people the helper's
 * records prove run it. A helper that is an agent with no proof of who runs it counts too: the server lets a lone
 * founder check it either way, and nobody else on the project is a person who could.
 */
export function isFoundersOwnWork(input: {
  founder: string;
  helper: string;
  helperIsAgent: boolean;
  owners: ReadonlySet<string>;
}): boolean {
  if (input.helper === input.founder || input.owners.has(input.founder))
    return true;
  return input.helperIsAgent && input.owners.size === 0;
}

/**
 * What one confirmation counts as: `accepted` (someone else's check), `own` (the founder's check of their own work,
 * worded and counted apart) or `ignored` (it does not count: the helper, whoever runs the helper, or an agent signed
 * it, or a team member checked their own work).
 */
export type ConfirmVerdict = "accepted" | "own" | "ignored";

export function judgeConfirmation(input: {
  author: string;
  founder: string;
  helper: string;
  /** The author is on the project's team now. */
  onTeam: boolean;
  team: ReadonlySet<string>;
  /** The people the helper's records prove run it. */
  owners: ReadonlySet<string>;
  /** The helper's records say it is an agent, or its profile does. */
  helperIsAgent: boolean;
  agents?: KnownAgents;
  /** The confirmation itself says an agent signed it. */
  signedAsAgent: boolean;
}): ConfirmVerdict {
  const agents = input.agents ?? NO_KNOWN_AGENTS;
  // An agent is never a person's yes, whatever its place on the team.
  if (input.signedAsAgent || agents.has(input.author)) return "ignored";
  const isFounder = input.author === input.founder && input.onTeam;
  // Nobody grades their own work: not the helper, and not whoever runs the helper. Except the founder, whose check
  // is kept and marked as their own.
  if (input.author === input.helper || input.owners.has(input.author))
    return isFounder ? "own" : "ignored";
  // The founder checking an agent's work that nothing ties to anyone else, with nobody else on the project who could.
  if (
    isFounder &&
    isFoundersOwnWork(input) &&
    founderIsAlone({ ...input, agents })
  )
    return "own";
  return "accepted";
}

/** The part of a task record that decides whom to ask about. */
interface AskedRecord {
  id: string;
  part: string;
  author: string;
  coordinate: string;
  taskId: string;
  helper: string | null;
}

/** How many accounts are asked about at most (the server asks 32; past this they count as people). */
const AGENT_LOOKUPS = 12;

/**
 * The accounts whose profiles say whether a founder was alone when work was checked: when anything on the project was
 * confirmed, the founder, the helpers of the tasks the founder confirmed, then the rest of the team. Nobody when
 * nothing was confirmed, so a project with no checked work reads nothing. Sorted, so the same people are one cache entry.
 */
export function whoToAsk(
  records: readonly AskedRecord[],
  coordinate: string,
  founder: string,
  team: readonly string[],
): string[] {
  const mine = records.filter((r) => r.coordinate === coordinate);
  if (!mine.some((r) => r.part === "confirm")) return [];
  const confirmedByFounder = new Set(
    mine
      .filter((r) => r.part === "confirm" && r.author === founder)
      .map((r) => r.taskId),
  );
  const helpers = mine
    .filter((r) => r.part === "task" && confirmedByFounder.has(r.id))
    .map((r) => r.helper)
    .filter((helper): helper is string => Boolean(helper));
  return [...new Set([founder, ...helpers, ...team])]
    .slice(0, AGENT_LOOKUPS)
    .sort();
}

/** How many accounts are asked about at most across several projects at once (a feed, a profile). */
const AGENT_LOOKUPS_ACROSS = 36;

/**
 * The accounts to ask about for many projects at once: each project's own list (`whoToAsk`), joined, founders first
 * and cut at a bound. Past the bound the rest count as people, as in `whoToAsk`. Sorted, so the same people are one
 * cache entry.
 */
export function whoToAskAcross(
  records: readonly AskedRecord[],
  projects: Iterable<{
    coordinate: string;
    founder: string;
    team: Iterable<string>;
  }>,
): string[] {
  const asked = new Set<string>();
  for (const project of projects) {
    for (const pubkey of whoToAsk(
      records,
      project.coordinate,
      project.founder,
      [...project.team],
    )) {
      if (asked.size >= AGENT_LOOKUPS_ACROSS) break;
      asked.add(pubkey);
    }
  }
  return [...asked].sort();
}
