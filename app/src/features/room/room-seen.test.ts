// The "New" dot: what was last seen is kept on this device only, and a device that cannot keep it shows the dot, never hides news.
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasNews, markRoomSeen, roomSeenAt } from "./room-seen";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("what was last seen in a room", () => {
  it("shows news only for something newer than the last look, and never for an empty room", () => {
    expect(hasNews("c", 0)).toBe(false);
    expect(hasNews("c", 100)).toBe(true);
    markRoomSeen("c", 100);
    expect(roomSeenAt("c")).toBe(100);
    expect(hasNews("c", 100)).toBe(false);
    expect(hasNews("c", 101)).toBe(true);
    // An older look never takes back a newer one.
    markRoomSeen("c", 50);
    expect(roomSeenAt("c")).toBe(100);
  });

  it("keeps each room apart and the list bounded", () => {
    for (let i = 0; i < 230; i++) markRoomSeen(`room-${i}`, i + 1);
    expect(
      Object.keys(
        JSON.parse(localStorage.getItem("creaton.room.seen") ?? "{}"),
      ),
    ).toHaveLength(200);
    expect(roomSeenAt("room-229")).toBe(230);
  });

  it("with storage that fails shows the dot and does not throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => markRoomSeen("c", 100)).not.toThrow();
    expect(roomSeenAt("c")).toBe(0);
    expect(hasNews("c", 100)).toBe(true);
  });

  it("reads a damaged value as nothing seen", () => {
    localStorage.setItem("creaton.room.seen", "{not json");
    expect(roomSeenAt("c")).toBe(0);
    localStorage.setItem("creaton.room.seen", '{"c":"soon"}');
    expect(roomSeenAt("c")).toBe(0);
  });
});
