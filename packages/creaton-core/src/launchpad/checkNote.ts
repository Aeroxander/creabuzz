/**
 * The check note (`docs/v3-review/CHECK-NOTE-PLAN.md`): every two weeks, weekly in a project's first month, the founder
 * says what the team expected, what happened, and what changes next. It is a founder-signed launch update (kind 47003)
 * with a structured `check` object beside a readable body, so it shows in Updates like any other.
 *
 * Most of it comes from the project's own records: each Now item's expectation (the focus record), work finished and
 * turned down since the last note (each note keeps the claims it covered, so the next one lists only what is new),
 * turn-downs by cause, and how many "taking this on" dates lapsed (a count, never names). The founder writes what
 * changed for the people the project serves, whether each expectation happened, keep / change / drop for each Now
 * item, and one thing the team changes in how it works.
 *
 * Pure: inputs in, a draft, a record or a reading out, driven by `checkNote.test.mjs`.
 */

import { KIND_LAUNCH_UPDATE } from "../kinds.generated.ts";
import type { FocusDraft } from "./projectStructure.ts";

const DAY = 86_400;
/** A project's first month, when the team checks every week. */
const FIRST_MONTH_DAYS = 30;
const EARLY_EVERY_DAYS = 7;
const EVERY_DAYS = 14;
/** How long past due before a project reads as having gone quiet. */
const QUIET_AFTER_DAYS = 7;
const TEXT_MAX = 600;
const LINE_MAX = 280;

export const HAPPENED = ["yes", "partly", "no", "not-yet"] as const;
export type Happened = (typeof HAPPENED)[number];
export const NEXT = ["keep", "change", "drop"] as const;
export type Next = (typeof NEXT)[number];

/** One Now item as the note covers it. */
interface CheckItem {
  text: string;
  /** What the team expected, and the day it said it would check; empty and null when it said nothing. */
  expected: string;
  checkBy: number | null;
  /** The founder's answers; null until given. */
  happened: Happened | null;
  why: string;
  next: Next | null;
  /** For "change": what the item becomes. Empty otherwise. */
  becomes: string;
}

export interface CheckNote {
  /** The previous note's time, or the project's start: the period this note covers begins here. */
  since: number;
  /** What changed for the people the project serves. */
  outside: string;
  items: CheckItem[];
  /** Claim keys (`<budget>:<claim id>`) finished or turned down since the last note, with their titles. */
  finished: { key: string; title: string }[];
  turnedDown: { key: string; title: string }[];
  /** Turn-downs since the last note, by cause. */
  causes: { label: string; count: number }[];
  /** Work waiting on someone, as the founder edits it. */
  stuck: string;
  /** "Taking this on" dates that passed without the work coming in. */
  lapsed: number;
  /** The one thing the team changes in how it works. */
  change: string;
  /** A short summary, optional; it may start as an AI draft the founder has to read and accept or edit. */
  summary: string;
}

export interface CheckNoteRecord extends CheckNote {
  id: string;
  createdAt: number;
}

// ---- when ------------------------------------------------------------------------------------

/** How often the team checks: weekly in its first month, then every two weeks. */
export function checkEveryDays(projectStart: number, now: number): number {
  return now - projectStart < FIRST_MONTH_DAYS * DAY
    ? EARLY_EVERY_DAYS
    : EVERY_DAYS;
}

/**
 * Where the project stands on checking: when the next note is due, whether it is due now, and whether the project has
 * gone quiet (a week past due). With no note yet, the first is due a check period after the project started.
 */
export function checkTiming(
  projectStart: number,
  lastNote: number | null,
  now: number,
): { dueAt: number; due: boolean; quiet: boolean } {
  const from = lastNote ?? projectStart;
  const dueAt = from + checkEveryDays(projectStart, from) * DAY;
  return {
    dueAt,
    due: now >= dueAt,
    quiet: now >= dueAt + QUIET_AFTER_DAYS * DAY,
  };
}

