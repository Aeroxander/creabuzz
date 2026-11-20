/**
 * The ranking on Home: money that has stayed (`docs/next-version/RECORD-V2.md` section 11.6). The server signs one small
 * index (kind 39009, `d = explore`, at most 20 entries); the app believes it only from the server's own key and only while it
 * is not older than a day, sorts it itself by the one rule and never trusts the order it came in, and keeps only the projects
 * whose own records still say they are listed and name that launch. **The rule reads money held, then the number of
 * different accounts, then age, then the key: never a price, never the pot, never joins, never volume.** An entry carries no
 * other figure, and whatever else it carries is not read.
 */
import { KIND_PROJECT_NUMBERS } from "@creaton/core/kinds.ts";
import {
  amount,
  arr,
  bool,
  count,
  fail,
  isObject,
  time,
} from "../money/numbers-strict";
import { BYTES32 } from "../money/numbers-strict";
import type { Project } from "../project/project-record";

/** The most entries the server signs, and the most project records Home reads for them. */
export const INDEX_ENTRIES_MAX = 20;
export const RANK_RECORDS_READ = 10;
/** The most rows the section shows. */
export const RANK_ROWS_SHOWN = 8;
/** An index older than this is not shown (as every money figure). */
export const INDEX_MAX_AGE_SECS = 24 * 60 * 60;
/** How far ahead of this device's clock an index may be signed before it is not believed. */
const FUTURE_SLACK_SECS = 10 * 60;

/** One ranked project, as the index says it: the money that stayed and the accounts that kept it. */
export interface ExploreEntry {
  /** The project's chain key. */
  key: string;
  /** The project record's address, `37001:<founder>:<id>`. */
  a: string;
  launchedAt: number;
  /** How long the money had to stay to count (seconds). */
  windowSecs: number;
  /** Money held for the whole window, valued at what a take-out would give now (6 decimals). */
  money: bigint;
  /** How many different accounts kept it. */
  accounts: number;
  /** The server's "Established" verdict, or null when it could not say. */
  reached: boolean | null;
}

export interface ExploreIndex {
  asOf: { block: number; time: number };
  entries: ExploreEntry[];
}

export interface IndexEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

const COORDINATE = /^37001:[0-9a-f]{64}:[^:\s]{1,128}$/;

function readEntry(raw: unknown, at: string): ExploreEntry {
  if (!isObject(raw)) return fail(at);
  const key = typeof raw.key === "string" ? raw.key.toLowerCase() : "";
  if (!BYTES32.test(key)) fail(`${at}.key`);
  if (typeof raw.a !== "string" || !COORDINATE.test(raw.a)) fail(`${at}.a`);
  const windowSecs = time(raw.windowSecs, `${at}.windowSecs`);
  if (windowSecs === 0) fail(`${at}.windowSecs`);
  return {
    key,
    a: raw.a as string,
    launchedAt: time(raw.launchedAt, `${at}.launchedAt`),
    windowSecs,
    money: amount(raw.money, `${at}.money`),
    accounts: count(raw.accounts, `${at}.accounts`),
    reached: raw.reached === null ? null : bool(raw.reached, `${at}.reached`),
  };
}

/**
 * The index an event carries, or null when it is not to be believed: not from the server's own key, not the index (`d` is not
 * `explore`), signed longer ago than a day or in the future, a version it does not know, more entries than the server signs,
 * the same project twice, entries of different windows, or an entry that is not readable. Never throws.
 */
export function parseIndex(
  event: IndexEvent,
  signer: string | null,
  now: number,
): ExploreIndex | null {
  try {
    if (event.kind !== KIND_PROJECT_NUMBERS || !signer) return null;
    if (event.pubkey !== signer) return null;
    if (event.tags.find((t) => t[0] === "d")?.[1] !== "explore") return null;
    if (event.created_at - now > FUTURE_SLACK_SECS) return null;
    if (now - event.created_at > INDEX_MAX_AGE_SECS) return null;
    const body: unknown = JSON.parse(event.content);
    if (!isObject(body) || body.version !== 1 || body.kind !== "explore")
      return null;
    const asOf = body.asOf;
    if (!isObject(asOf)) return null;
    const entries = arr(body.entries, "entries", INDEX_ENTRIES_MAX).map(
      (e, i) => readEntry(e, `entries[${i}]`),
    );
    if (new Set(entries.map((e) => e.key)).size !== entries.length) return null;
    // One window per index: money kept for different lengths of time is not ranked against each other.
    if (new Set(entries.map((e) => e.windowSecs)).size > 1) return null;
    return {
      asOf: {
        block: count(asOf.block, "asOf.block"),
        time: time(asOf.time, "asOf.time"),
      },
      entries,
    };
  } catch {
    return null;
  }
}

/**
 * The ranking rule: most money that stayed first, then most different accounts, then the older project, then the key. It
 * reads these four fields and nothing else.
 */
export function compareEntries(a: ExploreEntry, b: ExploreEntry): number {
  if (a.money !== b.money) return a.money > b.money ? -1 : 1;
  if (a.accounts !== b.accounts) return b.accounts - a.accounts;
  if (a.launchedAt !== b.launchedAt) return a.launchedAt - b.launchedAt;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** The entries in the app's own order, those with no money that stayed left out (a project with nothing kept is not ranked). */
export function rankedEntries(index: ExploreIndex): ExploreEntry[] {
  return index.entries
    .filter((e) => e.money > 0n && e.accounts > 0)
    .sort(compareEntries);
}

/** A project record's coordinate split into its founder and id, or null. */
export function splitCoordinate(
  a: string,
): { founder: string; id: string } | null {
  const [, founder, ...rest] = a.split(":");
  const id = rest.join(":");
  return founder && id ? { founder, id } : null;
}

/** An entry kept only when its project's record is there, is listed, and names the launch the entry is for. */
export function entryHolds(
  entry: ExploreEntry,
  project: Project | undefined,
  chainKeyOf: (project: Project) => string | null,
): project is Project {
  if (!project || project.unlisted) return false;
  if (project.coordinate !== entry.a) return false;
  return chainKeyOf(project) === entry.key;
}
