// Which posts a reader sees outside a room: never a holder room's, never a hidden person's, never a post they reported.
import { describe, expect, it } from "vitest";
import { visiblePosts, whyHidden } from "./visible";

const ANA = "a".repeat(64);
const BO = "b".repeat(64);
const KEY = `0x${"cd".repeat(32)}`;
const post = (id: string, pubkey: string, tags: string[][] = []) => ({
  id: id.repeat(64).slice(0, 64),
  pubkey,
  tags,
});
const none = { muted: new Set<string>(), reported: new Set<string>() };

describe("which posts a reader sees", () => {
  it("shows an ordinary post to someone who hid and reported nothing", () => {
    expect(visiblePosts([post("1", ANA)], none)).toEqual({
      shown: [post("1", ANA)],
      hidden: 0,
    });
  });

  it("leaves out a post of a holder room and does not count it as hidden by the reader", () => {
    const inRoom = post("2", ANA, [["t", `room:${KEY}`]]);
    const odd = post("3", ANA, [["t", "room:not-a-key"]]);
    expect(whyHidden(inRoom, none)).toBe("room");
    expect(visiblePosts([inRoom, odd], none)).toEqual({ shown: [], hidden: 0 });
  });

  it("leaves out the posts of a person the reader hid, whatever the case of the key", () => {
    const rules = { ...none, muted: new Set([ANA]) };
    const mine = post("4", ANA.toUpperCase());
    expect(whyHidden(mine, rules)).toBe("muted");
    const result = visiblePosts([mine, post("5", BO)], rules);
    expect(result.shown.map((p) => p.pubkey)).toEqual([BO]);
    expect(result.hidden).toBe(1);
  });

  it("leaves out a post the reader reported, and only that post", () => {
    const first = post("6", ANA);
    const second = post("7", ANA);
    const rules = { ...none, reported: new Set([first.id]) };
    expect(whyHidden(first, rules)).toBe("reported");
    expect(visiblePosts([first, second], rules)).toEqual({
      shown: [second],
      hidden: 1,
    });
  });

  it("keeps the order it was given", () => {
    const list = [post("8", ANA), post("9", BO), post("a", ANA)];
    expect(visiblePosts(list, none).shown).toEqual(list);
  });
});
