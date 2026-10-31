/**
 * A project's working structure (`docs/v3-review/PROJECT-STRUCTURE.md`, step 1), as two signed records:
 *
 * - **Work taken on** (kind 37019): a person says they are doing a piece of work in a work area, what they will
 *   deliver, who will use it, and by when. One per person per work area; a newer one replaces it, and letting it go
 *   publishes it again as released. It reserves nothing: anyone may still submit, and Shares still come only from
 *   review and the vote. After its date it is no longer shown, and nobody is blamed.
 * - **Project focus** (kind 37020): the launch author's "Now" (at most three, each optionally naming a work area) and
 *   "Not doing" lists. The server takes it only from the launch's author; this module checks the same again.
 *
 * Pure: inputs in, records or readings out, driven by `projectStructure.test.mjs`.
 */

import {
  KIND_LAUNCH_RECORD,
  KIND_PROJECT_FOCUS,
  KIND_WORK_TAKEN_ON,
} from "../kinds.generated.ts";

const DAY = 86_400;
const DELIVER_MAX = 280;
const FOR_MAX = 140;
const FOCUS_TEXT_MAX = 280;
const WHY_MAX = 280;
export const MAX_NOW = 3;
export const MAX_NOT_DOING = 10;
/** The longest anyone may say they are on a piece of work before saying so again. */
const MAX_TAKE_DAYS = 90;
/** The date a "take this on" form starts with. */
const DEFAULT_TAKE_DAYS = 14;
/** After this long, the founder is asked whether each Now item is still worth doing. */
const FOCUS_REVIEW_DAYS = 28;

interface EventLike {
  id?: unknown;
  pubkey?: unknown;
  kind?: unknown;
  created_at?: unknown;
  tags?: unknown;
  content?: unknown;
}

type Template = { kind: number; tags: string[][]; content: string };

const ADDRESS = /^0x[0-9a-f]{40}$/;
const WORD = /^0x[0-9a-f]{64}$/;

/** A work area as both records name it: `<budget>:<work-area-id>`, lowercase. */
export function areaKey(mandate: string, id: string): string {
  const key = `${mandate.toLowerCase()}:${id.toLowerCase()}`;
  if (!isAreaKey(key)) throw new Error("not a work area");
  return key;
}

function isAreaKey(value: string): boolean {
  const [budget, id, extra] = value.split(":");
  return (
    extra === undefined && ADDRESS.test(budget ?? "") && WORD.test(id ?? "")
  );
}

function tagsOf(event: EventLike): string[][] {
  return Array.isArray(event.tags)
    ? (event.tags as unknown[]).filter(
        (t): t is string[] =>
          Array.isArray(t) && t.every((part) => typeof part === "string"),
      )
    : [];
}

function only(tags: string[][], name: string): string | null {
  const found = tags.filter((t) => t[0] === name);
  return found.length === 1 ? (found[0][1] ?? null) : null;
}

