/**
 * Backing in Home's feed: what happened in the backing pools of the projects in view, as short cards below the project's
 * own records. Home is the one place a price line may appear (a project's page shows none), and even here these cards are
 * the quiet part of the feed: one compact line each, never above an update or a promise.
 *
 * Trust: an item comes only from the logs of a pool that `BackingPoolFactory.poolOf` names for a project's own DAO, where a
 * kit's launch event confirms the project was made here (`use-backing-feed.ts`). Whoever else emits events is not a source.
 * An event whose block has no date (only the newest few are dated, to keep the read bounded) is left out rather than given
 * a guessed time.
 *
 * Pure and alias-free: `backing-feed.test.mjs` drives it under `node --test`.
 */

import {
  type PoolEvent,
  priceMovePercent,
  type QuoteFacts,
} from "@creaton/core/launchpad/backing.ts";

import {
  money,
  unitsPhrase,
  whenWords,
} from "../../launchpad/lib/backing-copy.ts";

/** What the feed needs of one project's pool, as read. */
export interface BackingFeedPool {
  /** The project's coordinate, as the rest of the feed names it. */
  coordinate: string;
  pool: string;
  quote: QuoteFacts;
  /** The pool's events, newest first. */
  events: readonly PoolEvent[];
  /** Seconds, by block, for the events that were dated. */
  times: ReadonlyMap<number, number>;
}

type BackingCard =
  | {
      kind: "backed";
      backers: number;
      paidIn: bigint;
      /** The curve's move across the day's buys, in percent; null with nothing before them to compare. */
      moved: number | null;
    }
  | { kind: "milestone-posted"; id: bigint; leaveBy: number }
  | { kind: "milestone-released"; id: bigint; amount: bigint; leavers: number }
  | { kind: "milestone-closed"; id: bigint; leavers: number }
  | { kind: "round-opened"; minimum: bigint }
  | { kind: "round-settled"; received: bigint; units: bigint }
  | { kind: "round-failed" }
  | { kind: "abandoned" };

export interface BackingFeedItem {
  /** Unique in the feed. */
  id: string;
  at: number;
  coordinate: string;
  pool: string;
  quote: QuoteFacts;
  card: BackingCard;
}

const DAY = 86_400;

const order = (e: PoolEvent) => e.block * 1_000_000 + e.logIndex;

/** The feed's backing items, newest first. `now` is in seconds: nothing is dated later than it. */
export function backingFeedItems(
  pools: readonly BackingFeedPool[],
  now: number,
): BackingFeedItem[] {
  const out: BackingFeedItem[] = [];
  for (const p of pools) {
    const dated = (e: PoolEvent) => {
      const t = p.times.get(e.block);
      return t === undefined ? null : Math.min(t, now);
    };
    const base = (id: string, at: number, card: BackingCard) =>
      out.push({
        id: `${p.pool}:${id}`,
        at,
        coordinate: p.coordinate,
        pool: p.pool,
        quote: p.quote,
        card,
      });
    // The last trade before an event, for what the price moved from.
    const oldestFirst = [...p.events].sort((a, b) => order(a) - order(b));
    const priceBefore = (first: PoolEvent): bigint | null => {
      let found: bigint | null = null;
      for (const e of oldestFirst) {
        if (order(e) >= order(first)) break;
        if (e.kind === "bought" || e.kind === "sold" || e.kind === "left")
          found = e.priceAfter;
      }
      return found;
    };
    const leaversOf = new Map<bigint, number>();
    for (const e of p.events)
      if (e.kind === "left")
        leaversOf.set(e.id, (leaversOf.get(e.id) ?? 0) + 1);

    // Buys are one card for each day, so a busy day is one line and not a page of them.
    const days = new Map<number, PoolEvent[]>();
    for (const e of oldestFirst) {
      const at = dated(e);
      if (at === null) continue;
      if (e.kind === "bought") {
        const day = Math.floor(at / DAY);
        days.set(day, [...(days.get(day) ?? []), e]);
      } else if (e.kind === "milestone-posted") {
        base(`posted:${e.id}`, at, {
          kind: "milestone-posted",
          id: e.id,
          leaveBy: e.windowEndsAt,
        });
      } else if (e.kind === "milestone-resolved") {
        const leavers = leaversOf.get(e.id) ?? 0;
        base(
          `resolved:${e.id}`,
          at,
          e.released
            ? {
                kind: "milestone-released",
                id: e.id,
                amount: e.amount,
                leavers,
              }
            : { kind: "milestone-closed", id: e.id, leavers },
        );
      } else if (e.kind === "round-opened") {
        base("round-opened", at, {
          kind: "round-opened",
          minimum: e.minimumRaise,
        });
      } else if (e.kind === "round-settled") {
        base("round-settled", at, {
          kind: "round-settled",
          received: e.received,
          units: e.unitsSold,
        });
      } else if (e.kind === "round-failed") {
        base("round-failed", at, { kind: "round-failed" });
      } else if (e.kind === "abandoned") {
        base("abandoned", at, { kind: "abandoned" });
      }
    }
    for (const [day, buys] of days) {
      const first = buys[0];
      const last = buys[buys.length - 1];
      const before = priceBefore(first);
      const at = dated(last);
      if (at === null) continue;
      base(`backed:${day}`, at, {
        kind: "backed",
        backers: new Set(buys.map((b) => (b.kind === "bought" ? b.buyer : "")))
          .size,
        paidIn: buys.reduce(
          (sum, b) => sum + (b.kind === "bought" ? b.quoteIn : 0n),
          0n,
        ),
        moved:
          before !== null && last.kind === "bought"
            ? priceMovePercent(before, last.priceAfter)
            : null,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** A card as one line of words, with the project's name in it. */
export function backingFeedLine(item: BackingFeedItem, name: string): string {
  const card = item.card;
  const { quote } = item;
  switch (card.kind) {
    case "backed": {
      const move =
        card.moved === null
          ? ""
          : card.moved === 0
            ? " · price held"
            : ` · price moved ${card.moved > 0 ? "up" : "down"} ${Math.abs(card.moved)}%`;
      return `Backed ${name}: ${plural(card.backers, "backer", "backers")} · ${money(card.paidIn, quote)} paid in${move}`;
    }
    case "milestone-posted":
      // A window end that was not read (0) is left out rather than shown as the year 1970.
      return card.leaveBy > 0
        ? `${name} posted a milestone. Backers can leave until ${whenWords(card.leaveBy)}.`
        : `${name} posted a milestone.`;
    case "milestone-released": {
      const left =
        card.leavers > 0
          ? ` after ${plural(card.leavers, "backer", "backers")} left`
          : "";
      return card.amount === 0n
        ? `Everyone left before milestone ${card.id} of ${name} was settled, so nothing was released.`
        : `${name} released ${money(card.amount, quote)} at milestone ${card.id}${left}.`;
    }
    case "milestone-closed":
      return `Milestone ${card.id} of ${name} was not settled in time, so nothing was released.`;
    case "round-opened":
      return `${name} opened its round. It needs ${money(card.minimum, quote)} for backing to open.`;
    case "round-settled":
      return `${name}'s round ended and backing opened, with ${money(card.received, quote)} raised and ${unitsPhrase(card.units)} handed out.`;
    case "round-failed":
      return `${name}'s round did not reach its minimum. Bidders take their money back.`;
    case "abandoned":
      return `${name} stopped releasing money, so backing has closed for good.`;
  }
}
