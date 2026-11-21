/**
 * What the app asks the chain at the moment of a sheet (`docs/next-version/RECORD-V2.md`, section 5): the quotes, the door,
 * a person's balances and a grant's claim. Each read builds its call from the generated ABI, sends it through the
 * sender's `readCall` and decodes the answer strictly: an answer that is too short, or not hex, throws. A sheet that gets
 * a throw says so and does not guess; it never falls back to the server's record.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { decodeParameters, selectorOf } from "../launchpad/evmAbi.ts";
import {
  EARLIER_GRANTS_ABI,
  HOLDER_PAUSE_ABI,
  PLAY_DOLLAR_ABI,
  SHARE_TOKEN_ABI,
  TASK_BOOK_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "./abis.generated.ts";
import {
  type Abi,
  decodeReturn,
  encodeCall,
  functionOf,
  signatureOf,
} from "./abi-codec.ts";

/** A read-only call: the node's raw answer as hex. The sender's `readCall` has this shape. */
export type ReadCall = (to: string, data: string) => Promise<string>;

export async function ask(
  read: ReadCall,
  abi: Abi,
  to: string,
  name: string,
  args: readonly (bigint | boolean | string)[],
) {
  const answer = await read(to, encodeCall(abi, name, args));
  if (typeof answer !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(answer))
    throw new Error("The network gave an answer that is not readable.");
  return decodeReturn(abi, name, answer, args.length);
}

export const asBigint = (value: unknown): bigint => {
  if (typeof value !== "bigint") throw new Error("A number was expected.");
  return value;
};

/** What backing with an amount would do right now (`Treasury.quoteBack`). */
export interface BackQuote {
  /** Shares the amount would buy (18 decimals). */
  shares: bigint;
  /** What taking those Shares out at once would pay, in dollar units: "what you would get if you took out now". */
  takeOutNow: bigint;
  /** Money set aside for tasks that are still running, which the price counts at face value. */
  locked: bigint;
  /** Outside money still arriving, which a leaver is not paid on yet. */
  arriving: bigint;
}

/** `quoteBack(amount)` at the chain's latest block. */
export async function quoteBack(
  read: ReadCall,
  treasury: string,
  amount: bigint,
): Promise<BackQuote> {
  const [shares, takeOutNow, locked, arriving] = await ask(
    read,
    TREASURY_ABI,
    treasury,
    "quoteBack",
    [amount],
  );
  return {
    shares: asBigint(shares),
    takeOutNow: asBigint(takeOutNow),
    locked: asBigint(locked),
    arriving: asBigint(arriving),
  };
}

/** The platform's part of `amount` (`Treasury.feeFor`), in dollar units. */
export async function feeFor(
  read: ReadCall,
  treasury: string,
  amount: bigint,
): Promise<bigint> {
  const [fee] = await ask(read, TREASURY_ABI, treasury, "feeFor", [amount]);
  return asBigint(fee);
}

/** Whether a join would be accepted at the chain's latest block (`Treasury.doorOpenNow`). */
export async function doorOpenNow(
  read: ReadCall,
  treasury: string,
): Promise<boolean> {
  const [open] = await ask(read, TREASURY_ABI, treasury, "doorOpenNow", []);
  if (typeof open !== "boolean") throw new Error("A yes or no was expected.");
  return open;
}

/** What taking `n` Shares out would pay `holder` now (`Treasury.quoteTakeOut`). */
export interface TakeOutQuote {
  /** Cash, in dollar units, from the pot only. Zero when `n` is zero or more than the holder has. */
  cashNow: bigint;
  /**
   * What the holder would be owed later, up to, if the tasks money is set aside for are not paid in full (the face of the
   * exit note this take-out would write). Zero when no task is running.
   */
  note: bigint;
  /** Outside money still arriving that a take-out now leaves behind. */
  arrivingLeftBehind: bigint;
}

/** `quoteTakeOut(holder, n)` at the chain's latest block. */
export async function quoteTakeOut(
  read: ReadCall,
  treasury: string,
  holder: string,
  n: bigint,
): Promise<TakeOutQuote> {
  const [cashNow, note, arrivingLeftBehind] = await ask(
    read,
    TREASURY_ABI,
    treasury,
    "quoteTakeOut",
    [holder, n],
  );
  return {
    cashNow: asBigint(cashNow),
    note: asBigint(note),
    arrivingLeftBehind: asBigint(arrivingLeftBehind),
  };
}

