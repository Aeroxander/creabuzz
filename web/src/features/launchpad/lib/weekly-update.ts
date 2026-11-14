/**
 * The weekly update: one post with three light prompts ("What happened this week", "What's next", "Help needed").
 *
 * It stays one update record. The prompts become readable text in its body, which every reader of an update already
 * shows, plus tags this app reads back so it can lay the parts out and show the help asked for as a card. A founder who
 * wants to write freely still can: the body is theirs and no part tags are written.
 *
 * Also here: how long ago a project last posted, when the next one is due, and how many weeks in a row it has posted.
 * That last one is a plain count for one project. It is never compared between projects.
 *
 * Pure and alias-free: `weekly-update.test.mjs` drives it under `node --test`.
 */

import {
  type MarkDraft,
  markTags,
  marksSection,
  promiseTags,
} from "./promises.ts";

export const HELP_SIZES = ["small", "medium", "large"] as const;
export type HelpSize = (typeof HELP_SIZES)[number];

export const HELP_SIZE_LABEL: Record<HelpSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/** The three prompts, as the dialog and the page head them. */
export const PART_HEADINGS = {
  done: "What happened this week",
  next: "What's next",
  help: "Help needed",
} as const;

/** The longest each part may be: a tag is not a place for an essay, and a card has to stay a card. */
export const UPDATE_LIMITS = {
  title: 120,
  part: 2000,
  help: 500,
  helpTime: 40,
} as const;

const TAG_PART = "update-part";
const TAG_HELP = "help-needed";
const TAG_HELP_SIZE = "help-size";
const TAG_HELP_TIME = "help-time";
/** Marks an update written freely (no prompts, promises or answers) as a weekly update all the same. */
const TAG_KIND = "update-kind";

/**
 * Whether an update record is a weekly update: it answers a prompt, makes or answers a promise, or carries the
 * dialog's own mark. Other records of the same kind (a review note, submitted work, a goal) are not.
 */
export function isWeeklyUpdateTags(
  tags: readonly (readonly string[])[],
): boolean {
  return tags.some(
    (tag) =>
      tag[0] === TAG_PART ||
      tag[0] === "promise" ||
      tag[0] === "promise-mark" ||
      (tag[0] === TAG_KIND && tag[1] === "weekly"),
  );
}

/** What the founder asked for: the words, a size they picked and, when they gave one, a rough time. */
export interface HelpAsk {
  text: string;
  size: HelpSize;
  /** In the founder's own words ("about 3 days"), or empty. */
  time: string;
}

/** An update's parts as the app shows them. Any of them may be empty. */
export interface UpdateParts {
  done: string;
  next: string;
  help: HelpAsk | null;
}

