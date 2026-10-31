/**
 * Funding status — what a project says about raising, and what the chain says
 * about it (plan §2, docs/archive/funding-and-governance-plan.md).
 *
 * The technical `stage` (draft -> review -> live -> funding -> graduated) is a
 * machine's view of a sale. This is the project's own word: a stance a founder
 * declares and everyone else reads on every card, plus who the project wants to
 * hear from. The two are deliberately separate fields — "Planning a raise" is
 * real intent with no onchain state yet, and it must survive on that alone.
 *
 * The one rule with teeth: a declared stance stands, and the chain only
 * overrides it where the two contradict. So "Not raising" cannot hide a live
 * sale, and no missing chain reading can erase a declared plan.
 *
 * Pure and alias-free: `funding.test.mjs` drives it under `node --test`.
 */

/** How the project describes its funding right now. */
export type FundingStance =
  | "not-raising"
  | "planning"
  | "raising"
  | "closing"
  | "closed"
  | "rolling";

/**
 * The order the plan lists them in — also the order the discovery chips use.
 * A short closed list on purpose: a stance menu with forty near-duplicates is
 * no stance at all.
 */
export const FUNDING_STANCES: readonly FundingStance[] = [
  "not-raising",
  "planning",
  "raising",
  "closing",
  "closed",
  "rolling",
];

function isFundingStance(value: unknown): value is FundingStance {
  return (
    typeof value === "string" && (FUNDING_STANCES as string[]).includes(value)
  );
}

/** Who the project wants to hear from. A project can want several at once. */
export type FundingSeeking = "contributors" | "backers" | "advisors";

export const FUNDING_SEEKING: readonly FundingSeeking[] = [
  "contributors",
  "backers",
  "advisors",
];

function isFundingSeeking(value: unknown): value is FundingSeeking {
  return (
    typeof value === "string" && (FUNDING_SEEKING as string[]).includes(value)
  );
}

/**
 * How the project wants to fund itself: the two ways that exist (a sale, or no sale
 * and Shares earned by work). Null on a record that names neither, including records
 * written when two more were planned ("open-sale", "proposals"), which were never
 * built and are read as no declaration rather than offered.
 */
export type FundingPath = "auction" | "contributors";

export const FUNDING_PATHS: readonly FundingPath[] = [
  "auction",
  "contributors",
];

function isFundingPath(value: unknown): value is FundingPath {
  return (
    typeof value === "string" && (FUNDING_PATHS as string[]).includes(value)
  );
}

export const FUNDING_PATH_LABELS: Record<FundingPath, string> = {
  auction: "Auction",
  contributors: "Contributors only",
};

export const FUNDING_PATH_HINTS: Record<FundingPath, string> = {
  auction: "Sell a fixed tranche to the highest bidders over a set window.",
  contributors: "Nothing is sold. Shares are earned by work.",
};

/** The declared half: `content.funding` on the launch record (kind 37001). */
export interface FundingStatus {
  stance: FundingStance;
  seeking: FundingSeeking[];
  /** How the project wants to fund itself (plan §3). */
  path: FundingPath | null;
  /** The rough date the founder named for a planned raise (`YYYY-MM-DD`). */
  opensAt: string | null;
  /** A short line the founder wants read beside the stance. */
  note: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `content.funding` in, status out — or null when the block is malformed.
 * Never a guessed half: a record that lost its shape shows no declaration
 * rather than an invented one (the parse-refuses convention of
 * `unlock-plans.ts`).
 */
export function parseFunding(value: unknown): FundingStatus | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const block = value as Record<string, unknown>;
  if (!isFundingStance(block.stance)) return null;
  const seeking = Array.isArray(block.seeking)
    ? block.seeking.filter(isFundingSeeking)
    : [];
  const opensAt =
    typeof block.opensAt === "string" && ISO_DATE.test(block.opensAt)
      ? block.opensAt
      : null;
  const note =
    typeof block.note === "string" && block.note.trim() !== ""
      ? block.note.trim()
      : null;
  return {
    stance: block.stance,
    seeking: [...new Set(seeking)],
    path: isFundingPath(block.path) ? block.path : null,
    opensAt,
    note,
  };
}

/** The status as `content.funding`, so a save round-trips what it read. */
export function fundingContent(status: FundingStatus): Record<string, unknown> {
  const out: Record<string, unknown> = { stance: status.stance };
  if (status.seeking.length > 0) out.seeking = status.seeking;
  if (status.path) out.path = status.path;
  if (status.opensAt) out.opensAt = status.opensAt;
  if (status.note) out.note = status.note;
  return out;
}