/** What one whole Team Share would pay now, in dollar units per 1e18 (`Treasury.teamValue`): an estimate, never exact. */
export async function teamValue(
  read: ReadCall,
  treasury: string,
): Promise<bigint> {
  const [value] = await ask(read, TREASURY_ABI, treasury, "teamValue", []);
  return asBigint(value);
}

/** A token balance (Shares, Team Shares or the dollar). */
export async function balanceOf(
  read: ReadCall,
  token: string,
  holder: string,
): Promise<bigint> {
  const [balance] = await ask(read, SHARE_TOKEN_ABI, token, "balanceOf", [
    holder,
  ]);
  return asBigint(balance);
}

/** How many dollars `spender` may take from `owner` (`allowance`). */
export async function allowanceOf(
  read: ReadCall,
  dollar: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const [value] = await ask(read, PLAY_DOLLAR_ABI, dollar, "allowance", [
    owner,
    spender,
  ]);
  return asBigint(value);
}

/** The ids of the grants made to `member` (`Vester.idsOf`). */
export async function grantIdsOf(
  read: ReadCall,
  vester: string,
  member: string,
): Promise<bigint[]> {
  const [ids] = await ask(read, VESTER_ABI, vester, "idsOf", [member]);
  if (!Array.isArray(ids)) throw new Error("A list was expected.");
  return ids.map(asBigint);
}

/** What a grant has unlocked and not yet sent to its member (`Vester.claimable`), in Team Share units. */
export async function claimableOf(
  read: ReadCall,
  vester: string,
  id: bigint,
): Promise<bigint> {
  const [value] = await ask(read, VESTER_ABI, vester, "claimable", [id]);
  return asBigint(value);
}

/** What a grant has unlocked so far, sent or not (`Vester.vestedOf`). */
export async function vestedOf(
  read: ReadCall,
  vester: string,
  id: bigint,
): Promise<bigint> {
  const [value] = await ask(read, VESTER_ABI, vester, "vestedOf", [id]);
  return asBigint(value);
}

/** The ERC-1363 interface id: a dollar that answers yes to it has `transferAndCall`. */
const ERC1363_INTERFACE_ID = "b0202a11";

/**
 * Whether the dollar can pay and call in one signature (ERC-165 `supportsInterface` for ERC-1363). A dollar that does not
 * answer, or answers no, gets the two-step Back (approve, then join): the safe default.
 */
export async function dollarHasPayAndCall(
  read: ReadCall,
  dollar: string,
): Promise<boolean> {
  try {
    const data = `${selectorOf("supportsInterface(bytes4)")}${ERC1363_INTERFACE_ID.padEnd(64, "0")}`;
    const answer = await read(dollar, data);
    const [yes] = decodeParameters(["bool"], answer);
    return yes === true;
  } catch {
    return false;
  }
}

// --- Tasks (`contracts/pot/src/TaskBook.sol`, reached through the Treasury) ------------------------------------------------

/** Where a task is, as the book says it (`TaskBook.State`, without `None`: a task that does not exist reads as null). */
export type TaskStateName =
  | "announced"
  | "taken"
  | "paid"
  | "rejected"
  | "returned"
  | "cancelled"
  | "lapsed";

/** `TaskBook.State` by its number; `None` (0) is a task that does not exist. */
const TASK_STATES: readonly (TaskStateName | null)[] = [
  null,
  "announced",
  "taken",
  "paid",
  "rejected",
  "returned",
  "cancelled",
  "lapsed",
];

/**
 * One task as the chain says it now (`TaskBook.taskOf`), with the names of the server's record rows (1.4 of the step 2
 * plan): `setAside` is the book's `locked` and `stayerClaim` its `stayer`. Times are seconds; money is dollar units.
 */
