/**
 * The four step 3 keys of a record (`held`, `feed`, `streaks`, `established`; `docs/next-version/RECORD-V2.md` section 11),
 * read apart from the money: each is parsed on its own, and one that is wrong reads as null for that part only, so the
 * strict parser of the money never fails on a ranking, a feed or a badge. A key that is missing (an older server) is left
 * out of the result; null (the server could not work it out) and a key that cannot be believed are both null: "not known
 * here", never "none" and never zero. They are display only and unlock nothing.
 */
import {
  amount,
  arr,
  bool,
  count,
  fail,
  type Json,
  isObject,
  obj,
  oneOf,
  time,
  timeOrNull,
  whole,
} from "./numbers-strict";
import type {
  EstablishedNumbers,
  FeedHour,
  FeedItem,
  FeedItemKind,
  FeedNumbers,
  HeldNumbers,
  HeldWindow,
  StreaksNumbers,
} from "./numbers-types";

const ITEM_KINDS: readonly FeedItemKind[] = [
  "task_planned",
  "task_taken",
  "task_paid",
  "task_ended",
  "task_withdrawn",
  "update",
];
const BPS = 10_000;
/** The most hours and items a feed may carry here: the server's 48 and 30, so a hostile record cannot be big. */
const HOURS_MAX = 48;
const ITEMS_MAX = 30;
/** The most any count of people, joins or weeks may be (no real project is near it). */
const PEOPLE_MAX = 1_000_000;
/**
 * What the feed's amounts are rounded to: 100 dollars (6 decimals). The privacy of a small project rests on it, so a feed that
 * says another figure (an exact one) is not believed and is never drawn.
 */
const FEED_ROUND_TO = 100_000_000n;

/** What the parts of a record say that the four keys are checked against (all from the money part of the same record). */
export interface SocialContext {
  /** The time of the record's last block. */
  asOfTime: number;
  launchedAt: number;
  /** The project's time unit in seconds. */
  unit: number;
  /** The project's money now. */
  pot: bigint;
}

function readWindow(raw: unknown, at: string): HeldWindow {
  const w = obj(raw, at);
  return {
    shares: amount(w.shares, `${at}.shares`),
    bps: whole(w.bps, `${at}.bps`, BPS),
  };
}

function readHeld(raw: unknown, ctx: SocialContext): HeldNumbers {
  const h = obj(raw, "held");
  const windows = obj(h.windows, "held.windows");
  const rankSecs = time(windows.rankSecs, "held.windows.rankSecs");
  const badgeSecs = time(windows.badgeSecs, "held.windows.badgeSecs");
  if (rankSecs === 0 || badgeSecs === 0) fail("held.windows");
  const rank =
    h.rank === null
      ? null
      : (() => {
          const r = obj(h.rank, "held.rank");
          return {
            ...readWindow(r, "held.rank"),
            money: amount(r.money, "held.rank.money"),
            accounts: whole(r.accounts, "held.rank.accounts", PEOPLE_MAX),
          };
        })();
  const badge = h.badge === null ? null : readWindow(h.badge, "held.badge");
  const countedAccounts = whole(
    h.countedAccounts,
    "held.countedAccounts",
    PEOPLE_MAX,
  );
  // The people who held for a window are among the people who hold now.
  if (rank && rank.accounts > countedAccounts) fail("held.rank.accounts");
  // Money that stayed cannot be more than the project's money.
  if (rank && rank.money > ctx.pot) fail("held.rank.money");
  return { windows: { rankSecs, badgeSecs }, rank, badge, countedAccounts };
}

function readHour(raw: unknown, at: string): FeedHour {
  const h = obj(raw, at);
  const net = obj(h.net, `${at}.net`);
  const dir = oneOf(net.dir, ["in", "out", "even"], `${at}.net.dir`);
  const money = amount(net.amount, `${at}.net.amount`);
  // "Even" is exactly a net of nothing.
  if ((dir === "even") !== (money === 0n)) fail(`${at}.net`);
  return {
    at: time(h.at, `${at}.at`),
    joins: whole(h.joins, `${at}.joins`, PEOPLE_MAX),
    tookOut: whole(h.tookOut, `${at}.tookOut`, PEOPLE_MAX),
    net: { dir, amount: money },
  };
}

/** The items it knows; one of a kind this app has not heard of is skipped (never shown as something else). */
function readItems(raw: unknown): FeedItem[] {
  const out: FeedItem[] = [];
  arr(raw, "feed.items", ITEMS_MAX).forEach((entry, i) => {
    const at = `feed.items[${i}]`;
    const item = obj(entry, at);
    if (typeof item.kind !== "string") fail(`${at}.kind`);
    // A kind a newer server adds is skipped here; one of a kind this app knows is read in full or the feed is not believed.
    if (!(ITEM_KINDS as readonly string[]).includes(item.kind)) return;
    const kind = item.kind as FeedItemKind;
    const serial =
      item.serial === null ? null : count(item.serial, `${at}.serial`);
    // A task's row names the task; the update row names none.
    if ((kind === "update") !== (serial === null)) fail(`${at}.serial`);
    out.push({
      kind,
      at: time(item.at, `${at}.at`),
      serial,
      date: timeOrNull(item.date, `${at}.date`),
    });
  });
  return out;
}

