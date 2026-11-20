// biome-ignore-all lint/suspicious/noExplicitAny: the record is walked as loose JSON, the way a hostile one arrives
// The four step 3 keys of a record are read apart from the money: each is right or null for that part, and a bad one never
// makes the record unreadable. Every number below is read from the example the server's own code wrote, never typed.
import { describe, expect, it } from "vitest";
import {
  exampleEvent,
  raw,
  SERVER,
} from "../../../tests/helpers/numbers-v2-parse";
import { parseNumbers } from "./numbers";

const KEYS = ["held", "feed", "streaks", "established"] as const;

function parsed(content: unknown) {
  const out = parseNumbers(exampleEvent(content), SERVER);
  if (!out || out.removed) return null;
  return out;
}
function edit(
  path: (string | number)[],
  change: (parent: any, k: any) => void,
) {
  const c = raw() as any;
  let parent = c;
  for (const step of path.slice(0, -1)) parent = parent[step];
  change(parent, path[path.length - 1]);
  return c;
}
function leafPaths(value: unknown, path: (string | number)[] = []) {
  const out: (string | number)[][] = [];
  if (Array.isArray(value))
    value.forEach((v, i) => {
      out.push(path.concat(i), ...leafPaths(v, path.concat(i)));
    });
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value))
      out.push(path.concat(k), ...leafPaths(v, path.concat(k)));
  return out;
}
const wrongKind = (v: unknown) =>
  typeof v === "string"
    ? 5
    : typeof v === "number"
      ? "5"
      : typeof v === "boolean"
        ? "yes"
        : v === null
          ? "x"
          : Array.isArray(v)
            ? { not: "a list" }
            : [];

describe("the step 3 keys of the example", () => {
  it("are read in full, from the example and never typed", () => {
    const n = parsed(raw());
    const r = raw() as any;
    expect(n).not.toBeNull();
    expect(n?.held?.windows.rankSecs).toBe(r.held.windows.rankSecs);
    expect(n?.held?.rank?.money).toBe(BigInt(r.held.rank.money));
    expect(n?.held?.rank?.accounts).toBe(r.held.rank.accounts);
    expect(n?.held?.badge?.bps).toBe(r.held.badge.bps);
    expect(n?.held?.countedAccounts).toBe(r.held.countedAccounts);
    expect(n?.feed?.hours).toHaveLength(r.feed.hours.length);
    expect(n?.feed?.roundTo).toBe(BigInt(r.feed.roundTo));
    expect(n?.feed?.items).toHaveLength(r.feed.items.length);
    expect(n?.streaks?.updates.weeks).toBe(r.streaks.updates.weeks);
    expect(n?.established?.reached).toBe(r.established.reached);
    expect(n?.established?.rule.minAccounts).toBe(
      r.established.rule.minAccounts,
    );
  });

  it("are left out of a record from an older server, which still reads", () => {
    const content = raw() as any;
    for (const key of KEYS) delete content[key];
    const n = parsed(content);
    expect(n).not.toBeNull();
    for (const key of KEYS) expect(key in (n as object)).toBe(false);
  });

  it("are null when the server said null, and the money is still read", () => {
    for (const key of KEYS) {
      const content = raw() as any;
      content[key] = null;
      const n = parsed(content);
      expect(n?.[key], key).toBeNull();
      expect(n?.money.pot).toBe(BigInt((raw() as any).money.pot));
    }
  });
});