export interface ChainTaskNow {
  serial: bigint;
  /** The 32-byte id of the team's task record the plan was made for, lower-case `0x` text. */
  what: string;
  /** Who may take it; null when it is open to anyone. */
  payee: string | null;
  state: TaskStateName;
  /** The most it may ask of the project's money, in ten-thousandths. */
  shareBps: number;
  /** Who took it, and the only address a payment goes to; null before a take. */
  takenBy: string | null;
  announcedAt: number;
  /** The first second it can be taken. */
  noticeEnd: number;
  /** The end of the take window while announced; the deadline once taken. */
  expiresAt: number;
  takenAt: number | null;
  /** When it is due once taken; null before a take. */
  deadline: number | null;
  maxDollars: bigint;
  /** What the take moved out of the project's money into the task ("0" before a take; kept after the end). */
  setAside: bigint;
  /** The stayers' claim on it while taken. */
  stayerClaim: bigint;
  /** The face of the exit notes held against it. */
  noteFace: bigint;
  /** What came back when it ended. */
  returned: bigint;
  /** What is still held for the claims of its notes. */
  notesLeft: bigint;
}

/** What the book gives a task of one size: the notice before it can be taken, how long it can then be taken, how long it is due after. */
export interface NoticeFor {
  noticeSecs: number;
  takeWindowSecs: number;
  dueSecs: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** A uint that must fit a safe integer (times, counts); a larger answer is an error, never a rounded number. */
function asSafeInt(value: unknown, what: string): number {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error(`The network gave an unreadable ${what}.`);
  return Number(value);
}

const asAddress = (value: unknown): string => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new Error("An address was expected.");
  return value.toLowerCase();
};

const orNull = (address: string): string | null =>
  address === ZERO ? null : address;

/** The names of `taskOf`'s struct fields, in the order the ABI gives them: the tuple is read by name, never by position. */
function taskFieldNames(): string[] {
  const output = functionOf(TASK_BOOK_ABI, "taskOf", 1).outputs?.[0];
  const names = output?.components?.map((c) => c.name ?? "") ?? [];
  if (names.length === 0 || names.some((n) => n === ""))
    throw new Error("The task book's ABI does not name its task fields.");
  return names;
}

/**
 * Task `serial` of `book` at the chain's latest block (`TaskBook.taskOf`), or null when there is no such task (its state
 * is none). The answer is a static tuple, read by the field names of the ABI; a state the book does not have is an error.
 */
export async function readTask(
  read: ReadCall,
  book: string,
  serial: bigint,
): Promise<ChainTaskNow | null> {
  const [tuple] = await ask(read, TASK_BOOK_ABI, book, "taskOf", [serial]);
  const names = taskFieldNames();
  if (!Array.isArray(tuple) || tuple.length !== names.length)
    throw new Error("The network gave a task that is not readable.");
  const field = (name: string): unknown => {
    const at = names.indexOf(name);
    if (at < 0) throw new Error(`The task book has no field ${name}.`);
    return tuple[at];
  };
  const stateNumber = asSafeInt(field("state"), "task state");
  if (stateNumber >= TASK_STATES.length)
    throw new Error("The network gave a task state this app does not know.");
  const state = TASK_STATES[stateNumber];
  if (state === null) return null;
  const takenAt = asSafeInt(field("takenAt"), "time");
  const deadline = asSafeInt(field("deadline"), "time");
  const what = field("what");
  if (typeof what !== "string" || !/^0x[0-9a-f]{64}$/.test(what))
    throw new Error("The network gave a task with an unreadable id.");
  return {
    serial,
    what,
    payee: orNull(asAddress(field("payee"))),
    state,
    shareBps: asSafeInt(field("shareBps"), "share"),
    takenBy: orNull(asAddress(field("takenBy"))),
    announcedAt: asSafeInt(field("announcedAt"), "time"),
    noticeEnd: asSafeInt(field("noticeEnd"), "time"),
    expiresAt: asSafeInt(field("expiresAt"), "time"),
    takenAt: takenAt === 0 ? null : takenAt,
    deadline: deadline === 0 ? null : deadline,
    maxDollars: asBigint(field("maxDollars")),
    setAside: asBigint(field("locked")),
    stayerClaim: asBigint(field("stayer")),
    noteFace: asBigint(field("noteFace")),
    returned: asBigint(field("returned")),
    notesLeft: asBigint(field("notesLeft")),
  };
}

