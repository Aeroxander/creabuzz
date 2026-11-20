/**
 * The strict reading of a record's `tasks` section (`docs/next-version/RECORD-V2.md` section 10; plan sections 1.3 to 1.6
 * and 4.5). It is read apart from the rest of the body on purpose (C21): a section that cannot be believed makes only the
 * task queue unreadable (`"unreadable"`), and the project's money, Shares and holders are read as always, so leaving is
 * never blanked by a task bug.
 *
 * What is believed: amounts are decimal strings inside bounds, times and counts are whole numbers, addresses and
 * 32-byte values are lower-case hex, serials are whole numbers from 1, at most 8 rows are open and at most 32 have ended
 * (a list of more than 40 is not read), serials are unique, `openCount` equals the open rows, a repeat names an earlier
 * serial, the state is one of the seven words, and a row that is taken says who took it and when it is due. A section
 * that fails any of it is `"unreadable"`: the screens say so in one plain line and make no alert from it.
 */
import type {
  ChainNextKind,
  ChainTask,
  ChainTaskNotes,
  ChainTasks,
  ChainTaskState,
} from "../tasks/chain/types";
import {
  address,
  addressOrNull,
  amount,
  arr,
  bool,
  bytes32,
  COUNT_LIMIT,
  count,
  fail,
  type Json,
  obj,
  oneOf,
  time,
  timeOrNull,
  whole,
} from "./numbers-strict";

/** The most tasks open at once (the contract's own limit), and the most ended rows a record lists. */
const MAX_OPEN = 8;
const MAX_ENDED = 32;
const MAX_HOLDERS = 20;
const MAX_FREES = 16;
/** Ten-thousandths of the project's money: 10,000 is all of it. */
const BPS_MAX = 10_000;

const STATES: readonly ChainTaskState[] = [
  "announced",
  "taken",
  "paid",
  "rejected",
  "returned",
  "cancelled",
  "lapsed",
];
const NEXT_KINDS: readonly ChainNextKind[] = [
  "can_be_taken",
  "lapses",
  "due",
  "cap_room",
];

const isOpen = (state: ChainTaskState) =>
  state === "announced" || state === "taken";

/**
 * A serial is a whole number the record writes as a JSON integer, at least `min`. Each plan costs a transaction, so one
 * past a thousand million is not believed (the server refuses one past 2^53 and a screen has no use for the difference).
 */
function serialOf(v: unknown, path: string, min: number): bigint {
  const n = whole(v, path, COUNT_LIMIT);
  return n >= min ? BigInt(n) : fail(path);
}

function readNotes(raw: unknown, at: string): ChainTaskNotes | null {
  if (raw === null) return null;
  const n = obj(raw, at);
  const faceTotal = amount(n.faceTotal, `${at}.faceTotal`);
  const holders = arr(n.holders, `${at}.holders`, MAX_HOLDERS).map((h, i) => {
    const p = `${at}.holders[${i}]`;
    const holder = obj(h, p);
    const face = amount(holder.face, `${p}.face`);
    const claimable = amount(holder.claimable, `${p}.claimable`);
    // A claim never pays more than the note's face.
    if (claimable > face) fail(`${p}.claimable`);
    return {
      account: address(holder.account, `${p}.account`),
      face,
      claimable,
    };
  });
  // The listed holders are some of the holders: together they cannot hold more than the whole.
  if (holders.reduce((sum, h) => sum + h.face, 0n) > faceTotal)
    fail(`${at}.holders`);
  return {
    faceTotal,
    holders,
    holdersCut: bool(n.holdersCut, `${at}.holdersCut`),
  };
}

function readRow(raw: unknown, at: string): ChainTask {
  const r = obj(raw, at);
  const serial = serialOf(r.serial, `${at}.serial`, 1);
  const state = oneOf(r.state, STATES, `${at}.state`);
  const takenBy = addressOrNull(r.takenBy, `${at}.takenBy`);
  const takenAt = timeOrNull(r.takenAt, `${at}.takenAt`);
  const deadline = timeOrNull(r.deadline, `${at}.deadline`);
  // A taken task says who took it and when it is due: every sentence about it reads them.
  if (
    state === "taken" &&
    (takenBy === null || takenAt === null || deadline === null)
  )
    fail(`${at}.state`);
  const setAside = amount(r.setAside, `${at}.setAside`);
  const money = {
    stayerClaim: amount(r.stayerClaim, `${at}.stayerClaim`),
    noteFace: amount(r.noteFace, `${at}.noteFace`),
    pay: amount(r.pay, `${at}.pay`),
    returned: amount(r.returned, `${at}.returned`),
    notesLeft: amount(r.notesLeft, `${at}.notesLeft`),
  };
  // Nothing a task holds, paid or gave back passes what was set aside for it.
  for (const [name, value] of Object.entries(money))
    if (value > setAside) fail(`${at}.${name}`);
  const shareBps = whole(r.shareBps, `${at}.shareBps`, BPS_MAX);
  if (shareBps === 0) fail(`${at}.shareBps`);
  const repeatRaw = r.repeatOf;
  const repeatOf =
    repeatRaw === null ? null : serialOf(repeatRaw, `${at}.repeatOf`, 1);
  // A repeat is of an earlier plan.
  if (repeatOf !== null && repeatOf >= serial) fail(`${at}.repeatOf`);
  const resolvedTx =
    r.resolvedTx === null ? null : bytes32(r.resolvedTx, `${at}.resolvedTx`);
  return {
    serial,
    what: bytes32(r.what, `${at}.what`),
    payee: addressOrNull(r.payee, `${at}.payee`),
    state,
    shareBps,
    maxDollars: amount(r.maxDollars, `${at}.maxDollars`),
    atMostNow:
      r.atMostNow === null ? null : amount(r.atMostNow, `${at}.atMostNow`),
    announcedAt: time(r.announcedAt, `${at}.announcedAt`),
    noticeEnd: time(r.noticeEnd, `${at}.noticeEnd`),
    expiresAt: time(r.expiresAt, `${at}.expiresAt`),
    takenBy,
    takenAt,
    deadline,
    setAside,
    ...money,
    capBps: whole(r.capBps, `${at}.capBps`, BPS_MAX),
    resolvedAt: timeOrNull(r.resolvedAt, `${at}.resolvedAt`),
    resolvedTx,
    repeatOf,
    notes: readNotes(r.notes, `${at}.notes`),
  };
}

