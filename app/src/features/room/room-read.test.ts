// The room as it is built from one read of its tag (plan 4.1 and 7.6): only events that carry exactly this room's two tags are
// in it, replies hang under their root and are never read by `#e`, and a person the reader hid is gone everywhere.
import { describe, expect, it } from "vitest";
import type { SignedEvent } from "../posts/use-posts";
import { buildRoom, isOfRoom } from "./room-read";

const FOUNDER = "f".repeat(64);
const COORD = `37001:${FOUNDER}:lantern`;
const KEY = `0x${"cd".repeat(32)}`;
const OTHER_KEY = `0x${"ef".repeat(32)}`;
const ME = "1".repeat(64);
const ANA = "2".repeat(64);
const BO = "3".repeat(64);
let n = 0;
const id = () => (++n).toString(16).padStart(64, "0");
const roomTags = (key = KEY, coord = COORD) => [
  ["a", coord],
  ["t", `room:${key}`],
];
function note(
  pubkey: string,
  at: number,
  tags: string[][] = roomTags(),
  kind = 1,
  content = "words",
): SignedEvent {
  return {
    id: id(),
    pubkey,
    kind,
    created_at: at,
    tags,
    content,
    sig: "",
  } as SignedEvent;
}
const reply = (to: SignedEvent, pubkey: string, at: number) =>
  note(pubkey, at, [["e", to.id, "", "root"], ...roomTags()]);
const like = (to: SignedEvent, pubkey: string, at: number) =>
  note(
    pubkey,
    at,
    [["e", to.id], ["p", to.pubkey], ["k", "1"], ...roomTags()],
    7,
    "+",
  );
const room = (input: Partial<Parameters<typeof buildRoom>[0]>) =>
  buildRoom({
    notes: [],
    likes: [],
    coordinate: COORD,
    key: KEY,
    me: ME,
    hidden: new Set(),
    ...input,
  });

describe("which events are in the room", () => {
  it("needs the project's tag once and this room's key", () => {
    expect(isOfRoom({ tags: roomTags() }, COORD, KEY)).toBe(true);
    expect(isOfRoom({ tags: roomTags(OTHER_KEY) }, COORD, KEY)).toBe(false);
    expect(
      isOfRoom({ tags: roomTags(KEY, `37001:${FOUNDER}:other`) }, COORD, KEY),
    ).toBe(false);
    expect(isOfRoom({ tags: [["a", COORD]] }, COORD, KEY)).toBe(false);
    expect(
      isOfRoom(
        { tags: [...roomTags(), ["a", `37001:${FOUNDER}:other`]] },
        COORD,
        KEY,
      ),
    ).toBe(false);
  });
});

describe("building the room", () => {
  it("lists top-level posts newest first with their replies oldest first and their counts", () => {
    const old = note(ANA, 100);
    const fresh = note(BO, 300);
    const r1 = reply(old, BO, 250);
    const r2 = reply(old, ME, 150);
    const view = room({
      notes: [old, fresh, r1, r2],
      likes: [like(old, BO, 400), like(old, ANA, 401)],
    });
    expect(view.posts.map((p) => p.event.id)).toEqual([fresh.id, old.id]);
    const first = view.posts[1];
    expect(first.replies.map((r) => r.event.id)).toEqual([r2.id, r1.id]);
    expect(first.engagement.ups).toBe(2);
    expect(first.engagement.replies).toBe(2);
  });

  it("drops what is not in this room, whatever the server sent, and a reply with no root on screen", () => {
    const mine = note(ANA, 100);
    const foreign = note(ANA, 200, roomTags(OTHER_KEY));
    const untagged = note(ANA, 300, [["e", mine.id, "", "root"]]);
    const orphan = reply(note(BO, 50), ANA, 120);
    const view = room({
      notes: [mine, foreign, untagged, orphan],
      likes: [like(foreign, BO, 5)],
    });
    expect(view.posts.map((p) => p.event.id)).toEqual([mine.id]);
    expect(view.posts[0].replies).toEqual([]);
    expect(view.posts[0].engagement.replies).toBe(0);
    expect(view.total).toBe(1);
  });

  it("leaves out a hidden person, and the answers to their posts have nowhere to hang", () => {
    const theirs = note(ANA, 100);
    const kept = note(BO, 200);
    const view = room({
      notes: [theirs, kept, reply(theirs, BO, 300), reply(kept, ANA, 310)],
      hidden: new Set([ANA]),
    });
    expect(view.posts.map((p) => p.event.id)).toEqual([kept.id]);
    expect(view.posts[0].replies).toEqual([]);
  });

  it("knows the viewer's own like", () => {
    const post = note(ANA, 100);
    const view = room({ notes: [post], likes: [like(post, ME, 200)] });
    expect(view.posts[0].engagement.myVote).toBe("+");
  });
});
