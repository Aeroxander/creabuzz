// What stops a plan from being pressed, one sentence each, in the order the plan lists them. Pure: every input is built here.
import { describe, expect, it } from "vitest";
import {
  planRow,
  planTask,
  queueOf,
  sceneNumbers,
} from "../../../../../tests/helpers/plan-scene";
import type { ProjectNumbers } from "../../../money/numbers";
import { doorFor, shareFor } from "../door";
import { type PlanGateInput, planBlock } from "./plan-gate";
import { PLAN_BLOCK } from "./plan-words";
import type { PlanRead } from "./plan-read";
import type { ChainTaskNow } from "../types";

const ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

function scene(
  patch?: (content: Record<string, unknown>) => void,
): ProjectNumbers {
  return sceneNumbers(patch);
}

/** A chain read that is fine: checked in for a long time, nothing planned of this task, room for more. */
function read(numbers: ProjectNumbers, over: Partial<PlanRead> = {}): PlanRead {
  const time = numbers.asOf.time;
  return {
    book: queueOf(numbers).book,
    nextSerial: queueOf(numbers).nextSerial,
    open: queueOf(numbers).list.filter(
      (r) => r.state === "announced" || r.state === "taken",
    ),
    notice: {
      noticeSecs: 14 * 86_400,
      takeWindowSecs: 7 * 86_400,
      dueSecs: 14 * 86_400,
    },
    activeEnd: time + 30 * 86_400,
    box: numbers.allowance.box,
    boxCap: numbers.allowance.boxCap,
    time,
    ...over,
  };
}

function input(
  numbers: ProjectNumbers,
  over: Partial<PlanGateInput> & { read?: PlanRead } = {},
): PlanGateInput {
  const queue = queueOf(numbers);
  const task = over.task ?? planTask();
  const pay = BigInt(task.usd ?? 0) * 1_000_000n;
  const share = shareFor(pay, numbers.money.pot, queue.limits.maxShareBps);
  const chain = over.read ?? read(numbers);
  return {
    numbers,
    queue,
    task,
    read: chain,
    share,
    door: doorFor({
      usd: task.usd ?? 0,
      box: chain.box,
      boxCap: chain.boxCap,
      pot: numbers.money.pot,
      payee: task.payTo,
      runner: numbers.runner,
      limits: queue.limits,
      notice: chain.notice,
    }),
    address: ADDRESS,
    now: numbers.asOf.time,
    workerName: "Sam",
    ...over,
  };
}