// ---- the draft -------------------------------------------------------------------------------

export interface ClaimForCheck {
  key: string;
  title: string;
  status: string;
}

/**
 * The note as it starts: every automatic part filled in from the records, the founder's parts empty. Work already
 * covered by an earlier note is left out, so each piece of work is reported once.
 */
export function draftCheckNote(input: {
  since: number;
  now: number;
  focus: readonly {
    text: string;
    expect: string;
    checkBy: number | null;
  }[];
  claims: readonly ClaimForCheck[];
  /** Claim keys earlier notes covered. */
  covered: ReadonlySet<string>;
  /** Causes named for each claim turned down, by claim key. */
  causesOf: (key: string) => readonly string[];
  /** "Taking this on" dates, and whether each was let go. */
  takings: readonly { until: number; released: boolean }[];
}): CheckNote {
  const fresh = input.claims.filter((c) => !input.covered.has(c.key));
  const finished = fresh.filter(
    (c) => c.status === "Approved" || c.status === "Paid",
  );
  const turnedDown = fresh.filter((c) => c.status === "Rejected");
  const counts = new Map<string, number>();
  for (const claim of turnedDown) {
    for (const cause of new Set(input.causesOf(claim.key)))
      counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  const waiting = input.claims.filter((c) => c.status === "Open");
  return {
    since: input.since,
    outside: "",
    items: input.focus.map((item) => ({
      text: item.text,
      expected: item.expect,
      checkBy: item.expect ? item.checkBy : null,
      happened: null,
      why: "",
      next: null,
      becomes: "",
    })),
    finished: finished.map(({ key, title }) => ({ key, title })),
    turnedDown: turnedDown.map(({ key, title }) => ({ key, title })),
    causes: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count })),
    stuck: waiting.length
      ? `Waiting on review: ${waiting.map((c) => c.title).join(", ")}.`
      : "",
    lapsed: input.takings.filter(
      (t) => !t.released && t.until > input.since && t.until <= input.now,
    ).length,
    change: "",
    summary: "",
  };
}

/** The first thing the founder still has to say before the note can go out, or null. */
export function checkNoteProblem(note: CheckNote): string | null {
  if (note.outside.trim() === "")
    return 'Say what changed for the people the project is for, even if it is "nothing yet".';
  if ([...note.outside.trim()].length > TEXT_MAX)
    return `Keep "what changed" under ${TEXT_MAX} characters.`;
  for (const item of note.items) {
    if (item.expected && item.happened === null)
      return `Say whether "${item.expected}" happened.`;
    if (item.next === null)
      return `Choose keep, change or drop for "${item.text}".`;
    if (item.next === "change" && item.becomes.trim() === "")
      return `Say what "${item.text}" becomes.`;
    if ([...item.becomes.trim()].length > LINE_MAX)
      return `Keep what it becomes under ${LINE_MAX} characters.`;
    if ([...item.why.trim()].length > LINE_MAX)
      return `Keep each answer under ${LINE_MAX} characters.`;
  }
  if (note.change.trim() === "")
    return "Name one thing the team changes in how it works. Look at what was missing when work was turned down.";
  if ([...note.change.trim()].length > TEXT_MAX)
    return `Keep the change under ${TEXT_MAX} characters.`;
  if ([...note.summary.trim()].length > TEXT_MAX)
    return `Keep the summary under ${TEXT_MAX} characters.`;
  if ([...note.stuck.trim()].length > TEXT_MAX)
    return `Keep "stuck" under ${TEXT_MAX} characters.`;
  return null;
}

// ---- the record ------------------------------------------------------------------------------

const HAPPENED_WORDS: Record<Happened, string> = {
  yes: "Yes",
  partly: "Partly",
  no: "No",
  "not-yet": "Not yet",
};
const NEXT_WORDS: Record<Next, string> = {
  keep: "keep",
  change: "change",
  drop: "drop",
};