function object(content: unknown): Record<string, unknown> | null {
  if (typeof content !== "string") return null;
  try {
    const value: unknown = JSON.parse(content);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const chars = (text: string) => [...text].length;

function text(value: unknown, max: number, required: boolean): string | null {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if ((required && trimmed === "") || chars(trimmed) > max) return null;
  return trimmed;
}

// ---- work taken on ---------------------------------------------------------------------------

export interface TakenOn {
  author: string;
  /** `<budget>:<work-area-id>`. */
  area: string;
  deliver: string;
  for: string;
  /** Unix seconds. */
  until: number;
  released: boolean;
  createdAt: number;
}

/** What the "take this on" form holds. */
export interface TakeOnDraft {
  deliver: string;
  for: string;
  /** The last day, as the date box gives it (`YYYY-MM-DD`, local time). */
  untilDay: string;
}

/** The form's starting values: nothing said yet, and a date two weeks out. */
export function takeOnDraft(
  now: number,
  existing?: TakenOn | null,
): TakeOnDraft {
  const until =
    existing && !existing.released
      ? existing.until
      : now + DEFAULT_TAKE_DAYS * DAY;
  return {
    deliver: existing?.deliver ?? "",
    for: existing?.for ?? "",
    untilDay: dayOf(until),
  };
}

/** A date as the date box writes it, in local time. */
export function dayOf(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The end of the chosen day, local time, in Unix seconds; null when it is not a date. */
function endOfDay(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    23,
    59,
    59,
  );
  return Number.isNaN(date.getTime())
    ? null
    : Math.floor(date.getTime() / 1000);
}

/** The first problem with a "take this on" form, by field, or null when it can be sent. */
export function takeOnProblem(
  draft: TakeOnDraft,
  now: number,
): { field: keyof TakeOnDraft; message: string } | null {
  if (text(draft.deliver, DELIVER_MAX, true) === null)
    return {
      field: "deliver",
      message: `Say what you will deliver, in at most ${DELIVER_MAX} characters.`,
    };
  if (text(draft.for, FOR_MAX, true) === null)
    return {
      field: "for",
      message: `Say who will use it, in at most ${FOR_MAX} characters.`,
    };
  const until = endOfDay(draft.untilDay);
  if (until === null || until <= now)
    return { field: "untilDay", message: "Pick a day from today on." };
  if (until > now + MAX_TAKE_DAYS * DAY)
    return {
      field: "untilDay",
      message: `Pick a day within ${MAX_TAKE_DAYS} days. You can say so again when it comes.`,
    };
  return null;
}

/** The record saying you are on a piece of work, or letting it go (`released`). */
export function takenOnTemplate(input: {
  launch: string;
  area: string;
  deliver: string;
  for: string;
  until: number;
  released?: boolean;
}): Template {
  if (!isAreaKey(input.area)) throw new Error("not a work area");
  return {
    kind: KIND_WORK_TAKEN_ON,
    tags: [
      ["d", input.area],
      ["a", input.launch],
    ],
    content: JSON.stringify({
      deliver: input.deliver.trim(),
      for: input.for.trim(),
      until: input.until,
      ...(input.released ? { released: true } : {}),
    }),
  };
}

/** The "take this on" form as a record, or a thrown problem in words. */
export function takeOnFromDraft(
  draft: TakeOnDraft,
  input: { launch: string; area: string; now: number },
): Template {
  const problem = takeOnProblem(draft, input.now);
  if (problem) throw new Error(problem.message);
  return takenOnTemplate({
    launch: input.launch,
    area: input.area,
    deliver: draft.deliver,
    for: draft.for,
    until: endOfDay(draft.untilDay) as number,
  });
}

/** One record read back, or null when it is not a well-formed one for this launch. */
export function parseTakenOn(event: EventLike, launch: string): TakenOn | null {
  if (event.kind !== KIND_WORK_TAKEN_ON) return null;
  if (typeof event.pubkey !== "string" || typeof event.created_at !== "number")
    return null;
  const tags = tagsOf(event);
  const area = only(tags, "d");
  if (!area || !isAreaKey(area) || only(tags, "a") !== launch) return null;
  const body = object(event.content);
  if (!body) return null;
  const deliver = text(body.deliver, DELIVER_MAX, true);
  const forWhom = text(body.for, FOR_MAX, true);
  const until = body.until;
  if (
    deliver === null ||
    forWhom === null ||
    typeof until !== "number" ||
    !Number.isSafeInteger(until) ||
    until <= 0
  )
    return null;
  return {
    author: event.pubkey,
    area,
    deliver,
    for: forWhom,
    until,
    released: body.released === true,
    createdAt: event.created_at,
  };
}

/** Each person's newest record per work area: what the server keeps, applied again to whatever came back. */
function newestPerPerson(records: readonly TakenOn[]): TakenOn[] {
  const newest = new Map<string, TakenOn>();
  for (const r of records) {
    const key = `${r.author}|${r.area}`;
    const held = newest.get(key);
    if (!held || r.createdAt > held.createdAt) newest.set(key, r);
  }
  return [...newest.values()];
}

/** Who is on each work area now (not released, date not passed), soonest date first. */
export function takersByArea(
  records: readonly TakenOn[],
  now: number,
): Map<string, TakenOn[]> {
  const byArea = new Map<string, TakenOn[]>();
  for (const r of newestPerPerson(records)) {
    if (r.released || r.until <= now) continue;
    byArea.set(r.area, [...(byArea.get(r.area) ?? []), r]);
  }
  for (const list of byArea.values()) list.sort((a, b) => a.until - b.until);
  return byArea;
}

/** A person's own newest record on a work area, whatever its state, so the form can say it lapsed. */
export function myTaking(
  records: readonly TakenOn[],
  me: string | null,
  area: string,
): TakenOn | null {
  if (!me) return null;
  return (
    newestPerPerson(records).find((r) => r.author === me && r.area === area) ??
    null
  );
}

// ---- project focus ---------------------------------------------------------------------------

export interface FocusItem {
  text: string;
  /** The work area it is about, when it names one. */
  area: string | null;
}

export interface NotDoingItem {
  text: string;
  why: string;
}

export interface Focus {
  now: FocusItem[];
  notDoing: NotDoingItem[];
  createdAt: number;
}

/** The project's focus from its author's records (the newest well-formed one), or null when there is none. */
export function parseFocus(
  events: readonly EventLike[],
  launch: { author: string; id: string },
): Focus | null {
  let best: Focus | null = null;
  for (const event of events) {
    if (event.kind !== KIND_PROJECT_FOCUS || event.pubkey !== launch.author)
      continue;
    if (typeof event.created_at !== "number") continue;
    const tags = tagsOf(event);
    if (
      only(tags, "d") !== launch.id ||
      only(tags, "a") !== `${KIND_LAUNCH_RECORD}:${launch.author}:${launch.id}`
    )
      continue;
    const body = object(event.content);
    if (!body) continue;
    const nowRaw = Array.isArray(body.now) ? body.now : [];
    const notRaw = Array.isArray(body.notDoing) ? body.notDoing : [];
    if (nowRaw.length > MAX_NOW || notRaw.length > MAX_NOT_DOING) continue;
    const now = nowRaw.flatMap((item): FocusItem[] => {
      const entry = item as Record<string, unknown> | null;
      const t = text(entry?.text, FOCUS_TEXT_MAX, true);
      const area =
        typeof entry?.area === "string" && isAreaKey(entry.area)
          ? entry.area
          : null;
      return t === null ? [] : [{ text: t, area }];
    });
    const notDoing = notRaw.flatMap((item): NotDoingItem[] => {
      const entry = item as Record<string, unknown> | null;
      const t = text(entry?.text, FOCUS_TEXT_MAX, true);
      const why = text(entry?.why, WHY_MAX, false);
      return t === null || why === null ? [] : [{ text: t, why }];
    });
    if (!best || event.created_at > best.createdAt)
      best = { now, notDoing, createdAt: event.created_at };
  }
  return best;
}

/** The first problem with the focus form, or null. Empty rows are left out before checking. */
export function focusProblem(focus: {
  now: readonly FocusItem[];
  notDoing: readonly NotDoingItem[];
}): string | null {
  const now = focus.now.filter((i) => i.text.trim() !== "");
  const notDoing = focus.notDoing.filter((i) => i.text.trim() !== "");
  if (now.length > MAX_NOW)
    return `Keep Now to ${MAX_NOW}: a team gets more done on a few things at a time.`;
  if (notDoing.length > MAX_NOT_DOING)
    return `Keep Not doing to ${MAX_NOT_DOING}.`;
  if (now.some((i) => chars(i.text.trim()) > FOCUS_TEXT_MAX))
    return `Keep each Now item under ${FOCUS_TEXT_MAX} characters.`;
  if (notDoing.some((i) => chars(i.text.trim()) > FOCUS_TEXT_MAX))
    return `Keep each Not doing item under ${FOCUS_TEXT_MAX} characters.`;
  if (notDoing.some((i) => chars(i.why.trim()) > WHY_MAX))
    return `Keep each reason under ${WHY_MAX} characters.`;
  if (now.some((i) => i.area !== null && !isAreaKey(i.area)))
    return "Pick the work area again.";
  return null;
}

/** The focus record: the launch author's own, so `launch.author` must be who signs it. */
export function focusTemplate(
  launch: { author: string; id: string },
  focus: { now: readonly FocusItem[]; notDoing: readonly NotDoingItem[] },
): Template {
  const problem = focusProblem(focus);
  if (problem) throw new Error(problem);
  return {
    kind: KIND_PROJECT_FOCUS,
    tags: [
      ["d", launch.id],
      ["a", `${KIND_LAUNCH_RECORD}:${launch.author}:${launch.id}`],
    ],
    content: JSON.stringify({
      now: focus.now
        .filter((i) => i.text.trim() !== "")
        .map((i) => ({
          text: i.text.trim(),
          ...(i.area ? { area: i.area } : {}),
        })),
      notDoing: focus.notDoing
        .filter((i) => i.text.trim() !== "")
        .map((i) => ({
          text: i.text.trim(),
          ...(i.why.trim() ? { why: i.why.trim() } : {}),
        })),
    }),
  };
}

/** Whether the founder should be asked if each Now item is still worth doing. */
export function focusDueForReview(focus: Focus, now: number): boolean {
  return (
    focus.now.length > 0 && now - focus.createdAt >= FOCUS_REVIEW_DAYS * DAY
  );
}
