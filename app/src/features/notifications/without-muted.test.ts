// What names a person, without the people they hid.
import type { JoinAsk } from "@creaton/core/project/join.ts";
import type { NotificationGroup } from "@creaton/core/social/notifications.ts";
import { describe, expect, it } from "vitest";
import { withoutMuted } from "./without-muted";

const ANA = "a".repeat(64);
const BO = "b".repeat(64);
const group = (key: string, actors: string[]): NotificationGroup => ({
  key,
  kind: "like",
  actors,
  at: 10,
  targetId: null,
  noteId: null,
});
const ask = (author: string): JoinAsk => ({
  id: author.slice(0, 4),
  author,
  coordinate: `37001:${"f".repeat(64)}:x`,
  invite: "x",
  createdAt: 5,
});
const data = {
  groups: [group("k1", [ANA, BO]), group("k2", [ANA])],
  asks: [ask(ANA), ask(BO)],
  newestAt: 99,
};

describe("notifications without the people a person hid", () => {
  it("is the same data when nobody is hidden", () => {
    expect(withoutMuted(data, new Set())).toBe(data);
  });

  it("takes a hidden actor out of a row and drops a row with nobody left", () => {
    const result = withoutMuted(data, new Set([ANA]));
    expect(result.groups.map((g) => [g.key, g.actors])).toEqual([["k1", [BO]]]);
  });

  it("drops an ask from a hidden person and keeps what was read as the newest", () => {
    const result = withoutMuted(data, new Set([ANA]));
    expect(result.asks.map((a) => a.author)).toEqual([BO]);
    expect(result.newestAt).toBe(99);
  });
});
