// What a person has read, kept on this device only: it survives a reload, a device that cannot keep it shows everything
// unseen, pruning never drops a live id, and nothing here reaches the server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldKeys, markSeen, readSeen, rememberHeld } from "./seen";

const RELAY = "wss://seen.test";
const ME = "a".repeat(64);
const DAY = 86_400;
const NOW = 1_800_000_000;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("what was read", () => {
  it("starts empty, and what is marked is read back, also after a reload", () => {
    expect(readSeen(ME, RELAY)).toEqual({});
    markSeen(ME, ["k:1:planned"], new Set(["k:1:planned"]), NOW, RELAY);
    expect(readSeen(ME, RELAY)).toEqual({ "k:1:planned": NOW });
    // A reload keeps only the storage: a second read from it says the same.
    expect(
      JSON.parse(
        localStorage.getItem(`creaton-task-alerts-seen:${RELAY}:${ME}`) ?? "{}",
      ).seen,
    ).toEqual({ "k:1:planned": NOW });
  });

  it("is kept for this relay and this account only", () => {
    markSeen(ME, ["k:1:planned"], new Set(), NOW, RELAY);
    expect(readSeen(ME, "wss://another.test")).toEqual({});
    expect(readSeen("b".repeat(64), RELAY)).toEqual({});
  });

  it("a stored value that is not ours reads as nothing seen, never as an error", () => {
    for (const bad of [
      "not json",
      "[]",
      '{"v":2,"seen":{}}',
      '{"v":1,"seen":{"a":"x"}}',
    ])
      localStorage.setItem(`creaton-task-alerts-seen:${RELAY}:${ME}`, bad);
    expect(readSeen(ME, RELAY)).toEqual({});
  });

  it("storage that throws shows everything unseen at first and never fails the page; this visit remembers what it marks", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const me = "c".repeat(64);
    expect(readSeen(me, RELAY)).toEqual({});
    expect(() =>
      markSeen(me, ["k:2:taken"], new Set(), NOW, RELAY),
    ).not.toThrow();
    expect(readSeen(me, RELAY)).toEqual({ "k:2:taken": NOW });
  });
});

describe("pruning on every write", () => {
  it("drops what was read more than 60 days ago and is no longer derived, and keeps what was read within 60", () => {
    markSeen(ME, ["old", "recent"], new Set(), NOW - 61 * DAY, RELAY);
    markSeen(ME, ["recent"], new Set(), NOW - 10 * DAY, RELAY);
    markSeen(ME, ["fresh"], new Set(), NOW, RELAY);
    expect(Object.keys(readSeen(ME, RELAY)).sort()).toEqual([
      "fresh",
      "recent",
    ]);
  });

  it("never drops an id that is still derived, however old", () => {
    markSeen(ME, ["claim"], new Set(), NOW - 90 * DAY, RELAY);
    markSeen(ME, ["new"], new Set(["claim"]), NOW, RELAY);
    expect(Object.keys(readSeen(ME, RELAY)).sort()).toEqual(["claim", "new"]);
  });

  it("keeps at most 500 ids, the live ones first, then the newest", () => {
    const live = new Set(["live-1", "live-2"]);
    markSeen(ME, ["live-1", "live-2"], live, NOW - 100, RELAY);
    const many = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    markSeen(ME, many, live, NOW, RELAY);
    const seen = readSeen(ME, RELAY);
    expect(Object.keys(seen)).toHaveLength(500);
    expect(seen["live-1"]).toBeDefined();
    expect(seen["live-2"]).toBeDefined();
  });
});

describe("the projects a person was last found to hold", () => {
  it("are remembered per account, newest first, and forgotten when they hold nothing", () => {
    const account = "0x00000000000000000000000000000000000000AA";
    rememberHeld(ME, account, "key-a", true, NOW, RELAY);
    rememberHeld(ME, account, "key-b", true, NOW + 10, RELAY);
    rememberHeld(
      ME,
      "0x00000000000000000000000000000000000000bb",
      "key-c",
      true,
      NOW,
      RELAY,
    );
    expect(heldKeys(ME, account.toLowerCase(), RELAY)).toEqual([
      "key-b",
      "key-a",
    ]);
    rememberHeld(ME, account, "key-a", false, NOW + 20, RELAY);
    expect(heldKeys(ME, account, RELAY)).toEqual(["key-b"]);
  });

  it("a second note within the hour changes nothing (no write, no new render)", () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    rememberHeld(ME, "0xaa", "key-a", true, NOW, RELAY);
    const writes = set.mock.calls.length;
    rememberHeld(ME, "0xaa", "key-a", true, NOW + 60, RELAY);
    rememberHeld(ME, "0xaa", "key-z", false, NOW + 60, RELAY);
    expect(set.mock.calls.length).toBe(writes);
  });

  it("keeps the 40 newest", () => {
    for (let i = 0; i < 50; i += 1)
      rememberHeld(ME, "0xaa", `key-${i}`, true, NOW + i, RELAY);
    const keys = heldKeys(ME, "0xaa", RELAY);
    expect(keys).toHaveLength(40);
    expect(keys[0]).toBe("key-49");
  });
});
