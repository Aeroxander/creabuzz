// The join of the network's queue and the team's task records: by `what`, tied by `tieOf`, read once per project.
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  numbersV2Of,
  relayMock,
  serve,
} from "../../../../tests/helpers/money-harness";
import {
  numbersV2Content,
  withTasks,
} from "../../../../tests/helpers/numbers-v2-fixture";
import { parsedExample } from "../../../../tests/helpers/numbers-v2-parse";
import { KIND_LAUNCH_UPDATE } from "@creaton/core/kinds.ts";
import type { Project } from "../../project/project-record";
import { type ProjectTask, TASK_LABEL } from "../task-record";
import { joinTasks, useTaskJoin } from "./join";
import type { ChainTask, ChainTasks } from "./types";

vi.mock(
  "../../../lib/relay",
  async () =>
    (await import("../../../../tests/helpers/money-harness")).relayMock,
);

const FOUNDER = "b".repeat(64);
const WORKER = "d".repeat(64);
const queue = parsedExample().tasks as ChainTasks;
const project = {
  coordinate: COORDINATE,
  author: FOUNDER,
  team: [],
} as unknown as Project;

/** The team's record of a network row: its id is the row's `what`. */
function recordOf(
  serial: number,
  patch: Partial<ProjectTask> = {},
): ProjectTask {
  const row = queue.list.find((r) => Number(r.serial) === serial);
  if (!row) throw new Error(`no task ${serial}`);
  return {
    id: row.what.slice(2),
    author: FOUNDER,
    at: row.announcedAt - 10,
    what: "Translate the guide",
    usd: Number(row.maxDollars / 1_000_000n),
    openToAnyone: true,
    worker: WORKER,
    payTo: row.takenBy ?? row.payee,
    state: "working",
    handIn: null,
    acceptedBy: null,
    acceptedAt: null,
    paidTx: null,
    ...patch,
  };
}
const binding = queue.list.find((r) => r.state === "taken");
const serialOfBinding = Number(binding?.serial);

describe("joinTasks", () => {
  it("pairs each row with the record whose id is its `what`, and each record with the plan that binds it", () => {
    const record = recordOf(serialOfBinding);
    const join = joinTasks(queue, [record]);
    const joined = join.rows.find((r) => r.row.serial === binding?.serial);
    expect(joined?.task).toBe(record);
    expect(joined?.tie).toEqual({ ok: true });
    expect(join.tasks).toHaveLength(1);
    expect(join.tasks[0]?.chain?.serial).toBe(binding?.serial);
    expect(join.tasks[0]?.tie).toEqual({ ok: true });
  });

  it("rows the team has no record of are listed apart, and a record with no plan has no row", () => {
    const stranger: ProjectTask = {
      ...recordOf(serialOfBinding),
      id: "e".repeat(64),
    };
    const join = joinTasks(queue, [stranger]);
    expect(join.unmatched).toHaveLength(queue.list.length);
    expect(join.rows.every((r) => r.tie.ok === false)).toBe(true);
    expect(join.tasks[0]).toEqual({ task: stranger, chain: null, tie: null });
  });

  it("a record planned twice is bound to its lowest-serial plan, and the later row never ties", () => {
    const repeat = queue.list.find((r) => r.repeatOf !== null);
    if (!repeat) throw new Error("the example has no repeat");
    const record = recordOf(Number(repeat.serial), { state: "working" });
    const join = joinTasks(queue, [record]);
    expect(join.tasks[0]?.chain?.serial).toBe(repeat.repeatOf);
    const later = join.rows.find((r) => r.row.serial === repeat.serial);
    expect(later?.tie).toEqual({ ok: false, why: "repeat" });
  });

  it("a record's id is compared whatever its case", () => {
    const record = { ...recordOf(serialOfBinding) };
    record.id = record.id.toUpperCase();
    expect(joinTasks(queue, [record]).rows.some((r) => r.task === record)).toBe(
      true,
    );
  });
});

describe("useTaskJoin", () => {
  afterEach(() => {
    cleanup();
    serve([]);
  });

  function wrapper() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  const at = 1_800_000_000;
  const numbers = numbersV2Of(
    numbersV2Content({ coordinate: COORDINATE, now: at, patch: withTasks() }),
  );
  const without = numbersV2Of(
    numbersV2Content({ coordinate: COORDINATE, now: at }),
  );
  /** The team's task record for the row `serial`, and the worker's take of it naming where to be paid. */
  function records(serial: number) {
    const row = queue.list.find(
      (r) => Number(r.serial) === serial,
    ) as ChainTask;
    const base = (id: string, pubkey: string, tags: string[][]) => ({
      id,
      pubkey,
      kind: KIND_LAUNCH_UPDATE,
      created_at: at - 1_000,
      tags: [["a", COORDINATE], ["l", TASK_LABEL], ...tags],
      content: "{}",
    });
    const id = row.what.slice(2);
    return [
      base(id, FOUNDER, [
        ["task-part", "task"],
        ["task-what", "Translate the guide"],
        ["task-usd", String(row.maxDollars / 1_000_000n)],
      ]),
      base("f".repeat(64), WORKER, [
        ["task-part", "take"],
        ["task", id],
        ["task-pay-to", row.payee ?? ""],
      ]),
    ];
  }

  it("reads nothing and says there is no queue when the record has none, or it did not parse", () => {
    const spy = vi.spyOn(relayMock, "read");
    for (const n of [
      without,
      { ...numbers, tasks: null },
      { ...numbers, tasks: "unreadable" as const },
      null,
      undefined,
    ]) {
      const { result } = renderHook(() => useTaskJoin(project, n), {
        wrapper: wrapper(),
      });
      expect(result.current).toEqual({ status: "no-queue" });
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("joins the team's records to the rows, and reads the project's records once for every user of the join", async () => {
    const planned = queue.list.find(
      (r) => r.state === "announced" && r.repeatOf === null,
    ) as ChainTask;
    serve(records(Number(planned.serial)));
    const spy = vi.spyOn(relayMock, "read");
    const shared = wrapper();
    const a = renderHook(() => useTaskJoin(project, numbers), {
      wrapper: shared,
    });
    const b = renderHook(() => useTaskJoin(project, numbers), {
      wrapper: shared,
    });
    await waitFor(() => expect(a.result.current.status).toBe("ready"));
    await waitFor(() => expect(b.result.current.status).toBe("ready"));
    // One read of the task records and one of the signers' profiles: not one pair for each caller.
    expect(spy).toHaveBeenCalledTimes(2);
    const ready = a.result.current;
    if (ready.status !== "ready") throw new Error("not ready");
    expect(ready.queue).toBe(numbers.tasks);
    const row = ready.join.rows.find((r) => r.row.serial === planned.serial);
    expect(row?.task?.id).toBe(planned.what.slice(2));
    expect(row?.tie).toEqual({ ok: true });
    // every other row is a plan with no matching task here
    expect(ready.join.unmatched).toHaveLength(queue.list.length - 1);
    spy.mockRestore();
  });

  it("says so when the team's records could not be read, and still hands over the queue", async () => {
    const spy = vi
      .spyOn(relayMock, "read")
      .mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useTaskJoin(project, numbers), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.status === "failed" && result.current.queue).toBe(
      numbers.tasks,
    );
    spy.mockRestore();
  });
});