export interface UpdateDraft {
  title: string;
  /** "What happened this week". */
  done: string;
  /** "What's next". */
  next: string;
  /** Free-form words, used in place of the two prompts when the founder writes freely. */
  body: string;
  help: string;
  helpSize: HelpSize;
  helpTime: string;
  /** The founder's answers to the promises earlier updates made (`lib/promises.ts`). */
  marks?: readonly MarkDraft[];
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function isHelpSize(value: unknown): value is HelpSize {
  return (HELP_SIZES as readonly string[]).includes(value as string);
}

/** "Small, about 3 days" or "Small". */
function helpSizeLine(ask: Pick<HelpAsk, "size" | "time">): string {
  return ask.time
    ? `${HELP_SIZE_LABEL[ask.size]}, ${ask.time}`
    : HELP_SIZE_LABEL[ask.size];
}

/** The body's sections for these parts, exactly as {@link updateEvent} writes them after any free words. */
function partSections(parts: UpdateParts): string[] {
  const sections: string[] = [];
  if (parts.done) sections.push(`${PART_HEADINGS.done}\n${parts.done}`);
  if (parts.next) sections.push(`${PART_HEADINGS.next}\n${parts.next}`);
  if (parts.help)
    sections.push(
      `${PART_HEADINGS.help} (${helpSizeLine(parts.help)})\n${parts.help.text}`,
    );
  return sections;
}

/**
 * The update record's content and extra tags for a draft. The body reads on its own in any app that shows updates;
 * the tags carry the same parts for this one.
 */
export function updateEvent(
  draft: UpdateDraft,
  /**
   * `promises: false` for an update a team member posts: promises and the answers to them are the founder's alone
   * (the server refuses them from anyone else), so the lines of "What's next" are plans and no answer is attached.
   */
  options: { promises?: boolean } = {},
): {
  content: { title: string; body: string };
  tags: string[][];
} {
  const withPromises = options.promises !== false;
  const marks = withPromises ? (draft.marks ?? []) : [];
  const done = clip(draft.done, UPDATE_LIMITS.part);
  const next = clip(draft.next, UPDATE_LIMITS.part);
  const free = clip(draft.body, UPDATE_LIMITS.part * 2);
  const helpText = clip(draft.help, UPDATE_LIMITS.help);
  const helpTime = clip(draft.helpTime, UPDATE_LIMITS.helpTime);
  const size = isHelpSize(draft.helpSize) ? draft.helpSize : "small";
  const parts: UpdateParts = {
    done,
    next,
    help: helpText ? { text: helpText, size, time: helpTime } : null,
  };

  const answered = marksSection(marks);

  const tags: string[][] = [];
  if (done) tags.push([TAG_PART, "done", done]);
  if (next) tags.push([TAG_PART, "next", next]);
  // Each line of "What's next" is also its own tag: a promise the next update answers.
  if (withPromises) tags.push(...promiseTags(next), ...markTags(marks));
  if (helpText) {
    tags.push([TAG_HELP, helpText], [TAG_HELP_SIZE, size]);
    if (helpTime) tags.push([TAG_HELP_TIME, helpTime]);
  }
  // Written freely: nothing above says it is a weekly update, so it says so itself.
  if (!isWeeklyUpdateTags(tags)) tags.push([TAG_KIND, "weekly"]);
  return {
    content: {
      title: clip(draft.title, UPDATE_LIMITS.title),
      // The answers read as plain words after the founder's own, before the prompts' sections.
      body: [
        ...(free ? [free] : []),
        ...(answered ? [answered] : []),
        ...partSections(parts),
      ].join("\n\n"),
    },
    tags,
  };
}

/** The parts an update's tags carry, or null when it carries none (a free-form update, or one from before this). */
export function partsFromTags(
  tags: readonly (readonly string[])[],
): UpdateParts | null {
  let done = "";
  let next = "";
  let helpText = "";
  let size: HelpSize = "small";
  let time = "";
  for (const tag of tags) {
    const value = typeof tag[1] === "string" ? tag[1] : "";
    if (tag[0] === TAG_PART && typeof tag[2] === "string") {
      if (value === "done" && !done) done = clip(tag[2], UPDATE_LIMITS.part);
      if (value === "next" && !next) next = clip(tag[2], UPDATE_LIMITS.part);
    } else if (tag[0] === TAG_HELP && !helpText) {
      helpText = clip(value, UPDATE_LIMITS.help);
    } else if (tag[0] === TAG_HELP_SIZE && isHelpSize(value)) {
      size = value;
    } else if (tag[0] === TAG_HELP_TIME && !time) {
      time = clip(value, UPDATE_LIMITS.helpTime);
    }
  }
  if (!done && !next && !helpText) return null;
  return {
    done,
    next,
    help: helpText ? { text: helpText, size, time } : null,
  };
}

/**
 * How to show an update: its free words, and whether its parts can be laid out under their prompts.
 *
 * The body ends with the parts' sections, written by {@link updateEvent}. Exactly those sections are taken off the end
 * (rebuilt from the tags, so an answer of several paragraphs comes off whole) and what is left is the founder's free
 * words, untouched: a paragraph of theirs that happens to begin "What's next" stays. A body that does not end with the
 * rebuilt sections was written by something else: it is shown whole and the parts are not laid out beside it, so
 * nothing is shown twice and nothing is hidden.
 */
export function updateLayout(
  body: string,
  parts: UpdateParts | null,
): { free: string; showParts: boolean } {
  if (!parts) return { free: body, showParts: false };
  const tail = partSections(parts).join("\n\n");
  if (body === tail) return { free: "", showParts: true };
  if (body.endsWith(`\n\n${tail}`))
    return {
      free: body.slice(0, body.length - tail.length - 2),
      showParts: true,
    };
  return { free: body, showParts: false };
}

const DAY = 24 * 60 * 60;
/** A project is expected to post once in this many days. */
const UPDATE_EVERY_DAYS = 7;

/** Whole days from `at` to `now` (both in seconds), never negative. */
export function daysSince(at: number, now: number): number {
  return Math.max(0, Math.floor((now - at) / DAY));
}

function days(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** What everyone reads about how fresh a project's news is. `lastAt` is null when it never posted. */
export function freshnessLine(lastAt: number | null, now: number): string {
  if (lastAt === null) return "No updates yet";
  const n = daysSince(lastAt, now);
  if (n === 0) return "Updated today";
  if (n === 1) return "Updated yesterday";
  if (n < UPDATE_EVERY_DAYS) return `Updated ${days(n)} ago`;
  if (n < UPDATE_EVERY_DAYS * 2) return `No update in ${days(n)}`;
  return `No update in ${Math.floor(n / 7)} weeks`;
}

/**
 * What the founder reads on their own project page: a prompt once a week has passed with no update (or none was ever
 * posted), and otherwise when the next one is due.
 */
export function founderNudge(
  lastAt: number | null,
  now: number,
): { due: boolean; text: string } {
  if (lastAt === null)
    return {
      due: true,
      text: "You haven't posted an update yet. A short one each week keeps the people following you close.",
    };
  const n = daysSince(lastAt, now);
  if (n >= UPDATE_EVERY_DAYS)
    return {
      due: true,
      text: `It's been ${days(n)} since your last update.`,
    };
  const left = UPDATE_EVERY_DAYS - n;
  return { due: false, text: `Next update due in ${days(left)}.` };
}

/**
 * When the next weekly update is due, for everyone to read: "Update due in 2 days", "Update due today",
 * "Update late by 3 days". Null when the project never posted (there is no week to be late in yet).
 */
export function updateDueWords(
  lastAt: number | null,
  now: number,
): { late: boolean; text: string } | null {
  if (lastAt === null) return null;
  const n = daysSince(lastAt, now);
  if (n < UPDATE_EVERY_DAYS)
    return {
      late: false,
      text: `Update due in ${days(UPDATE_EVERY_DAYS - n)}`,
    };
  if (n === UPDATE_EVERY_DAYS) return { late: false, text: "Update due today" };
  return { late: true, text: `Update late by ${days(n - UPDATE_EVERY_DAYS)}` };
}

/** "Posted this week" for one, "4 weeks in a row" from two, null with none. */
export function streakLine(weeks: number): string | null {
  if (weeks <= 0) return null;
  return weeks === 1 ? "1 week so far" : `${weeks} weeks in a row`;
}

/**
 * The lines the update dialog starts "What we did" with: the work accepted since the last update, one per line,
 * without the ones the founder took off. The founder's own words follow.
 */
export function doneWithAccepted(
  done: string,
  accepted: readonly { id: string; what: string }[],
  removed: ReadonlySet<string>,
): string {
  const lines = accepted
    .filter((task) => !removed.has(task.id))
    .map((task) => `Work accepted: ${task.what.replace(/\s+/g, " ").trim()}`);
  return [...lines, ...(done.trim() ? [done.trim()] : [])]
    .join("\n")
    .slice(0, UPDATE_LIMITS.part);
}

/** How many pieces of accepted work the dialog offers as lines. */
const ACCEPTED_OFFERED = 5;

/**
 * The work accepted since the last update (or ever, with none), newest first, for the dialog to offer as lines. A
 * confirmation dated ahead of now counts as now, so it cannot stay "new" for ever.
 */
export function acceptedSince<
  T extends {
    id: string;
    what: string;
    accepted: { confirmedAt: number } | null;
  },
>(tasks: readonly T[], lastAt: number | null, now: number): T[] {
  const at = (task: T) => Math.min(task.accepted?.confirmedAt ?? 0, now);
  return tasks
    .filter((task) => task.accepted && (lastAt === null || at(task) > lastAt))
    .sort((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : 1))
    .slice(0, ACCEPTED_OFFERED);
}

/** How many new promises the dialog takes from "What's next": a week holds about three. */
const NEW_PROMISES = 3;

/** The first {@link NEW_PROMISES} lines of "What's next" that say something, and whether more were typed. */
export function firstPromises(next: string): { text: string; dropped: number } {
  const lines = next.split("\n").filter((line) => line.trim() !== "");
  return {
    text: lines.slice(0, NEW_PROMISES).join("\n"),
    dropped: Math.max(0, lines.length - NEW_PROMISES),
  };
}

/** The week a moment falls in: weeks start on Monday, in UTC, so everyone counts the same weeks. */
function weekOf(at: number): number {
  // 1 January 1970 was a Thursday: three days on, the count turns over on Mondays.
  return Math.floor((Math.floor(at / DAY) + 3) / 7);
}

/**
 * How many weeks in a row a project posted at least one update, counting back from this week. A week that has only
 * just begun does not break the run: with nothing posted yet this week, the count runs back from last week.
 */
export function weeksInARow(times: readonly number[], now: number): number {
  const weeks = new Set(times.filter((at) => at <= now).map(weekOf));
  let week = weekOf(now);
  if (!weeks.has(week)) week -= 1;
  let count = 0;
  while (weeks.has(week)) {
    count += 1;
    week -= 1;
  }
  return count;
}

/**
 * What can be said as fact about a project's updates, given how much of them was read.
 *
 * The team's update records are read newest first, so the newest one read is the newest there is; "never posted" needs
 * the read to have reached the end. Posts marked as updates come from a read cut at a fixed number of posts: when it
 * was cut, a marked post older than the oldest one read may exist, so the newest update known is the newest only if it
 * is not older than that. The count of weeks in a row needs every read complete. What is not known is not said.
 */
export function updateFacts(input: {
  /** When the newest update known was posted, or null when none is known. */
  latestAt: number | null;
  /** The team's update records were read to the end. */
  recordsComplete: boolean;
  /** The read of posts was cut at its limit, and the oldest post it returned. */
  postsCut: boolean;
  oldestPostAt: number | null;
}): { freshness: boolean; inARow: boolean } {
  const { latestAt, recordsComplete, postsCut, oldestPostAt } = input;
  const postsCover =
    !postsCut ||
    (latestAt !== null && oldestPostAt !== null && latestAt >= oldestPostAt);
  return {
    freshness: postsCover && (latestAt !== null || recordsComplete),
    inARow: recordsComplete && !postsCut,
  };
}

/** "3 weekly updates in a row", shown only from two: one update is not a run. */
export function inARowLine(count: number): string | null {
  return count >= 2 ? `${count} weekly updates in a row` : null;
}

/** How long a dismissed prompt stays away: the week it was about. */
const NUDGE_QUIET_SECONDS = UPDATE_EVERY_DAYS * DAY;

/** Whether the founder's prompt is hidden: they dismissed it less than a week ago. */
export function nudgeDismissed(
  dismissedAt: number | null,
  now: number,
): boolean {
  return (
    dismissedAt !== null &&
    now >= dismissedAt &&
    now - dismissedAt < NUDGE_QUIET_SECONDS
  );
}
