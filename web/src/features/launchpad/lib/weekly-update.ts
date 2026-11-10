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

/**
 * The update record's content and extra tags for a draft. The body reads on its own in any app that shows updates;
 * the tags carry the same parts for this one.
 */
export function updateEvent(draft: UpdateDraft): {
  content: { title: string; body: string };
  tags: string[][];
} {
  const done = clip(draft.done, UPDATE_LIMITS.part);
  const next = clip(draft.next, UPDATE_LIMITS.part);
  const free = clip(draft.body, UPDATE_LIMITS.part * 2);
  const helpText = clip(draft.help, UPDATE_LIMITS.help);
  const helpTime = clip(draft.helpTime, UPDATE_LIMITS.helpTime);
  const size = isHelpSize(draft.helpSize) ? draft.helpSize : "small";

  const sections: string[] = [];
  const tags: string[][] = [];
  if (free) sections.push(free);
  if (done) {
    sections.push(`${PART_HEADINGS.done}\n${done}`);
    tags.push([TAG_PART, "done", done]);
  }
  if (next) {
    sections.push(`${PART_HEADINGS.next}\n${next}`);
    tags.push([TAG_PART, "next", next]);
  }
  if (helpText) {
    sections.push(
      `${PART_HEADINGS.help} (${helpSizeLine({ size, time: helpTime })})\n${helpText}`,
    );
    tags.push([TAG_HELP, helpText], [TAG_HELP_SIZE, size]);
    if (helpTime) tags.push([TAG_HELP_TIME, helpTime]);
  }
  return {
    content: {
      title: clip(draft.title, UPDATE_LIMITS.title),
      body: sections.join("\n\n"),
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
 * The words to show for an update whose parts are laid out separately: its body without the sections the parts
 * repeat. A free-form update has no parts and shows its whole body.
 */
export function bodyWithoutParts(
  body: string,
  parts: UpdateParts | null,
): string {
  if (!parts) return body;
  const headings = Object.values(PART_HEADINGS);
  return body
    .split(/\n{2,}/)
    .filter((section) => !headings.some((h) => section.startsWith(h)))
    .join("\n\n")
    .trim();
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
