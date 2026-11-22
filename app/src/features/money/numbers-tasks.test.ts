// biome-ignore-all lint/suspicious/noExplicitAny: the record is walked as loose JSON, the way a hostile one arrives
// The record's task queue (`tasks`): the example the server wrote parses, every number a screen needs is reachable from the
// parsed record, and a queue that cannot be believed makes only the queue unreadable (C1, C21).
import { describe, expect, it } from "vitest";
import {
  exampleEvent,
  type Json,
  parsedExample,
  raw,
  SERVER,
} from "../../../tests/helpers/numbers-v2-parse";
import {
  COORDINATE,
  NOW,
  numbersV2Of,
} from "../../../tests/helpers/money-harness";
import {
  numbersV2Content,
  taskRow,
  withTasks,
} from "../../../tests/helpers/numbers-v2-fixture";
import type { ChainTask, ChainTasks } from "../tasks/chain/types";
import { parseNumbers } from "./numbers";
import { withStepKeys } from "./numbers-step9";

const parse = (content: unknown) => {
  const n = parseNumbers(exampleEvent(content), SERVER);
  if (!n || n.removed) throw new Error("the record was not read");
  return withStepKeys(n);
};
const tasksOf = (content: unknown) => parse(content).tasks;
const rec = () => raw() as Record<string, any>;

/** The record's own spelling of a parsed row (bigint to decimal text, serial to a JSON integer), to compare with the file. */
function written(row: ChainTask): Json {
  const text = (v: bigint | null) => (v === null ? null : v.toString());
  return {
    serial: Number(row.serial),
    what: row.what,
    payee: row.payee,
    state: row.state,
    shareBps: row.shareBps,
    maxDollars: text(row.maxDollars),
    atMostNow: text(row.atMostNow),
    announcedAt: row.announcedAt,
    noticeEnd: row.noticeEnd,
    expiresAt: row.expiresAt,
    takenBy: row.takenBy,
    takenAt: row.takenAt,
    deadline: row.deadline,
    setAside: text(row.setAside),
    stayerClaim: text(row.stayerClaim),
    noteFace: text(row.noteFace),
    pay: text(row.pay),
    returned: text(row.returned),
    notesLeft: text(row.notesLeft),
    capBps: row.capBps,
    resolvedAt: row.resolvedAt,
    resolvedTx: row.resolvedTx,
    repeatOf: row.repeatOf === null ? null : Number(row.repeatOf),
    notes: row.notes && {
      faceTotal: row.notes.faceTotal.toString(),
      holders: row.notes.holders.map((h) => ({
        account: h.account,
        face: h.face.toString(),
        claimable: h.claimable.toString(),
      })),
      holdersCut: row.notes.holdersCut,
    },
  };
}

function writtenSection(t: ChainTasks): Json {
  const { list, nextSerial, limits, next, ...rest } = t;
  return {
    ...rest,
    nextSerial: Number(nextSerial),
    limits: { ...limits, minTask: limits.minTask.toString() },
    next: next && { ...next, serial: Number(next.serial) },
    list: list.map(written),
  };
}

describe("the example's task queue", () => {
  it("parses, and every number a screen needs is reachable from the parsed record", () => {
    const tasks = parsedExample().tasks;
    expect(tasks).toBeTypeOf("object");
    if (!tasks || tasks === "unreadable") return;
    // Reading the parsed record back into the record's own spelling gives the file's section: nothing is dropped or changed.
    const file = rec().tasks;
    const back = writtenSection(tasks);
    // The rows come out open first and in serial order; the file is already in that order.
    expect(back).toEqual(file);
  });

  it("is the queue the server wrote: open rows first, then ended rows, newest first", () => {
    const tasks = parsedExample().tasks as ChainTasks;
    const open = tasks.list.filter(
      (r) => r.state === "announced" || r.state === "taken",
    );
    expect(tasks.openCount).toBe(open.length);
    expect(tasks.list.slice(0, open.length)).toEqual(open);
    const serials = tasks.list.map((r) => r.serial);
    for (let i = 1; i < open.length; i++)
      expect(serials[i] > serials[i - 1]).toBe(true);
    for (let i = open.length + 1; i < serials.length; i++)
      expect(serials[i] < serials[i - 1]).toBe(true);
  });

  it("obeys the rules of RECORD-V2 section 7.3, item 11, read from the file alone", () => {
    const r = rec();
    const rows = r.tasks.list as any[];
    const taken = rows.filter((x) => x.state === "taken");
    // money.locked is the sum of the stayers' claims of the taken rows that have not run out.
    const running = taken.filter((x) => x.deadline > r.asOf.time);
    expect(
      running.reduce((s, x) => s + BigInt(x.stayerClaim), 0n).toString(),
    ).toBe(r.money.locked);
    for (const x of rows) {
      const paid = BigInt(x.pay);
      const setAside = BigInt(x.setAside);
      if (x.state === "taken")
        expect(BigInt(x.stayerClaim) + BigInt(x.noteFace)).toBe(setAside);
      if (x.state === "paid") expect(paid + BigInt(x.returned)).toBe(setAside);
      if (x.state === "rejected" || x.state === "returned") {
        expect(paid).toBe(0n);
        expect(BigInt(x.returned)).toBe(setAside);
      }
      if (["announced", "cancelled", "lapsed"].includes(x.state))
        expect(setAside).toBe(0n);
      // atMostNow: only while an announced task can still be taken.
      expect(x.atMostNow !== null).toBe(
        x.state === "announced" && r.asOf.time < x.expiresAt,
      );
    }
    expect(r.tasks.cap.usedBps + r.tasks.cap.roomBps).toBe(
      r.tasks.limits.capBps,
    );
    expect(r.tasks.cap.frees.reduce((s: number, f: any) => s + f.bps, 0)).toBe(
      r.tasks.cap.usedBps,
    );
  });

  it("has the cases the screens must show: running with a note, in notice, a repeat, ended five ways", () => {
    const tasks = parsedExample().tasks as ChainTasks;
    const states = new Set(tasks.list.map((r) => r.state));
    for (const s of [
      "announced",
      "taken",
      "paid",
      "rejected",
      "returned",
      "cancelled",
      "lapsed",
    ])
      expect(states.has(s as never), s).toBe(true);
    expect(tasks.list.some((r) => r.repeatOf !== null)).toBe(true);
    expect(tasks.list.some((r) => (r.notes?.holders.length ?? 0) > 0)).toBe(
      true,
    );
    expect(tasks.next).not.toBeNull();
  });
});