/** The serials of the tasks that are announced or taken now (`TaskBook.openSerials`): at most the book's open limit. */
export async function readOpenSerials(
  read: ReadCall,
  book: string,
): Promise<bigint[]> {
  const [serials] = await ask(read, TASK_BOOK_ABI, book, "openSerials", []);
  if (!Array.isArray(serials)) throw new Error("A list was expected.");
  return serials.map(asBigint);
}

/** The notice, take window and due time a task of `shareBps` gets (`Treasury.noticeFor`), in seconds. */
export async function readNoticeFor(
  read: ReadCall,
  treasury: string,
  shareBps: number,
): Promise<NoticeFor> {
  const [notice, window, due] = await ask(
    read,
    TREASURY_ABI,
    treasury,
    "noticeFor",
    [BigInt(shareBps)],
  );
  return {
    noticeSecs: asSafeInt(notice, "notice"),
    takeWindowSecs: asSafeInt(window, "take window"),
    dueSecs: asSafeInt(due, "due time"),
  };
}

/**
 * The room left under the cap on what may be taken in the rolling window, in ten-thousandths of the project's money
 * (`TaskBook.takeRoomBps`). As the book stores it: takes that ran past their deadline and are not yet settled still count.
 */
export async function readTakeRoom(
  read: ReadCall,
  book: string,
): Promise<number> {
  const [room] = await ask(read, TASK_BOOK_ABI, book, "takeRoomBps", []);
  return asSafeInt(room, "room");
}

/** The face of `holder`'s exit note against task `serial` (`TaskBook.noteOf`), in dollar units. */
export async function readNoteOf(
  read: ReadCall,
  book: string,
  serial: bigint,
  holder: string,
): Promise<bigint> {
  const [face] = await ask(read, TASK_BOOK_ABI, book, "noteOf", [
    serial,
    holder,
  ]);
  return asBigint(face);
}

/**
 * What a claim of `holder`'s note on task `serial` would pay now (`TaskBook.claimableNote`). Zero while the task is open
 * or was paid in full. It reads zero too for a taken task past its deadline that nobody has settled; the claim itself
 * settles first and pays the whole note.
 */
export async function readClaimable(
  read: ReadCall,
  book: string,
  serial: bigint,
  holder: string,
): Promise<bigint> {
  const [paid] = await ask(read, TASK_BOOK_ABI, book, "claimableNote", [
    serial,
    holder,
  ]);
  return asBigint(paid);
}

/** The project's task book (`Treasury.tasks`), or null when the Treasury has none. */
export async function readBookOf(
  read: ReadCall,
  treasury: string,
): Promise<string | null> {
  const [book] = await ask(read, TREASURY_ABI, treasury, "tasks", []);
  return orNull(asAddress(book));
}

/** The second the project's last check-in stops counting (`Treasury.activeEnd`): after it nothing can be planned or taken. */
export async function readActiveEnd(
  read: ReadCall,
  treasury: string,
): Promise<number> {
  const [end] = await ask(read, TREASURY_ABI, treasury, "activeEnd", []);
  return asSafeInt(end, "time");
}

/** The project's time unit in seconds (`Treasury.unit`): 7 days on a real network. */
export async function readUnit(
  read: ReadCall,
  treasury: string,
): Promise<number> {
  const [unit] = await ask(read, TREASURY_ABI, treasury, "unit", []);
  return asSafeInt(unit, "unit");
}

// --- Looking back for a person's notes -----------------------------------------------------------------------------------

/** A log as the network returns it (what `eth_getLogs` gives, and what the sender's `getLogs` passes on). */
export interface NoteLog {
  address: string;
  topics: string[];
  data: string;
  /** Hex quantity. */
  blockNumber: string;
}

/** Where a look for notes reads the chain: logs over a range of blocks, and the latest block. The sender has both. */
export interface NoteLogSource {
  getLogs(filter: {
    address: string;
    topics: (string | null)[];
    from: number;
    to: number;
  }): Promise<readonly NoteLog[]>;
  blockNumber(): Promise<number>;
}

/** The blocks a first page covers. */
export const NOTE_SCAN_PAGE = 5_000;
/** The smallest page tried: a node that refuses this much is not asked for less. */
const NOTE_SCAN_MIN_PAGE = 100;
/** The most pages one press reads. */
export const NOTE_SCAN_MAX_PAGES = 40;

