/**
 * A mocked server for the season tests: it answers like the relay for kinds, authors, any `#x` tag, `until` and `limit`
 * (newest first), counts every read it is asked, and keeps what was published. The records are made here the way the
 * server stores them: a season by an operator, an entry by a team.
 */
import { NOW } from "./money-harness";

export interface Stored {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

interface Filter {
  kinds?: number[];
  authors?: string[];
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

export const store: Stored[] = [];
export const reads: Filter[] = [];
export const published: { kind: number; tags: string[][]; content: string }[] =
  [];
/** What the next publish is refused with (once), or null. */
export const refuse: { message: string | null } = { message: null };

export function serve(events: Stored[]) {
  store.splice(0, store.length, ...events);
  reads.length = 0;
  published.length = 0;
  refuse.message = null;
}

function matches(filter: Filter, event: Stored): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;
  for (const [key, wanted] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(wanted)) continue;
    const name = key.slice(1);
    if (!event.tags.some((t) => t[0] === name && wanted.includes(t[1])))
      return false;
  }
  return true;
}

export async function readServed(filter: Filter) {
  reads.push(filter);
  return store
    .filter((e) => matches(filter, e))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
    .slice(0, filter.limit ?? store.length);
}

export const seasonRelayMock = {
  read: (filter: Filter) => readServed(filter),
  readMulti: async (filters: Filter[]) =>
    Promise.all(filters.map((f) => readServed(f))),
  readLatest: async (filter: Filter) => (await readServed(filter))[0] ?? null,
  publishAsUser: async (event: {
    kind: number;
    tags: string[][];
    content: string;
  }) => {
    if (refuse.message !== null) {
      const message = refuse.message;
      refuse.message = null;
      throw new Error(message);
    }
    published.push(event);
    return { ...event, id: "e".repeat(64) };
  },
};

let counter = 0;
const idOf = () => (++counter).toString(16).padStart(64, "0");

/** The operator's key in these tests (the app cannot tell an operator; the server decides). */
export const OPERATOR = `${"0".repeat(63)}1`;
export const DAY = 86_400;

/** A season record: `startsAt`, `demoDayAt` and `endsAt` as days from `NOW`. */
export function season(
  number: number,
  days: { start: number; demo: number; end: number },
  over: Partial<Stored> = {},
): Stored {
  return {
    id: idOf(),
    pubkey: OPERATOR,
    kind: 37021,
    created_at: NOW - 40 * DAY,
    tags: [["d", `season-${number}`]],
    content: JSON.stringify({
      v: 1,
      number,
      startsAt: NOW + days.start * DAY,
      demoDayAt: NOW + days.demo * DAY,
      endsAt: NOW + days.end * DAY,
    }),
    ...over,
  };
}

/** An entry, leave or removal of `coordinate` in season `number`, signed by `signer` `ago` seconds ago. */
export function step(
  number: number,
  coordinate: string,
  family: "entry" | "leave" | "remove",
  signer: string,
  ago = 100,
): Stored {
  return {
    id: idOf(),
    pubkey: signer,
    kind: 47003,
    created_at: NOW - ago,
    tags: [
      ["a", coordinate],
      ["t", `season-${number}`],
      [`season-${family}`, String(number)],
    ],
    content: "{}",
  };
}

/** A team update record about `coordinate`. */
export function update(
  coordinate: string,
  signer: string,
  text: { title: string; body: string },
  ago = 3_600,
): Stored {
  return {
    id: idOf(),
    pubkey: signer,
    kind: 47003,
    created_at: NOW - ago,
    tags: [["a", coordinate]],
    content: JSON.stringify(text),
  };
}
