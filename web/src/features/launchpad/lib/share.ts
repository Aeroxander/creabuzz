/**
 * Sharing a project's record: the link people open and the one sentence that goes with it. The sentence states only
 * what the record shows (weeks in a row, promises kept of answered); it never promises anything.
 *
 * Pure and alias-free: `share.test.mjs` drives it under `node --test`.
 */

/** Where a project's public page lives. */
export function projectSharePath(project: { id: string; author: string }) {
  return `/launchpad/${encodeURIComponent(project.id)}?author=${project.author}`;
}

/** "Nebula on Creaton: 4 weeks in a row, 3 of 4 promises kept." and then the link. */
export function shareWords(input: {
  name: string;
  app: string;
  streak: number | null;
  kept: number | null;
  answered: number | null;
  url: string;
}): string {
  const facts: string[] = [];
  if (input.streak && input.streak >= 2)
    facts.push(`${input.streak} weeks in a row`);
  if (input.kept !== null && input.answered)
    facts.push(
      `${input.kept} of ${input.answered} ${input.answered === 1 ? "promise" : "promises"} kept`,
    );
  const head = `${input.name} on ${input.app}`;
  return `${facts.length > 0 ? `${head}: ${facts.join(", ")}.` : `${head}: follow along as it gets built.`} ${input.url}`;
}
