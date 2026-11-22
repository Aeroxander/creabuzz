// biome-ignore-all lint/suspicious/noExplicitAny: the record is walked as loose JSON, the way a hostile one arrives
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  event,
  parsedExample,
  raw,
} from "../../../tests/helpers/numbers-v2-parse";
import { parseNumbers } from "./numbers";

const pausePath = resolve(
  __dirname,
  "../../../../docs/next-version/record-v2-example-pause.json",
);
const pauseRaw = (): Record<string, any> =>
  JSON.parse(readFileSync(pausePath, "utf8"));
const parse = (content: unknown) => {
  const key = String((content as Record<string, unknown>).key).toLowerCase();
  const n = parseNumbers(
    event(content, { tags: [["d", key]] }),
    "f".repeat(64),
  );
  if (!n || n.removed) throw new Error("the record did not parse");
  return n;
};
/** The pause example with `change` applied to a copy (the example itself is the server's output and is never retyped). */
const with4 = (change: (r: Record<string, any>) => void) => {
  const r = pauseRaw();
  change(r);
  return parse(r);
};

describe("the step 4 keys: the two real examples", () => {
  it("an ordinary deployment's record has every key null and the money reads as before", () => {
    const n = parsedExample();
    expect(n.pause).toBeNull();
    expect(n.earlierGrants).toBeNull();
    expect(n.contracts.pause).toBeNull();
    expect(n.team.earlier).toBeNull();
  });

  it("the pause example reads field by field from the file", () => {
    const r = pauseRaw();
    const n = parse(r);
    expect(n.contracts.pause).toBe(r.contracts.pause);
    expect(n.pause).toEqual({
      contract: r.pause.contract,
      parkedTotal: BigInt(r.pause.parkedTotal),
      line: BigInt(r.pause.line),
      dayLength: r.pause.dayLength,
      lineDivisor: r.pause.lineDivisor,
      armedAt: r.pause.armedAt,
      pausesFrom: r.pause.pausesFrom,
      paused: true,
      since: r.pause.since,
      parkerCount: r.pause.parkerCount,
    });
    expect(n.earlierGrants).toEqual({
      contract: r.earlierGrants.contract,
      bound: true,
      root: r.earlierGrants.root,
      textHash: r.earlierGrants.textHash,
      total: BigInt(r.earlierGrants.total),
      rows: r.earlierGrants.rows,
      claimedRows: r.earlierGrants.claimedRows,
      claimedTotal: BigInt(r.earlierGrants.claimedTotal),
      clockSecs: r.earlierGrants.clockSecs,
    });
    expect(n.team.earlier).toEqual({
      pool: BigInt(r.team.earlierPool),
      reserve: BigInt(r.team.earlierReserve),
    });
    // the founder's own pool and the grant sheet's number are the record's, unchanged
    expect(n.team.ungranted).toBe(BigInt(r.team.ungranted));
  });

  it("a record signed before step 4 (no such keys at all) leaves them out: never a guess that a stop exists", () => {
    const r = raw() as Record<string, any>;
    delete r.pause;
    delete r.earlierGrants;
    delete r.contracts.pause;
    delete r.team.earlierPool;
    delete r.team.earlierReserve;
    const n = parse(r);
    expect("pause" in n).toBe(false);
    expect("earlierGrants" in n).toBe(false);
    expect("pause" in n.contracts).toBe(false);
    expect("earlier" in n.team).toBe(false);
    // and the rest of the record is the same one
    expect(n.money.pot).toBe(parsedExample().money.pot);
  });
});

