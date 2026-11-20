/**
 * Seasons as the records say them (plan section 5; `docs/next-version/ROOM-AND-SEASON-RECORDS.md` section 5). Pure.
 *
 * - A **season** is one record the platform's operator signs (kind 37021, `d = season-<n>`): its number and three dates. The
 *   server stores it only from an operator, so the app reads it as stored and checks only that it is whole and in order.
 * - An **entry** is a record the project's own team signs (kind 47003, tags `a`, `t season-<n>` and exactly one of
 *   `season-entry`, `season-leave`, `season-remove`). The server refuses an entry from anyone else; the app checks it again
 *   against the project's own record before it lists the project (defence in depth, as the updates have).
 *
 * Who is in a season, and in which order, is worked out here and nowhere else.
 */
import { KIND_LAUNCH_UPDATE, KIND_SEASON } from "@creaton/core/kinds.ts";

/** The tags that mark a record of kind 47003 as a season's, not a project update. */
const ENTRY_FAMILIES = [
  "season-entry",
  "season-leave",
  "season-remove",
] as const;
type EntryFamilyTag = (typeof ENTRY_FAMILIES)[number];

/** The records of kind 47003 that belong to the season and the room, and that no Updates list should show as an update. */
const NOT_AN_UPDATE = [...ENTRY_FAMILIES, "room-mute"];

/** Whether a record of kind 47003 is a season entry, leave or removal, or a room stop: never a project update. */
export function isNotAnUpdate(tags: readonly (readonly string[])[]): boolean {
  return tags.some((tag) => NOT_AN_UPDATE.includes(tag[0]));
}

interface Tagged {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

const tagValues = (tags: readonly string[][], name: string): string[] =>
  tags
    .filter((tag) => tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1]);

// --- The season record ---------------------------------------------------------------------------------------------------

export interface Season {
  number: number;
  startsAt: number;
  demoDayAt: number;
  endsAt: number;
  /** When the record was signed: the newest of two records of one number wins. */
  signedAt: number;
  id: string;
}

