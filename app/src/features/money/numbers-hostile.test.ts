// biome-ignore-all lint/suspicious/noExplicitAny: the record is walked as loose JSON, the way a hostile one arrives
import { describe, expect, it } from "vitest";
import {
  BACKER_EVM,
  FOUNDER_EVM,
} from "../../../tests/helpers/numbers-v2-fixture";
import {
  EXAMPLE_KEY,
  exampleEvent,
  raw,
  SERVER,
} from "../../../tests/helpers/numbers-v2-parse";
import { parseNumbers } from "./numbers";

describe("a record that cannot be read is null, never a crash and never a default number", () => {
  const parse = (content: unknown) =>
    parseNumbers(exampleEvent(content), SERVER);

  it("a version other than 2", () => {
    for (const version of [1, 3, 0, "2", null, undefined, 2.5, [2]])
      expect(parse({ ...raw(), version })).toBeNull();
    const { version: _v, ...without } = raw();
    expect(parse(without)).toBeNull();
  });

  it("not JSON, not an object", () => {
    for (const body of ["", "{", "null", "[]", "2", '"x"', "true", "{}"])
      expect(parseNumbers(exampleEvent(body), SERVER)).toBeNull();
  });

  it("another signer, another kind, no signer known, no d tag", () => {
    expect(parseNumbers(exampleEvent(), "e".repeat(64))).toBeNull();
    expect(parseNumbers(exampleEvent(), null)).toBeNull();
    expect(parseNumbers({ ...exampleEvent(), kind: 1 }, SERVER)).toBeNull();
    expect(parseNumbers({ ...exampleEvent(), tags: [] }, SERVER)).toBeNull();
    expect(
      parseNumbers({ ...exampleEvent(), tags: [["d", "0x12"]] }, SERVER),
    ).toBeNull();
    expect(
      parseNumbers(
        { ...exampleEvent(), tags: [["d", "f".repeat(66)]] },
        SERVER,
      ),
    ).toBeNull();
  });

  // Every leaf of the record: gone, or the wrong kind of thing, must read as null (the ledger block is not read at all,
  // and `playMoney` is the one field that falls back, to the safe answer).
  const NOT_READ = new Set(["ledger", "playMoney"]);
  function leafPaths(value: unknown, path: (string | number)[] = []) {
    const out: (string | number)[][] = [];
    if (Array.isArray(value))
      value.forEach((v, i) => {
        out.push(path.concat(i), ...leafPaths(v, path.concat(i)));
      });
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        if (path.length === 0 && NOT_READ.has(k)) continue;
        out.push(path.concat(k), ...leafPaths(v, path.concat(k)));
      }
    return out;
  }
  const SOCIAL = new Set(["held", "feed", "streaks", "established"]);
  // The step 4 keys are read apart the same way (`numbers-step4.ts`, walked by `numbers-step4.test.ts`): a broken one makes only
  // that key null, and a record signed before step 4 leaves them out.
  const STEP4 = new Set([
    "pause",
    "earlierGrants",
    "contracts.pause",
    "team.earlierPool",
    "team.earlierReserve",
  ]);
  // The milestone 9 keys are read by their own lazy parser, which nulls a hostile value and keeps the rest (6.6); an older
  // record simply has none of them, so their absence or a wrong kind never makes the whole record unreadable.
  const STEP9 = new Set(["runner.kind", "runner.seats", "council", "vote"]);
  const ALL_PATHS = leafPaths(raw());
  const PATHS = ALL_PATHS.filter(
    // `key` is checked against the d tag, and the signers/holders lists are exercised by their own elements. The task
    // queue is read apart (C21), and so are the four step 3 keys: a broken leaf of those makes only that part null, and
    // `numbers-social.test.ts` walks them.
    (p) =>
      p.join(".") !== "key" &&
      p[0] !== "tasks" &&
      !SOCIAL.has(String(p[0])) &&
      !STEP4.has(p.join(".")) &&
      !STEP9.has(p.join(".")) &&
      !STEP4.has(String(p[0])),
  );
  // The two totals a step 2 server adds: a record from an older server leaves them out, and is still read.
  const MAY_BE_ABSENT = new Set(["totals.paidToWorkers", "totals.noteClaims"]);
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

  it("has many fields to check", () => {
    expect(PATHS.length).toBeGreaterThan(150);
  });

  it("a missing field, anywhere", () => {
    const survivors: string[] = [];
    for (const path of PATHS) {
      const c = edit(path, (parent, k) => {
        if (Array.isArray(parent)) parent.splice(k, 1);
        else delete parent[k];
      });
      // Taking an element out of a list leaves a shorter, still valid list; every other missing field is unreadable.
      const parentOf = path
        .slice(0, -1)
        .reduce((o: any, k) => o[k], raw() as any);
      if (Array.isArray(parentOf)) continue;
      if (MAY_BE_ABSENT.has(path.join("."))) continue;
      if (parse(c) !== null) survivors.push(path.join("."));
    }
    expect(survivors).toEqual([]);
  });

  it("a field of the wrong kind, anywhere", () => {
    const survivors: string[] = [];
    for (const path of PATHS) {
      const parentOf = path
        .slice(0, -1)
        .reduce((o: any, k) => o[k], raw() as any);
      const c = edit(path, (parent, k) => {
        parent[k] = wrongKind(parent[k]);
      });
      if (parse(c) !== null) survivors.push(path.join("."));
      void parentOf;
    }
    expect(survivors).toEqual([]);
  });

  it("an amount that is negative, fractional, padded, hexadecimal, a number, or absurd", () => {
    const amountPaths = PATHS.filter((p) => {
      const v = p.reduce((o: any, k) => o[k], raw() as any);
      return typeof v === "string" && /^\d+$/.test(v);
    });
    expect(amountPaths.length).toBeGreaterThan(50);
    for (const path of amountPaths)
      for (const bad of [
        "-1",
        "1.5",
        "01",
        "00",
        "0x10",
        "1e6",
        " 1",
        "",
        "9".repeat(40),
        "1".padEnd(79, "0"),
        1,
        -1,
      ]) {
        const c = edit(path, (parent, k) => {
          parent[k] = bad;
        });
        expect(parse(c), `${path.join(".")} = ${String(bad)}`).toBeNull();
      }
  });

  it("a time or count that is negative, fractional, absurd or text", () => {
    const intPaths = PATHS.filter((p) => {
      const v = p.reduce((o: any, k) => o[k], raw() as any);
      return typeof v === "number";
    });
    expect(intPaths.length).toBeGreaterThan(40);
    for (const path of intPaths)
      for (const bad of [-1, 1.5, 2 ** 53, Number.MAX_SAFE_INTEGER, "1"]) {
        const c = edit(path, (parent, k) => {
          parent[k] = bad;
        });
        expect(parse(c), `${path.join(".")} = ${String(bad)}`).toBeNull();
      }
  });

  it("an address that is short, capitalised, or not hex", () => {
    const addressPaths = PATHS.filter((p) => {
      const v = p.reduce((o: any, k) => o[k], raw() as any);
      return typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v);
    });
    expect(addressPaths.length).toBeGreaterThan(10);
    for (const path of addressPaths)
      for (const bad of [
        "0x12",
        "0x3C44CDdDB6a900fa2b585dd299e03d12FA4293BC",
        `0x${"g".repeat(40)}`,
        "",
      ]) {
        const c = edit(path, (parent, k) => {
          parent[k] = bad;
        });
        expect(parse(c), `${path.join(".")} = ${bad}`).toBeNull();
      }
  });

  it("lists past their caps", () => {
    const base = raw() as any;
    const holder = base.holders[0];
    const tooManyHolders = { ...base, holders: Array(201).fill(holder) };
    expect(parse(tooManyHolders)).toBeNull();
    const grant = base.team.grants[0];
    expect(
      parse({
        ...base,
        team: { ...base.team, grants: Array(201).fill(grant) },
      }),
    ).toBeNull();
    expect(
      parse({ ...base, agents: Array(51).fill(base.agents[0]) }),
    ).toBeNull();
  });

  it("facts that contradict each other", () => {
    const base = raw() as any;
    // A notice running on a grant that is not announced, and an announced grant with no notice.
    const g = structuredClone(base);
    g.team.grants[0].forfeit = { amount: "1", burnAt: 1, byMember: true };
    expect(parse(g)).toBeNull();
    const h = structuredClone(base);
    h.team.grants[1].forfeit = null;
    expect(parse(h)).toBeNull();
    // More claimed than vested; claimable that is not vested less claimed.
    const i = structuredClone(base);
    i.team.grants[0].claimable = "1";
    expect(parse(i)).toBeNull();
    // A Pair with no signers, a lone runner with signers.
    const j = structuredClone(base);
    j.runner.isPair = true;
    expect(parse(j)).toBeNull();
    const k = structuredClone(base);
    k.runner.signers = [FOUNDER_EVM, BACKER_EVM];
    expect(parse(k)).toBeNull();
    // Money arriving with no end, and an end with nothing arriving.
    const l = structuredClone(base);
    l.money.arrivalEnd = null;
    expect(parse(l)).toBeNull();
    const m = structuredClone(base);
    m.money.arriving = "0";
    expect(parse(m)).toBeNull();
    // Wound down in the state but not in the record.
    const n = structuredClone(base);
    n.quiet.state = "wound_down";
    expect(parse(n)).toBeNull();
    // A refresh promise of nothing, or of a week: unbelievable. The least the server's settings allow, 5 seconds, is not.
    expect(
      parse({ ...structuredClone(base), refreshEverySecs: 5 }),
    ).not.toBeNull();
    for (const r of [0, 4, 86_401]) {
      const o = structuredClone(base);
      o.refreshEverySecs = r;
      expect(parse(o)).toBeNull();
    }
    // An unknown state word.
    const p = structuredClone(base);
    p.quiet.state = "sleepy";
    expect(parse(p)).toBeNull();
  });

  it("a field the reader does not know changes nothing (additive fields do not bump the version)", () => {
    const withExtra = { ...raw(), newThing: { x: 1 } };
    const n = parse(withExtra);
    expect(n).not.toBeNull();
    // And a `tasks` that is not the queue the reader knows is an unreadable queue, with the rest of the record read.
    const odd = parse({ ...raw(), tasks: [{ id: 1 }] });
    expect(odd && !odd.removed && odd.tasks).toBe("unreadable");
  });

  it("play money is the safe default when the record does not say", () => {
    const { playMoney: _p, ...without } = raw();
    for (const content of [
      without,
      { ...raw(), playMoney: "no" },
      { ...raw(), playMoney: null },
      { ...raw(), playMoney: 0 },
    ]) {
      const n = parse(content);
      expect(n && !n.removed && n.playMoney).toBe(true);
    }
    const real = parse({ ...raw(), playMoney: false });
    expect(real && !real.removed && real.playMoney).toBe(false);
  });

  it("never throws, on anything", () => {
    for (const content of [
      { version: 2 },
      { version: 2, contracts: null },
      { version: 2, removed: true },
      { version: 2, removed: true, key: EXAMPLE_KEY },
      { version: 2, removed: true, key: EXAMPLE_KEY, asOf: null },
      { ...raw(), holders: null },
      { ...raw(), holders: [null] },
      { ...raw(), team: { ...(raw().team as object), grants: [[]] } },
      JSON.parse('{"version":2,"__proto__":{"x":1}}'),
    ])
      expect(() => parse(content)).not.toThrow();
  });
});

