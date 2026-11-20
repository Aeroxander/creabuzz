/**
 * The settled money of a project at a time, worked forward from the Treasury's stored numbers by section 3 of the record's
 * spec (docs/next-version/RECORD-V2.md), in integers, exactly as `Treasury._settled()` does: the allowance box fills, its cap,
 * the arriving money released by one formula on the stream's own start, and the money of tasks that ran out put back last.
 * `live-record.ts` uses it to make the record a browser spec's page reads; `tests/anvil/pot-tasks.test.ts` checks it against what
 * the Treasury itself stores after a settle, at several times, so a mistake here shows there and not in a page.
 */
import {
  decodeReturn,
  encodeCall,
} from "../../../../packages/creaton-core/src/pot/abi-codec.ts";
import type { Abi } from "../../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  TASK_BOOK_ABI,
  TREASURY_ABI,
} from "../../../../packages/creaton-core/src/pot/abis.generated.ts";
import { call } from "../../anvil/rpc";

const big = (v: unknown) => BigInt(v as bigint);
const mulDiv = (a: bigint, b: bigint, c: bigint) => (a * b) / c;

/** What the Treasury stores as of its last settle, and the rules it works forward with. */
export interface StoredMoney {
  lastSettle: bigint;
  activeEnd: bigint;
  ratePpm: bigint;
  unit: bigint;
  pot: bigint;
  box: bigint;
  arriving: bigint;
  arrivalEnd: bigint;
  arrivalStart: bigint;
  arrivalTotal: bigint;
  locked: bigint;
  activeSeconds: bigint;
  /** The stayers' claims of the tasks that have run out by the time asked about (the task book's `dueC`); zero when none. */
  dueC: bigint;
}

/** The numbers at a time: what a settle at that time would store. */
export interface SettledMoney {
  pot: bigint;
  box: bigint;
  arriving: bigint;
  locked: bigint;
  activeSeconds: bigint;
  /** Seconds of allowance that accrued since the last settle. */
  dt: bigint;
}

async function view(
  abi: Abi,
  to: string,
  name: string,
  args: (bigint | string)[] = [],
): Promise<bigint | string> {
  return decodeReturn(
    abi,
    name,
    await call(to, encodeCall(abi, name, args)),
    args.length,
  )[0] as bigint | string;
}

/** Reads the Treasury's stored numbers, and the book's `dueC` for time `t` when a task's time has run out by then. */
export async function readStored(
  treasury: string,
  t: bigint,
): Promise<StoredMoney> {
  const T = async (name: string) =>
    big(await view(TREASURY_ABI, treasury, name));
  const nextExpiry = await T("nextExpiry");
  let dueC = 0n;
  if (nextExpiry !== 0n && t >= nextExpiry) {
    const book = String(await view(TREASURY_ABI, treasury, "tasks"));
    dueC = big(await view(TASK_BOOK_ABI, book, "dueC", [t]));
  }
  return {
    lastSettle: await T("lastSettle"),
    activeEnd: await T("activeEnd"),
    ratePpm: await T("ratePpm"),
    unit: await T("unit"),
    pot: await T("pot"),
    box: await T("box"),
    arriving: await T("arriving"),
    arrivalEnd: await T("arrivalEnd"),
    arrivalStart: await T("arrivalStart"),
    arrivalTotal: await T("arrivalTotal"),
    locked: await T("locked"),
    activeSeconds: await T("activeSeconds"),
    dueC,
  };
}

/** The stored numbers worked forward to time `t`. Pure. */
export function rollForward(t: bigint, s: StoredMoney): SettledMoney {
  let { pot, box, arriving } = s;
  const upto = t < s.activeEnd ? t : s.activeEnd;
  const dt = upto > s.lastSettle ? upto - s.lastSettle : 0n;
  const cap = mulDiv(pot + box, s.ratePpm * 7n, 1_000_000n);
  if (dt !== 0n && s.ratePpm !== 0n) {
    const toBox = mulDiv(pot, s.ratePpm * dt, 1_000_000n * (s.unit / 7n));
    box += toBox;
    pot -= toBox;
  }
  if (box > cap) {
    pot += box - cap;
    box = cap;
  }
  if (arriving !== 0n) {
    // What has arrived by `t` is one rounding of one formula on the stream's own start, so that settling every second gives what
    // settling once gives.
    const target =
      t >= s.arrivalEnd
        ? s.arrivalTotal
        : mulDiv(
            s.arrivalTotal,
            t - s.arrivalStart,
            s.arrivalEnd - s.arrivalStart,
          );
    const done = s.arrivalTotal - arriving;
    const released = target > done ? target - done : 0n;
    arriving -= released;
    pot += released;
  }
  // Tasks that ran out come back last: the returned money is not charged allowance for the time it was not in the pot.
  const locked = s.locked - s.dueC;
  pot += s.dueC;
  return {
    pot,
    box,
    arriving,
    locked,
    activeSeconds: s.activeSeconds + dt,
    dt,
  };
}
