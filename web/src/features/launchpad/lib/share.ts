/**
 * Sharing a project's record: the link people open and the one sentence that goes with it. The sentence states only
 * what the record shows (weeks in a row, promises kept of answered); it never promises anything.
 *
 * Pure and alias-free: `share.test.mjs` drives it under `node --test`.
 */

import { doneAloneLine } from "./task-checks.ts";
import { updateDueWords } from "./weekly-update.ts";

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

const TITLE_CHARS = 80;

/**
 * What the record says about accepted work: the piece just accepted by its title, else how many pieces were
 * accepted. Null when it says neither. Never a price and never Shares.
 */
export function acceptedWords(input: {
  accepted?: number | null;
  workTitle?: string | null;
}): string | null {
  const title = (input.workTitle ?? "").replace(/\s+/g, " ").trim();
  if (title) {
    const chars = [...title];
    return `Work accepted: ${chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join("")}…` : title}`;
  }
  const n = input.accepted ?? 0;
  if (n > 0)
    return `${n} ${n === 1 ? "piece of work" : "pieces of work"} accepted`;
  return null;
}

/**
 * When a brand-new project's first update is due, as "Mon, Nov 23", or null when that is not known or has passed (a
 * project whose first update is late is not "just started"). `startedAt` and `now` are Unix seconds.
 */
export function firstUpdateDue(
  startedAt: number | null,
  now: number,
  locale?: string,
): string | null {
  if (startedAt === null) return null;
  const due = updateDueWords(startedAt, now, locale);
  if (!due || due.late) return null;
  return due.text.replace(/^Next update /, "");
}

/**
 * The record's own words on work only the founder checked, for a share: "1 piece of work done, checked by the
 * founder". Never "accepted": that word is for work someone else checked. Null for none.
 */
export function doneAloneWords(input: {
  doneAlone?: number | null;
}): string | null {
  return doneAloneLine(input.doneAlone ?? 0);
}

/**
 * "Nebula on Creaton: 4 weeks in a row, 3 of 4 promises kept." and then the link.
 *
 * `variant` "started" is for a brand-new project: "Nebula on Creaton: just started. First update due Mon, Nov 23."
 * (or "...Follow along as it gets built." when the due date is not known). "accepted" leads with the work someone
 * else accepted, and "done" with the work the founder checked alone, in its own words. Without one, or when the record
 * holds nothing for the variant, the
 * sentence is the record's own facts, and with none of those it only says to follow along. Given a variant, weeks in a
 * row are stated only once at least two promises are answered, as on the picture; without one, from two weeks.
 */
export function shareWords(input: {
  name: string;
  app: string;
  streak: number | null;
  kept: number | null;
  answered: number | null;
  url: string;
  variant?: "started" | "kept" | "accepted" | "done";
  accepted?: number | null;
  /** Pieces of work only the founder checked: stated for the "done" variant, apart from `accepted`. */
  doneAlone?: number | null;
  /** When the first update is due ("Mon, Nov 23"), for the "started" variant. */
  firstDue?: string | null;
  workTitle?: string | null;
}): string {
  const head = `${input.name} on ${input.app}`;
  if (input.variant === "started")
    return input.firstDue
      ? `${head}: just started. First update due ${input.firstDue}. ${input.url}`
      : `${head}: just started. Follow along as it gets built. ${input.url}`;
  const facts: string[] = [];
  const work = input.variant === "accepted" ? acceptedWords(input) : null;
  if (work) facts.push(work);
  const alone = input.variant === "done" ? doneAloneWords(input) : null;
  if (alone) facts.push(alone);
  const streakStated =
    input.variant === undefined || (input.answered ?? 0) >= 2;
  if (streakStated && input.streak && input.streak >= 2)
    facts.push(`${input.streak} weeks in a row`);
  if (input.kept !== null && input.answered)
    facts.push(
      `${input.kept} of ${input.answered} ${input.answered === 1 ? "promise" : "promises"} kept`,
    );
  return `${facts.length > 0 ? `${head}: ${facts.join(", ")}.` : `${head}: follow along as it gets built.`} ${input.url}`;
}
