/**
 * Which launch a `$TICKER` in a post names.
 *
 * The rule is the plan's (D5): the first launch to claim a ticker owns it, case-insensitively. "First" is the
 * earliest published record; a tie goes to the lower `author:id`, so every client resolves the same ticker to the same
 * launch. A ticker nobody has claimed resolves to nothing, and the post shows plain text: a cashtag is never
 * guessed at.
 *
 * Pure and alias-free: `cashtag.test.mjs` drives it under `node --test`.
 */

/** The part of a launch this needs; the app's `Launch` satisfies it. */
export interface CashtagLaunch {
  record: {
    id: string;
    author: string;
    name: string;
    createdAt: number;
    stage: string;
    tokenPlan: { symbol: string } | null;
  };
}

/** Plain words for where a launch is, for the chip's tooltip and screen-reader label. */
const STAGE_WORDS: Record<string, string> = {
  draft: "draft",
  review: "in review",
  live: "open for backers",
  funding: "raising now",
  graduated: "launched",
  failed: "did not raise",
};

export function stageWords(stage: string): string {
  return STAGE_WORDS[stage] ?? stage;
}

const identity = (l: CashtagLaunch) => `${l.record.author}:${l.record.id}`;

/** Every claimed ticker (upper-cased) and the launch that owns it. */
export function tickerOwners<L extends CashtagLaunch>(
  launches: readonly L[],
): Map<string, L> {
  const owners = new Map<string, L>();
  for (const launch of launches) {
    const symbol = launch.record.tokenPlan?.symbol.trim().toUpperCase();
    if (!symbol) continue;
    const held = owners.get(symbol);
    if (
      !held ||
      launch.record.createdAt < held.record.createdAt ||
      (launch.record.createdAt === held.record.createdAt &&
        identity(launch) < identity(held))
    ) {
      owners.set(symbol, launch);
    }
  }
  return owners;
}

/** A price the chip may show, and where it came from. */
export interface CashtagPrice {
  /** `bids`: the highest price recorded bids would pay. `floor`: the sale's starting price, when nobody has bid. */
  source: "bids" | "floor";
  latest: number;
  /** Oldest first; at most {@link SPARK_POINTS}. A single point draws no line. */
  points: number[];
}

/** How many bids a chip's trend line draws. */
export const SPARK_POINTS = 12;

/**
 * The price a chip shows for a launch, from what is actually recorded: the highest price each bid said it would pay
 * (newest last), or the sale's floor price when there are no bids. It is not a market trade and the chip says so.
 * Null when there is nothing honest to show. `toPrice` turns a stored Q96 price into whole currency per token.
 */
export function cashtagPrice(
  input: {
    bids: readonly { createdAt: number; maxPrice: string | null }[];
    floorPrice: string | null;
  },
  toPrice: (q96: string | null) => number | null,
): CashtagPrice | null {
  const points = [...input.bids]
    .sort((a, b) => a.createdAt - b.createdAt)
    .flatMap((bid) => {
      const price = toPrice(bid.maxPrice);
      return price === null ? [] : [price];
    })
    .slice(-SPARK_POINTS);
  const latest = points[points.length - 1];
  if (latest !== undefined) return { source: "bids", latest, points };
  const floor = toPrice(input.floorPrice);
  return floor === null
    ? null
    : { source: "floor", latest: floor, points: [floor] };
}

/** The label a screen reader hears for a resolved cashtag. */
export function cashtagLabel(
  symbol: string,
  launch: CashtagLaunch,
  price?: { price: CashtagPrice; unit: string; text: string } | null,
): string {
  const base = `$${symbol}: ${launch.record.name}, ${stageWords(launch.record.stage)}`;
  if (!price) return base;
  const what =
    price.price.source === "bids"
      ? "Highest recent bid price"
      : "Starting price of the sale";
  return `${base}. ${what} ${price.text} ${price.unit} per token, not a market trade`;
}
