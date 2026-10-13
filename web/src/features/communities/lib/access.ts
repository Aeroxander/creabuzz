/**
 * Who may join a community, and the people in it, as data and as words.
 *
 * A community is either open (anyone with its address can come in) or invite-only (only people on its list can, and
 * they get on it with an invite link an owner or admin makes). The server decides; this file only reads what the server
 * says, builds the one record that changes it, and words the screens. Nothing here is a second opinion about who may do
 * what: an owner-only action is offered to an owner, and the server refuses everyone else regardless.
 *
 * Alias-free for `node --test`.
 */

export type Access = "open" | "invite_only";

/** The signed record that sets who may join. Only the owner's is accepted. */
export const KIND_SET_ACCESS = 9034;
/** The signed record that removes a person from the community's list. */
export const KIND_REMOVE_MEMBER = 9031;
/** The signed record that makes a member an admin, or an admin a member. Only the owner's is accepted. */
export const KIND_CHANGE_ROLE = 9032;
/** The server's list of a community's people and their roles. */
export const KIND_MEMBER_LIST = 13534;

/** The community's answer ("open" or "invite_only"), or null for anything else, including no answer. */
export function parseAccess(value: unknown): Access | null {
  return value === "open" || value === "invite_only" ? value : null;
}

/** The record that sets who may join. */
export function setAccessRecord(access: Access): {
  kind: number;
  content: string;
  tags: string[][];
} {
  return { kind: KIND_SET_ACCESS, content: "", tags: [["access", access]] };
}

export const ACCESS_CHOICES: readonly {
  value: Access;
  title: string;
  detail: string;
}[] = [
  {
    value: "invite_only",
    title: "Only people I invite",
    detail:
      "Nobody can come in or read anything without an invite link from you.",
  },
  {
    value: "open",
    title: "Anyone with the address",
    detail:
      "Anyone who has the address can look around and join. Good for a public community.",
  },
];

/** One short line about the current setting. */
export function accessSummary(access: Access): string {
  return access === "invite_only"
    ? "Only people with an invite link can join."
    : "Anyone with the address can join.";
}

/** What closing a community does to people already in it, said before it happens. */
export const CLOSING_WARNING =
  "People who are not on the list will be signed out right away. Members stay.";

export type Role = "owner" | "admin" | "member";

