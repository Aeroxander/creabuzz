/**
 * Who is banned from a community, and how a ban is asked for, as pure functions.
 *
 * A ban keeps a person out of everything the community's server holds, whether or not they have an invite, and the
 * server tells them why. It is not the same as removing someone from the list: in an open community a removed person
 * can simply come back, a banned one cannot. The ban itself (the record a moderator signs) is built in
 * `moderation/lib/moderationEvents`; this is the community-facing part: the lengths on offer, the server's list read
 * safely, and the words used for each ban.
 *
 * Alias-free; `bans.test.mjs` drives it under `node --test`.
 */

/** How long a ban lasts. `secs: null` is for good. */
export interface BanLength {
  label: string;
  secs: number | null;
}

export const BAN_LENGTHS: readonly BanLength[] = [
  { label: "For good", secs: null },
  { label: "1 day", secs: 86_400 },
  { label: "7 days", secs: 604_800 },
  { label: "30 days", secs: 2_592_000 },
];

/** The unix time a ban of this length ends, or `undefined` for a ban that does not end. */
export function banExpiry(
  now: number,
  secs: number | null,
): number | undefined {
  return secs === null ? undefined : now + secs;
}

/** One current ban, as the server lists it. */
export interface Ban {
  pubkey: string;
  /** Why, in the words the moderator gave. Empty when none were given. */
  reason: string;
  /** Unix seconds the ban ends, or `null` for a ban that does not end. */
  until: number | null;
  /** Who banned them. */
  by: string;
}

const HEX_64 = /^[0-9a-f]{64}$/i;

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A server timestamp (RFC 3339) as unix seconds, or `null` when absent or unreadable. */
function seconds(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * The bans in the server's list of restricted people. Time-outs are in the same list and are left out (`parseTimeouts`
 * reads them); so is anyone whose ban has already ended, and any row without a whole key. Anything that is not a list
 * gives no bans, never a guess.
 */
export function parseBans(json: unknown, now: number): Ban[] {
  if (!Array.isArray(json)) return [];
  const bans: Ban[] = [];
  for (const row of json) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const pubkey = asText(record.pubkey).toLowerCase();
    if (!HEX_64.test(pubkey) || record.banned !== true) continue;
    const until = seconds(record.ban_expires_at);
    if (until !== null && until <= now) continue;
    bans.push({
      pubkey,
      reason: asText(record.ban_reason).trim(),
      until,
      by: asText(record.actor_pubkey).toLowerCase(),
    });
  }
  return bans;
}

/**
 * Days left, for a time a day or more away: rounded, so a seven-day ban made a moment ago says seven, not six. Under a
 * day (with a minute's slack for that same rounding) it is 0, and the time is said in hours, so 13 hours never reads as
 * a day.
 */
function wholeDaysLeft(left: number): number {
  return left >= 86_400 - 60 ? Math.round(left / 86_400) : 0;
}

/** How long a ban has left, in plain words. */
export function describeBan(ban: Ban, now: number): string {
  if (ban.until === null) return "Banned for good";
  const left = ban.until - now;
  const days = wholeDaysLeft(left);
  if (days >= 1)
    return `Banned for ${days} more ${days === 1 ? "day" : "days"}`;
  const hours = Math.max(1, Math.ceil(left / 3600));
  return `Banned for ${hours} more ${hours === 1 ? "hour" : "hours"}`;
}

/**
 * One current community-wide mute (the server's "timeout"): they can read but not write anywhere in the community until
 * it ends. A moderator puts one in place from a report; this is how it is listed and ended early.
 */
export interface Timeout {
  pubkey: string;
  /** Why, in the words the moderator gave. Empty when none were given. */
  reason: string;
  /** Unix seconds the mute ends. */
  until: number;
  /**
   * Who last changed this person's restrictions: the server keeps one name for a ban and a mute together, so for
   * someone also banned it can be whoever banned them.
   */
  by: string;
}

/**
 * The people muted everywhere in the server's list of restricted people: a row whose mute ends later than `now`. A
 * banned person can be muted as well and is then in both lists. Anything that is not a list gives none.
 */
export function parseTimeouts(json: unknown, now: number): Timeout[] {
  if (!Array.isArray(json)) return [];
  const timeouts: Timeout[] = [];
  for (const row of json) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const pubkey = asText(record.pubkey).toLowerCase();
    if (!HEX_64.test(pubkey)) continue;
    const until = seconds(record.muted_until);
    if (until === null || until <= now) continue;
    timeouts.push({
      pubkey,
      reason: asText(record.mute_reason).trim(),
      until,
      by: asText(record.actor_pubkey).toLowerCase(),
    });
  }
  return timeouts;
}

/** How long a mute has left, in plain words. */
export function describeTimeout(timeout: Timeout, now: number): string {
  const left = timeout.until - now;
  const days = wholeDaysLeft(left);
  if (days >= 1) return `Muted for ${days} more ${days === 1 ? "day" : "days"}`;
  const hours = Math.ceil(left / 3600);
  if (hours >= 2) return `Muted for ${hours} more hours`;
  const minutes = Math.max(1, Math.ceil(left / 60));
  return `Muted for ${minutes} more ${minutes === 1 ? "minute" : "minutes"}`;
}