describe("a step 3 key that cannot be believed is null for that part only", () => {
  const PATHS = KEYS.flatMap((key) => leafPaths((raw() as any)[key], [key]));

  it("has many fields to check", () => {
    expect(PATHS.length).toBeGreaterThan(300);
  });

  function check(
    make: (parent: any, k: any) => void,
    only?: (p: (string | number)[]) => boolean,
  ) {
    const survivors: string[] = [];
    for (const path of PATHS) {
      if (only && !only(path)) continue;
      const parentOf = path
        .slice(0, -1)
        .reduce((o: any, k) => o[k], raw() as any);
      const c = edit(path, make);
      const n = parsed(c);
      // The record is always read: the money and the other three keys stand.
      if (!n) survivors.push(`record lost: ${path.join(".")}`);
      else if (
        // A shorter list is a valid list; every other change must make the part null.
        !(Array.isArray(parentOf) && make.name === "remove") &&
        (n as any)[path[0]] !== null
      )
        survivors.push(path.join("."));
      else {
        for (const other of KEYS)
          if (other !== path[0] && (n as any)[other] === null)
            survivors.push(`${other} lost with ${path.join(".")}`);
      }
    }
    return survivors;
  }

  it("a field gone, anywhere", () => {
    const remove = (parent: any, k: any) => {
      if (Array.isArray(parent)) parent.splice(k, 1);
      else delete parent[k];
    };
    expect(check(remove)).toEqual([]);
  });

  it("a field of the wrong kind, anywhere", () => {
    expect(
      check((parent, k) => {
        parent[k] = wrongKind(parent[k]);
      }),
    ).toEqual([]);
  });

  it("an amount that is negative, fractional, padded, hexadecimal or absurd", () => {
    const amounts = PATHS.filter((p) => {
      const v = p.reduce((o: any, k) => o[k], raw() as any);
      return typeof v === "string" && /^\d+$/.test(v);
    });
    expect(amounts.length).toBeGreaterThan(20);
    for (const path of amounts)
      for (const bad of [
        "-1",
        "1.5",
        "01",
        "0x10",
        "1e6",
        "",
        "9".repeat(40),
        1,
      ]) {
        const n = parsed(
          edit(path, (parent, k) => {
            parent[k] = bad;
          }),
        );
        expect(n, `${path.join(".")} = ${String(bad)}`).not.toBeNull();
        expect(
          (n as any)[path[0]],
          `${path.join(".")} = ${String(bad)}`,
        ).toBeNull();
      }
  });

  it("a time or count that is negative, fractional, absurd or text", () => {
    const ints = PATHS.filter((p) => {
      const v = p.reduce((o: any, k) => o[k], raw() as any);
      return typeof v === "number";
    });
    expect(ints.length).toBeGreaterThan(100);
    for (const path of ints)
      for (const bad of [-1, 1.5, 2 ** 53, "1"]) {
        const n = parsed(
          edit(path, (parent, k) => {
            parent[k] = bad;
          }),
        );
        expect(n, `${path.join(".")} = ${String(bad)}`).not.toBeNull();
        expect(
          (n as any)[path[0]],
          `${path.join(".")} = ${String(bad)}`,
        ).toBeNull();
      }
  });

  it("lists past their caps", () => {
    const base = raw() as any;
    const tooManyHours = {
      ...base,
      feed: { ...base.feed, hours: [...base.feed.hours, base.feed.hours[0]] },
    };
    expect(parsed(tooManyHours)?.feed).toBeNull();
    const tooManyItems = {
      ...base,
      feed: { ...base.feed, items: Array(31).fill(base.feed.items[0]) },
    };
    expect(parsed(tooManyItems)?.feed).toBeNull();
    expect(parsed(tooManyItems)?.held).not.toBeNull();
  });
});

