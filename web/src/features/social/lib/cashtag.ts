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

/** The label a screen reader hears for a resolved cashtag. */
export function cashtagLabel(symbol: string, launch: CashtagLaunch): string {
  return `$${symbol}: ${launch.record.name}, ${stageWords(launch.record.stage)}`;
}
