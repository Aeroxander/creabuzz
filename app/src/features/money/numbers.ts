/**
 * A project's numbers as the server reads them from the chain: kind 39009, signed by the server's own key, record
 * version 2 (`docs/next-version/RECORD-V2.md`). Pure: parsing, the checks that decide whether a record is believed, the
 * small words the screens use for amounts and times, and how old a record is.
 *
 * Amounts are decimal strings of whole numbers in raw units (dollars 6 decimals, Shares 18) and are read into bigints;
 * times are unix seconds. Everything under `asOf` is as of one final block. **The parser is strict**: a version it does
 * not know, a field that is missing or the wrong type, a negative or absurd number gives null ("cannot read"), never a
 * crash and never a default number. The chain decides the real amount when a person acts: a sheet reads the chain
 * (`@creaton/core/pot/pot-reads.ts`), not this record.
 */
import { KIND_PROJECT_NUMBERS } from "@creaton/core/kinds.ts";
import { numbersBelongTo } from "@creaton/core/launchpad/project-chain.ts";

import { BYTES32, isObject, obj, readBody, time } from "./numbers-read";
import type {
  NumbersEvent,
  ProjectNumbers,
  QuietState,
  RemovedNumbers,
} from "./numbers-types";

export type {
  NumbersEvent,
  ProjectNumbers,
  QuietState,
  RemovedNumbers,
} from "./numbers-types";

/** Raw dollar units in one dollar, and raw Share units in one Share. */
export const DOLLAR = 1_000_000n;
const SHARE = 1_000_000_000_000_000_000n;

function dTag(event: NumbersEvent): string | null {
  const d = event.tags.find((t) => t[0] === "d")?.[1];
  return typeof d === "string" ? d.toLowerCase() : null;
}

/**
 * The numbers a record carries, or null when it is not to be believed: not signed by the server's own key, a version
 * this app does not know (version 1 included), not the numbers of that project's launch when `project` is given, or any
 * field missing, mistyped, negative or absurd. Never throws.
 */
export function parseNumbers(
  event: NumbersEvent,
  signer: string | null,
  project?: { coordinate: string; chainKey: string | null },
): ProjectNumbers | RemovedNumbers | null {
  try {
    if (event.kind !== KIND_PROJECT_NUMBERS || !signer) return null;
    if (event.pubkey !== signer) return null;
    const d = dTag(event);
    if (!d || !BYTES32.test(d)) return null;
    if (project && (!project.chainKey || project.chainKey !== d)) return null;
    let body: unknown;
    try {
      body = JSON.parse(event.content);
    } catch {
      return null;
    }
    if (!isObject(body) || body.version !== 2) return null;
    if (body.removed === true) {
      // The removal form: the key it names must be the record's own.
      if (typeof body.key !== "string" || body.key.toLowerCase() !== d)
        return null;
      const asOf = obj(body.asOf, "asOf");
      time(asOf.block, "asOf.block");
      time(asOf.time, "asOf.time");
      return { removed: true, key: d };
    }
    if (typeof body.key !== "string" || body.key.toLowerCase() !== d)
      return null;
    if (
      project &&
      !numbersBelongTo({
        d,
        founder: body.founder,
        projectId: body.projectId,
        chainKey: project.chainKey ?? "",
        coordinate: project.coordinate,
      })
    )
      return null;
    return readBody(body, d);
  } catch {
    // Unreadable (a field that cannot be believed), or anything unforeseen: "cannot read", never a crash.
    return null;
  }
}

// --- What the screens ask of a record -----------------------------------------------------------------------------

/** Whether `address` runs the project (the only account that may check in, or, with a Pair, either signer may). */
export function isRunner(numbers: ProjectNumbers, address: string | null) {
  return Boolean(address && numbers.runner.address === address.toLowerCase());
}

/** Whether `address` is one of the two signers of the project's Pair. */
export function signsForRunner(
  numbers: ProjectNumbers,
  address: string | null,
): boolean {
  if (!address || !numbers.runner.signers) return false;
  const who = address.toLowerCase();
  return numbers.runner.signers.includes(who);
}

