/**
 * What the room's component tests share: a server that holds events and answers a filter the way the real one does (kinds,
 * authors, `#a`, `#t`, `#e`, newest first, cut at `limit`), refuses a write with whatever reason a test sets, and a page to
 * draw the room in. A test file mocks `../../lib/relay` with `relayMock` and `./use-room-standing` with `standingMock`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ToastProvider } from "../../ui/toast";
import type { SignedEvent } from "../posts/use-posts";
import type { Standing } from "./room-standing";
import type { RoomMute } from "./room-records";

export const FOUNDER = "f".repeat(64);
export const ME = "1".repeat(64);
export const ANA = "2".repeat(64);
export const BO = "3".repeat(64);
export const MATE = "e".repeat(64);
export const KEY = `0x${"cd".repeat(32)}`;
export const COORD = `37001:${FOUNDER}:lantern`;
export const NOW = Math.floor(Date.now() / 1000);

type Filter = Record<string, unknown> & { kinds?: number[]; limit?: number };

export const world = {
  events: [] as SignedEvent[],
  /** The reason the next writes are refused with, or null to accept. */
  refuse: null as string | null,
  published: [] as SignedEvent[],
  /** Who the writes are signed as. */
  me: ME,
  signedIn: true,
  standing: { kind: "write", graceEndsAt: null, renewBy: null } as Standing,
  stops: [] as RoomMute[],
  /** How many times the room asked to read what the person holds again. */
  retried: 0,
};
let counter = 0;
export const nextId = () => (++counter).toString(16).padStart(64, "0");

export function reset() {
  world.events = [];
  world.refuse = null;
  world.published = [];
  world.me = ME;
  world.signedIn = true;
  world.standing = { kind: "write", graceEndsAt: null, renewBy: null };
  world.stops = [];
  world.retried = 0;
}

const has = (e: SignedEvent, name: string, values: unknown) =>
  !Array.isArray(values) ||
  e.tags.some((t) => t[0] === name && values.includes(t[1]));

function query(filter: Filter): SignedEvent[] {
  return world.events
    .filter((e) => !filter.kinds || filter.kinds.includes(e.kind))
    .filter(
      (e) =>
        !Array.isArray(filter.authors) || filter.authors.includes(e.pubkey),
    )
    .filter(
      (e) =>
        has(e, "a", filter["#a"]) &&
        has(e, "t", filter["#t"]) &&
        has(e, "e", filter["#e"]) &&
        has(e, "p", filter["#p"]) &&
        has(e, "d", filter["#d"]),
    )
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
    .slice(0, filter.limit ?? 1000);
}

export const relayMock = {
  read: async (filter: Filter) => query(filter),
  readMulti: async (filters: Filter[]) => filters.map(query),
  readLatest: async (kind: number, author: string) =>
    query({ kinds: [kind], authors: [author] })[0] ?? null,
  publishAsUser: async (template: {
    kind: number;
    tags: string[][];
    content: string;
    created_at?: number;
  }) => {
    await new Promise((r) => setTimeout(r, 5));
    if (world.refuse) throw new Error(world.refuse);
    const event = {
      id: nextId(),
      pubkey: world.me,
      sig: "",
      created_at: NOW,
      ...template,
    } as SignedEvent;
    world.published.push(event);
    world.events.push(event);
    return event;
  },
};

export const accountMock = {
  useAccount: () => ({
    pubkey: world.signedIn ? world.me : null,
    locked: false,
  }),
};

export const standingMock = {
  useRoomStanding: () => ({
    standing: world.standing,
    mutes: world.stops,
    retry: () => {
      world.retried += 1;
    },
  }),
};

/** A stored event. */
export function stored(
  pubkey: string,
  kind: number,
  tags: string[][],
  content: string,
  at: number,
): SignedEvent {
  const event = {
    id: nextId(),
    pubkey,
    kind,
    tags,
    content,
    created_at: at,
    sig: "",
  } as SignedEvent;
  world.events.push(event);
  return event;
}

export const roomTags = [
  ["a", COORD],
  ["t", `room:${KEY}`],
];

export const roomPost = (pubkey: string, content: string, at: number) =>
  stored(pubkey, 1, roomTags, content, at);

export function draw(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}