function readFeed(raw: unknown, ctx: SocialContext): FeedNumbers {
  const f = obj(raw, "feed");
  const roundTo = amount(f.roundTo, "feed.roundTo");
  const bucketSecs = time(f.bucketSecs, "feed.bucketSecs");
  if (roundTo !== FEED_ROUND_TO || bucketSecs === 0) fail("feed");
  const hours = arr(f.hours, "feed.hours", HOURS_MAX).map((h, i) =>
    readHour(h, `feed.hours[${i}]`),
  );
  // Oldest first and exactly one bucket apart: a feed that is out of order or has gaps cannot be told as "the last hours".
  for (let i = 1; i < hours.length; i += 1)
    if (hours[i].at - hours[i - 1].at !== bucketSecs) fail("feed.hours");
  // The last hour is the one that holds the record's own time, so "the last two days" is the two days up to this record.
  const last = hours[hours.length - 1];
  if (last && !(last.at <= ctx.asOfTime && ctx.asOfTime < last.at + bucketSecs))
    fail("feed.hours");
  // Every amount is a whole multiple of the rounding: an exact figure is never drawn.
  for (const h of hours) if (h.net.amount % roundTo !== 0n) fail("feed.net");
  const items = readItems(f.items);
  // Newest first, and none from after the record's own time.
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].at > ctx.asOfTime + bucketSecs) fail("feed.items");
    if (i > 0 && items[i].at > items[i - 1].at) fail("feed.items");
  }
  return { roundTo, bucketSecs, hours, items, cut: count(f.cut, "feed.cut") };
}

function readStreaks(raw: unknown, ctx: SocialContext): StreaksNumbers {
  const s = obj(raw, "streaks");
  const u = obj(s.updates, "streaks.updates");
  const weeks = whole(u.weeks, "streaks.updates.weeks", PEOPLE_MAX);
  const longest = whole(u.longest, "streaks.updates.longest", PEOPLE_MAX);
  if (weeks > longest) fail("streaks.updates.weeks");
  // A run cannot be longer than the project has lived (the window that holds the record's time is still open: one more).
  const lived = Math.floor((ctx.asOfTime - ctx.launchedAt) / ctx.unit) + 1;
  if (!(ctx.unit > 0) || longest > lived) fail("streaks.updates.longest");
  return {
    updates: {
      weeks,
      longest,
      lastAt: timeOrNull(u.lastAt, "streaks.updates.lastAt"),
    },
  };
}

function readEstablished(
  raw: unknown,
  held: HeldNumbers | null | undefined,
): EstablishedNumbers {
  const e = obj(raw, "established");
  const rule = obj(e.rule, "established.rule");
  const minHeldBps = whole(rule.minHeldBps, "established.rule.minHeldBps", BPS);
  const heldSecs = time(rule.heldSecs, "established.rule.heldSecs");
  const minAccounts = whole(
    rule.minAccounts,
    "established.rule.minAccounts",
    PEOPLE_MAX,
  );
  const heldBps =
    e.heldBps === null ? null : whole(e.heldBps, "established.heldBps", BPS);
  const accounts =
    e.accounts === null
      ? null
      : whole(e.accounts, "established.accounts", PEOPLE_MAX);
  const twoSigners = bool(e.twoSigners, "established.twoSigners");
  const reached =
    e.reached === null ? null : bool(e.reached, "established.reached");
  // The verdict is the rule on its own inputs (the server checks it too): one that contradicts them is not believed.
  if (reached !== null) {
    const worked =
      heldBps !== null &&
      accounts !== null &&
      heldBps >= minHeldBps &&
      accounts >= minAccounts &&
      twoSigners;
    if (reached !== worked) fail("established.reached");
  }
  // The inputs are the record's own `held` (the server says so): a badge built on other figures is not believed.
  if (held) {
    if (held.badge && heldBps !== null && heldBps !== held.badge.bps)
      fail("established.heldBps");
    if (accounts !== null && accounts !== held.countedAccounts)
      fail("established.accounts");
  }
  return {
    rule: { minHeldBps, heldSecs, minAccounts },
    heldBps,
    accounts,
    twoSigners,
    reached,
  };
}

function apart<T>(raw: unknown, read: (value: unknown) => T): T | null {
  if (raw === null) return null;
  try {
    return read(raw);
  } catch {
    return null;
  }
}

export interface SocialKeys {
  held?: HeldNumbers | null;
  feed?: FeedNumbers | null;
  streaks?: StreaksNumbers | null;
  established?: EstablishedNumbers | null;
}

/**
 * The step 3 keys of a record body: a key that is missing is left out, one that is null or cannot be believed is null.
 * Never throws and never touches the money.
 */
export function readSocial(body: Json, ctx: SocialContext): SocialKeys {
  const out: SocialKeys = {};
  if (!isObject(body)) return out;
  if ("held" in body) out.held = apart(body.held, (v) => readHeld(v, ctx));
  if ("feed" in body) out.feed = apart(body.feed, (v) => readFeed(v, ctx));
  if ("streaks" in body)
    out.streaks = apart(body.streaks, (v) => readStreaks(v, ctx));
  if ("established" in body)
    out.established = apart(body.established, (v) =>
      readEstablished(v, out.held),
    );
  return out;
}