const isSecond = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A season from its record, or null when it is not one: wrong kind or `d`, a number that does not match, dates out of order. */
export function parseSeason(event: Tagged): Season | null {
  if (event.kind !== KIND_SEASON) return null;
  const d = tagValues(event.tags, "d");
  if (d.length !== 1) return null;
  const named = /^season-([1-9][0-9]{0,3})$/.exec(d[0]);
  if (!named) return null;
  let body: unknown;
  try {
    body = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { number, startsAt, demoDayAt, endsAt } = body as Record<
    string,
    unknown
  >;
  if (number !== Number(named[1])) return null;
  if (!isSecond(startsAt) || !isSecond(demoDayAt) || !isSecond(endsAt))
    return null;
  if (!(startsAt < demoDayAt && demoDayAt <= endsAt)) return null;
  return {
    number,
    startsAt,
    demoDayAt,
    endsAt,
    signedAt: event.created_at,
    id: event.id,
  };
}

/** The newest record of each number, highest number first. */
export function seasonsOf(events: readonly Tagged[]): Season[] {
  const byNumber = new Map<number, Season>();
  for (const event of events) {
    const season = parseSeason(event);
    if (!season) continue;
    const was = byNumber.get(season.number);
    if (
      !was ||
      season.signedAt > was.signedAt ||
      (season.signedAt === was.signedAt && season.id > was.id)
    )
      byNumber.set(season.number, season);
  }
  return [...byNumber.values()].sort((a, b) => b.number - a.number);
}

/** Where a season stands at a moment: before it starts, open for entry, demo day, or over. */
export type Phase = "upcoming" | "open" | "demo" | "ended";

export function phaseOf(season: Season, now: number): Phase {
  if (now < season.startsAt) return "upcoming";
  if (now < season.demoDayAt) return "open";
  if (now < season.endsAt) return "demo";
  return "ended";
}

/**
 * The season the band speaks of: the one on its demo day (it is the one thing happening now), else one open for entry, else the
 * next to start, else the last to end. Two seasons in one phase: the higher number.
 */
export function currentSeason(
  seasons: readonly Season[],
  now: number,
): { season: Season; phase: Phase } | null {
  const order: Phase[] = ["demo", "open", "upcoming", "ended"];
  for (const phase of order) {
    const same = seasons.filter((season) => phaseOf(season, now) === phase);
    if (same.length === 0) continue;
    // The next to start is the soonest; every other phase takes the highest number.
    const pick =
      phase === "upcoming"
        ? [...same].sort((a, b) => a.startsAt - b.startsAt)[0]
        : [...same].sort((a, b) => b.number - a.number)[0];
    return { season: pick, phase };
  }
  return null;
}

// --- Entries -------------------------------------------------------------------------------------------------------------

export interface SeasonEntry {
  id: string;
  signer: string;
  at: number;
  /** The project's address: `37001:<founder>:<id>`. */
  coordinate: string;
  family: "entry" | "leave" | "remove";
}

const COORDINATE = /^37001:([0-9a-f]{64}):(.+)$/;

/** The founder and the id a project's address names, or null when it is not one. */
export function splitCoordinate(
  coordinate: string,
): { founder: string; id: string } | null {
  const match = COORDINATE.exec(coordinate);
  return match ? { founder: match[1], id: match[2] } : null;
}

/**
 * An entry, leave or removal for season `number`, or null when the record is none: it must name one project (`a`), the season
 * (`t`), and carry exactly one family tag whose number is the season's.
 */
export function parseEntry(event: Tagged, number: number): SeasonEntry | null {
  if (event.kind !== KIND_LAUNCH_UPDATE) return null;
  const families = event.tags.filter((tag) =>
    (ENTRY_FAMILIES as readonly string[]).includes(tag[0]),
  );
  if (families.length !== 1 || families[0][1] !== String(number)) return null;
  if (!tagValues(event.tags, "t").includes(`season-${number}`)) return null;
  const named = tagValues(event.tags, "a");
  if (named.length !== 1 || !splitCoordinate(named[0])) return null;
  return {
    id: event.id,
    signer: event.pubkey,
    at: event.created_at,
    coordinate: named[0],
    family: (families[0][0] as EntryFamilyTag).slice("season-".length) as
      | "entry"
      | "leave"
      | "remove",
  };
}

/** Every entry record of one season among `events`, each once. */
export function entriesOf(
  events: readonly Tagged[],
  number: number,
): SeasonEntry[] {
  const seen = new Set<string>();
  const out: SeasonEntry[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    const entry = parseEntry(event, number);
    if (!entry) continue;
    seen.add(event.id);
    out.push(entry);
  }
  return out;
}

/**
 * The projects that are in: entered, not left since, and not removed. The newest of a project's entries and leaves decides (by
 * time, then by id, as the server does). A removal wins over everything, before or after. `mayAct` says whether an entry or a
 * leave may count: the first pass takes every one the server stored, the second only those the project's own team signed.
 */
export function liveCoordinates(
  entries: readonly SeasonEntry[],
  mayAct: (entry: SeasonEntry) => boolean = () => true,
): string[] {
  const removed = new Set<string>();
  const newest = new Map<string, SeasonEntry>();
  for (const entry of entries) {
    if (entry.family === "remove") {
      removed.add(entry.coordinate);
      continue;
    }
    if (!mayAct(entry)) continue;
    const was = newest.get(entry.coordinate);
    if (!was || entry.at > was.at || (entry.at === was.at && entry.id > was.id))
      newest.set(entry.coordinate, entry);
  }
  return [...newest.values()]
    .filter((e) => e.family === "entry" && !removed.has(e.coordinate))
    .map((e) => e.coordinate)
    .sort();
}

/**
 * The projects that may be in, before each is checked against its own record: a project is a candidate when an entry names it
 * and the newest word of a person who certainly speaks for it (its founder, named in its address) is not a leave, and no
 * removal names it. An entry or leave from anyone else is not trusted either way yet: the second pass decides it.
 */
export function candidateCoordinates(
  entries: readonly SeasonEntry[],
): string[] {
  return liveCoordinates(
    entries,
    (entry) =>
      entry.family === "entry" ||
      entry.signer === splitCoordinate(entry.coordinate)?.founder,
  );
}
