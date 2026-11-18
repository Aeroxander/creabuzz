/**
 * A project's record in one line of chips: how fresh it is, how many weeks in a row, how many promises were kept,
 * and the work done. The project page and the scorecard show the same line, so the two never say different things.
 *
 * Only true parts are shown, in this order. A part that is not known is left out and the line says so once: a missing
 * number is never shown as 0. Work other people accepted and work only the founder checked are two chips and are
 * never added together. Nothing here is a price, a return or a number of Shares.
 *
 * Pure and alias-free: `record-line.test.mjs` drives it under `node --test`.
 */

import { whenWords } from "./record-date.ts";
import { projectSharePath } from "./share.ts";
import { doneAloneLine } from "./task-checks.ts";
import { daysSince, updateDueWords } from "./weekly-update.ts";

type RecordPartId =
  | "freshness"
  | "started"
  | "first-update"
  | "streak"
  | "kept"
  | "accepted"
  | "done-alone";

interface RecordPart {
  id: RecordPartId;
  text: string;
  /** `warning` for a late update; never red, and never the only sign (the words say it). */
  tone: "neutral" | "success" | "warning";
}

/** What the line is made from: the project's state, with `null` for what could not be read. */
export interface RecordLineInput {
  /** Now, in seconds. */
  now: number;
  /** When the project was made, or null when that is not known. */
  startedAt: number | null;
  /** When the team last posted an update, or null when it never did. Meaningful only when `updatesKnown`. */
  lastUpdateAt: number | null;
  /** The newest update known is the newest there is (or there is none). */
  updatesKnown: boolean;
  /** Weeks in a row with a weekly update, or null when that could not be worked out. */
  streak: number | null;
  /** The founder's promises, totalled, or null when they could not all be read. */
  promises: { kept: number; missed: number; changed: number } | null;
  /** Pieces of work someone other than the person who did it accepted, or null when not known. */
  acceptedByOthers: number | null;
  /** Pieces of work only the founder checked, or null when not known. */
  doneByFounder: number | null;
  /** The viewer is the founder: their own work reads "checked by you". */
  viewerIsFounder?: boolean;
  /** The reader's own language unless a test names one. */
  locale?: string;
}

export interface RecordLine {
  parts: RecordPart[];
  /** One line when some of the record could not be read, else null. */
  cut: string | null;
}

/** Said once when part of the record did not load. */
export const RECORD_CUT_LINE =
  "Some of this record didn't load. A missing number is not zero.";

/** The one link beside the line, to the project's scorecard. */
export const SEE_FULL_RECORD = "See the full record";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The record line for a project. */
export function recordLine(input: RecordLineInput): RecordLine {
  const { now, locale } = input;
  const parts: RecordPart[] = [];
  let cut = false;

  if (!input.updatesKnown) {
    cut = true;
  } else if (input.lastUpdateAt === null) {
    // A project that never posted: when it started, and when its first update is due.
    if (input.startedAt !== null) {
      parts.push({
        id: "started",
        text: `Started ${whenWords(input.startedAt, now, locale)}`,
        tone: "neutral",
      });
      const due = updateDueWords(input.startedAt, now, locale);
      if (due)
        parts.push({
          id: "first-update",
          text: due.late
            ? due.text
            : `First update due ${due.text.replace(/^Next update /, "")}`,
          tone: due.late ? "warning" : "neutral",
        });
    }
  } else {
    const due = updateDueWords(input.lastUpdateAt, now, locale);
    if (due?.late)
      parts.push({ id: "freshness", text: due.text, tone: "warning" });
    else if (daysSince(input.lastUpdateAt, now) === 0)
      parts.push({ id: "freshness", text: "Posted today", tone: "success" });
    else if (due)
      parts.push({ id: "freshness", text: due.text, tone: "neutral" });
  }

  if (input.streak === null) cut = true;
  else if (input.streak >= 2)
    parts.push({
      id: "streak",
      text: `${input.streak} weeks in a row`,
      tone: "success",
    });

  if (input.promises === null) {
    cut = true;
  } else {
    const { kept, missed, changed } = input.promises;
    const answered = kept + missed + changed;
    if (answered > 0)
      parts.push({
        id: "kept",
        text: `Kept ${kept} of ${answered} ${plural(answered, "promise", "promises")}${
          missed > 0 ? `, ${missed} missed` : ""
        }${changed > 0 ? `, ${changed} changed` : ""}`,
        tone: "neutral",
      });
  }

  if (input.acceptedByOthers === null) cut = true;
  else if (input.acceptedByOthers > 0)
    parts.push({
      id: "accepted",
      text: `${input.acceptedByOthers} ${plural(input.acceptedByOthers, "piece", "pieces")} of work accepted by others`,
      tone: "success",
    });

  if (input.doneByFounder === null) cut = true;
  else {
    const line = doneAloneLine(input.doneByFounder);
    if (line)
      parts.push({
        id: "done-alone",
        text: input.viewerIsFounder
          ? line.replace("checked by the founder", "checked by you")
          : line,
        tone: "neutral",
      });
  }

  return { parts, cut: cut ? RECORD_CUT_LINE : null };
}

/** The `$slug` of a project's scorecard route (`/p/$slug`), unencoded: the router encodes it when it makes the link. */
export function scorecardSlug(project: { id: string; author: string }): string {
  return decodeURIComponent(projectSharePath(project).replace(/^\/p\//, ""));
}