describe("what the parts must agree with", () => {
  it("a verdict that contradicts its inputs is not believed", () => {
    const flip = raw() as any;
    flip.established.reached = !flip.established.reached;
    expect(parsed(flip)?.established).toBeNull();
    // Reached with too few people is a contradiction as well.
    const few = raw() as any;
    few.established.reached = true;
    few.established.twoSigners = true;
    few.established.heldBps = few.established.rule.minHeldBps;
    few.established.accounts = few.established.rule.minAccounts - 1;
    expect(parsed(few)?.established).toBeNull();
    // A verdict that is not known is fine when its inputs are not known.
    const unknown = raw() as any;
    unknown.established.reached = null;
    expect(parsed(unknown)?.established?.reached).toBeNull();
  });

  it("an even hour has no money and a busy one has some", () => {
    const base = raw() as any;
    const bad = structuredClone(base);
    bad.feed.hours[0].net = { dir: "even", amount: base.feed.roundTo };
    expect(parsed(bad)?.feed).toBeNull();
    const bad2 = structuredClone(base);
    bad2.feed.hours[0].net = { dir: "in", amount: "0" };
    expect(parsed(bad2)?.feed).toBeNull();
  });

  it("hours out of order are not believed", () => {
    const bad = raw() as any;
    const [first, second] = bad.feed.hours;
    bad.feed.hours[0] = second;
    bad.feed.hours[1] = first;
    expect(parsed(bad)?.feed).toBeNull();
  });

  it("a feed that is not rounded to the server's 100 dollars, or has an amount that is not a multiple of it, is not believed (never drawn as an exact figure)", () => {
    const exact = raw() as any;
    exact.feed.roundTo = "1";
    exact.feed.hours[47] = {
      ...exact.feed.hours[47],
      joins: 1,
      net: { dir: "in", amount: "12345678" },
    };
    expect(parsed(exact)?.feed).toBeNull();
    const odd = raw() as any;
    odd.feed.hours[47] = {
      ...odd.feed.hours[47],
      joins: 1,
      net: { dir: "in", amount: String(BigInt(odd.feed.roundTo) + 1n) },
    };
    expect(parsed(odd)?.feed).toBeNull();
  });

  it("hours that are not one bucket apart, or do not end at the record's own time, are not believed", () => {
    const gap = raw() as any;
    gap.feed.hours[10].at += 1;
    expect(parsed(gap)?.feed).toBeNull();
    const old = raw() as any;
    for (const h of old.feed.hours) h.at -= 365 * 86_400;
    expect(parsed(old)?.feed).toBeNull();
    const ahead = raw() as any;
    for (const h of ahead.feed.hours) h.at += ahead.feed.bucketSecs;
    expect(parsed(ahead)?.feed).toBeNull();
  });

  it("hours whose only fault is two neighbours that are not exactly one bucket apart are not believed (the order and the last hour are right)", () => {
    // An hour is missing in the middle: the list still runs oldest first, still ends at the record's own time, every amount is
    // still a multiple of the rounding. Nothing but the distance between two neighbours is wrong.
    const missing = raw() as any;
    missing.feed.hours.splice(20, 1);
    expect(parsed(missing)?.feed).toBeNull();
    // The first twenty hours sit half a bucket early: one pair is one and a half buckets apart and every other pair is exact.
    const half = raw() as any;
    for (let i = 0; i < 20; i += 1)
      half.feed.hours[i].at -= half.feed.bucketSecs / 2;
    expect(parsed(half)?.feed).toBeNull();
    // The same list with every pair exact is believed, so the two cases above fail for the gap alone.
    expect(parsed(raw())?.feed).not.toBeNull();
  });

  it("items oldest first, or dated after the record's own time, are not believed", () => {
    const reversed = raw() as any;
    reversed.feed.items.reverse();
    expect(parsed(reversed)?.feed).toBeNull();
    const future = raw() as any;
    future.feed.items[0].at = future.asOf.time + 30 * 86_400;
    expect(parsed(future)?.feed).toBeNull();
  });

  it("a run of updates longer than the project has lived is not believed", () => {
    const bad = raw() as any;
    bad.streaks.updates.weeks = 900;
    bad.streaks.updates.longest = 900;
    expect(parsed(bad)?.streaks).toBeNull();
  });

  it("money kept for a window above all the project's money is not believed", () => {
    const bad = raw() as any;
    bad.held.rank.money = "999999999999999999";
    expect(parsed(bad)?.held).toBeNull();
  });

  it("a badge whose inputs are not the record's own held figures is not believed", () => {
    const bad = raw() as any;
    bad.established.heldBps = bad.established.rule.minHeldBps;
    bad.established.accounts = bad.established.rule.minAccounts;
    bad.established.twoSigners = true;
    bad.established.reached = true;
    expect(parsed(bad)?.established).toBeNull();
    const other = raw() as any;
    other.established.accounts = other.held.countedAccounts + 1;
    other.established.reached = false;
    expect(parsed(other)?.established).toBeNull();
  });

  it("a streak cannot be longer than the longest one", () => {
    const bad = raw() as any;
    bad.streaks.updates.weeks = bad.streaks.updates.longest + 1;
    expect(parsed(bad)?.streaks).toBeNull();
  });

  it("an item of a kind this app does not know is skipped, never shown as something else", () => {
    const base = raw() as any;
    const content = structuredClone(base);
    content.feed.items.unshift({
      kind: "rate_proposed",
      at: base.feed.items[0].at,
      serial: null,
      date: null,
    });
    const n = parsed(content);
    expect(n?.feed?.items).toHaveLength(base.feed.items.length);
    expect(
      n?.feed?.items.every((i) => i.kind !== ("rate_proposed" as any)),
    ).toBe(true);
  });

  it("a task row names its task and an update names none", () => {
    const bad = raw() as any;
    const update = bad.feed.items.find((i: any) => i.kind === "update");
    update.serial = 3;
    expect(parsed(bad)?.feed).toBeNull();
  });

  it("the example carries no address and no name anywhere in the four keys", () => {
    const text = JSON.stringify(KEYS.map((k) => (raw() as any)[k]));
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});
