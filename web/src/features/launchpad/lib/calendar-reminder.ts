/**
 * A weekly calendar reminder for the update: one small `.ics` file (RFC 5545) the person opens in their own calendar
 * app. It repeats every week on the update day and links to the project, where the update is posted. Nothing is sent
 * from here: no email, no push. The reminder lives in the person's calendar, not on the server.
 *
 * `weeklyReminderIcs` and `weeklyReminderFileName` are shared: the update card and the project's start page both call
 * them. Keep their signatures stable.
 *
 * Pure and alias-free: `calendar-reminder.test.mjs` drives it under `node --test`.
 */

import { APP_NAME } from "../../../shared/constants/brand.ts";

/** The project a reminder is for: its id, its name, and the address the reminder links to. */
export interface ReminderProject {
  id: string;
  name: string;
  /** Where the update is posted: an `http` or `https` address. Another kind of address is left out of the file. */
  url: string;
}

/** The weekday codes of RFC 5545, indexed like `Date#getDay` (0 is Sunday). */
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** The reminder's weekday when none is given: Monday. */
const DEFAULT_WEEKDAY = 1;
/** The reminder's time of day, in the person's own calendar time. */
const HOUR = 9;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `20261117` for a date, in the local calendar. */
function dateStamp(date: Date): string {
  return `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** A moment as an RFC 5545 UTC time: `20261115T093000Z`. */
function utcStamp(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** A text value (RFC 5545, 3.3.11): backslash, semicolon and comma are escaped, a line break is `\n`. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Folds a content line at 75 octets (RFC 5545, 3.1): the rest goes on lines that begin with one space. */
function fold(line: string): string[] {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // The first line holds 75 octets; each continuation holds 74 after its leading space.
    if (size + bytes > (out.length === 0 ? 75 : 74)) {
      out.push(out.length === 0 ? current : ` ${current}`);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  out.push(out.length === 0 ? current : ` ${current}`);
  return out;
}

/** A weekday as the number `Date#getDay` gives (0 Sunday to 6 Saturday), or the default for anything else. */
function weekdayOf(value: number | undefined): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 6
    ? value
    : DEFAULT_WEEKDAY;
}

/** Only an `http` or `https` address goes into the file. */
function linkOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/** What goes in a calendar's UID: letters, digits and a few marks, so the same project always updates one event. */
function uidPart(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "project";
}

/**
 * The text of a weekly reminder for `project`: a calendar file with one event, repeating every week
 * (`RRULE:FREQ=WEEKLY`) on `opts.weekday` at 9:00 in the person's own calendar time, 15 minutes long, with the
 * project's address as its link. Lines end in CRLF and are folded at 75 octets, as the format asks.
 *
 * - `opts.weekday`: the update day, 0 (Sunday) to 6 (Saturday), like `Date#getDay`. Monday when it is missing or not a
 *   weekday.
 * - `opts.now`: the moment the first event is counted from, so a test can fix it. Callers leave it out. The first
 *   event is the next time the weekday comes round, today included.
 */
export function weeklyReminderIcs(
  project: ReminderProject,
  opts: { weekday?: number; now?: Date } = {},
): string {
  const weekday = weekdayOf(opts.weekday);
  const now = opts.now ?? new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  first.setDate(first.getDate() + ((weekday - first.getDay() + 7) % 7));
  const link = linkOf(project.url);
  const name = project.name.trim() || "your project";
  const words = link
    ? `Your weekly update for ${name} is due. Post it here: ${link}`
    : `Your weekly update for ${name} is due.`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${escapeText(APP_NAME)}//Weekly update reminder//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:weekly-update-${uidPart(project.id)}@${APP_NAME.toLowerCase()}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${dateStamp(first)}T${pad(HOUR)}0000`,
    "DURATION:PT15M",
    `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[weekday]}`,
    `SUMMARY:${escapeText(`Weekly update due: ${name}`)}`,
    `DESCRIPTION:${escapeText(words)}`,
    ...(link ? [`URL:${link}`] : []),
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.flatMap(fold).join("\r\n")}\r\n`;
}

/** The file's name: `weekly-update-nebula-os.ics`. Safe for any file system. */
export function weeklyReminderFileName(project: { name: string }): string {
  const slug = project.name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `weekly-update-${slug || "project"}.ics`;
}

/**
 * The address of a project's page in this app, where its update is posted: `https://host/launchpad/<id>?author=…`.
 * It ends in `&action=update`, which opens the founder's update dialog on arrival (`deep-link.ts`); anyone else gets
 * the page.
 */
export function projectPageUrl(
  origin: string,
  project: { id: string; author: string },
): string {
  return `${origin}/launchpad/${encodeURIComponent(project.id)}?author=${encodeURIComponent(project.author)}&action=update`;
}
