// The records the room's tools write and read (plan 4.4): exactly what the server accepts, and a stop believed only when the
// team signed it.
import { describe, expect, it } from "vitest";
import type { SignedEvent } from "../posts/use-posts";
import {
  activeMutes,
  linkedAddresses,
  mutedUntil,
  muteRecord,
  removeRecord,
  reportRecord,
} from "./room-records";

const FOUNDER = "f".repeat(64);
const MATE = "e".repeat(64);
const ANA = "2".repeat(64);
const COORD = `37001:${FOUNDER}:lantern`;
const W1 = `0x${"11".repeat(20)}`;
const W2 = `0x${"22".repeat(20)}`;
let n = 0;
const ev = (
  pubkey: string,
  at: number,
  tags: string[][],
  content = "{}",
): SignedEvent =>
  ({
    id: (++n).toString(16).padStart(64, "0"),
    pubkey,
    kind: 47003,
    created_at: at,
    tags,
    content,
    sig: "",
  }) as SignedEvent;

describe("the records", () => {
  it("a report names the post and its author with one of the server's types", () => {
    const post = ev(ANA, 1, []);
    expect(reportRecord(post, "spam")).toEqual({
      kind: 1984,
      tags: [
        ["e", post.id, "spam"],
        ["p", ANA],
      ],
      content: "",
    });
  });

  it("a removal is one post and a public reason of at most 280 characters, and no channel", () => {
    const record = removeRecord("a".repeat(64), `  ${"x".repeat(400)}  `);
    expect(record.kind).toBe(9005);
    expect(record.tags[0]).toEqual(["e", "a".repeat(64)]);
    expect(record.tags[1][0]).toBe("public_reason");
    expect(record.tags[1][1].length).toBe(280);
    expect(record.tags.some((t) => t[0] === "h")).toBe(false);
    expect(removeRecord("a".repeat(64), "  ").tags).toEqual([
      ["e", "a".repeat(64)],
    ]);
  });

  it("a stop names the person, up to 8 wallets (once each, lower case) and when it ends", () => {
    const wallets = Array.from(
      { length: 12 },
      (_, i) => `0x${i.toString(16).padStart(40, "a")}`,
    );
    const record = muteRecord({
      coordinate: COORD,
      person: ANA.toUpperCase(),
      wallets: [W1.toUpperCase().replace("0X", "0x"), W1, "nope", ...wallets],
      until: 1234.9,
    });
    expect(record.kind).toBe(47003);
    expect(record.tags[0]).toEqual(["a", COORD]);
    expect(record.tags[1]).toEqual(["room-mute", ANA]);
    expect(record.tags.filter((t) => t[0] === "room-mute-wallet")).toHaveLength(
      8,
    );
    expect(record.tags.at(-1)).toEqual(["expiration", "1234"]);
    expect(record.content).toBe("{}");
  });
});

describe("the stops in force", () => {
  const team = new Set([FOUNDER, MATE]);
  const stop = (
    by: string,
    at: number,
    person: string,
    until: number,
    wallets: string[] = [],
  ) =>
    ev(by, at, [
      ["a", COORD],
      ["room-mute", person],
      ...wallets.map((w) => ["room-mute-wallet", w]),
      ["expiration", String(until)],
    ]);

  it("believes only the team, the newest per person, and none that ended", () => {
    const events = [
      stop(FOUNDER, 10, ANA, 500),
      stop(ANA, 20, ANA, 0 + 9999),
      stop("9".repeat(64), 30, MATE, 9999),
      stop(MATE, 40, "5".repeat(64), 50),
    ];
    expect(activeMutes(events, team, 100).map((m) => m.person)).toEqual([ANA]);
    // A later record that ends it at once lifts the stop.
    expect(
      activeMutes([...events, stop(FOUNDER, 60, ANA, 99)], team, 100),
    ).toEqual([]);
    expect(activeMutes(events, team, 600)).toEqual([]);
  });

  it("stops an account, or any account that uses a wallet the stopped person had linked", () => {
    const stops = activeMutes([stop(FOUNDER, 10, ANA, 500, [W1])], team, 100);
    expect(mutedUntil(stops, ANA, [])).toBe(500);
    expect(
      mutedUntil(stops, "7".repeat(64), [W1.toUpperCase().replace("0X", "0x")]),
    ).toBe(500);
    expect(mutedUntil(stops, "7".repeat(64), [W2])).toBeNull();
    expect(mutedUntil([], ANA, [W1])).toBeNull();
  });
});

describe("a person's linked wallets, as the team names them", () => {
  const link = (address: string, at: number, content = "{}") =>
    ev(ANA, at, [["d", address]], content);
  it("lists the newest record per address that is not revoked, for that person only", () => {
    const events = [
      link(W1, 1),
      link(W1, 5, '{"revoked":true}'),
      link(W2, 3),
      ev("9".repeat(64), 4, [["d", `0x${"33".repeat(20)}`]]),
    ];
    expect(linkedAddresses(events, ANA)).toEqual([W2]);
  });
});