describe("a task queue that cannot be believed makes only the queue unreadable (C21)", () => {
  const parse = (content: unknown) => {
    const n = parseNumbers(exampleEvent(content), SERVER);
    if (!n || n.removed) throw new Error("the rest of the record was not read");
    return n;
  };
  const clean = parse(raw());
  const TASK_PATHS = leafPaths(raw()).filter(
    (p) => p[0] === "tasks" && p.length > 1,
  );
  const restOf = (n: ReturnType<typeof parse>) => ({ ...n, tasks: undefined });

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
  const at = (path: (string | number)[]) =>
    path.reduce((o: any, k) => o[k], raw() as any);
  function broken(
    path: (string | number)[],
    change: (parent: any, k: any) => void,
  ) {
    const c = raw() as any;
    let parent = c;
    for (const step of path.slice(0, -1)) parent = parent[step];
    change(parent, path[path.length - 1]);
    return c;
  }
  const unreadable = (content: unknown, why: string) => {
    const n = parse(content);
    expect(n.tasks, why).toBe("unreadable");
    // The rest of the record reads exactly as it does without the fault: leaving is never blanked by a task bug.
    expect(restOf(n), why).toEqual(restOf(clean));
  };

  it("has many leaves to check", () => {
    expect(TASK_PATHS.length).toBeGreaterThan(100);
  });

  it("a missing field, anywhere in the queue", () => {
    for (const path of TASK_PATHS) {
      const parent = at(path.slice(0, -1));
      if (Array.isArray(parent)) continue;
      unreadable(
        broken(path, (p, k) => {
          delete p[k];
        }),
        `missing ${path.join(".")}`,
      );
    }
  });

  it("a field of the wrong kind, anywhere in the queue", () => {
    const wrong = (v: unknown) =>
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
    for (const path of TASK_PATHS)
      unreadable(
        broken(path, (p, k) => {
          p[k] = wrong(p[k]);
        }),
        `wrong kind ${path.join(".")}`,
      );
  });

  it("an amount that is negative, fractional, padded, hexadecimal, a number or absurd", () => {
    const paths = TASK_PATHS.filter((p) => {
      const v = at(p);
      return typeof v === "string" && /^\d+$/.test(v);
    });
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths)
      for (const bad of [
        "-1",
        "1.5",
        "01",
        "0x10",
        "1e6",
        "",
        "9".repeat(40),
        1,
        -1,
      ])
        unreadable(
          broken(path, (p, k) => {
            p[k] = bad;
          }),
          `${path.join(".")} = ${String(bad)}`,
        );
  });

  it("a time, count, share or serial that is negative, fractional, absurd or text", () => {
    const paths = TASK_PATHS.filter((p) => typeof at(p) === "number");
    expect(paths.length).toBeGreaterThan(40);
    for (const path of paths)
      for (const bad of [-1, 1.5, 2 ** 53, Number.MAX_SAFE_INTEGER, "1"])
        unreadable(
          broken(path, (p, k) => {
            p[k] = bad;
          }),
          `${path.join(".")} = ${String(bad)}`,
        );
  });

  it("an address or 32-byte value that is short, capitalised or not hex", () => {
    const paths = TASK_PATHS.filter((p) => {
      const v = at(p);
      return typeof v === "string" && /^0x[0-9a-f]+$/.test(v);
    });
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths)
      for (const bad of [
        "0x12",
        "0xAB",
        `0x${"g".repeat(at(path).length - 2)}`,
        at(path).toUpperCase().replace("0X", "0x"),
        "",
      ])
        if (bad !== at(path))
          unreadable(
            broken(path, (p, k) => {
              p[k] = bad;
            }),
            `${path.join(".")} = ${bad}`,
          );
  });

  it("a script in a field is only a string that does not fit", () => {
    const what = "<script>alert(1)</script>".padEnd(66, "0");
    unreadable(
      broken(["tasks", "list", 0, "what"], (p, k) => {
        p[k] = what;
      }),
      "what",
    );
  });
});

describe("the removal form", () => {
  const removed = (body: unknown) => parseNumbers(exampleEvent(body), SERVER);

  it("is read, with the key it names", () => {
    expect(
      removed({
        version: 2,
        key: EXAMPLE_KEY,
        removed: true,
        asOf: { block: 9, time: 1_795_000_000 },
      }),
    ).toEqual({ removed: true, key: EXAMPLE_KEY });
  });

  it("must name its own key and carry its block", () => {
    const asOf = { block: 9, time: 1_795_000_000 };
    expect(
      removed({ version: 2, key: `0x${"1".repeat(64)}`, removed: true, asOf }),
    ).toBeNull();
    expect(removed({ version: 2, removed: true, asOf })).toBeNull();
    expect(removed({ version: 2, key: EXAMPLE_KEY, removed: true })).toBeNull();
    expect(
      removed({ version: 1, key: EXAMPLE_KEY, removed: true, asOf }),
    ).toBeNull();
  });
});
