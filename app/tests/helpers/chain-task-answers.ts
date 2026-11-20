/**
 * What the chain answers about a project's tasks, for the unit tests of the task screens: the book's views (`taskOf`,
 * `openSerials`, `windowSumBps`, `noteOf`, `claimableNote` and the rest the sheets read), made from the same parsed `tasks`
 * section the screens list from. It holds no contract logic: a test says what the chain answers by changing a row, and the
 * answer follows. Spread it over the table `installPotChain` takes (`{ ...backerAnswers(n), ...taskBookAnswers(n.tasks) }`).
 *
 * Where a test needs the chain to say something the record does not (a task that moved since the record was made), it passes
 * `rows`: the chain's own reading, row by row, instead of the record's.
 */
import type { AbiValue } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import type {
  ChainTask,
  ChainTaskNow,
  ChainTasks,
  NoticeFor,
} from "../../src/features/tasks/chain/types";

type Answer = (args: readonly unknown[], to: string) => AbiValue[];
type Fixed = AbiValue[];

/** The book's numbering of a task's state (`TaskBook.State`): none is 0. */
export const STATE_NUMBER: Record<ChainTaskNow["state"], bigint> = {
  announced: 1n,
  taken: 2n,
  paid: 3n,
  rejected: 4n,
  returned: 5n,
  cancelled: 6n,
  lapsed: 7n,
};

const ZERO = "0x0000000000000000000000000000000000000000";
/** `taskOf(serial)`'s answer for a row: the book's struct, in the order of the build's ABI. `null` is a task that does not exist. */
export function taskOfAnswer(row: ChainTaskNow | null): AbiValue[] {
  if (row === null)
    return [
      [
        `0x${"0".repeat(64)}`,
        ZERO,
        0n,
        0n,
        0n,
        ZERO,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
        0n,
      ],
    ];
  return [
    [
      row.what,
      row.payee ?? ZERO,
      STATE_NUMBER[row.state],
      BigInt(row.shareBps),
      0n,
      row.takenBy ?? ZERO,
      BigInt(row.announcedAt),
      BigInt(row.noticeEnd),
      BigInt(row.expiresAt),
      BigInt(row.takenAt ?? 0),
      BigInt(row.deadline ?? 0),
      row.maxDollars,
      row.setAside,
      row.stayerClaim,
      row.noteFace,
      row.returned,
      row.notesLeft,
    ],
  ];
}

/** What a notice of a plan is worth, unless a test says otherwise: the same for every share. */
export const DEFAULT_NOTICE: NoticeFor = {
  noticeSecs: 14 * 86_400,
  takeWindowSecs: 7 * 86_400,
  dueSecs: 14 * 86_400,
};

/**
 * The book's and the Treasury's task views, answered from `tasks`. `rows` replaces the rows the chain answers `taskOf` and
 * the note views from (a task the chain says is paid while the record still says taken); `notice` is what `noticeFor` says.
 */
export function taskBookAnswers(
  tasks: ChainTasks,
  options: { rows?: readonly ChainTask[]; notice?: NoticeFor } = {},
): Record<string, Answer | Fixed> {
  const rows = options.rows ?? tasks.list;
  const find = (serial: unknown) => rows.find((r) => r.serial === serial);
  const notice = options.notice ?? DEFAULT_NOTICE;
  const open = rows.filter(
    (r) => r.state === "announced" || r.state === "taken",
  );
  const note = (serial: unknown, holder: unknown) =>
    find(serial)?.notes?.holders.find(
      (h) => h.account === String(holder).toLowerCase(),
    );
  return {
    tasks: [tasks.book],
    taskOf: (args) => taskOfAnswer(find(args[0]) ?? null),
    openSerials: [open.map((r) => r.serial)],
    openCount: [BigInt(open.length)],
    nextSerial: [tasks.nextSerial],
    windowSumBps: [BigInt(tasks.cap.usedBps)],
    takeRoomBps: [BigInt(tasks.cap.roomBps)],
    nextExpiry: [BigInt(tasks.nextExpiry ?? 0)],
    noticeFor: [
      BigInt(notice.noticeSecs),
      BigInt(notice.takeWindowSecs),
      BigInt(notice.dueSecs),
    ],
    noteOf: (args) => [note(args[0], args[1])?.face ?? 0n],
    // The view says 0 while the task is open; the record's own `claimable` is the settled figure for an ended one.
    claimableNote: (args) => {
      const row = find(args[0]);
      const held = note(args[0], args[1]);
      const ended = row && row.state !== "announced" && row.state !== "taken";
      return [ended && held ? held.claimable : 0n];
    },
  };
}