describe("a record with no queue, or one from an older server", () => {
  it("`tasks` absent reads as absent, and the rest is read as always", () => {
    const { tasks: _t, ...without } = rec();
    const n = parse(without);
    expect(n.tasks).toBeUndefined();
    expect("tasks" in n).toBe(false);
  });

  it("`tasks: null` (a project with no task book) reads as null", () => {
    expect(tasksOf({ ...rec(), tasks: null })).toBeNull();
  });

  it("a step 1 record, with neither the queue nor the two new totals, is read in full", () => {
    const old = rec();
    delete old.tasks;
    delete old.totals.paidToWorkers;
    delete old.totals.noteClaims;
    const n = parse(old);
    expect(n.tasks).toBeUndefined();
    expect(n.totals.paidToWorkers).toBeUndefined();
    expect(n.totals.noteClaims).toBeUndefined();
    expect(n.money.pot).toBe(BigInt(old.money.pot));
  });
});

describe("a queue that cannot be believed is unreadable and nothing else is", () => {
  function unreadable(change: (tasks: any) => void, why: string) {
    const c = rec();
    change(c.tasks);
    const n = parse(c);
    expect(n.tasks, why).toBe("unreadable");
    // The money, the Shares and the holders read as they do without the fault.
    expect({ ...n, tasks: undefined }).toEqual({
      ...parsedExample(),
      tasks: undefined,
    });
  }
  const row = (t: any, n: number) => t.list[n];
  const open = (t: any) =>
    t.list.filter((r: any) => r.state === "announced" || r.state === "taken");

  it("a bad row: an unknown state, a missing field, a taken row with no taker", () => {
    unreadable((t) => {
      row(t, 0).state = "sleeping";
    }, "state");
    unreadable((t) => {
      delete row(t, 1).setAside;
    }, "missing field");
    unreadable((t) => {
      const taken = t.list.find((r: any) => r.state === "taken");
      taken.takenBy = null;
    }, "taken with no taker");
  });

  it("a duplicate serial", () => {
    unreadable((t) => {
      row(t, 1).serial = row(t, 0).serial;
    }, "duplicate");
  });

  it("nine open tasks, and an open count that is not the open rows", () => {
    unreadable((t) => {
      const more = [];
      for (let i = 0; i < 6; i++)
        more.push({
          ...structuredClone(open(t)[0]),
          serial: 100 + i,
          state: "announced",
        });
      t.list.push(...more);
      t.nextSerial = 1000;
      t.openCount = open(t).length;
    }, "more than eight open");
    unreadable((t) => {
      t.openCount += 1;
    }, "open count too high");
    unreadable((t) => {
      t.openCount -= 1;
    }, "open count too low");
  });

  it("thirty-three ended rows (thirty-two are read), and a list of more than forty", () => {
    const ended = (t: any, count: number) => {
      const planned = t.list.find(
        (r: any) => r.state === "announced" && r.repeatOf === null,
      );
      const lapsed = t.list.find((r: any) => r.state === "lapsed");
      t.list = [
        planned,
        ...Array.from({ length: count }, (_, i) => ({
          ...structuredClone(lapsed),
          serial: 200 + i,
        })),
      ];
      t.openCount = 1;
      t.nextSerial = 1000;
    };
    const c = rec();
    ended(c.tasks, 32);
    expect((parse(c).tasks as ChainTasks).list).toHaveLength(33);
    unreadable((t) => ended(t, 33), "33 ended");
    unreadable((t) => {
      const ended = t.list.find((r: any) => r.state === "lapsed");
      for (let i = 0; i < 41; i++)
        t.list.push({ ...structuredClone(ended), serial: 300 + i });
      t.nextSerial = 1000;
    }, "41 rows");
  });

  it("a negative or absurd amount, a short `what`, a repeat of a later serial, a next serial below the rows", () => {
    unreadable((t) => {
      row(t, 0).maxDollars = "-5";
    }, "negative amount");
    unreadable((t) => {
      row(t, 0).maxDollars = "9".repeat(60);
    }, "absurd amount");
    unreadable((t) => {
      row(t, 0).what = row(t, 0).what.slice(0, 40);
    }, "short what");
    unreadable((t) => {
      const repeat = t.list.find((r: any) => r.repeatOf !== null);
      repeat.repeatOf = repeat.serial;
    }, "repeat of itself");
    unreadable((t) => {
      t.nextSerial = 2;
    }, "next serial below the rows");
  });

  it("money in a row that cannot be: more returned or paid than was set aside, notes larger than their whole", () => {
    unreadable((t) => {
      const paid = t.list.find((r: any) => r.state === "paid");
      paid.returned = (BigInt(paid.setAside) + 1n).toString();
    }, "returned above set aside");
    unreadable((t) => {
      const noted = t.list.find((r: any) => r.notes?.holders.length);
      noted.notes.holders[0].face = (
        BigInt(noted.notes.faceTotal) + 1n
      ).toString();
    }, "holders above the total");
    unreadable((t) => {
      const noted = t.list.find((r: any) => r.notes?.holders.length);
      noted.notes.holders[0].claimable = (
        BigInt(noted.notes.holders[0].face) + 1n
      ).toString();
    }, "claim above the face");
  });

  it("more than twenty note holders in a row, more than sixteen frees", () => {
    unreadable((t) => {
      const noted = t.list.find((r: any) => r.notes?.holders.length);
      const holder = noted.notes.holders[0];
      noted.notes.holders = Array(21).fill({
        ...holder,
        face: "0",
        claimable: "0",
      });
    }, "21 holders");
    unreadable((t) => {
      t.cap.frees = Array(17).fill({ at: 1, bps: 1 });
    }, "17 frees");
  });

  it("a next date that names the wrong serial", () => {
    unreadable((t) => {
      t.next = { at: 1, kind: "cap_room", serial: 3 };
    }, "cap room of a task");
    unreadable((t) => {
      t.next = { at: 1, kind: "due", serial: 0 };
    }, "due of no task");
    unreadable((t) => {
      t.next = { at: 1, kind: "someday", serial: 1 };
    }, "unknown kind");
  });

  it("rows listed in another order are put in the order the screens rely on", () => {
    const c = rec();
    c.tasks.list.reverse();
    const n = parse(c);
    expect(n.tasks).toEqual(parsedExample().tasks);
  });
});

