import { expect, test } from "@playwright/test";
import type { NostrEvent } from "../../src/shared/lib/nostr-client";
import {
  buildNotifications,
  groupNotifications,
} from "../../src/features/feed/notifications";
import {
  mostFollowed,
  scoreNotes,
  topIds,
  trendingHashtags,
} from "../../src/features/feed/trending";

const hex = (c: string) => c.repeat(64);
const ME = hex("a");

function ev(
  over: Partial<NostrEvent> & Pick<NostrEvent, "id" | "kind">,
): NostrEvent {
  return {
    pubkey: hex("b"),
    created_at: 1000,
    tags: [],
    content: "",
    sig: "0".repeat(128),
    ...over,
  };
}

test("notifications cover likes, reposts, replies, mentions and follows", () => {
  const events = [
    ev({
      id: hex("1"),
      kind: 7,
      content: "+",
      created_at: 10,
      tags: [
        ["e", hex("9")],
        ["p", ME],
      ],
    }),
    ev({
      id: hex("2"),
      kind: 7,
      content: "-",
      created_at: 11,
      tags: [
        ["e", hex("9")],
        ["p", ME],
      ],
    }),
    ev({
      id: hex("3"),
      kind: 6,
      created_at: 12,
      tags: [
        ["e", hex("9")],
        ["p", ME],
      ],
    }),
    ev({
      id: hex("4"),
      kind: 1,
      created_at: 13,
      tags: [
        ["e", hex("9"), "", "reply"],
        ["p", ME],
      ],
    }),
    ev({ id: hex("5"), kind: 1, created_at: 14, tags: [["p", ME]] }),
    ev({ id: hex("6"), kind: 3, created_at: 15, tags: [["p", ME]] }),
    ev({ id: hex("7"), kind: 3, created_at: 16, tags: [["p", hex("z")]] }),
    ev({
      id: hex("8"),
      kind: 7,
      content: "+",
      pubkey: ME,
      tags: [["e", hex("9")]],
    }),
  ];
  const kinds = buildNotifications(events, ME).map((n) => n.kind);
  // newest first; the "-" reaction, someone else's follow and my own like are ignored
  expect(kinds).toEqual(["follow", "mention", "reply", "repost", "like"]);
});

test("only the newest follow per account is kept", () => {
  const events = [
    ev({ id: hex("1"), kind: 3, created_at: 5, tags: [["p", ME]] }),
    ev({ id: hex("2"), kind: 3, created_at: 9, tags: [["p", ME]] }),
  ];
  const items = buildNotifications(events, ME);
  expect(items).toHaveLength(1);
  expect(items[0].at).toBe(9);
});

test("likes on the same note collapse into one group", () => {
  const like = (id: string, who: string, at: number) =>
    ev({
      id,
      kind: 7,
      content: "+",
      pubkey: who,
      created_at: at,
      tags: [["e", hex("9")]],
    });
  const groups = groupNotifications(
    buildNotifications(
      [
        like(hex("1"), hex("b"), 1),
        like(hex("2"), hex("c"), 2),
        like(hex("3"), hex("b"), 3),
      ],
      ME,
    ),
  );
  expect(groups).toHaveLength(1);
  expect(groups[0].actors).toEqual([hex("b"), hex("c")]);
});

test("trending weighs reposts and replies above likes", () => {
  const a = hex("1");
  const b = hex("2");
  const scores = scoreNotes([
    ev({ id: hex("3"), kind: 7, content: "+", tags: [["e", a]] }),
    ev({ id: hex("4"), kind: 7, content: "+", tags: [["e", a]] }),
    ev({ id: hex("5"), kind: 6, tags: [["e", b]] }),
    ev({ id: hex("6"), kind: 1, tags: [["e", b, "", "reply"]] }),
    ev({ id: hex("7"), kind: 7, content: "-", tags: [["e", a]] }),
  ]);
  expect(scores.get(a)).toBe(2);
  expect(scores.get(b)).toBe(4);
  expect(topIds(scores, 1)).toEqual([b]);
});

test("a hashtag counts once per author", () => {
  const note = (id: string, who: string, content: string) =>
    ev({ id, kind: 1, pubkey: who, content });
  expect(
    trendingHashtags(
      [
        note(hex("1"), hex("b"), "#buzz #buzz again"),
        note(hex("2"), hex("b"), "#buzz"),
        note(hex("3"), hex("c"), "#buzz #nostr"),
      ],
      5,
    ),
  ).toEqual([
    { tag: "buzz", count: 2 },
    { tag: "nostr", count: 1 },
  ]);
});

test("who-to-follow ranks by followers and skips excluded accounts", () => {
  const list = (author: string, follows: string[], at = 1) =>
    ev({
      id: author.slice(0, 1).repeat(64),
      kind: 3,
      pubkey: author,
      created_at: at,
      tags: follows.map((p) => ["p", p]),
    });
  const result = mostFollowed(
    [
      list(hex("b"), [hex("x"), hex("y")]),
      list(hex("c"), [hex("x"), ME]),
      list(hex("d"), [hex("x"), hex("y")]),
      // b's stale list must not be double counted
      list(hex("b"), [hex("y")], 0),
    ],
    new Set([ME]),
    5,
  );
  expect(result).toEqual([
    { pubkey: hex("x"), followers: 3 },
    { pubkey: hex("y"), followers: 2 },
  ]);
});
