// Whether a network task ties to the team's record of it, and whether Accept may be offered: each refusal, in order, on the
// example's own rows and on the two-plans fixture the relay and the server also use (one record planned twice).
import { describe, expect, it } from "vitest";
import { parsedExample } from "../../../../tests/helpers/numbers-v2-parse";
import type { ProjectTask, WorkerLinks } from "../task-record";
import { acceptGate, chainRowOf, tieOf } from "./state";
import type { ChainTask, ChainTaskNow, ChainTasks } from "./types";

const example = parsedExample();
const queue = example.tasks as ChainTasks;
const at = example.asOf.time;
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

describe("acceptGate: Accept is offered only when the network and the record agree", () => {
  const founder = example.runner.address;
  const links: WorkerLinks = {
    founder: "a".repeat(64),
    agents: new Set(),
    operators: new Map(),
  };
  const team = new Set(["a".repeat(64), "c".repeat(64)]);
  const record = recordOf(taken, { state: "submitted" });
  const inputs = (over: Partial<Parameters<typeof acceptGate>[0]> = {}) => ({
    fresh: taken as ChainTaskNow,
    shown: taken,
    relay: record,
    now: at,
    me: "c".repeat(64),
    address: founder,
    runner: example.runner,
    team,
    links,
    ...over,
  });
  const refused = (over: Partial<Parameters<typeof acceptGate>[0]>) => {
    const gate = acceptGate(inputs(over));
    if (gate.ok) throw new Error("the gate was open");
    return gate;
  };

  it("is open when the task is taken, ties, is not near its deadline and the sender runs the project", () => {
    expect(acceptGate(inputs())).toEqual({ ok: true });
  });

  it("refuses when the network no longer says taken, and says what it says", () => {
    for (const state of [
      "paid",
      "rejected",
      "returned",
      "cancelled",
      "lapsed",
      "announced",
    ] as const) {
      const gate = refused({ fresh: { ...taken, state } });
      expect(gate.sentence).toContain("not waiting for payment on the network");
      expect(gate.sentence).toMatch(/Nothing can be paid\.$/);
    }
    expect(refused({ fresh: { ...taken, state: "paid" } }).sentence).toContain(
      "already paid",
    );
  });

  it("refuses when the deadline passed, or is within a minute (and offers no send-back after it)", () => {
    const deadline = taken.deadline ?? 0;
    const late = refused({ now: deadline });
    expect(late.sentence).toMatch(/^The deadline passed on /);
    expect(late.sendBackOffered).toBe(false);
    expect(refused({ now: deadline + 5_000 }).sentence).toMatch(
      /^The deadline passed on /,
    );
    const near = refused({ now: deadline - 30 });
    expect(near.sentence).toMatch(/too close to pay this safely/);
    expect(near.sendBackOffered).toBe(true);
    expect(acceptGate(inputs({ now: deadline - 61 }))).toEqual({ ok: true });
    expect(refused({ now: deadline - 60 }).sentence).toMatch(/too close/);
  });

  it("refuses when the taker on the network is not the wallet the record names, and offers to send the money back", () => {
    const named = "0x00000000000000000000000000000000000000a1";
    const gate = refused({
      relay: recordOf(taken, { payTo: named, state: "submitted" }),
    });
    // the wallet the plan names must be the one named too, so this fails at the payee; a changed taker fails at the taker
    expect(gate.sentence).toMatch(/not for this task as it was written here/);
    const swapped = refused({
      fresh: { ...taken, takenBy: named },
      shown: { ...taken, takenBy: named },
    });
    expect(swapped.sentence).toContain(`taken by ${named}`);
    expect(swapped.sentence).toContain(`named ${record.payTo} to be paid`);
    expect(swapped.sendBackOffered).toBe(true);
  });

  it("refuses when the plan is for another record, another amount, or a closed or already paid task", () => {
    const sentence = (r: ProjectTask) => refused({ relay: r }).sentence;
    expect(
      sentence(recordOf(taken, { id: "e".repeat(64), state: "submitted" })),
    ).toContain("names another task");
    expect(sentence(recordOf(taken, { usd: 1, state: "submitted" }))).toContain(
      "the pay is not the same",
    );
    expect(sentence(recordOf(taken, { state: "cancelled" }))).toContain(
      "stopped or given up",
    );
    expect(
      sentence(
        recordOf(taken, { state: "accepted", paidTx: `0x${"1".repeat(64)}` }),
      ),
    ).toContain("already paid here");
    expect(refused({ relay: null }).sentence).toContain(
      "not on this project's task list",
    );
  });

  it("refuses a repeat, and says which plan came first", () => {
    const gate = refused({
      fresh: {
        ...repeat,
        state: "taken",
        takenBy: repeat.payee,
        takenAt: 1,
        deadline: at + 99_999,
        setAside: 5n,
      },
      shown: { ...repeat, state: "taken", takenBy: repeat.payee },
      relay: recordOf(repeat, { state: "submitted" }),
    });
    expect(gate.sentence).toContain(`task ${repeat.repeatOf} came first`);
    expect(gate.sendBackOffered).toBe(true);
  });

  it("refuses when the sender is not the runner, and when the sender did the work", () => {
    expect(refused({ address: null }).sentence).toMatch(
      /Only the wallet that runs this project/,
    );
    expect(
      refused({ address: "0x00000000000000000000000000000000000000a1" })
        .sentence,
    ).toMatch(/Only the wallet that runs this project/);
    // with a Pair, either signer may
    const signers = [
      "0x00000000000000000000000000000000000000a1",
      "0x00000000000000000000000000000000000000a2",
    ] as [string, string];
    const pair = {
      address: "0x00000000000000000000000000000000000000f0",
      isPair: true,
      signers,
    };
    expect(acceptGate(inputs({ runner: pair, address: signers[1] }))).toEqual({
      ok: true,
    });
    expect(refused({ me: record.worker ?? "" }).sentence).toMatch(
      /done by you or by an agent you run/,
    );
  });

  it("refuses when nothing is set aside", () => {
    expect(refused({ fresh: { ...taken, setAside: 0n } }).sentence).toBe(
      "Nothing is set aside for this task, so nothing can be paid.",
    );
  });

  it("reads the fresh task, never the shown row, for what is on the network now", () => {
    // the card showed a taken task; the chain now says it was paid
    const gate = refused({
      fresh: {
        ...taken,
        state: "paid",
        setAside: taken.setAside,
        returned: 0n,
      },
    });
    expect(gate.sentence).toContain("already paid");
    // the card showed a plan with the wrong taker, the chain has the right one: open
    expect(
      acceptGate(
        inputs({
          shown: {
            ...taken,
            takenBy: "0x00000000000000000000000000000000000000a1",
          },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("never offers 'Send the money back' on a refusal where nothing is set aside, or after the deadline", () => {
    expect(refused({ fresh: { ...taken, setAside: 0n } }).sendBackOffered).toBe(
      false,
    );
    expect(refused({ now: (taken.deadline ?? 0) + 1 }).sendBackOffered).toBe(
      false,
    );
  });
});