/** What a look found so far and how far it got. */
export interface NoteScan {
  /** The tasks `holder` has a note on, newest first, each once. */
  serials: bigint[];
  /** The lowest block the look has covered. Continue with `from: reachedBlock - 1` when `done` is false. */
  reachedBlock: number;
  /** True only when the look has covered every block back to `bookBlock`: only then may a screen say "nothing found". */
  done: boolean;
}

/**
 * The node refused even a small range, so the look is unfinished. It carries what was found before, so a screen can show
 * it, but the look is never "done" and an empty result is never "none".
 */
export class NoteScanRefused extends Error {
  readonly found: NoteScan;
  constructor(found: NoteScan) {
    super("The network could not be asked for these notes just now.");
    this.name = "NoteScanRefused";
    this.found = found;
  }
}

/** The topic of `NoteMinted`, from the ABI. */
function noteMintedTopic(): string {
  const event = TASK_BOOK_ABI.find(
    (item) => item.type === "event" && item.name === "NoteMinted",
  );
  if (!event) throw new Error("The task book has no NoteMinted event.");
  const text = signatureOf(event);
  return `0x${Array.from(keccak_256(new TextEncoder().encode(text)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")}`;
}

/**
 * Look back through the chain for the tasks `holder` wrote an exit note on: the `NoteMinted` logs of `book` whose indexed
 * holder is `holder`, **newest first**, from block `from` (default: the latest block) down toward `bookBlock`, the first
 * block the book can have logs in.
 *
 * - A page starts at 5,000 blocks and is halved each time the node refuses the range, down to 100; a node that refuses
 *   that too throws {@link NoteScanRefused} (carrying what was found), never "none".
 * - At most 40 pages per call. When it stops short it returns `done: false` and `reachedBlock`; the next call continues
 *   with `from: reachedBlock - 1`, so there is no ceiling over several presses.
 * - Only logs of `book` that name `holder` are kept, whatever the node returns.
 */
export async function scanNotes(
  source: NoteLogSource,
  book: string,
  bookBlock: number,
  holder: string,
  from?: number,
): Promise<NoteScan> {
  const address = asAddress(book);
  const holderTopic = `0x${asAddress(holder).slice(2).padStart(64, "0")}`;
  const topic = noteMintedTopic();
  let high = from ?? (await source.blockNumber());
  const serials: bigint[] = [];
  const seen = new Set<bigint>();
  let reached = Math.max(high + 1, bookBlock);
  let page = NOTE_SCAN_PAGE;
  let pages = 0;
  while (high >= bookBlock && pages < NOTE_SCAN_MAX_PAGES) {
    const low = Math.max(bookBlock, high - page + 1);
    let logs: readonly NoteLog[];
    try {
      logs = await source.getLogs({
        address,
        topics: [topic, null, holderTopic],
        from: low,
        to: high,
      });
    } catch {
      if (page <= NOTE_SCAN_MIN_PAGE)
        throw new NoteScanRefused({
          serials,
          reachedBlock: reached,
          done: false,
        });
      page = Math.max(NOTE_SCAN_MIN_PAGE, Math.floor(page / 2));
      continue;
    }
    // Newest first: by block, and within a block the later log first (the node lists a range oldest first).
    const ordered = logs
      .map((log, index) => ({ log, index }))
      .sort((a, b) => {
        const blockA = Number(BigInt(a.log.blockNumber));
        const blockB = Number(BigInt(b.log.blockNumber));
        return blockB - blockA || b.index - a.index;
      });
    for (const { log } of ordered) {
      if (
        log.address.toLowerCase() !== address ||
        log.topics.length !== 3 ||
        log.topics[0]?.toLowerCase() !== topic ||
        log.topics[2]?.toLowerCase() !== holderTopic
      )
        continue;
      const serial = BigInt(log.topics[1] ?? "0x0");
      if (seen.has(serial)) continue;
      seen.add(serial);
      serials.push(serial);
    }
    pages += 1;
    reached = low;
    high = low - 1;
  }
  return { serials, reachedBlock: reached, done: high < bookBlock };
}

// --- The holder pause and the earlier backers' claim (step 4) ------------------------------------------------------------

