// biome-ignore-all lint/suspicious/noExplicitAny: an index is changed as loose JSON, the way a hostile one arrives
// The ranking's index: believed only from the server's own key, only when it is not old, read apart from anything else, sorted
// by the one rule (money that stayed, accounts, older, key) whatever order it came in, and never reading a price, the pot or
// volume. The money and the people are the example's own, scaled by arithmetic; nothing is typed in.
import { describe, expect, it } from "vitest";
import {
  type ShapeOnlyEntry,
  shapeOnlyIndexContent,
} from "../../../tests/helpers/numbers-v2-fixture";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import {
  compareEntries,
  entryHolds,
  type ExploreEntry,
  INDEX_ENTRIES_MAX,
  INDEX_MAX_AGE_SECS,
  parseIndex,
  rankedEntries,
  splitCoordinate,
} from "./ranking";

const SIGNER = "f".repeat(64);
const NOW = 1_800_000_000;
const rank = parsedExample().held?.rank;
if (!rank) throw new Error("the example has no ranking window");
const WINDOW = parsedExample().held?.windows.rankSecs ?? 0;
const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const coordinate = (n: number) => `37001:${"b".repeat(64)}:p${n}`;

function shape(n: number, over: Partial<ShapeOnlyEntry> = {}): ShapeOnlyEntry {
  return {
    key: key(n),
    a: coordinate(n),
    launchedAt: NOW - 100 * WINDOW,
    windowSecs: WINDOW,
    money: rank?.money.toString() ?? "0",
    accounts: rank?.accounts ?? 0,
    reached: false,
    ...over,
  };
}
const times = (k: number) => ((rank?.money ?? 0n) * BigInt(k)).toString();

function event(entries: ShapeOnlyEntry[], over: Record<string, unknown> = {}) {
  return {
    id: "1".repeat(64),
    pubkey: SIGNER,
    kind: 39009,
    created_at: NOW - 60,
    tags: [["d", "explore"]],
    content: JSON.stringify(shapeOnlyIndexContent(entries, { now: NOW })),
    ...over,
  };
}
const parse = (e: ReturnType<typeof event>) => parseIndex(e, SIGNER, NOW);
const order = (entries: ShapeOnlyEntry[]) => {
  const index = parse(event(entries));
  return rankedEntries(
    index ?? { asOf: { block: 0, time: 0 }, entries: [] },
  ).map((e) => e.key);
};

describe("the index is believed only from the server, for the ranking, and while it is new", () => {
  it("reads a good one", () => {
    const index = parse(event([shape(1), shape(2)]));
    expect(index?.entries).toHaveLength(2);
    expect(index?.entries[0].money).toBe(rank?.money);
  });

  it("not from another key, not another record, not too old, not from the future", () => {
    expect(parseIndex(event([shape(1)]), "e".repeat(64), NOW)).toBeNull();
    expect(parseIndex(event([shape(1)]), null, NOW)).toBeNull();
    expect(parse(event([shape(1)], { pubkey: "e".repeat(64) }))).toBeNull();
    expect(parse(event([shape(1)], { kind: 1 }))).toBeNull();
    expect(parse(event([shape(1)], { tags: [["d", "other"]] }))).toBeNull();
    expect(parse(event([shape(1)], { tags: [] }))).toBeNull();
    expect(
      parse(event([shape(1)], { created_at: NOW - INDEX_MAX_AGE_SECS - 1 })),
    ).toBeNull();
    expect(
      parse(event([shape(1)], { created_at: NOW - INDEX_MAX_AGE_SECS })),
    ).not.toBeNull();
    expect(parse(event([shape(1)], { created_at: NOW + 3600 }))).toBeNull();
  });

  it("not when it is not the index, or is a version it does not know, or has too many entries or one twice", () => {
    const good = JSON.parse(event([shape(1)]).content);
    for (const bad of [
      { ...good, version: 2 },
      { ...good, kind: "numbers" },
      { ...good, entries: "x" },
      { ...good, asOf: null },
      {
        ...good,
        entries: Array.from({ length: INDEX_ENTRIES_MAX + 1 }, (_, i) =>
          shape(i + 1),
        ),
      },
      { ...good, entries: [shape(1), shape(1)] },
    ])
      expect(
        parse(event([], { content: JSON.stringify(bad) })),
        JSON.stringify(bad).slice(0, 60),
      ).toBeNull();
    expect(parse(event([], { content: "not json" }))).toBeNull();
    expect(parse(event([], { content: "null" }))).toBeNull();
  });

  it("not when its entries carry different windows (money kept for different lengths is not ranked together)", () => {
    expect(
      parse(event([shape(1, { windowSecs: 1, money: "999000000" }), shape(2)])),
    ).toBeNull();
    expect(parse(event([shape(1), shape(2)]))).not.toBeNull();
  });

  it("not when one entry cannot be read", () => {
    const fields = Object.keys(shape(1)) as (keyof ShapeOnlyEntry)[];
    for (const f of fields) {
      const gone: any = { ...shape(1) };
      delete gone[f];
      expect(parse(event([gone])), `no ${f}`).toBeNull();
      const wrong: any = { ...shape(1), [f]: [] };
      expect(parse(event([wrong])), `${f} a list`).toBeNull();
    }
    for (const bad of [
      { money: "-1" },
      { money: "1.5" },
      { accounts: -1 },
      { windowSecs: 0 },
      { key: "0x12" },
      { a: "37001:nobody:x" },
      { a: `30023:${"b".repeat(64)}:x` },
    ])
      expect(
        parse(event([shape(1, bad as any)])),
        JSON.stringify(bad),
      ).toBeNull();
    expect(
      parse(event([shape(1, { reached: null })]))?.entries[0].reached,
    ).toBeNull();
  });
});

