/**
 * The `tasks` section of the server's record (RECORD-V2 section 10), made from the real chain for a browser spec, as
 * `live-record.ts` makes the rest: every task of the project's book read from the book's own views, what was paid and the
 * transaction that ended each task from the book's own logs. It stands in for the server's chain reader (the server track
 * tests that on its own): the page sees a record signed by the "server" key and nothing else about it is different. It holds
 * no leavers' notes (a spec with notes would add them) and lists the project's whole history (a spec makes a handful).
 */
import { signatureOf } from "../../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  TASK_BOOK_ABI,
  TREASURY_ABI,
} from "../../../../packages/creaton-core/src/pot/abis.generated.ts";
import { topicOf } from "../../../../packages/creaton-core/src/launchpad/work.ts";
import * as reads from "../../../../packages/creaton-core/src/pot/pot-reads.ts";
import { call, rpc } from "../../anvil/rpc";
import type { LiveProject } from "./live-chain";

type Json = Record<string, unknown>;
interface Log {
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

const read = (to: string, data: string) => call(to, data);
const text = (v: bigint) => v.toString();
const word = (log: Log, n: number) =>
  BigInt(`0x${log.data.slice(2 + n * 64, 2 + (n + 1) * 64)}`);

async function logs(
  address: string,
  abi: typeof TASK_BOOK_ABI | typeof TREASURY_ABI,
  event: string,
): Promise<Log[]> {
  const item = abi.find((i) => i.type === "event" && i.name === event);
  if (!item) throw new Error(`no event ${event}`);
  return rpc<Log[]>("eth_getLogs", [
    {
      address,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [topicOf(signatureOf(item as never))],
    },
  ]);
}

const serialOf = (log: Log) => BigInt(log.topics[1] ?? "0x0");

async function timeOf(blockNumber: string): Promise<number> {
  const block = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [
    blockNumber,
    false,
  ]);
  return Number.parseInt(block.timestamp, 16);
}

/**
 * The record's `tasks` section for `project`, as of the chain's newest block at time `now`, with the project's money `pot`
 * (what the most a take would set aside is worked from). Null when the project has no task book.
 */
