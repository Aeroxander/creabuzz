/**
 * SHAPE-ONLY fixtures for the task queue screens (`src/features/tasks/chain/types.ts`): a row and a `tasks` section with
 * every field present and plausible, changed by a patch. They are made by hand for the edge cases a test needs to name
 * (a second before a date, a state the example does not hold), so the numbers in them are not facts about any contract. A
 * test that needs real numbers reads the example record the server writes (`docs/next-version/record-v2-example.json`,
 * through `withTasks` in `numbers-v2-fixture.ts` or `parsedExample()`), and no test copies a number from it into one of these.
 */
import type {
  ChainTask,
  ChainTasks,
} from "../../src/features/tasks/chain/types";

export const SHAPE_WORKER = "0x00000000000000000000000000000000000000a1";
export const SHAPE_BOOK = "0x00000000000000000000000000000000000000b0";
const DOLLAR = 1_000_000n;

/** The id (64 hex digits) of the task record that row `n` is shaped for; its `what` is `0x` + this. */
export const shapeTaskId = (n: number): string =>
  n.toString(16).padStart(2, "0").repeat(32);

/** A planned task in its notice, announced at `at`; change what the test is about with `patch`. */
export function shapeRow(
  serial: bigint,
  patch: Partial<ChainTask> = {},
  at = 1_800_000_000,
): ChainTask {
  return {
    serial,
    what: `0x${shapeTaskId(Number(serial))}`,
    payee: SHAPE_WORKER,
    state: "announced",
    shareBps: 100,
    takenBy: null,
    announcedAt: at,
    noticeEnd: at + 14 * 86_400,
    expiresAt: at + 21 * 86_400,
    takenAt: null,
    deadline: null,
    maxDollars: 40n * DOLLAR,
    setAside: 0n,
    stayerClaim: 0n,
    noteFace: 0n,
    returned: 0n,
    notesLeft: 0n,
    atMostNow: 40n * DOLLAR,
    pay: 0n,
    capBps: 0,
    resolvedAt: null,
    resolvedTx: null,
    repeatOf: null,
    notes: null,
    ...patch,
  };
}

/** A `tasks` section holding `list` (open rows first, as the server writes it); change what the test is about with `patch`. */
export function shapeTasks(
  list: ChainTask[] = [],
  patch: Partial<ChainTasks> = {},
): ChainTasks {
  const open = list.filter(
    (row) => row.state === "announced" || row.state === "taken",
  );
  return {
    book: SHAPE_BOOK,
    bookBlock: 1,
    nextSerial: list.reduce((m, r) => (r.serial > m ? r.serial : m), 0n) + 1n,
    openCount: open.length,
    nextExpiry: open.length ? Math.min(...open.map((r) => r.expiresAt)) : null,
    limits: {
      maxOpen: 8,
      maxShareBps: 500,
      capBps: 1000,
      minTask: DOLLAR,
      capWindowSecs: 28 * 86_400,
      takeWindowSecs: 7 * 86_400,
      dueSecs: 14 * 86_400,
    },
    cap: { usedBps: 0, roomBps: 1000, frees: [] },
    next: null,
    list,
    cut: {
      maxEnded: 32,
      endedWithinSecs: 28 * 86_400,
      endedDropped: 0,
      notesRowsDropped: 0,
    },
    truncated: false,
    ...patch,
  };
}