describe("the fixture the screens' tests use", () => {
  const make = (patch?: (c: Json) => void) =>
    numbersV2Of(numbersV2Content({ coordinate: COORDINATE, now: NOW, patch }));

  it("has no queue unless a test asks, so a step 1 test is a step 1 record", () => {
    expect(make().tasks).toBeUndefined();
  });

  it("brings the example's queue back with `withTasks`, moved in time with the rest of the record", () => {
    const n = make(withTasks());
    const queue = n.tasks as ChainTasks;
    const original = parsedExample().tasks as ChainTasks;
    expect(queue.list).toHaveLength(original.list.length);
    // every date keeps its distance from the record's own time
    const shift = n.asOf.time - parsedExample().asOf.time;
    for (const [i, row] of queue.list.entries()) {
      const was = original.list[i] as ChainTask;
      expect(row.noticeEnd).toBe(was.noticeEnd + shift);
      expect(row.deadline).toBe(
        was.deadline === null ? null : was.deadline + shift,
      );
      expect(row.resolvedAt).toBe(
        was.resolvedAt === null ? null : was.resolvedAt + shift,
      );
      expect(row.pay).toBe(was.pay);
    }
    expect(queue.nextExpiry).toBe((original.nextExpiry ?? 0) + shift);
    expect(queue.cap.frees[0]?.at).toBe(
      (original.cap.frees[0]?.at ?? 0) + shift,
    );
    expect(queue.limits).toEqual(original.limits);
  });

  it("lets a test change a row, and empties or clears the queue", () => {
    const n = make(
      withTasks((tasks) => {
        taskRow(tasks, 6).state = "paid";
        // a queue that says three are open must hold three open rows: the parser would not read it otherwise
        tasks.openCount = (tasks.openCount as number) - 1;
      }),
    );
    expect(
      (n.tasks as ChainTasks).list.find((r) => r.serial === 6n)?.state,
    ).toBe("paid");
    // the example's own rows are untouched by the change
    expect(
      (parsedExample().tasks as ChainTasks).list.find((r) => r.serial === 6n)
        ?.state,
    ).toBe("taken");
    expect(
      make(
        withTasks((t, c) => {
          c.tasks = null;
          void t;
        }),
      ).tasks,
    ).toBeNull();
  });
});