/** Plain-words labels. The plan's own table, no protocol vocabulary. */
export const FUNDING_STANCE_LABELS: Record<FundingStance, string> = {
  "not-raising": "Not raising",
  planning: "Planning a raise",
  raising: "Raising now",
  closing: "Closing the raise",
  closed: "Raise closed",
  rolling: "Rolling round",
};

export const FUNDING_SEEKING_LABELS: Record<FundingSeeking, string> = {
  contributors: "Contributors",
  backers: "Backers",
  advisors: "Advisors",
};

/** One line for a card: "Not raising · looking for contributors". */
export function fundingSummary(status: ResolvedFunding): string {
  const stance = FUNDING_STANCE_LABELS[status.stance];
  if (status.seeking.length === 0) return stance;
  return `${stance} · looking for ${status.seeking
    .map((s) => FUNDING_SEEKING_LABELS[s].toLowerCase())
    .join(", ")}`;
}

// ---- chain truth ----

/**
 * What the chain knows about a raise, whatever the record claims:
 *
 * - `none`     no sale on file — the declaration speaks alone.
 * - `open`     money can be put in right now.
 * - `settling` the window closed, the outcome is not recorded yet.
 * - `done`     the outcome is recorded (or the record itself says so).
 */
export type ChainRaise = "none" | "open" | "settling" | "done";

/** Receipts that record a raise's outcome, whatever it was. */
const SETTLED_TABLES: readonly string[] = [
  "summon",
  "graduate",
  "failed",
  "refund-open",
];

/** The structural slice of a launch the funding derivation needs. */
export interface FundingLaunch {
  record: {
    stage: string;
    endBlock: number | null;
    funding: FundingStatus | null;
    createdAt: number;
    /** Read only to tell a contributor project apart (`isContributorProject`); a caller may leave them out. */
    auction?: string | null;
    tokenPlan?: { mode: string } | null;
  };
  receipts: readonly { table: string }[];
}

/**
 * A contributor project: a DAO made with no sale at all, whose Shares are only ever awarded for accepted work. The
 * record says "contributors only" and names the DAO's own Shares, and no auction is linked to it. Its DAO exists from
 * the first day, so its saved stage is the one a DAO has; that stage must never be read as a sale that took place.
 */
export function isContributorProject(record: {
  funding?: FundingStatus | null;
  auction?: string | null;
  tokenPlan?: { mode: string } | null;
}): boolean {
  return (
    record.funding?.path === "contributors" &&
    record.tokenPlan?.mode === "dao" &&
    !record.auction
  );
}

/**
 * The chain's reading of one launch. `head` is the current block, or null when
 * the chain could not be read — which yields "open" for a live stage rather
 * than a guess that the raise ended (the `launch-filters.ts` honesty rule).
 */
export function chainRaise(
  launch: Pick<FundingLaunch, "record" | "receipts">,
  head: number | bigint | null,
): ChainRaise {
  const { stage, endBlock } = launch.record;
  // Nothing was ever sold, so there is no raise to be open, closing or closed.
  if (isContributorProject(launch.record)) return "none";
  if (launch.receipts.some((r) => SETTLED_TABLES.includes(r.table))) {
    return "done";
  }
  if (stage === "graduated" || stage === "failed") return "done";
  if (stage !== "live" && stage !== "funding") return "none";
  if (endBlock === null || head === null) return "open";
  const at = typeof head === "bigint" ? head : BigInt(head);
  return at > BigInt(endBlock) ? "settling" : "open";
}

/** The stance the chain asserts when it disagrees with the declaration. */
const CHAIN_STANCE: Record<Exclude<ChainRaise, "none">, FundingStance> = {
  open: "raising",
  settling: "closing",
  done: "closed",
};

/**
 * Stances that already say what the chain says — no contradiction, so the
 * declared wording wins and keeps its nuance ("Closing the raise" during the
 * final stretch is more useful than "Raising now").
 *
 * The one declaration a finished sale can never contradict is "rolling": an
 * open-ended round is not closed by one sale settling.
 */
const AGREES: Record<Exclude<ChainRaise, "none">, readonly FundingStance[]> = {
  open: ["raising", "closing", "rolling"],
  settling: ["closing", "rolling"],
  done: ["closed", "rolling"],
};

