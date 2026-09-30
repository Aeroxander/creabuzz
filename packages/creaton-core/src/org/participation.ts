// Participation weight — how much of a project someone has earned, from the
// two things that actually build it: money committed and kept in, and work
// the project accepted.
//
// Nothing decays. Points only ever accumulate, so a person who stops
// contributing keeps what they earned while everyone still active keeps
// earning — their SHARE shrinks on its own. That is the whole "stay engaged"
// mechanism; no timers, no halving.
//
//   capital points = Σ amount × days the money stayed committed
//   work points    = Σ accepted contributions, each worth the amount the
//                    accepting reviewer saw (1 when the record names none)
//   weight         = blend × capital share + (1 − blend) × work share
//
// Staying compounds on the capital side (every day in adds points) and
// delivery compounds on the work side (every accepted piece adds points).
// When a project has only one kind of points — no raise yet, or no reviewed
// work yet — that side carries the whole weight.
//
// Accepted work follows the NIP-ORG review rule the relay and the royalty
// settlement use: per action (`d`), the claimant is the signer of the
// earliest record carrying an `amount` (else the earliest signer); only
// reviews by an authorized human other than the claimant, published at or
// after the filing, count; the newest such review decides (ties: lowest event
// id); and the amount paid is the one the accepting review copied, else the
// claimant's newest record at or before that review — an edit made after
// acceptance is never paid.
//
// Pure and alias-free so both apps and `node --test` share it.

/** Seconds per day; capital points are amount × days. */
const DAY_SECONDS = 86_400;

/**
 * Default share of the weight that comes from capital. Work counts a little
 * more than money unless a project decides otherwise ("owned by the people
 * who build it, not by passive capital").
 */
export const DEFAULT_CAPITAL_BLEND = 0.4;

/** Money someone committed to a project. */
export type CapitalCommitment = {
  /** Lowercase hex pubkey or wallet address of the backer. */
  who: string;
  /** Amount committed, in one fixed unit per project (e.g. USD cents). */
  amount: number;
  /** When it was committed, unix seconds. */
  from: number;
  /** When it left (exit, refund, sale), unix seconds; absent = still in. */
  until?: number | null;
};

/** One contribution the project accepted. */
export type AcceptedWork = {
  /** Lowercase hex pubkey of the contributor. */
  who: string;
  /** Points for this piece of work (the reviewed amount, or 1). */
  points: number;
  /** When the accepting review was published, unix seconds. */
  acceptedAt: number;
  /** The action id (`d` tag) the points came from. */
  action: string;
};

/** One person's standing in a project. */
export type ParticipationRow = {
  who: string;
  /** amount × days committed, summed. */
  capitalPoints: number;
  /** Accepted work points, summed. */
  workPoints: number;
  /** This person's fraction of all capital points (0–1). */
  capitalShare: number;
  /** This person's fraction of all work points (0–1). */
  workShare: number;
  /** Blended participation weight (0–1); all rows sum to 1. */
  weight: number;
};

function finitePositive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

/** amount × days the money stayed in, as of `now`. */
export function capitalPoints(c: CapitalCommitment, now: number): number {
  const amount = finitePositive(c.amount);
  const end = Math.min(now, c.until ?? now);
  const seconds = end - c.from;
  if (amount === 0 || !Number.isFinite(seconds) || seconds <= 0) return 0;
  return (amount * seconds) / DAY_SECONDS;
}

/**
 * Participation weights for everyone with capital or accepted work.
 * `capitalBlend` is clamped to [0, 1]; rows are ordered by weight (highest
 * first), then by `who` for a stable order.
 */