/** The whole section, or throws. */
function readSection(raw: unknown): ChainTasks {
  const t = obj(raw, "tasks");
  const limits = obj(t.limits, "tasks.limits");
  const cap = obj(t.cap, "tasks.cap");
  const cut = obj(t.cut, "tasks.cut");
  const rows = arr(t.list, "tasks.list", MAX_OPEN + MAX_ENDED).map((row, i) =>
    readRow(row, `tasks.list[${i}]`),
  );
  const seen = new Set<bigint>();
  for (const row of rows) {
    if (seen.has(row.serial)) fail("tasks.list");
    seen.add(row.serial);
  }
  const open = rows.filter((row) => isOpen(row.state));
  if (rows.length - open.length > MAX_ENDED) fail("tasks.list");
  // At most 8 open (the contract's limit), and the count says how many rows are open.
  const openCount = whole(t.openCount, "tasks.openCount", MAX_OPEN);
  if (openCount !== open.length) fail("tasks.openCount");
  const nextSerial = serialOf(t.nextSerial, "tasks.nextSerial", 1);
  // The next serial is above every serial the record names.
  if (rows.some((row) => row.serial >= nextSerial)) fail("tasks.nextSerial");
  const frees = arr(cap.frees, "tasks.cap.frees", MAX_FREES).map((f, i) => {
    const p = `tasks.cap.frees[${i}]`;
    const free = obj(f, p);
    return {
      at: time(free.at, `${p}.at`),
      bps: whole(free.bps, `${p}.bps`, BPS_MAX),
    };
  });
  const nextRaw = t.next;
  const next =
    nextRaw === null
      ? null
      : (() => {
          const n = obj(nextRaw, "tasks.next");
          const kind = oneOf(n.kind, NEXT_KINDS, "tasks.next.kind");
          const serial = serialOf(n.serial, "tasks.next.serial", 0);
          // The room under the cap belongs to no task; every other date belongs to one.
          if ((kind === "cap_room") !== (serial === 0n))
            fail("tasks.next.serial");
          return { at: time(n.at, "tasks.next.at"), kind, serial };
        })();
  return {
    book: address(t.book, "tasks.book"),
    bookBlock: whole(t.bookBlock, "tasks.bookBlock", 1_000_000_000_000),
    nextSerial,
    openCount,
    nextExpiry: timeOrNull(t.nextExpiry, "tasks.nextExpiry"),
    limits: {
      maxOpen: whole(limits.maxOpen, "tasks.limits.maxOpen", MAX_OPEN),
      maxShareBps: whole(
        limits.maxShareBps,
        "tasks.limits.maxShareBps",
        BPS_MAX,
      ),
      capBps: whole(limits.capBps, "tasks.limits.capBps", BPS_MAX),
      minTask: amount(limits.minTask, "tasks.limits.minTask"),
      capWindowSecs: time(limits.capWindowSecs, "tasks.limits.capWindowSecs"),
      takeWindowSecs: time(
        limits.takeWindowSecs,
        "tasks.limits.takeWindowSecs",
      ),
      dueSecs: time(limits.dueSecs, "tasks.limits.dueSecs"),
    },
    cap: {
      usedBps: whole(cap.usedBps, "tasks.cap.usedBps", BPS_MAX),
      roomBps: whole(cap.roomBps, "tasks.cap.roomBps", BPS_MAX),
      frees,
    },
    next,
    // Open tasks first (serial ascending), then ended ones (serial descending): the order the screens rely on.
    list: [
      ...open.sort((a, b) => (a.serial < b.serial ? -1 : 1)),
      ...rows
        .filter((row) => !isOpen(row.state))
        .sort((a, b) => (a.serial > b.serial ? -1 : 1)),
    ],
    cut: {
      maxEnded: count(cut.maxEnded, "tasks.cut.maxEnded"),
      endedWithinSecs: time(cut.endedWithinSecs, "tasks.cut.endedWithinSecs"),
      endedDropped: count(cut.endedDropped, "tasks.cut.endedDropped"),
      notesRowsDropped: count(
        cut.notesRowsDropped,
        "tasks.cut.notesRowsDropped",
      ),
    },
    truncated: bool(t.truncated, "tasks.truncated"),
  };
}

/**
 * The record's task queue: the section when it reads, `null` when the project has no task book, `"unreadable"` when the
 * section is there and cannot be believed (the rest of the record is read as always), and `undefined` when the server is
 * older than step 2 and wrote none. Never throws.
 */
export function readTasks(
  raw: Json[string],
): ChainTasks | null | "unreadable" | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  try {
    return readSection(raw);
  } catch {
    return "unreadable";
  }
}