function day(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** The note as readable text, for Updates and anyone reading the raw record. */
function checkNoteBody(note: CheckNote): string {
  const lines: string[] = [
    `What changed for the people we serve: ${note.outside.trim()}`,
  ];
  for (const item of note.items) {
    const expected = item.expected
      ? ` We expected ${item.expected}${item.checkBy ? ` by ${day(item.checkBy)}` : ""}: ${item.happened ? HAPPENED_WORDS[item.happened] : "not answered"}.`
      : "";
    const why = item.why.trim() ? ` ${item.why.trim()}` : "";
    lines.push(
      `- ${item.text}.${expected}${why} Next: ${item.next ? NEXT_WORDS[item.next] : "not decided"}${item.next === "change" ? `, to "${item.becomes.trim()}"` : ""}.`,
    );
  }
  if (note.finished.length)
    lines.push(`Finished: ${note.finished.map((c) => c.title).join(", ")}.`);
  if (note.turnedDown.length)
    lines.push(
      `Turned down: ${note.turnedDown.length}${note.causes.length ? ` (${note.causes.map((c) => `${c.label}: ${c.count}`).join("; ")})` : ""}.`,
    );
  if (note.lapsed)
    lines.push(
      `${note.lapsed} "taking this on" date${note.lapsed === 1 ? "" : "s"} passed without the work coming in.`,
    );
  if (note.stuck.trim()) lines.push(`Stuck: ${note.stuck.trim()}`);
  lines.push(`What we change in how we work: ${note.change.trim()}`);
  if (note.summary.trim()) lines.unshift(note.summary.trim());
  return lines.join("\n");
}

/** The launch update that publishes the note. Throws the first problem when it is not ready. */
export function checkNoteContent(
  note: CheckNote,
  now: number,
): Record<string, unknown> {
  const problem = checkNoteProblem(note);
  if (problem) throw new Error(problem);
  return {
    title: `Check note, ${day(now)}`,
    body: checkNoteBody(note),
    links: [],
    check: {
      v: 1,
      since: note.since,
      outside: note.outside.trim(),
      items: note.items.map((i) => ({
        text: i.text,
        ...(i.expected ? { expected: i.expected, checkBy: i.checkBy } : {}),
        happened: i.happened,
        ...(i.why.trim() ? { why: i.why.trim() } : {}),
        next: i.next,
        ...(i.next === "change" ? { becomes: i.becomes.trim() } : {}),
      })),
      finished: note.finished,
      turnedDown: note.turnedDown,
      causes: note.causes,
      ...(note.stuck.trim() ? { stuck: note.stuck.trim() } : {}),
      lapsed: note.lapsed,
      change: note.change.trim(),
      ...(note.summary.trim() ? { summary: note.summary.trim() } : {}),
    },
  };
}

export const KIND_CHECK_NOTE = KIND_LAUNCH_UPDATE;

const isStr = (v: unknown): v is string => typeof v === "string";
const claimList = (v: unknown) =>
  Array.isArray(v)
    ? v.flatMap((c) =>
        c && isStr(c.key) && isStr(c.title)
          ? [{ key: c.key, title: c.title }]
          : [],
      )
    : [];

/**
 * The check notes among a launch's updates: only the launch author's, newest first. A malformed one is skipped rather
 * than guessed at.
 */
export function parseCheckNotes(
  events: readonly {
    id: string;
    pubkey: string;
    kind: number;
    created_at: number;
    content: string;
  }[],
  author: string,
): CheckNoteRecord[] {
  const notes: CheckNoteRecord[] = [];
  for (const event of events) {
    if (event.kind !== KIND_CHECK_NOTE || event.pubkey !== author) continue;
    let body: unknown;
    try {
      body = JSON.parse(event.content);
    } catch {
      continue;
    }
    const check = (body as { check?: unknown } | null)?.check as
      | Record<string, unknown>
      | undefined;
    if (!check || check.v !== 1 || typeof check.since !== "number") continue;
    if (!isStr(check.outside) || !isStr(check.change)) continue;
    const items = Array.isArray(check.items)
      ? check.items.flatMap((raw): CheckItem[] => {
          const i = raw as Record<string, unknown> | null;
          if (!i || !isStr(i.text)) return [];
          return [
            {
              text: i.text,
              expected: isStr(i.expected) ? i.expected : "",
              checkBy: typeof i.checkBy === "number" ? i.checkBy : null,
              happened: HAPPENED.includes(i.happened as Happened)
                ? (i.happened as Happened)
                : null,
              why: isStr(i.why) ? i.why : "",
              next: NEXT.includes(i.next as Next) ? (i.next as Next) : null,
              becomes: isStr(i.becomes) ? i.becomes : "",
            },
          ];
        })
      : [];
    notes.push({
      id: event.id,
      createdAt: event.created_at,
      since: check.since,
      outside: check.outside,
      items,
      finished: claimList(check.finished),
      turnedDown: claimList(check.turnedDown),
      causes: Array.isArray(check.causes)
        ? check.causes.flatMap((c) =>
            c && isStr(c.label) && typeof c.count === "number"
              ? [{ label: c.label, count: c.count }]
              : [],
          )
        : [],
      stuck: isStr(check.stuck) ? check.stuck : "",
      lapsed: typeof check.lapsed === "number" ? check.lapsed : 0,
      change: check.change,
      summary: isStr(check.summary) ? check.summary : "",
    });
  }
  return notes.sort((a, b) => b.createdAt - a.createdAt);
}

/** Every claim earlier notes covered, so the next note lists only what is new. */
export function coveredClaims(notes: readonly CheckNote[]): Set<string> {
  return new Set(
    notes.flatMap((n) => [...n.finished, ...n.turnedDown].map((c) => c.key)),
  );
}

// ---- adjust: the note applied to Now ---------------------------------------------------------

/** The most Not doing items the focus record holds (`projectStructure.ts`); the oldest fall off. */
const NOT_DOING_MAX = 10;

/**
 * Now and Not doing after the note's answers: "keep" stays, "change" becomes what the founder wrote, "drop" moves to Not
 * doing with what was seen as the reason. An expectation the note answered (yes, partly or no) is settled and cleared,
 * as is the one on a changed item; one answered "not yet" stays. Items are matched by their words, so an item changed
 * since the note was drafted is left as it is.
 */
export function applyCheckToFocus(
  focus: FocusDraft,
  note: Pick<CheckNote, "items">,
): FocusDraft {
  const answers = new Map(note.items.map((i) => [i.text, i]));
  const now: FocusDraft["now"] = [];
  const dropped: FocusDraft["notDoing"] = [];
  for (const item of focus.now) {
    const answer = answers.get(item.text);
    if (!answer || answer.next === null) {
      now.push(item);
      continue;
    }
    if (answer.next === "drop") {
      dropped.push({
        text: item.text,
        why: answer.why.trim() || "Dropped at a check",
      });
      continue;
    }
    const settled =
      answer.next === "change" ||
      (answer.happened !== null && answer.happened !== "not-yet");
    now.push({
      ...item,
      text: answer.next === "change" ? answer.becomes.trim() : item.text,
      ...(settled ? { expect: "", checkBy: null } : {}),
    });
  }
  return {
    aim: focus.aim,
    now,
    notDoing: [...dropped, ...focus.notDoing].slice(0, NOT_DOING_MAX),
  };
}

/**
 * Whether the latest note still has to be applied to Now: the focus was not saved after it, and applying it would change
 * something. Then the founder is offered "Apply to Now", so a note whose focus update failed is never left half done.
 */
export function checkNeedsApplying(
  note: CheckNoteRecord,
  focus: (FocusDraft & { createdAt: number }) | null,
): boolean {
  if (!focus || focus.createdAt > note.createdAt) return false;
  const { createdAt: _, ...draft } = focus;
  return (
    JSON.stringify(applyCheckToFocus(draft, note)) !== JSON.stringify(draft)
  );
}