export function participationWeights(input: {
  capital: readonly CapitalCommitment[];
  work: readonly AcceptedWork[];
  now: number;
  capitalBlend?: number;
}): ParticipationRow[] {
  const blendInput = input.capitalBlend ?? DEFAULT_CAPITAL_BLEND;
  const blend = Number.isFinite(blendInput)
    ? Math.min(1, Math.max(0, blendInput))
    : DEFAULT_CAPITAL_BLEND;

  const capitalBy = new Map<string, number>();
  for (const c of input.capital) {
    const points = capitalPoints(c, input.now);
    if (points <= 0) continue;
    const who = c.who.toLowerCase();
    capitalBy.set(who, (capitalBy.get(who) ?? 0) + points);
  }
  const workBy = new Map<string, number>();
  for (const w of input.work) {
    const points = finitePositive(w.points);
    if (points === 0) continue;
    const who = w.who.toLowerCase();
    workBy.set(who, (workBy.get(who) ?? 0) + points);
  }

  const capitalTotal = [...capitalBy.values()].reduce((a, b) => a + b, 0);
  const workTotal = [...workBy.values()].reduce((a, b) => a + b, 0);
  // A side with no points cannot carry weight: the other side takes it all.
  const capitalPart = capitalTotal === 0 ? 0 : workTotal === 0 ? 1 : blend;
  const workPart = workTotal === 0 ? 0 : 1 - capitalPart;

  const people = new Set([...capitalBy.keys(), ...workBy.keys()]);
  const rows: ParticipationRow[] = [];
  for (const who of people) {
    const capital = capitalBy.get(who) ?? 0;
    const work = workBy.get(who) ?? 0;
    const capitalShare = capitalTotal === 0 ? 0 : capital / capitalTotal;
    const workShare = workTotal === 0 ? 0 : work / workTotal;
    rows.push({
      who,
      capitalPoints: capital,
      workPoints: work,
      capitalShare,
      workShare,
      weight: capitalPart * capitalShare + workPart * workShare,
    });
  }
  return rows.sort((a, b) =>
    b.weight !== a.weight ? b.weight - a.weight : a.who < b.who ? -1 : 1,
  );
}

/** A kind:37013 contribution record as read from the relay. */
export type ContributionEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  tags: readonly (readonly string[])[];
  content: string;
};

type ParsedRecord = {
  id: string;
  signer: string;
  at: number;
  status: string | null;
  amount: number | null;
};

function parseRecord(event: ContributionEvent): [string, ParsedRecord] | null {
  const d = event.tags.find((t) => t[0] === "d")?.[1];
  if (typeof d !== "string" || d === "") return null;
  let body: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(event.content);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      body = value as Record<string, unknown>;
    }
  } catch {
    // Unreadable content: the record still marks the action, with no fields.
  }
  const amount =
    typeof body.amount === "number"
      ? body.amount
      : typeof body.amount === "string" && /^\d+$/.test(body.amount)
        ? Number(body.amount)
        : null;
  return [
    d,
    {
      id: event.id.toLowerCase(),
      signer: event.pubkey.toLowerCase(),
      at: event.created_at,
      status: typeof body.reviewStatus === "string" ? body.reviewStatus : null,
      amount: amount !== null && Number.isFinite(amount) ? amount : null,
    },
  ];
}

/**
 * Accepted contributions, one entry per accepted action, under the NIP-ORG
 * review rule (see the module header). `isReviewer(pubkey)` answers whether a
 * key holds human review authority in the project (never a seated agent).
 */
export function acceptedWork(
  records: readonly ContributionEvent[],
  isReviewer: (pubkey: string) => boolean,
): AcceptedWork[] {
  const byAction = new Map<string, ParsedRecord[]>();
  for (const event of records) {
    const parsed = parseRecord(event);
    if (!parsed) continue;
    const [d, record] = parsed;
    const list = byAction.get(d);
    if (list) list.push(record);
    else byAction.set(d, [record]);
  }

  const out: AcceptedWork[] = [];
  const reviewerCache = new Map<string, boolean>();
  const canReview = (pubkey: string) => {
    let known = reviewerCache.get(pubkey);
    if (known === undefined) {
      known = isReviewer(pubkey);
      reviewerCache.set(pubkey, known);
    }
    return known;
  };

  for (const [action, rows] of [...byAction.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    rows.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    const claimant = (rows.find((r) => r.amount !== null) ?? rows[0]).signer;
    const filedAt = Math.min(
      ...rows.filter((r) => r.signer === claimant).map((r) => r.at),
    );

    let review: ParsedRecord | null = null;
    for (const row of rows) {
      if (row.signer === claimant || row.at < filedAt) continue;
      if (!canReview(row.signer)) continue;
      if (
        !review ||
        row.at > review.at ||
        (row.at === review.at && row.id < review.id)
      ) {
        review = row;
      }
    }
    if (review?.status !== "accepted") continue;

    const reviewedAt = review.at;
    const asReviewed = rows
      .filter((r) => r.signer === claimant && r.at <= reviewedAt)
      .at(-1);
    const points =
      positiveOrNull(review.amount) ?? positiveOrNull(asReviewed?.amount) ?? 1;
    out.push({ who: claimant, points, acceptedAt: review.at, action });
  }
  return out;
}
