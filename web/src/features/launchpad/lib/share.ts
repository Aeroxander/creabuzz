/**
 * Sharing a project's record: the link people open and the one sentence that goes with it. The sentence states only
 * what the record shows (weeks in a row, promises kept of answered); it never promises anything.
 *
 * Pure and alias-free: `share.test.mjs` drives it under `node --test`.
 */

/** How much of the founder's account id a scorecard address carries: enough that no two projects share one. */
const FOUNDER_PART = 16;
const SLUG_RE = /^(.+)-([0-9a-f]{16})$/;

/**
 * Where a project's public scorecard lives: `/p/<project id>-<start of the founder's account id>`. The founder's
 * part is there because two founders may pick the same project id; the page opens only the project whose founder
 * matches it.
 */
export function projectSharePath(project: { id: string; author: string }) {
  return `/p/${encodeURIComponent(project.id)}-${project.author.slice(0, FOUNDER_PART).toLowerCase()}`;
}

/** The project id and the start of the founder's account id a scorecard address names, or null when it names none. */
export function parseScorecardSlug(
  slug: string,
): { id: string; founderStart: string } | null {
  const match = SLUG_RE.exec(slug);
  return match ? { id: match[1], founderStart: match[2] } : null;
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