export interface Person {
  pubkey: string;
  role: Role;
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

/**
 * The people in the newest member list, owner first, then admins, then everyone else in the order the server wrote
 * them. A list without a valid entry gives an empty array; the page says nothing is known, not that nobody is here.
 *
 * Tags are `["member", <pubkey>, <role>]` or `["p", <pubkey>, <relay>, <role>]`.
 */
export function peopleFromEvents(
  events: readonly {
    kind: number;
    created_at: number;
    tags: readonly (readonly string[])[];
  }[],
): Person[] {
  let newest: (typeof events)[number] | null = null;
  for (const event of events) {
    if (event.kind !== KIND_MEMBER_LIST) continue;
    if (!newest || event.created_at > newest.created_at) newest = event;
  }
  if (!newest) return [];
  const seen = new Set<string>();
  const people: Person[] = [];
  for (const tag of newest.tags) {
    const [name, rawPubkey, second, third] = tag;
    if (name !== "member" && name !== "p") continue;
    const pubkey = (rawPubkey ?? "").trim().toLowerCase();
    if (!HEX_PUBKEY.test(pubkey) || seen.has(pubkey)) continue;
    seen.add(pubkey);
    const raw = name === "member" ? second : third;
    people.push({
      pubkey,
      role: raw === "owner" || raw === "admin" ? raw : "member",
    });
  }
  const rank: Record<Role, number> = { owner: 0, admin: 1, member: 2 };
  // `sort` is stable, so people with the same role keep the server's order.
  return people.sort((a, b) => rank[a.role] - rank[b.role]);
}

/** A person's role in the list, or null when they are not on it. */
export function roleOf(
  people: readonly Person[],
  pubkey: string | null,
): Role | null {
  if (!pubkey) return null;
  const want = pubkey.trim().toLowerCase();
  return people.find((person) => person.pubkey === want)?.role ?? null;
}

/** Owners and admins make invite links. */
export function mayInvite(role: Role | null): boolean {
  return role === "owner" || role === "admin";
}

/** Only the owner decides who may join. */
export function mayChangeAccess(role: Role | null): boolean {
  return role === "owner";
}

/** The record that removes `pubkey` from the community. They are signed out at once and need a new invite to return. */
export function removeMemberRecord(pubkey: string): {
  kind: number;
  content: string;
  tags: string[][];
} {
  return { kind: KIND_REMOVE_MEMBER, content: "", tags: [["p", pubkey]] };
}

/** The record that gives `pubkey` the role `role` (`admin` or `member`). */
export function changeRoleRecord(
  pubkey: string,
  role: "admin" | "member",
): { kind: number; content: string; tags: string[][] } {
  return {
    kind: KIND_CHANGE_ROLE,
    content: "",
    tags: [
      ["p", pubkey],
      ["role", role],
    ],
  };
}

/**
 * The role `me` is offered to give `person`, or null for none: only the owner changes roles, an admin can be made a
 * member and a member an admin, and nobody changes their own role or the owner's. The server decides again.
 */
export function roleOfferedFor(
  myRole: Role | null,
  me: string | null,
  person: Person,
): "admin" | "member" | null {
  if (myRole !== "owner" || !me) return null;
  if (person.pubkey === me.trim().toLowerCase() || person.role === "owner") {
    return null;
  }
  return person.role === "admin" ? "member" : "admin";
}

/**
 * Whether `me` is offered "Remove" for `person`. The owner can remove an admin or a member; an admin can remove a
 * member; nobody removes themselves or the owner. The server decides all of this again, and says so when it refuses.
 */
export function mayRemove(
  myRole: Role | null,
  me: string | null,
  person: Person,
): boolean {
  if (!me || person.pubkey === me.trim().toLowerCase()) return false;
  if (person.role === "owner") return false;
  if (myRole === "owner") return true;
  return myRole === "admin" && person.role === "member";
}

export const DAY = 24 * 60 * 60;

export const INVITE_LIFETIMES: readonly {
  id: string;
  label: string;
  secs: number;
}[] = [
  { id: "day", label: "1 day", secs: DAY },
  { id: "week", label: "1 week", secs: 7 * DAY },
  { id: "month", label: "30 days", secs: 30 * DAY },
];

export const INVITE_USES: readonly {
  id: string;
  label: string;
  uses: number | null;
}[] = [
  { id: "one", label: "One person", uses: 1 },
  { id: "ten", label: "Up to 10 people", uses: 10 },
  { id: "any", label: "Anyone who has it", uses: null },
];

/** The body of the request that makes an invite link. */
export function inviteRequestBody(
  secs: number,
  uses: number | null,
): { ttl_secs: number; max_uses?: number } {
  return uses === null
    ? { ttl_secs: secs }
    : { ttl_secs: secs, max_uses: uses };
}

export interface MintedInvite {
  /** The link to share. */
  url: string;
  /** Unix seconds it stops working. */
  expiresAt: number;
  /** How many people can use it, or null for no limit. */
  maxUses: number | null;
}

/** The server's answer to a new invite, or null when it is not what was promised. */
export function parseMintedInvite(json: unknown): MintedInvite | null {
  if (json === null || typeof json !== "object") return null;
  const body = json as {
    url?: unknown;
    expires_at?: unknown;
    max_uses?: unknown;
  };
  if (typeof body.url !== "string" || body.url === "") return null;
  if (typeof body.expires_at !== "number") return null;
  return {
    url: body.url,
    expiresAt: body.expires_at,
    maxUses: typeof body.max_uses === "number" ? body.max_uses : null,
  };
}

/** What a new link allows, in a sentence. */
export function describeInvite(invite: MintedInvite, nowSecs: number): string {
  const left = invite.expiresAt - nowSecs;
  const lasts = timeLeft(left);
  const who =
    invite.maxUses === null
      ? "anyone who has it"
      : invite.maxUses === 1
        ? "one person"
        : `up to ${invite.maxUses} people`;
  return `Works for ${lasts}, for ${who}.`;
}

/** An invite that can still be used, as the server lists it. The link itself is never shown again. */
export interface ActiveInvite {
  id: string;
  /** Who made it. */
  madeBy: string;
  /** Unix seconds it stops working. */
  expiresAt: number;
  /** How many people can use it, or null for no limit. */
  maxUses: number | null;
  /** How many have. */
  used: number;
}

/** The server's list of invites, or an empty list for anything that is not one. Entries that are not whole are left out. */
export function parseInvites(json: unknown): ActiveInvite[] {
  if (json === null || typeof json !== "object") return [];
  const list = (json as { invites?: unknown }).invites;
  if (!Array.isArray(list)) return [];
  const invites: ActiveInvite[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id === "") continue;
    if (typeof e.created_by !== "string") continue;
    if (typeof e.expires_at !== "number") continue;
    invites.push({
      id: e.id,
      madeBy: e.created_by,
      expiresAt: e.expires_at,
      maxUses: typeof e.max_uses === "number" ? e.max_uses : null,
      used: typeof e.use_count === "number" ? e.use_count : 0,
    });
  }
  return invites;
}

/** How long is left, in the words the page uses everywhere. */
function timeLeft(secs: number): string {
  if (secs < 2 * 60 * 60) return "less than 2 hours";
  if (secs < DAY) return `${Math.round(secs / 3600)} hours`;
  const days = Math.round(secs / DAY);
  return days === 1 ? "1 day" : `${days} days`;
}

/** One line about an invite: how much it has been used and how long it has left. */
export function describeActiveInvite(
  invite: ActiveInvite,
  nowSecs: number,
): string {
  const used =
    invite.maxUses === null
      ? `${invite.used} used`
      : `${invite.used} of ${invite.maxUses} used`;
  return `${used} · ends in ${timeLeft(invite.expiresAt - nowSecs)}`;
}

/** Whether a failed sign-in to a community looks like "you are not on its list" rather than a broken connection. */
export function looksLikeNotAMember(message: string): boolean {
  return /not a (relay |community )?member|membership/i.test(message);
}