/** How many Shares `holder` has parked in the project's pause contract. */
export async function parkedOf(
  read: ReadCall,
  pause: string,
  holder: string,
): Promise<bigint> {
  const [parked] = await ask(read, HOLDER_PAUSE_ABI, pause, "parkedOf", [
    holder,
  ]);
  return asBigint(parked);
}

/** What the project's pause contract says now, in one read (`HolderPause.state`). */
export interface PauseNow {
  /** Shares parked in all. */
  parked: bigint;
  /** The backers' Shares (parked ones included). */
  backerShares: bigint;
  /** The parked Shares that reach the line now. */
  line: bigint;
  /** When the line was first seen reached in an unbroken run; 0 when it is not. */
  armedAt: number;
  /** When the pause starts if the line stays reached; 0 when not armed. */
  pausesFrom: number;
  /** Whether the team's draws and new task plans are refused now. */
  paused: boolean;
}

/** `HolderPause.state()` at the chain's latest block. Throws when the answer is not readable; never guesses. */
export async function pauseState(
  read: ReadCall,
  pause: string,
): Promise<PauseNow> {
  const [parked, backerShares, line, armed, pausesAt, isPaused] = await ask(
    read,
    HOLDER_PAUSE_ABI,
    pause,
    "state",
    [],
  );
  if (typeof isPaused !== "boolean")
    throw new Error("The network gave an answer that is not readable.");
  const secs = (value: unknown): number => {
    const n = asBigint(value);
    if (n > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("The network gave an answer that is not readable.");
    return Number(n);
  };
  return {
    parked: asBigint(parked),
    backerShares: asBigint(backerShares),
    line: asBigint(line),
    armedAt: secs(armed),
    pausesFrom: secs(pausesAt),
    paused: isPaused,
  };
}

/** Whether row `index` of the earlier backers' list was claimed (`EarlierGrants.isClaimed`). */
export async function earlierRowClaimed(
  read: ReadCall,
  contract: string,
  index: bigint,
): Promise<boolean> {
  const [claimed] = await ask(read, EARLIER_GRANTS_ABI, contract, "isClaimed", [
    index,
  ]);
  if (typeof claimed !== "boolean")
    throw new Error("The network gave an answer that is not readable.");
  return claimed;
}

/** The text fingerprint the claim contract holds now (`EarlierGrants.textHash`), lower case. */
export async function earlierTextHash(
  read: ReadCall,
  contract: string,
): Promise<string> {
  const [hash] = await ask(read, EARLIER_GRANTS_ABI, contract, "textHash", []);
  if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash))
    throw new Error("The network gave an answer that is not readable.");
  return hash.toLowerCase();
}

/** Whether the claim contract is tied to the project's Vester, so claims can start (`EarlierGrants.vester` is not zero). */
export async function earlierIsBound(
  read: ReadCall,
  contract: string,
): Promise<boolean> {
  const [vester] = await ask(read, EARLIER_GRANTS_ABI, contract, "vester", []);
  return typeof vester === "string" && !/^0x0{40}$/i.test(vester);
}

/**
 * The project's holder pause contract as the Treasury itself names it (`Treasury.pauseGate`), lower case, or null when the
 * project has none. The chain is the only source for where Shares are approved to: a record is never trusted for it.
 */
export async function pauseGateOf(
  read: ReadCall,
  treasury: string,
): Promise<string | null> {
  const [gate] = await ask(read, TREASURY_ABI, treasury, "pauseGate", []);
  if (typeof gate !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(gate))
    throw new Error("The network gave an answer that is not readable.");
  return /^0x0{40}$/.test(gate) ? null : gate.toLowerCase();
}

/** The pause contract's two fixed numbers: the warning period in seconds and the line's divisor (3: "a third"). */
export async function pauseRules(
  read: ReadCall,
  pause: string,
): Promise<{ dayLength: number; lineDivisor: number }> {
  const [[day], [divisor]] = await Promise.all([
    ask(read, HOLDER_PAUSE_ABI, pause, "day", []),
    ask(read, HOLDER_PAUSE_ABI, pause, "LINE_DIVISOR", []),
  ]);
  const d = asBigint(day);
  const v = asBigint(divisor);
  if (d <= 0n || d > 365n * 86_400n || v < 2n || v > 100n)
    throw new Error("The network gave an answer that is not readable.");
  return { dayLength: Number(d), lineDivisor: Number(v) };
}
