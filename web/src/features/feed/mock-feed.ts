import type { NostrEvent } from "@/shared/lib/nostr-client";
import { KIND_NOTE, KIND_PROFILE } from "./feed-model";

const now = Math.floor(Date.now() / 1000);
const hex = (c: string) => c.repeat(64);

export const MOCK_VIEWER = hex("a");

const people = [
  { pubkey: hex("a"), name: "ada", display_name: "Ada Lovelace" },
  { pubkey: hex("b"), name: "grace", display_name: "Grace Hopper" },
  { pubkey: hex("c"), name: "linus", display_name: "Linus" },
  { pubkey: hex("d"), name: "margaret", display_name: "Margaret H." },
];

function note(
  id: string,
  author: number,
  ago: number,
  content: string,
  parent?: string,
): NostrEvent {
  return {
    id: id.repeat(64).slice(0, 64),
    pubkey: people[author].pubkey,
    kind: KIND_NOTE,
    created_at: now - ago,
    tags: parent ? [["e", parent.repeat(64).slice(0, 64), "", "reply"]] : [],
    content,
    sig: "0".repeat(128),
  };
}

/** Local-only data for previewing the feed without a relay (`?preview=feed`). */
export const mockProfiles: NostrEvent[] = people.map((p) => ({
  id: p.pubkey,
  pubkey: p.pubkey,
  kind: KIND_PROFILE,
  created_at: now,
  tags: [],
  content: JSON.stringify({ name: p.name, display_name: p.display_name }),
  sig: "0".repeat(128),
}));

export const mockNotes: NostrEvent[] = [
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
    "Agents are great teammates as long as they can read the room. Working on exactly that this week.",
  ),
  note(
    "5",
    1,
    60 * 60 * 30,
    "Hot take: the best feed is the one you can leave without feeling guilty.",
  ),
  note("6", 2, 60 * 60 * 24 * 9, "Small teams, sharp tools, loud demos."),
];

export const mockReplies: NostrEvent[] = [
  note("7", 0, 60, "Congrats! Was this the connection pooling change?", "1"),
  note("8", 3, 45, "Nice. Any chance of a write-up?", "1"),
];
