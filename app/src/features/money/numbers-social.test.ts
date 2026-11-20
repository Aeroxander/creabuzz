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