export async function liveTasks(
  project: LiveProject,
  now: number,
  pot: bigint,
  unit: number,
): Promise<Json | null> {
  const book = await reads.readBookOf(read, project.treasury);
  if (book === null) return null;
  const bookReady = await logs(project.treasury, TREASURY_ABI, "TasksReady");
  const bookBlock = bookReady[0]
    ? Number.parseInt(bookReady[0].blockNumber, 16)
    : 0;
  const [nextSerial] = await reads.ask(
    read,
    TASK_BOOK_ABI,
    book,
    "nextSerial",
    [],
  );
  const next = Number(nextSerial);
  const resolved = new Map<bigint, Log>();
  for (const log of await logs(book, TASK_BOOK_ABI, "TaskResolved"))
    resolved.set(serialOf(log), log);
  const taken = new Map<bigint, Log>();
  for (const log of await logs(book, TASK_BOOK_ABI, "TaskTaken"))
    taken.set(serialOf(log), log);

  const chainRows: reads.ChainTaskNow[] = [];
  for (let s = 1; s < next; s += 1) {
    const row = await reads.readTask(read, book, BigInt(s));
    if (row) chainRows.push(row);
  }
  const live = new Set(["announced", "taken", "paid"]);
  const firstOf = new Map<string, bigint>();
  const rows: Json[] = [];
  for (const row of chainRows) {
    const is = live.has(row.state);
    const earlier = is ? firstOf.get(row.what) : undefined;
    if (is && earlier === undefined) firstOf.set(row.what, row.serial);
    const end = resolved.get(row.serial);
    const took = taken.get(row.serial);
    const pay = row.state === "paid" ? row.setAside - row.returned : 0n;
    const announcedNow =
      row.state === "announced" && now < row.expiresAt
        ? (() => {
            const share = (pot * BigInt(row.shareBps)) / 10_000n;
            return row.maxDollars < share ? row.maxDollars : share;
          })()
        : null;
    rows.push({
      serial: Number(row.serial),
      what: row.what,
      payee: row.payee,
      state: row.state,
      shareBps: row.shareBps,
      maxDollars: text(row.maxDollars),
      atMostNow: announcedNow === null ? null : text(announcedNow),
      announcedAt: row.announcedAt,
      noticeEnd: row.noticeEnd,
      expiresAt: row.expiresAt,
      takenBy: row.takenBy,
      takenAt: row.takenAt,
      deadline: row.deadline,
      setAside: text(row.setAside),
      stayerClaim: text(row.stayerClaim),
      noteFace: text(row.noteFace),
      pay: text(pay),
      returned: text(row.returned),
      notesLeft: text(row.notesLeft),
      capBps: took && row.state !== "rejected" ? Number(word(took, 2)) : 0,
      resolvedAt: end ? await timeOf(end.blockNumber) : null,
      resolvedTx: end ? end.transactionHash : null,
      repeatOf: earlier === undefined ? null : Number(earlier),
      notes: null,
    });
  }
  const open = rows
    .filter((r) => r.state === "announced" || r.state === "taken")
    .sort((a, b) => (a.serial as number) - (b.serial as number));
  const ended = rows
    .filter((r) => r.state !== "announced" && r.state !== "taken")
    .sort((a, b) => (b.serial as number) - (a.serial as number));

  const [maxOpen] = await reads.ask(read, TASK_BOOK_ABI, book, "MAX_OPEN", []);
  const [maxShare] = await reads.ask(
    read,
    TASK_BOOK_ABI,
    book,
    "MAX_SHARE_BPS",
    [],
  );
  const [capBps] = await reads.ask(read, TASK_BOOK_ABI, book, "CAP_BPS", []);
  const [minTask] = await reads.ask(read, TASK_BOOK_ABI, book, "MIN_TASK", []);
  const [capMult] = await reads.ask(
    read,
    TASK_BOOK_ABI,
    book,
    "CAP_WINDOW_MULT",
    [],
  );
  const [used] = await reads.ask(read, TASK_BOOK_ABI, book, "windowSumBps", []);
  const [room] = await reads.ask(read, TASK_BOOK_ABI, book, "takeRoomBps", []);
  const notice = await reads.readNoticeFor(read, project.treasury, 1);
  const [expiry] = await reads.ask(
    read,
    TREASURY_ABI,
    project.treasury,
    "nextExpiry",
    [],
  );

  // The next date something can happen: a notice ends, a plan lapses, a task is due.
  const dates: { at: number; kind: string; serial: number }[] = [];
  for (const r of open) {
    if (r.state === "announced") {
      if ((r.noticeEnd as number) > now)
        dates.push({
          at: r.noticeEnd as number,
          kind: "can_be_taken",
          serial: r.serial as number,
        });
      if ((r.expiresAt as number) > now)
        dates.push({
          at: r.expiresAt as number,
          kind: "lapses",
          serial: r.serial as number,
        });
    } else if ((r.deadline as number) > now)
      dates.push({
        at: r.deadline as number,
        kind: "due",
        serial: r.serial as number,
      });
  }
  dates.sort((a, b) => a.at - b.at);
  return {
    book,
    bookBlock,
    nextSerial: next,
    openCount: open.length,
    nextExpiry: expiry === 0n ? null : Number(expiry),
    limits: {
      maxOpen: Number(maxOpen),
      maxShareBps: Number(maxShare),
      capBps: Number(capBps),
      minTask: text(minTask as bigint),
      capWindowSecs: Number(capMult) * unit,
      takeWindowSecs: notice.takeWindowSecs,
      dueSecs: notice.dueSecs,
    },
    cap: { usedBps: Number(used), roomBps: Number(room), frees: [] },
    next: dates[0] ?? null,
    list: [...open, ...ended],
    cut: {
      maxEnded: 32,
      endedWithinSecs: Math.max(Number(capMult) * unit, 28 * 86_400),
      endedDropped: 0,
      notesRowsDropped: 0,
    },
    truncated: false,
  };
}