describe("the step 4 keys: a key that cannot be believed is null and the record stands", () => {
  const stands = (n: ReturnType<typeof parse>) =>
    expect(n.money.pot).toBe(BigInt(pauseRaw().money.pot));

  const bad: Array<[string, (r: Record<string, any>) => void]> = [
    [
      "a parked total above the backers' Shares",
      (r) => {
        r.pause.parkedTotal = (BigInt(r.shares.backers) + 1n).toString();
      },
    ],
    [
      "a line that is not the backers' Shares over the divisor",
      (r) => {
        r.pause.line = "1";
      },
    ],
    [
      "a divisor of 1",
      (r) => {
        r.pause.lineDivisor = 1;
      },
    ],
    [
      "a divisor that is not a number",
      (r) => {
        r.pause.lineDivisor = "3";
      },
    ],
    [
      "a day that is not a seventh of the unit",
      (r) => {
        r.pause.dayLength = 60;
      },
    ],
    [
      "paused true before the pause starts",
      (r) => {
        r.pause.armedAt = r.asOf.time;
        r.pause.pausesFrom = r.asOf.time + r.pause.dayLength;
        r.pause.since = r.pause.pausesFrom;
      },
    ],
    [
      "paused false after the pause started with the line reached",
      (r) => {
        r.pause.paused = false;
        r.pause.since = null;
      },
    ],
    [
      "since set while not paused",
      (r) => {
        r.pause.paused = false;
      },
    ],
    [
      "a start that is not armedAt plus a day",
      (r) => {
        r.pause.pausesFrom = r.pause.armedAt + 1;
        r.pause.since = r.pause.pausesFrom;
      },
    ],
    [
      "armed with no start",
      (r) => {
        r.pause.pausesFrom = null;
        r.pause.since = null;
        r.pause.paused = false;
      },
    ],
    [
      "an armed time after the record's own time",
      (r) => {
        r.pause.armedAt = r.asOf.time + 10;
      },
    ],
    [
      "a parker count of zero with Shares parked",
      (r) => {
        r.pause.parkerCount = 0;
      },
    ],
    [
      "a contract that is not the record's own",
      (r) => {
        r.pause.contract = `0x${"12".repeat(20)}`;
      },
    ],
    [
      "a non-numeric amount",
      (r) => {
        r.pause.parkedTotal = "lots";
      },
    ],
    [
      "a missing field",
      (r) => {
        delete r.pause.since;
      },
    ],
    [
      "a string where the object should be",
      (r) => {
        r.pause = "paused";
      },
    ],
  ];
  for (const [name, change] of bad)
    it(`${name} makes the pause key null`, () => {
      const n = with4(change);
      expect(n.pause).toBeNull();
      // the contract list still says there is one: the park sheet says it could not be read
      expect(n.contracts.pause).toBe(pauseRaw().contracts.pause);
      stands(n);
    });

  const badEarlier: Array<[string, (r: Record<string, any>) => void]> = [
    [
      "a claimed count above the rows",
      (r) => {
        r.earlierGrants.claimedRows = r.earlierGrants.rows + 1;
      },
    ],
    [
      "a claimed total above the pool",
      (r) => {
        r.earlierGrants.claimedTotal = (
          BigInt(r.earlierGrants.total) + 1n
        ).toString();
      },
    ],
    [
      "a pool that is not the team's earlier pool",
      (r) => {
        // Above what was claimed, so only the pool check can refuse it (a total of 1 would fail the claimed-total check first).
        r.earlierGrants.total = (BigInt(r.team.earlierPool) + 1n).toString();
      },
    ],
    [
      "zero rows",
      (r) => {
        r.earlierGrants.rows = 0;
      },
    ],
    [
      "a root that is not a fingerprint",
      (r) => {
        r.earlierGrants.root = "0x12";
      },
    ],
    [
      "a bound that is not a boolean",
      (r) => {
        r.earlierGrants.bound = "yes";
      },
    ],
    [
      "a text fingerprint in capitals",
      (r) => {
        r.earlierGrants.textHash = r.earlierGrants.textHash.toUpperCase();
      },
    ],
    [
      "a vesting clock of zero",
      (r) => {
        r.earlierGrants.clockSecs = 0;
      },
    ],
  ];
  for (const [name, change] of badEarlier)
    it(`${name} makes the earlier-grants key null`, () => {
      const n = with4(change);
      expect(n.earlierGrants).toBeNull();
      stands(n);
    });

  it("a reserve above its pool, or one without the other, makes the team's pair null and the claim key with it", () => {
    const high = with4((r) => {
      r.team.earlierReserve = (BigInt(r.team.earlierPool) + 1n).toString();
    });
    expect(high.team.earlier).toBeNull();
    const half = with4((r) => {
      r.team.earlierReserve = null;
    });
    expect(half.team.earlier).toBeNull();
    stands(high);
  });

  it("a bad contracts.pause is null, and a pause that names another contract is then not believed against it", () => {
    const n = with4((r) => {
      r.contracts.pause = "nope";
    });
    expect(n.contracts.pause).toBeNull();
    // a stop with no readable contract in the list still reads (it names its own); the park sheet shows nothing without both
    expect(n.pause).not.toBeNull();
  });

  it("a hostile pause never fails the whole record", () => {
    const r = pauseRaw();
    r.pause = { contract: 7, parkedTotal: {}, line: [], paused: "x" };
    r.earlierGrants = 12;
    r.team.earlierPool = {};
    const n = parse(r);
    expect(n.pause).toBeNull();
    expect(n.earlierGrants).toBeNull();
    expect(n.team.earlier).toBeNull();
    stands(n);
  });

  it("a divisor other than 3 reads (the words, not the parser, refuse 'a third')", () => {
    const r = pauseRaw();
    const backers = BigInt(r.shares.backers);
    r.pause.lineDivisor = 5;
    r.pause.line = ((backers + 4n) / 5n).toString();
    const n = parse(r);
    expect(n.pause?.lineDivisor).toBe(5);
  });
});
