/**
 * A project's numbers as the server reads them from the chain (kind 39009, signed by the server's own key, milestone 5).
 * Pure: parsing, the checks that decide whether a record is believed, and the small sums the screens show.
 *
 * Amounts are whole numbers in raw units: dollars with 6 decimals, Shares with 18. Times are unix seconds. Everything
 * under `now` is as of `asOf.time`; the chain decides the real amount when a person acts.
 */
import { KIND_PROJECT_NUMBERS } from "@creaton/core/kinds.ts";
import { numbersBelongTo } from "@creaton/core/launchpad/project-chain.ts";

/** Raw dollar units in one dollar, and raw Share units in one Share. */
export const DOLLAR = 1_000_000n;
const SHARE = 1_000_000_000_000_000_000n;

export type StageName = "solo" | "backed" | "team" | "council" | "open";
const STAGES: readonly StageName[] = [
  "solo",
  "backed",
  "team",
  "council",
  "open",
];

export interface RoundNumbers {
  round: number;
  size: bigint;
  sharesPerRawDollar: bigint;
  /** Dollars for all 1,000,000,000 Shares at this round's price, to the cent ("333333.33"). */
  projectPrice: string;
  opensAt: number;
  closesAt: number;
  backers: number;
  asked: bigint;
  closed: boolean;
  accepted: bigint | null;
  /** The percent of each ask that was taken when more was asked than fit, or null. */
  acceptedPercent: string | null;
}

export interface ReceiptNumbers {
  round: number;
  backer: string;
  accepted: bigint;
  shares: bigint;
  heldMoney: bigint;
  sharesHeld: bigint;
  /** When the backer took their money back, or null. */
  refunded: number | null;
  /** How much they were paid back then, when the record says. */
  refundedPaid: bigint | null;
}

interface HolderNumbers {
  account: string;
  held: bigint;
  free: bigint;
}

export interface RefundNow {
  round: number;
  backer: string;
  refundable: bigint;
  /** What is left to take back of each 100 paid ("58.64"). */
  per100: string;
}

export interface ProjectNumbers {
  removed: false;
  key: string;
  projectId: string;
  founder: string;
  chainId: number;
  launcher: string;
  contracts: {
    shares: string | null;
    treasury: string | null;
    vester: string | null;
    rounds: string | null;
  };
  stage: { name: StageName; since: number | null };
  eligible: { for: StageName; since: number } | null;
  raised: { total: bigint; cap: bigint; left: bigint };
  rounds: RoundNumbers[];
  clock: {
    lastCheckIn: number | null;
    runsUntil: number | null;
    paused: boolean;
    woundDown: boolean;
  };
  receipts: ReceiptNumbers[];
  receiptCount: number;
  holders: HolderNumbers[];
  holderCount: number;
  /** The lists were cut at 200: "none" is never said about a cut list. */
  truncated: boolean;
  runner: string | null;
  asOf: { block: number; time: number };
  now: { quietSince: number | null; refunds: RefundNow[] };
}

/** A launch that later left the chain: nothing about money is shown for it. */
export interface RemovedNumbers {
  removed: true;
  key: string;
}

export interface NumbersEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function big(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) return null;
  return BigInt(v);
}
function bigOr0(v: unknown): bigint {
  return big(v) ?? 0n;
}
function int(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}
function address(v: unknown): string | null {
  return typeof v === "string" && ADDRESS.test(v) ? v.toLowerCase() : null;
}
function stageName(v: unknown): StageName | null {
  return typeof v === "string" && (STAGES as readonly string[]).includes(v)
    ? (v as StageName)
    : null;
}
function list(v: unknown): Json[] {
  return Array.isArray(v) ? v.filter(isObject) : [];
}
function priceText(v: unknown): string {
  return typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : "";
}

function parseRound(r: Json): RoundNumbers | null {
  const round = int(r.round);
  const size = big(r.size);
  const price = big(r.sharesPerRawDollar);
  const opensAt = int(r.opensAt);
  const closesAt = int(r.closesAt);
  if (round === null || size === null || price === null) return null;
  if (opensAt === null || closesAt === null) return null;
  return {
    round,
    size,
    sharesPerRawDollar: price,
    projectPrice: priceText(r.projectPrice),
    opensAt,
    closesAt,
    backers: int(r.backers) ?? 0,
    asked: bigOr0(r.asked),
    closed: r.closed === true,
    accepted: big(r.accepted),
    acceptedPercent:
      typeof r.acceptedPercent === "string" ? r.acceptedPercent : null,
  };
}

