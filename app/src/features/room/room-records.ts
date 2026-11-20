/**
 * The records the room's tools write and read besides posts (plan section 4.4): a report, the team's removal of a post, the
 * team's stop on a person writing, and the reading of those stops. Pure. The server checks each of these against its own
 * rules (`docs/next-version/ROOM-AND-SEASON-RECORDS.md`, section 4); the shapes here are exactly what it accepts.
 */
import {
  KIND_LAUNCH_UPDATE,
  KIND_NIP29_DELETE_EVENT,
  KIND_REPORT,
} from "@creaton/core/kinds.ts";
import type { SignedEvent } from "../posts/use-posts";
import type { ReportChoice } from "./room-words";

const HEX64 = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
/** The most wallets a stop names, and the longest a stop may run (the server's bounds). */
export const MUTE_WALLETS_MAX = 8;
export const MUTE_DAYS_MAX = 30;

export interface Template {
  kind: number;
  tags: string[][];
  content: string;
  created_at?: number;
}

/** Tell the people who run the server about a post: it goes to their queue and nowhere else. */
export function reportRecord(post: SignedEvent, type: ReportChoice): Template {
  return {
    kind: KIND_REPORT,
    tags: [
      ["e", post.id, type],
      ["p", post.pubkey],
    ],
    content: "",
  };
}

/** The team takes a post out of its own room, saying why in public. The reason is at most 280 characters. */
export function removeRecord(postId: string, reason: string): Template {
  const why = reason.trim().slice(0, 280);
  const tags: string[][] = [["e", postId]];
  if (why) tags.push(["public_reason", why]);
  return { kind: KIND_NIP29_DELETE_EVENT, tags, content: "" };
}

/**
 * The team's stop on a person writing in the room until `until` (unix seconds), naming the wallets that account had linked so a
 * new account on the same wallet is stopped too. An `until` already past lifts the stop.
 */
export function muteRecord(input: {
  coordinate: string;
  person: string;
  wallets: readonly string[];
  until: number;
}): Template {
  const wallets = [...new Set(input.wallets.map((w) => w.toLowerCase()))]
    .filter((w) => ADDRESS.test(w))
    .slice(0, MUTE_WALLETS_MAX);
  return {
    kind: KIND_LAUNCH_UPDATE,
    tags: [
      ["a", input.coordinate],
      ["room-mute", input.person.toLowerCase()],
      ...wallets.map((w) => ["room-mute-wallet", w]),
      ["expiration", String(Math.floor(input.until))],
    ],
    content: "{}",
  };
}

/** A stop that is in force, as the team's record states it. */
export interface RoomMute {
  person: string;
  wallets: string[];
  /** Unix seconds when it ends. */
  until: number;
}

const tagAll = (tags: readonly string[][], name: string) =>
  tags
    .filter((t) => t[0] === name && typeof t[1] === "string")
    .map((t) => t[1]);

/**
 * The stops in force at `now`: from records signed by the team only, the newest per person (so a later record that lifts a
 * stop wins over an earlier one), whatever else is stored.
 */
export function activeMutes(
  events: readonly SignedEvent[],
  team: ReadonlySet<string>,
  now: number,
): RoomMute[] {
  const newest = new Map<string, { event: SignedEvent; mute: RoomMute }>();
  for (const event of events) {
    if (!team.has(event.pubkey)) continue;
    const person = tagAll(event.tags, "room-mute")[0]?.toLowerCase();
    if (!person || !HEX64.test(person)) continue;
    const until = Number(tagAll(event.tags, "expiration")[0]);
    if (!Number.isSafeInteger(until)) continue;
    const mute: RoomMute = {
      person,
      wallets: tagAll(event.tags, "room-mute-wallet")
        .map((w) => w.toLowerCase())
        .filter((w) => ADDRESS.test(w))
        .slice(0, MUTE_WALLETS_MAX),
      until,
    };
    const was = newest.get(person);
    if (
      !was ||
      event.created_at > was.event.created_at ||
      (event.created_at === was.event.created_at && event.id > was.event.id)
    )
      newest.set(person, { event, mute });
  }
  return [...newest.values()].map((v) => v.mute).filter((m) => m.until > now);
}

/** When a stop on this account (or on a wallet it uses) ends, or null when none is in force. */
export function mutedUntil(
  mutes: readonly RoomMute[],
  me: string,
  myWallets: readonly string[],
): number | null {
  const mine = new Set(myWallets.map((w) => w.toLowerCase()));
  let until: number | null = null;
  for (const m of mutes) {
    if (m.person === me || m.wallets.some((w) => mine.has(w)))
      until = Math.max(until ?? 0, m.until);
  }
  return until;
}

/**
 * The wallets an account has linked (its link records, kind 37017): the newest record per address that is not revoked, at most
 * eight. What the team names in a stop; the server reads the same records the same way.
 */
export function linkedAddresses(
  events: readonly SignedEvent[],
  person: string,
): string[] {
  const newest = new Map<string, SignedEvent>();
  for (const event of events) {
    if (event.pubkey !== person) continue;
    const d = tagAll(event.tags, "d")[0]?.toLowerCase();
    if (!d || !ADDRESS.test(d)) continue;
    const was = newest.get(d);
    if (!was || event.created_at > was.created_at) newest.set(d, event);
  }
  const out: string[] = [];
  for (const [address, event] of newest) {
    try {
      const body = JSON.parse(event.content) as { revoked?: unknown };
      if (body.revoked === true) continue;
    } catch {
      continue;
    }
    out.push(address);
  }
  return out.slice(0, MUTE_WALLETS_MAX);
}
