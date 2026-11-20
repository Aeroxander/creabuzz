// The test helper that answers the book's views from a parsed `tasks` section: the app's own readers (the ones every sheet
// uses) read the same rows back from it, so a screen test can change a row and the chain "changes" with it.
import {
  readBookOf,
  readClaimable,
  readNoteOf,
  readNoticeFor,
  readOpenSerials,
  readTakeRoom,
  readTask,
  type ReadCall,
} from "@creaton/core/pot/pot-reads.ts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_NOTICE,
  taskBookAnswers,
} from "../../../../tests/helpers/chain-task-answers";
import { installPotChain } from "../../../../tests/helpers/pot-chain";
import { parsedExample } from "../../../../tests/helpers/numbers-v2-parse";
import type { ChainTask, ChainTasks } from "./types";

const example = parsedExample();
const tasks = example.tasks as ChainTasks;
const { treasury } = example.contracts;

function chainWith(rows?: readonly ChainTask[]) {
  const chain = installPotChain({
    account: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    answers: taskBookAnswers(tasks, { rows }) as never,
  });
  const read: ReadCall = async (to, data) =>
    (
      window as unknown as {
        ethereum: { request: (a: unknown) => Promise<string> };
      }
    ).ethereum.request({
      method: "eth_call",
      params: [{ to, data }, "latest"],
    });
  return { chain, read };
}
afterEach(() => {
  (window as unknown as { ethereum?: unknown }).ethereum = undefined;
});

describe("the chain's answers about tasks, made from the record's rows", () => {
  it("taskOf gives each row back to the app's own reader, field for field", async () => {
    const { read } = chainWith();
    for (const row of tasks.list) {
      const now = await readTask(read, tasks.book, row.serial);
      expect(now).toMatchObject({
        serial: row.serial,
        what: row.what,
        payee: row.payee,
        state: row.state,
        shareBps: row.shareBps,
        takenBy: row.takenBy,
        announcedAt: row.announcedAt,
        noticeEnd: row.noticeEnd,
        expiresAt: row.expiresAt,
        takenAt: row.takenAt,
        deadline: row.deadline,
        maxDollars: row.maxDollars,
        setAside: row.setAside,
        stayerClaim: row.stayerClaim,
        noteFace: row.noteFace,
        returned: row.returned,
        notesLeft: row.notesLeft,
      });
    }
  });

  it("a serial the book does not have is a task that does not exist", async () => {
    const { read } = chainWith();
    expect(await readTask(read, tasks.book, tasks.nextSerial + 5n)).toBeNull();
  });

  it("the book's address, the open serials, the room under the cap and the notice", async () => {
    const { read } = chainWith();
    expect(await readBookOf(read, treasury)).toBe(tasks.book);
    expect([...(await readOpenSerials(read, tasks.book))].sort()).toEqual(
      tasks.list
        .filter((r) => r.state === "announced" || r.state === "taken")
        .map((r) => r.serial)
        .sort(),
    );
    expect(await readTakeRoom(read, tasks.book)).toBe(tasks.cap.roomBps);
    expect(await readNoticeFor(read, treasury, 100)).toEqual(DEFAULT_NOTICE);
  });

  it("a holder's note and what a claim would pay now: nothing while the task runs, the record's figure once it ended", async () => {
    const { read } = chainWith();
    const ended = tasks.list.find(
      (r) => r.state === "returned" && (r.notes?.holders.length ?? 0) > 0,
    ) as ChainTask;
    const running = tasks.list.find(
      (r) => r.state === "taken" && (r.notes?.holders.length ?? 0) > 0,
    ) as ChainTask;
    const holderOf = (row: ChainTask) => row.notes?.holders[0];
    const a = holderOf(ended);
    const b = holderOf(running);
    expect(
      await readNoteOf(read, tasks.book, ended.serial, a?.account ?? ""),
    ).toBe(a?.face);
    expect(
      await readClaimable(read, tasks.book, ended.serial, a?.account ?? ""),
    ).toBe(a?.claimable);
    expect(
      await readNoteOf(read, tasks.book, running.serial, b?.account ?? ""),
    ).toBe(b?.face);
    expect(
      await readClaimable(read, tasks.book, running.serial, b?.account ?? ""),
    ).toBe(0n);
    // someone with no note
    expect(
      await readNoteOf(
        read,
        tasks.book,
        ended.serial,
        "0x00000000000000000000000000000000000000a1",
      ),
    ).toBe(0n);
  });

  it("a test can move one task on the chain while the record still shows the old one", async () => {
    const taken = tasks.list.find((r) => r.state === "taken") as ChainTask;
    const moved = tasks.list.map((r) =>
      r.serial === taken.serial ? { ...r, state: "paid" as const } : r,
    );
    const { read } = chainWith(moved);
    expect((await readTask(read, tasks.book, taken.serial))?.state).toBe(
      "paid",
    );
    expect(tasks.list.find((r) => r.serial === taken.serial)?.state).toBe(
      "taken",
    );
  });
});