describe("the rule: money that stayed, then accounts, then older, then the key", () => {
  const a = shape(1, { money: times(3), accounts: 1 });
  const b = shape(2, { money: times(2), accounts: 9 });
  const c = shape(3, { money: times(2), accounts: 4 });
  const d = shape(4, {
    money: times(2),
    accounts: 4,
    launchedAt: NOW - 200 * WINDOW,
  });
  const e = shape(5, {
    money: times(2),
    accounts: 4,
    launchedAt: NOW - 200 * WINDOW,
  });
  const f = shape(6);
  const wanted = [a, b, d, e, c, f].map((x) => x.key);

  it("applies it to the entries in any order they come", () => {
    const entries = [a, b, c, d, e, f];
    for (let round = 0; round < 12; round += 1) {
      const shuffled = [...entries].sort(
        (x, y) =>
          ((x.key.charCodeAt(63) * (round + 3)) % 7) -
            ((y.key.charCodeAt(63) * (round + 3)) % 7) || (round % 2 ? 1 : -1),
      );
      expect(order(shuffled), `round ${round}`).toEqual(wanted);
    }
    expect(order([f, e, d, c, b, a])).toEqual(wanted);
  });

  it("puts more accounts above fewer for the same money, an older project above a younger, and the key last", () => {
    const x = (n: ExploreEntry) => n;
    const all = parse(event([a, b, c, d, e, f]))?.entries ?? [];
    const [pa, pb, pc, pd, pe] = all.map(x);
    expect(compareEntries(pb, pc)).toBeLessThan(0);
    expect(compareEntries(pd, pc)).toBeLessThan(0);
    expect(compareEntries(pd, pe)).toBeLessThan(0);
    expect(compareEntries(pa, pb)).toBeLessThan(0);
  });

  it("a project with no money that stayed is not ranked, whatever else is true of it", () => {
    const none = shape(7, { money: "0", accounts: 3 });
    const nobody = shape(8, { accounts: 0 });
    expect(order([a, none, nobody])).toEqual([a.key]);
  });

  it("reads no price, no pot, no volume and no joins: an entry that carries them is ranked as if it did not", () => {
    const plain = order([a, b, c]);
    const noisy = [a, b, c].map((e, i) => ({
      ...e,
      price: String(10 ** (9 - i)),
      pot: String(10 ** (12 - 3 * i)),
      volume: String(10 ** (8 + i)),
      joins: 10 ** (3 - i),
    }));
    expect(order(noisy as any)).toEqual(plain);
    // And what is read of an entry is exactly the seven fields it is ranked by and shown with.
    const read = parse(event(noisy as any))?.entries[0];
    expect(Object.keys(read ?? {}).sort()).toEqual(
      [
        "a",
        "accounts",
        "key",
        "launchedAt",
        "money",
        "reached",
        "windowSecs",
      ].sort(),
    );
  });
});

describe("an entry holds only while its project's own record says so", () => {
  const entry = parse(event([shape(1)]))?.entries[0] as ExploreEntry;
  const project = (over: Record<string, unknown> = {}) =>
    ({ coordinate: coordinate(1), unlisted: false, ...over }) as any;
  const keyOf = (p: any) => (p.keyOf ?? key(1)) as string;
  it("is kept when listed and naming that launch", () => {
    expect(entryHolds(entry, project(), keyOf)).toBe(true);
  });
  it("is dropped when the record is missing, unlisted, another project's or names another launch", () => {
    expect(entryHolds(entry, undefined, keyOf)).toBe(false);
    expect(entryHolds(entry, project({ unlisted: true }), keyOf)).toBe(false);
    expect(
      entryHolds(entry, project({ coordinate: coordinate(2) }), keyOf),
    ).toBe(false);
    expect(entryHolds(entry, project({ keyOf: key(2) }), keyOf)).toBe(false);
    expect(entryHolds(entry, project(), () => null)).toBe(false);
  });
  it("splits the coordinate", () => {
    expect(splitCoordinate(coordinate(1))).toEqual({
      founder: "b".repeat(64),
      id: "p1",
    });
    expect(splitCoordinate("x")).toBeNull();
  });
});
