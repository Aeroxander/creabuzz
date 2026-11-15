/**
 * "Post updates from your agent": which projects get the card, and the commands it shows. The commands are the
 * `buzz launchpad updates` ones an operator's own agent runs (`docs/agents/WORKER-LOOP.md`); an agent's update makes
 * no promises, because a promise needs a person.
 *
 * Pure and alias-free: `agent-post.test.mjs` drives it under `node --test`.
 */

/** The categories Start offers for AI projects (`LAUNCH_CATEGORIES` holds both spellings). */
const AI_CATEGORIES: ReadonlySet<string> = new Set([
  "ai agent or tool",
  "ai agents",
]);

/** Whether a project's category says it is about AI work. */
export function isAiCategory(category: string | null | undefined): boolean {
  return AI_CATEGORIES.has((category ?? "").trim().toLowerCase());
}

/** A word for a shell: left bare when it is plain, else in single quotes with any quote inside it closed and reopened. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9._@%+=:,/-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The two commands the card offers: read what the record shows, then post from it. `--author` names the founder, which
 * a team member's agent needs, because it posts as part of the founder's project.
 */
export function agentPostCommands(project: {
  id: string;
  author: string;
}): string[] {
  const id = shellWord(project.id);
  const author = shellWord(project.author);
  return [
    `buzz launchpad updates facts ${id} --author ${author}`,
    `buzz launchpad updates post ${id} --author ${author} --title "Week 1" --done "What happened, from the facts" --no-promises`,
  ];
}