/**
 * A hint, not a position: the record's holders list is cut at 200, so `listed` false says nothing about a person's
 * Shares when `truncated` is true. A person's own position is read from the chain when a sheet opens.
 */
export function holdingHint(
  numbers: ProjectNumbers,
  addresses: readonly string[],
): { listed: boolean; shares: bigint; teamShares: bigint; certain: boolean } {
  const mine = new Set(addresses.map((a) => a.toLowerCase()));
  let shares = 0n;
  let teamShares = 0n;
  let listed = false;
  for (const h of numbers.holders)
    if (mine.has(h.account)) {
      listed = true;
      shares += h.shares;
      teamShares += h.teamShares;
    }
  return { listed, shares, teamShares, certain: listed || !numbers.truncated };
}

/**
 * The state's word at `now`, from the three fixed times (RECORD-V2 section 2.7): for words only. What the door and the
 * allowance actually do is decided by the chain.
 */
export function quietStateAt(numbers: ProjectNumbers, now: number): QuietState {
  if (numbers.windDown) return "wound_down";
  const { quietFrom, dormantFrom, windableFrom } = numbers.quiet;
  if (quietFrom === null || dormantFrom === null || windableFrom === null)
    return numbers.quiet.state;
  if (now < quietFrom) return "active";
  if (now < dormantFrom) return "quiet";
  if (now < windableFrom) return "dormant";
  return "may_wind_down";
}

/** How old a record is, by the rule of RECORD-V2 section 6. */
export type Freshness =
  /** Nothing special to say: "as of" sits in the details. */
  | { level: "fresh"; ageSecs: number }
  /** Older than three refresh periods: money figures say "Numbers as of <time>". */
  | { level: "as-of"; ageSecs: number }
  /** Older than a day: lists show no money figures; the project page says the numbers could not be refreshed. */
  | { level: "stale"; ageSecs: number };

/** How far ahead of this device's clock a record's time may be before it is not believed (a clock a little behind is normal). */
const FUTURE_SLACK_SECS = 10 * 60;

/**
 * The age of the server's work: `now - builtAt` (a clock a little behind the server counts as zero). A record built far in
 * the future of this device's clock cannot be told from a wrong one: it is "stale", never "fresh for ever". The
 * day's limit is tested first, so a slow refresh period never makes a record older than a day "fresh".
 */
export function freshnessOf(numbers: ProjectNumbers, now: number): Freshness {
  if (numbers.builtAt - now > FUTURE_SLACK_SECS)
    return { level: "stale", ageSecs: 0 };
  const ageSecs = Math.max(0, now - numbers.builtAt);
  if (ageSecs > 24 * 60 * 60) return { level: "stale", ageSecs };
  const limit = 3 * numbers.refreshEverySecs + 60;
  if (ageSecs <= limit) return { level: "fresh", ageSecs };
  return { level: "as-of", ageSecs };
}

/** The allowance box's growth in a day, as far as the record can say: the pot times the daily rate. An estimate. */
export function allowancePerDay(numbers: ProjectNumbers): bigint {
  return (numbers.money.pot * BigInt(numbers.allowance.ratePpm)) / 1_000_000n;
}

// --- Words for numbers --------------------------------------------------------------------------------------------

function groupThousands(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Dollars from raw units: "2,500" or "2,500.50" (cents only when there are some; rounded down). */
export function dollarsText(raw: bigint): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / DOLLAR;
  const cents = (abs % DOLLAR) / 10_000n;
  const text =
    cents === 0n
      ? groupThousands(whole)
      : `${groupThousands(whole)}.${cents.toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** Whole Shares from raw units, rounded down, with thousands marked: "7,200,000". */
export function sharesText(raw: bigint): string {
  return groupThousands(raw / SHARE);
}

/** A date for people: "18 Nov 2026". */
export function dayText(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** A time for people: "18 Nov, 14:05". */
export function timeText(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
