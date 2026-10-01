import type { NostrEvent, NostrFilter } from "@/shared/lib/nostr-client";
import { neventOf, toNpub } from "@/shared/lib/nip19";
import { KIND_NOTE, KIND_PROFILE, hashtagsOf } from "./feed-model";

const now = Math.floor(Date.now() / 1000);
const hex = (c: string) => c.repeat(64);
const id = (c: string) => c.repeat(64).slice(0, 64);

export const MOCK_VIEWER = hex("a");

const people = [
  {
    pubkey: hex("a"),
    name: "ada",
    display_name: "Ada Lovelace",
    about: "Analyst. Poetical science. Writing the first programs.",
    website: "https://example.com/ada",
  },
  {
    pubkey: hex("b"),
    name: "grace",
    display_name: "Grace Hopper",
    about: "Compilers, debugging, and nanoseconds.",
  },
  { pubkey: hex("c"), name: "linus", display_name: "Linus" },
  { pubkey: hex("d"), name: "margaret", display_name: "Margaret H." },
];

function ev(
  eventId: string,
  author: number,
  kind: number,
  ago: number,
  content: string,
  tags: string[][] = [],
): NostrEvent {
  return {
    id: id(eventId),
    pubkey: people[author].pubkey,
    kind,
    created_at: now - ago,
    tags,
    content,
    sig: "0".repeat(128),
  };
}

const note = (
  eventId: string,
  author: number,
  ago: number,
  content: string,
  parent?: string,
  mention?: number,
) =>
  ev(eventId, author, KIND_NOTE, ago, content, [
    ...(parent ? [["e", id(parent), "", "reply"]] : []),
    ...(mention !== undefined ? [["p", people[mention].pubkey]] : []),
    ...hashtagsOf(content).map((t) => ["t", t]),
  ]);

const profile = (i: number) =>
  ev(`p${i}`, i, KIND_PROFILE, 0, JSON.stringify(people[i]));
const contacts = (author: number, follows: number[]) =>
  ev(
    `c${author}`,
    author,
    3,
    10,
    "",
    follows.map((i) => ["p", people[i].pubkey]),
  );
const like = (
  n: string,
  author: number,
  target: string,
  targetAuthor: number,
) =>
  ev(`l${n}`, author, 7, 5, "+", [
    ["e", id(target)],
    ["p", people[targetAuthor].pubkey],
  ]);

/** Local-only data for previewing the feed without a relay (`?preview=feed`). */
export const allMockEvents: NostrEvent[] = [
  ...people.map((_, i) => profile(i)),
  contacts(0, [1, 2]),
  contacts(1, [0]),
  contacts(3, [0, 1]),
  note(
    "1",
    1,
    90,
    "Shipped the new relay build. Latency is down 40% across the board 🚀 #nostr #buzz",
  ),
  note(
    "2",
    2,
    60 * 22,
    "Reminder that a repository is just a community with opinions.\n\nhttps://example.com/blog/communities",
  ),
  note(
    "3",
    0,
    60 * 60 * 3,
    "Writing a spec is the cheapest way to find out you don't understand your own idea.",
  ),
  note(
    "4",
    3,
    60 * 60 * 9,
    "Agents are great teammates as long as they can read the room. Working on exactly that this week. cc nostr:" +
      toNpub(hex("b")) +
      " #agents",
  ),
  note(
    "5",
    1,
    60 * 60 * 30,
    "Hot take: the best feed is the one you can leave without feeling guilty.",
  ),
  note("6", 2, 60 * 60 * 24 * 9, "Small teams, sharp tools, loud demos. #buzz"),
  note("7", 0, 60, "Congrats! Was this the connection pooling change?", "1"),
  note("8", 3, 45, "Nice. Any chance of a write-up?", "1"),
  note("a0", 1, 30, "Totally agree, Ada. Specs first.", "3", 0),
  note(
    "a1",
    3,
    600,
    `Hey nostr:${toNpub(hex("a"))} want to pair on this?`,
    undefined,
    0,
  ),
  ev("r1", 3, 6, 120, "", [
    ["e", id("3")],
    ["p", people[0].pubkey],
  ]),
  note(
    "9",
    2,
    60 * 60 * 2,
    `Quoting this one: nostr:${neventOf(id("3"), people[0].pubkey)}`,
  ),
  like("1", 0, "1", 1),
  like("2", 3, "1", 1),
  like("3", 1, "3", 0),
  like("4", 0, "5", 1),
];

export function matchesFilter(e: NostrEvent, f: NostrFilter): boolean {
  if (f.ids && !f.ids.includes(e.id)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.search && !e.content.toLowerCase().includes(f.search.toLowerCase())) {
    return false;
  }
  if (f.since && e.created_at < f.since) return false;
  if (f.until && e.created_at > f.until) return false;
  for (const [key, values] of Object.entries(f)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const name = key.slice(1);
    if (!e.tags.some((t) => t[0] === name && values.includes(t[1]))) {
      return false;
    }
  }
  return true;
}

export function queryMockEvents(f: NostrFilter): NostrEvent[] {
  return allMockEvents
    .filter((e) => matchesFilter(e, f))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, f.limit ?? 100);
}
