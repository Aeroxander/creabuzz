// The pure rules behind the Take sheet: what a take sets aside, when room under the limit comes back, and the order in which
// the sheet says why a task cannot be taken. Each sentence is the first reason a person would fix.
import { describe, expect, it } from "vitest";
import {
  plannedNumbers,
  plannedRowOf,
  queueOf,
  WORKER_WALLET,
} from "../../../../../tests/helpers/plan-scene";
import { timeText, type ProjectNumbers } from "../../../money/numbers";
import type { ChainTasks } from "../types";
import { TAKE_BLOCK } from "./holder-words";
import { atMostOf, roomBackAt, takeBlock } from "./take-gate";
import type { TakeRead } from "./take-read";

const D = 1_000_000n;

describe("what a take sets aside", () => {
  it("is the smaller of the most and the share of the project's money, rounded down", () => {
    expect(atMostOf(400n * D, 100, 6_375_060_409n)).toBe(63_750_604n);
    expect(atMostOf(50n * D, 100, 6_375_060_409n)).toBe(50n * D);
    expect(atMostOf(50n * D, 100, 0n)).toBe(0n);
  });
});

describe("when room under the limit comes back", () => {
  const frees = [
    { at: 200, bps: 100 },
    { at: 100, bps: 50 },
    { at: 300, bps: 400 },
  ];
  it("walks the dates oldest first and says the date when enough is free, or null when the list cannot say", () => {
    expect(roomBackAt(frees, 0, 50, 0)).toBe(100);
    expect(roomBackAt(frees, 0, 100, 0)).toBe(200);
    expect(roomBackAt(frees, 0, 500, 0)).toBe(300);
    expect(roomBackAt(frees, 0, 600, 0)).toBeNull();
    // A date already past is not waited for.
    expect(roomBackAt(frees, 0, 50, 150)).toBe(200);
    expect(roomBackAt(frees, 70, 50, 0)).toBe(100);
  });
});

describe("why a task cannot be taken, in order", () => {
  const numbers: ProjectNumbers = plannedNumbers();
  const queue: ChainTasks = queueOf(numbers);
  const row = plannedRowOf(numbers);
  const open = row.noticeEnd + 10;

  function read(
    over: Partial<TakeRead["task"]> = {},
    rest: Partial<TakeRead> = {},
  ): TakeRead {
    return {
      book: queue.book,
      task: { ...row, payee: WORKER_WALLET, ...over },
      time: open,
      activeEnd: open + 100_000,
      roomBps: queue.cap.roomBps,
      ...rest,
    };
  }
  const ask = (
    r: TakeRead,
    over: { address?: string; now?: number; numbers?: ProjectNumbers } = {},
  ) =>
    takeBlock({
      read: r,
      numbers: over.numbers ?? numbers,
      queue,
      address: over.address ?? WORKER_WALLET,
      now: over.now ?? open,
    });

  it("none when the named wallet can take it now", () => {
    expect(ask(read())).toBeNull();
  });

  it("the project wound down comes first, then the runner or a signer, then who it is named for", () => {
    const wound = { ...numbers, windDown: { at: 1 } } as ProjectNumbers;
    expect(ask(read(), { numbers: wound })).toBe(TAKE_BLOCK.wound);
    expect(ask(read(), { address: numbers.runner.address })).toBe(
      TAKE_BLOCK.runs,
    );
    expect(ask(read({ payee: null }))).toMatch(/Open to anyone/);
    expect(
      ask(read(), { address: "0x00000000000000000000000000000000000000ee" }),
    ).toMatch(/named for the wallet 0x0000…00cd/);
  });

  it("then the state, the notice, the take window and the team's check-in", () => {
    expect(ask(read({ state: "taken" }))).toBe(TAKE_BLOCK.state);
    expect(ask(read(), { now: row.noticeEnd - 1 })).toMatch(
      new RegExp(
        `can be taken from ${timeText(row.noticeEnd).replace(".", "\\.")}`,
      ),
    );
    expect(ask(read(), { now: row.expiresAt })).toBe(TAKE_BLOCK.over);
    expect(ask(read({}, { activeEnd: open }))).toBe(TAKE_BLOCK.quiet);
  });

  it("the room under the limit is short only when the book and the record both say so", () => {
    const short = { ...queue, cap: { ...queue.cap, roomBps: 0 } };
    const base = read({}, { roomBps: 0 });
    expect(
      takeBlock({
        read: base,
        numbers,
        queue: short,
        address: WORKER_WALLET,
        now: open,
      }),
    ).toMatch(
      /Too much of the project's money has been set aside for tasks recently/,
    );
    // The record has room (it counts a task that ran out as freed): not blocked.
    expect(
      takeBlock({
        read: base,
        numbers,
        queue,
        address: WORKER_WALLET,
        now: open,
      }),
    ).toBeNull();
    // The book has room: not blocked.
    expect(
      takeBlock({
        read: read({}, { roomBps: queue.cap.roomBps }),
        numbers,
        queue: short,
        address: WORKER_WALLET,
        now: open,
      }),
    ).toBeNull();
  });
});