describe("what stops a plan", () => {
  it("nothing, when the record is fresh, the team has checked in, there is room and the task ties", () => {
    const numbers = scene();
    expect(planBlock(input(numbers))).toBeNull();
  });

  it("a task the box already paid (its record is still to be saved) is not planned", () => {
    const numbers = scene();
    expect(planBlock(input(numbers, { boxPaid: true }))?.sentence).toBe(
      PLAN_BLOCK.boxPaid,
    );
    expect(planBlock(input(numbers, { boxPaid: false }))).toBeNull();
  });

  it("a pay-to of the zero address (open to anyone on the network) is no account, so nothing is planned", () => {
    const numbers = scene();
    const task = planTask({ payTo: `0x${"0".repeat(40)}` });
    expect(planBlock(input(numbers, { task }))?.sentence).toMatch(
      /has not named an account/,
    );
  });

  it("a project that wound down plans nothing", () => {
    const numbers = scene();
    const wound = {
      ...numbers,
      windDown: { kind: 1 as const, at: numbers.asOf.time },
    };
    expect(planBlock(input(wound))?.sentence).toBe(PLAN_BLOCK.wound);
  });

  it("a record past its as-of band cannot size a share", () => {
    const numbers = scene((c) => {
      c.builtAt = (c.builtAt as number) - 5_000;
    });
    expect(
      planBlock(input(numbers, { now: numbers.builtAt + 5_000 }))?.sentence,
    ).toBe(PLAN_BLOCK.stale);
  });

  it("a wallet that does not run the project cannot plan", () => {
    const numbers = scene();
    expect(
      planBlock(
        input(numbers, {
          address: "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
        }),
      )?.sentence,
    ).toBe(PLAN_BLOCK.notRunner);
  });

  it("a payee who runs the project is paid from the box only: the door's own sentence", () => {
    const numbers = scene();
    const task = planTask({ payTo: numbers.runner.address });
    const block = planBlock(input(numbers, { task }));
    expect(block?.sentence).toMatch(
      /cannot be planned. It can be paid from the allowance/,
    );
  });

  it("a project that has not checked in lately plans nothing", () => {
    const numbers = scene();
    const chain = read(numbers, { activeEnd: numbers.asOf.time });
    expect(planBlock(input(numbers, { read: chain }))?.sentence).toBe(
      PLAN_BLOCK.quiet,
    );
  });

  it("eight tasks open whose time is not up is the limit; a plan whose time is up counts as free", () => {
    const numbers = scene();
    const base = planRow(numbers);
    const rows = (expiresAt: number): ChainTaskNow[] =>
      Array.from({ length: 8 }, (_, i) => ({
        ...base,
        what: `0x${(i + 8).toString(16).repeat(64)}`,
        serial: BigInt(100 + i),
        expiresAt,
      }));
    const live = read(numbers, { open: rows(numbers.asOf.time + 1_000) });
    expect(planBlock(input(numbers, { read: live }))?.sentence).toBe(
      PLAN_BLOCK.full,
    );
    const past = read(numbers, { open: rows(numbers.asOf.time) });
    expect(planBlock(input(numbers, { read: past }))).toBeNull();
  });

  it("a task already planned on the network is said so, with the date, and is the one block a waiting send of ours may walk through", () => {
    const numbers = scene();
    const planned = planRow(numbers, { serial: 99n });
    const chain = read(numbers, { open: [planned] });
    const block = planBlock(input(numbers, { read: chain }));
    expect(block?.why).toBe("planned");
    expect(block?.sentence).toMatch(
      /This task is already planned: it can be taken from/,
    );
    // A plan whose time is up is ended by the next step: it is not "already planned".
    const lapsed = read(numbers, {
      open: [{ ...planned, expiresAt: numbers.asOf.time }],
    });
    expect(planBlock(input(numbers, { read: lapsed }))).toBeNull();
  });

  it("a task record that does not tie says why, in the plain words of the plan", () => {
    const numbers = scene();
    const say = (task: ReturnType<typeof planTask>) =>
      planBlock(input(numbers, { task }))?.sentence;
    expect(say(planTask({ payTo: null }))).toBe(
      "Sam has not named an account to be paid at, so this cannot be planned. Ask them to agree to the task first.",
    );
    expect(say(planTask({ state: "cancelled" }))).toMatch(
      /stopped or given up/,
    );
    expect(say(planTask({ state: "given-up" }))).toMatch(/stopped or given up/);
    expect(
      say(planTask({ state: "accepted", paidTx: `0x${"ab".repeat(32)}` })),
    ).toMatch(/already paid here/);
    expect(say(planTask({ usd: null }))).toBe(PLAN_BLOCK.noPay);
    expect(say(planTask({ state: "open", worker: null, payTo: null }))).toMatch(
      /^Sam has not named an account/,
    );
    expect(say(planTask({ state: "offered" }))).toMatch(
      /Nobody has taken or agreed/,
    );
  });

  it("a pay that is too much of the project's money for one task is told so", () => {
    const numbers = scene();
    const big = Number((numbers.money.pot * 5n) / 100n / 1_000_000n) + 1;
    expect(
      planBlock(input(numbers, { task: planTask({ usd: big }) }))?.sentence,
    ).toBe(PLAN_BLOCK.tooBig);
  });
});
