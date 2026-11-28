// Whether a network task ties to the team's record of it: each refusal, in order, on the
// example's own rows and on the two-plans fixture the relay and the server also use (one record planned twice).
import { describe, expect, it } from "vitest";
import { parsedExample } from "../../../../tests/helpers/numbers-v2-parse";
import type { ProjectTask } from "../task-record";
import { chainRowOf, tieOf } from "./state";
import type { ChainTask, ChainTasks } from "./types";

const example = parsedExample();
const queue = example.tasks as ChainTasks;
/** The team's own record of a network task, as the app would read it once the worker took it and named the same wallet. */
function recordOf(
  chain: ChainTask,
  patch: Partial<ProjectTask> = {},
): ProjectTask {
  return {
    id: chain.what.slice(2),
    author: "a".repeat(64),
    at: chain.announcedAt - 100,
    what: "Translate the guide",
    usd: Number(chain.maxDollars / 1_000_000n),
    openToAnyone: true,
    worker: "b".repeat(64),
    payTo: chain.takenBy ?? chain.payee,
    state: "working",
    handIn: null,
    acceptedBy: null,
    acceptedAt: null,
    paidTx: null,
    ...patch,
  };
}
const taken = queue.list.find((r) => r.state === "taken") as ChainTask;
const repeat = queue.list.find((r) => r.repeatOf !== null) as ChainTask;
const first = queue.list.find(
  (r) => r.what === repeat.what && r.repeatOf === null,
) as ChainTask;

describe("tieOf", () => {
  it("ties a plan to the record that made it", () => {
    expect(tieOf(taken, recordOf(taken))).toEqual({ ok: true });
  });

  it("each failure, with the one reason", () => {
    const why = (record: ProjectTask | null, chain: ChainTask = taken) => {
      const t = tieOf(chain, record);
      return t.ok ? "ok" : t.why;
    };
    expect(why(null)).toBe("no-record");
    expect(why(recordOf(taken, { id: "e".repeat(64) }))).toBe("what");
    expect(why(recordOf(taken, { state: "cancelled" }))).toBe("closed");
    expect(why(recordOf(taken, { state: "given-up" }))).toBe("closed");
    expect(
      why(
        recordOf(taken, { state: "accepted", paidTx: `0x${"1".repeat(64)}` }),
      ),
    ).toBe("already-paid");
    expect(why(recordOf(taken, { usd: 1 }))).toBe("amount");
    expect(why(recordOf(taken, { usd: null }))).toBe("amount");
    expect(why(recordOf(taken, { payTo: null }))).toBe("payee");
    expect(
      why(
        recordOf(taken, {
          payTo: "0x00000000000000000000000000000000000000a1",
        }),
      ),
    ).toBe("payee");
    expect(why(recordOf(taken), { ...taken, payee: null })).toBe("payee");
    // taken by another wallet than the one the plan names and the worker named
    expect(
      why(recordOf(taken), {
        ...taken,
        takenBy: "0x00000000000000000000000000000000000000a1",
      }),
    ).toBe("taker");
    expect(why(recordOf(repeat), repeat)).toBe("repeat");
    expect(why(recordOf(taken, { worker: null }))).toBe("worker-left");
    expect(why(recordOf(taken, { state: "offered" }))).toBe("not-taken");
    expect(why(recordOf(taken, { state: "open" }))).toBe("not-taken");
  });

  it("an accepted record whose pay is still owed still ties (step 1's pay owed, planned later)", () => {
    expect(
      tieOf(taken, recordOf(taken, { state: "accepted", paidTx: null })),
    ).toEqual({ ok: true });
  });

  it("a plan that was announced but not taken has no taker to check", () => {
    const planned = queue.list.find(
      (r) => r.state === "announced" && r.repeatOf === null,
    ) as ChainTask;
    expect(tieOf(planned, recordOf(planned))).toEqual({ ok: true });
  });

  it("returns the first failure when several hold, in the order of the plan", () => {
    const bad = recordOf(taken, {
      id: "e".repeat(64),
      state: "cancelled",
      usd: 1,
      payTo: null,
    });
    expect(tieOf(taken, bad)).toEqual({ ok: false, why: "what" });
    expect(tieOf(taken, { ...bad, id: taken.what.slice(2) })).toEqual({
      ok: false,
      why: "closed",
    });
    expect(
      tieOf(taken, { ...bad, id: taken.what.slice(2), state: "working" }),
    ).toEqual({
      ok: false,
      why: "amount",
    });
    expect(
      tieOf(taken, {
        ...bad,
        id: taken.what.slice(2),
        state: "working",
        usd: 400,
      }),
    ).toEqual({ ok: false, why: "payee" });
  });

  it("is not fooled by the case of an id or a wallet", () => {
    expect(
      tieOf(taken, recordOf(taken, { id: taken.what.slice(2).toUpperCase() })),
    ).toEqual({ ok: true });
    expect(
      tieOf(
        taken,
        recordOf(taken, {
          payTo: (taken.takenBy ?? "").toUpperCase().replace("0X", "0x"),
        }),
      ),
    ).toEqual({ ok: true });
  });
});

describe("one plan per task record: the lowest-serial live plan binds, a later one is a repeat", () => {
  it("the example plans one task twice; the first binds and the second never ties", () => {
    expect(repeat.repeatOf).toBe(first.serial);
    expect(first.serial < repeat.serial).toBe(true);
    const id = repeat.what.slice(2);
    expect(chainRowOf(queue, id)?.serial).toBe(first.serial);
    expect(tieOf(repeat, recordOf(repeat, { state: "working" }))).toEqual({
      ok: false,
      why: "repeat",
    });
  });
});