function parseReceipt(r: Json): ReceiptNumbers | null {
  const round = int(r.round);
  const backer = address(r.backer);
  if (round === null || !backer) return null;
  return {
    round,
    backer,
    accepted: bigOr0(r.accepted),
    shares: bigOr0(r.shares),
    heldMoney: bigOr0(r.heldMoney),
    sharesHeld: bigOr0(r.sharesHeld),
    // The chain reader writes `{"paid": "<raw dollars>", "at": <unix>}` once a receipt is taken back.
    refunded: isObject(r.refunded) ? int(r.refunded.at) : int(r.refunded),
    refundedPaid: isObject(r.refunded) ? big(r.refunded.paid) : null,
  };
}

function parseHolder(h: Json): HolderNumbers | null {
  const account = address(h.account);
  if (!account) return null;
  return { account, held: bigOr0(h.held), free: bigOr0(h.free) };
}

function parseRefund(r: Json): RefundNow | null {
  const round = int(r.round);
  const backer = address(r.backer);
  const refundable = big(r.refundable);
  if (round === null || !backer || refundable === null) return null;
  return {
    round,
    backer,
    refundable,
    per100: typeof r.per100 === "string" ? r.per100 : "",
  };
}

function dTag(event: NumbersEvent): string | null {
  const d = event.tags.find((t) => t[0] === "d")?.[1];
  return typeof d === "string" ? d.toLowerCase() : null;
}

/**
 * The numbers a record carries, or null when it is not to be believed: not signed by the server's own key, a version
 * this app does not know, or (when `project` is given) not the numbers of that project's launch.
 */
export function parseNumbers(
  event: NumbersEvent,
  signer: string | null,
  project?: { coordinate: string; chainKey: string | null },
): ProjectNumbers | RemovedNumbers | null {
  if (event.kind !== KIND_PROJECT_NUMBERS || !signer) return null;
  if (event.pubkey !== signer) return null;
  const d = dTag(event);
  if (!d) return null;
  if (project && (!project.chainKey || project.chainKey !== d)) return null;
  let body: unknown;
  try {
    body = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!isObject(body) || body.version !== 1) return null;
  if (body.removed === true) return { removed: true, key: d };
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
  const founder = address(body.founder);
  const launcher = address(body.launcher);
  const chainId = int(body.chainId);
  const stage = isObject(body.stage) ? body.stage : {};
  const raised = isObject(body.raised) ? body.raised : {};
  const clock = isObject(body.clock) ? body.clock : {};
  const contracts = isObject(body.contracts) ? body.contracts : {};
  const asOf = isObject(body.asOf) ? body.asOf : {};
  const now = isObject(body.now) ? body.now : {};
  const eligible = isObject(body.eligible) ? body.eligible : null;
  const treasury = isObject(body.treasury) ? body.treasury : {};
  if (!founder || !launcher || chainId === null) return null;
  const eligibleFor = eligible ? stageName(eligible.for) : null;
  const eligibleSince = eligible ? int(eligible.since) : null;
  const receipts = list(body.receipts)
    .map(parseReceipt)
    .filter((r): r is ReceiptNumbers => r !== null);
  const holders = list(body.holders)
    .map(parseHolder)
    .filter((h): h is HolderNumbers => h !== null);
  return {
    removed: false,
    key: d,
    projectId: typeof body.projectId === "string" ? body.projectId : "",
    founder,
    chainId,
    launcher,
    contracts: {
      shares: address(contracts.shares),
      treasury: address(contracts.treasury),
      vester: address(contracts.vester),
      rounds: address(contracts.rounds),
    },
    stage: {
      name: stageName(stage.name) ?? "solo",
      since: int(stage.since),
    },
    eligible:
      eligibleFor && eligibleSince !== null
        ? { for: eligibleFor, since: eligibleSince }
        : null,
    raised: {
      total: bigOr0(raised.total),
      cap: bigOr0(raised.cap),
      left: bigOr0(raised.left),
    },
    rounds: list(body.rounds)
      .map(parseRound)
      .filter((r): r is RoundNumbers => r !== null)
      .sort((a, b) => a.round - b.round),
    clock: {
      lastCheckIn: int(clock.lastCheckIn),
      runsUntil: int(clock.runsUntil),
      paused: clock.paused === true,
      woundDown: clock.woundDown === true,
    },
    receipts,
    receiptCount: int(body.receiptCount) ?? receipts.length,
    holders,
    holderCount: int(body.holderCount) ?? holders.length,
    truncated: body.truncated === true,
    runner: address(treasury.runner),
    asOf: { block: int(asOf.block) ?? 0, time: int(asOf.time) ?? 0 },
    now: {
      quietSince: int(now.quietSince),
      refunds: list(now.refunds)
        .map(parseRefund)
        .filter((r): r is RefundNow => r !== null),
    },
  };
}

