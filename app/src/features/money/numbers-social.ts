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

function readWindow(raw: unknown, at: string): HeldWindow {
  const w = obj(raw, at);
  return {
    shares: amount(w.shares, `${at}.shares`),
    bps: whole(w.bps, `${at}.bps`, BPS),
  };
}

function readHeld(raw: unknown): HeldNumbers {
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

function readFeed(raw: unknown): FeedNumbers {
  const f = obj(raw, "feed");
  const roundTo = amount(f.roundTo, "feed.roundTo");
  const bucketSecs = time(f.bucketSecs, "feed.bucketSecs");
  if (roundTo === 0n || bucketSecs === 0) fail("feed");
  const hours = arr(f.hours, "feed.hours", HOURS_MAX).map((h, i) =>
    readHour(h, `feed.hours[${i}]`),
  );
  // Oldest first, one bucket apart: a feed that is out of order cannot be told as "the last hours".
  for (let i = 1; i < hours.length; i += 1)
    if (hours[i].at <= hours[i - 1].at) fail("feed.hours");
  return {
    roundTo,
    bucketSecs,
    hours,
    items: readItems(f.items),
    cut: count(f.cut, "feed.cut"),
  };
}

function readStreaks(raw: unknown): StreaksNumbers {
  const s = obj(raw, "streaks");
  const u = obj(s.updates, "streaks.updates");
  const weeks = whole(u.weeks, "streaks.updates.weeks", PEOPLE_MAX);
  const longest = whole(u.longest, "streaks.updates.longest", PEOPLE_MAX);
  if (weeks > longest) fail("streaks.updates.weeks");
  return {
    updates: {
      weeks,
      longest,
      lastAt: timeOrNull(u.lastAt, "streaks.updates.lastAt"),
    },
  };
}

function readEstablished(raw: unknown): EstablishedNumbers {
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
export function readSocial(body: Json): SocialKeys {
  const out: SocialKeys = {};
  if (!isObject(body)) return out;
  if ("held" in body) out.held = apart(body.held, readHeld);
  if ("feed" in body) out.feed = apart(body.feed, readFeed);
  if ("streaks" in body) out.streaks = apart(body.streaks, readStreaks);
  if ("established" in body)
    out.established = apart(body.established, readEstablished);
  return out;
}