/**
 * The stance to show: the project's word, corrected by the chain only where
 * the chain contradicts it.
 *
 * | chain     | effect                                                     |
 * | --------- | ---------------------------------------------------------- |
 * | `open`    | "Raising now", unless the word already covers an open sale   |
 * | `settling`| "Closing the raise", unless the word already covers it       |
 * | `done`    | "Raise closed", unless the word already covers it            |
 * | `none`    | the declaration stands; nothing declared means not raising    |
 */
export function effectiveStance(
  declared: FundingStatus | null,
  raise: ChainRaise,
): FundingStance {
  const stance = declared?.stance ?? "not-raising";
  if (raise === "none") return stance;
  if (AGREES[raise].includes(stance)) return stance;
  return CHAIN_STANCE[raise];
}

/** The stance and seeking a launch actually shows, after the chain's correction. */
export interface ResolvedFunding {
  stance: FundingStance;
  seeking: readonly FundingSeeking[];
  /** How the project wants to fund itself (plan §3), when it said. */
  path: FundingPath | null;
  /** The founder's line, when there is one. */
  note: string | null;
  /** The rough date named for a planned raise, when there is one. */
  opensAt: string | null;
  /** Whether a sale is open for money right now. */
  raisingNow: boolean;
}

/** The funding status for a launch whose stage the auction has corrected (`stageForLaunch`): the saved label may be behind. */
export function effectiveFundingAt(
  launch: Pick<FundingLaunch, "record" | "receipts">,
  stage: string,
  head: number | bigint | null,
): ResolvedFunding {
  return effectiveFunding(
    { record: { ...launch.record, stage }, receipts: launch.receipts },
    head,
  );
}

export function effectiveFunding(
  launch: Pick<FundingLaunch, "record" | "receipts">,
  head: number | bigint | null,
): ResolvedFunding {
  const declared = launch.record.funding;
  const raise = chainRaise(launch, head);
  return {
    stance: effectiveStance(declared, raise),
    seeking: declared?.seeking ?? [],
    path: declared?.path ?? null,
    note: declared?.note ?? null,
    opensAt: declared?.opensAt ?? null,
    raisingNow: raise === "open",
  };
}

// ---- the stale-plan nudge ----

/** Thirty days: long enough to plan, short enough that silence reads as stale. */
export const PLANNING_NUDGE_AFTER_SECONDS = 30 * 24 * 60 * 60;

/**
 * A "Planning a raise" that has stood untouched for 30 days gets a nudge to
 * update. `declaredAt` is the record's own timestamp, which a save refreshes,
 * so the clock restarts whenever the founder touches the record.
 */
export function planningIsStale(
  status: FundingStatus | null,
  declaredAt: number,
  now: number,
): boolean {
  return (
    status?.stance === "planning" &&
    now - declaredAt >= PLANNING_NUDGE_AFTER_SECONDS
  );
}

// ---- discovery ----

/** What the person is filtering the directory by. Absent means "everything". */
export interface FundingFilter {
  stance?: FundingStance;
  seeking?: FundingSeeking;
}

export function matchesFunding(
  resolved: ResolvedFunding,
  filter: FundingFilter,
): boolean {
  if (filter.stance !== undefined && resolved.stance !== filter.stance) {
    return false;
  }
  if (
    filter.seeking !== undefined &&
    !resolved.seeking.includes(filter.seeking)
  ) {
    return false;
  }
  return true;
}

/** Counts per stance and per wanted role, for the chips' own labels. */
export interface FundingCounts {
  stance: Record<FundingStance, number>;
  seeking: Record<FundingSeeking, number>;
}

export function fundingCounts(
  items: readonly ResolvedFunding[],
): FundingCounts {
  const stance = Object.fromEntries(
    FUNDING_STANCES.map((s) => [s, 0]),
  ) as Record<FundingStance, number>;
  const seeking = Object.fromEntries(
    FUNDING_SEEKING.map((s) => [s, 0]),
  ) as Record<FundingSeeking, number>;
  for (const item of items) {
    stance[item.stance] += 1;
    for (const wanted of item.seeking) seeking[wanted] += 1;
  }
  return { stance, seeking };
}

/**
 * "Raising now" first by default: a stable partition on top of the person's
 * chosen ranking, so live raises lead the directory while each group keeps
 * that ranking inside it. Stable on purpose — the order the caller passed in
 * is preserved within both groups.
 */
export function raisingFirst<T>(
  items: readonly T[],
  fundingOf: (item: T) => ResolvedFunding,
): T[] {
  const raising: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    (fundingOf(item).stance === "raising" ? raising : rest).push(item);
  }
  return [...raising, ...rest];
}