/** The round taking asks at `now`, or null. A round is open for 24 hours from when it opened. */
export function openRound(
  numbers: ProjectNumbers,
  now: number,
): RoundNumbers | null {
  if (numbers.clock.woundDown) return null;
  return (
    numbers.rounds.find(
      (r) => !r.closed && r.opensAt <= now && now < r.closesAt,
    ) ?? null
  );
}

/**
 * Where a round is at `now`: taking asks, past its 24 hours but not closed yet (anyone may close it; until then no new
 * round can open), or closed.
 */
export function roundState(
  round: RoundNumbers,
  now: number,
): "open" | "waiting" | "closed" {
  if (round.closed) return "closed";
  return now < round.closesAt ? "open" : "waiting";
}

/** Whether any round is not closed yet: then no new round can open. */
export function anyRoundUnclosed(numbers: ProjectNumbers): boolean {
  return numbers.rounds.some((r) => !r.closed);
}

/** Asks may be lowered or withdrawn only in a round's first 12 hours. */
export const LOWER_WINDOW_SECONDS = 12 * 60 * 60;

/** Whether an ask in `round` may still be lowered at `now`. */
export function canLower(round: RoundNumbers, now: number): boolean {
  return now < round.opensAt + LOWER_WINDOW_SECONDS && now < round.closesAt;
}

/** A person's receipts in a project, by any of their wallet addresses. */
export function receiptsFor(
  numbers: ProjectNumbers,
  addresses: readonly string[],
): ReceiptNumbers[] {
  const mine = new Set(addresses.map((a) => a.toLowerCase()));
  return numbers.receipts.filter((r) => mine.has(r.backer));
}

/** What a backer can still take back in a round, as of the record's time, or null when the record says nothing. */
export function refundFor(
  numbers: ProjectNumbers,
  round: number,
  backer: string,
): RefundNow | null {
  const who = backer.toLowerCase();
  return (
    numbers.now.refunds.find((r) => r.round === round && r.backer === who) ??
    null
  );
}

/**
 * A person's Shares in a project: held for them (not free yet) and free, over all their addresses. `listed` is false
 * when none of their addresses is in the holders list: on a cut list (`truncated`) that says nothing about what they hold.
 */
export function holdingsFor(
  numbers: ProjectNumbers,
  addresses: readonly string[],
): { held: bigint; free: bigint; listed: boolean } {
  const mine = new Set(addresses.map((a) => a.toLowerCase()));
  let held = 0n;
  let free = 0n;
  let listed = false;
  for (const h of numbers.holders) {
    if (!mine.has(h.account)) continue;
    listed = true;
    held += h.held;
    free += h.free;
  }
  return { held, free, listed };
}

/** Whether `address` runs the project (the only one who may check in on the chain). */
export function isRunner(numbers: ProjectNumbers, address: string | null) {
  return Boolean(
    address && numbers.runner && numbers.runner === address.toLowerCase(),
  );
}

// --- Words for numbers -------------------------------------------------------------------------------------------------

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

/** How many Shares one dollar buys at a round's price: 3e15 raw Shares a raw dollar is 3,000. */
export function sharesPerDollar(sharesPerRawDollar: bigint): string {
  return groupThousands((sharesPerRawDollar * DOLLAR) / SHARE);
}

/** A whole-project price as the record writes it ("333333.33") with thousands marked ("333,333.33"). */
export function projectPriceText(price: string): string {
  if (!price) return "";
  const [whole, cents] = price.split(".");
  return cents
    ? `${groupThousands(BigInt(whole))}.${cents}`
    : groupThousands(BigInt(whole));
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

/** The stage names as the stage line shows them. */
export const STAGE_LABEL: Record<StageName, string> = {
  solo: "Solo",
  backed: "Backed",
  team: "Team",
  council: "Council",
  open: "Open",
};
