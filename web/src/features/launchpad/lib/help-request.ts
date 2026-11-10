/**
 * Help requests: an update that asks for help, the offers people make, the founder's replies, and "Help found".
 *
 * An offer, a reply and "Help found" are each a small signed update record that names what it answers. They are public,
 * like the update they answer, and they promise nothing: an offer is a person saying "I can help", not an agreement,
 * and nothing here carries an amount of Shares or money.
 *
 *   offer       names the update (`e`), its author (`p`) and `help-offer`
 *   reply       names the offer (`e`), the person who offered (`p`) and `help-reply`
 *   Help found  names the update (`e`) and `help-found`
 *
 * Who may say what is decided here, when reading: only the project's team can mark a request found or reply as the
 * team, and the team's own "offers" are not offers. A person takes an offer back by deleting their record.
 *
 * Pure and alias-free: `help-request.test.mjs` drives it under `node --test`.
 */

import type { HelpAsk } from "./weekly-update.ts";

const TAG_OFFER = "help-offer";
const TAG_REPLY = "help-reply";
const TAG_FOUND = "help-found";

/** The longest note on an offer or a reply: one or two sentences. */
export const HELP_NOTE_MAX = 280;
/** How many offers a card lists. The count above the list is the full count. */
export const OFFERS_SHOWN = 20;
/** How many replies show under one offer. */
const REPLIES_SHOWN = 5;

const ID_RE = /^[0-9a-f]{64}$/;

type HelpSignalKind = "offer" | "reply" | "found";

/** One offer, reply or "Help found" record, as read. */
export interface HelpSignal {
  id: string;
  kind: HelpSignalKind;
  /** The update an offer or "Help found" answers; the offer a reply answers. */
  target: string;
  author: string;
  at: number;
  note: string;
}

interface EventLike {
  id: string;
  pubkey: string;
  created_at: number;
  tags: readonly (readonly string[])[];
  content: string;
}

const KIND_OF_TAG: Record<string, HelpSignalKind> = {
  [TAG_OFFER]: "offer",
  [TAG_REPLY]: "reply",
  [TAG_FOUND]: "found",
};

/** The help signal an update record is, or null when it is an ordinary update. */
export function parseHelpSignal(event: EventLike): HelpSignal | null {
  const marks = event.tags.filter((tag) => tag[0] in KIND_OF_TAG);
  // Exactly one mark: a record that claims to be two things is neither.
  if (marks.length !== 1) return null;
  const [name, target] = marks[0];
  if (typeof target !== "string" || !ID_RE.test(target)) return null;
  let note = "";
  try {
    const body: unknown = JSON.parse(event.content);
    if (body && typeof body === "object") {
      const text = (body as { body?: unknown }).body;
      if (typeof text === "string") note = text.trim().slice(0, HELP_NOTE_MAX);
    }
  } catch {
    // A note that cannot be read is an empty note; the signal itself is in the tags.
  }
  return {
    id: event.id,
    kind: KIND_OF_TAG[name],
    target,
    author: event.pubkey,
    at: event.created_at,
    note,
  };
}

/** Whether a record's tags mark it as a help signal (so it is never listed as an update). */
export function isHelpSignalTags(
  tags: readonly (readonly string[])[],
): boolean {
  return tags.some((tag) => tag[0] in KIND_OF_TAG);
}

interface SignalEvent {
  content: { title: string; body: string };
  tags: string[][];
}

/** "I can help": an offer on `update`, with an optional short note. */
export function offerEvent(input: {
  updateId: string;
  updateAuthor: string;
  note: string;
}): SignalEvent {
  return {
    content: {
      title: "Offer to help",
      body: input.note.trim().slice(0, HELP_NOTE_MAX),
    },
    tags: [
      ["e", input.updateId],
      ["p", input.updateAuthor],
      [TAG_OFFER, input.updateId],
    ],
  };
}

/** The team's reply to one offer. */
export function replyEvent(input: {
  offerId: string;
  offerAuthor: string;
  note: string;
}): SignalEvent {
  return {
    content: {
      title: "Reply to an offer to help",
      body: input.note.trim().slice(0, HELP_NOTE_MAX),
    },
    tags: [
      ["e", input.offerId],
      ["p", input.offerAuthor],
      [TAG_REPLY, input.offerId],
    ],
  };
}

/** "Help found": the request takes no new offers. */
export function foundEvent(input: { updateId: string }): SignalEvent {
  return {
    content: {
      title: "Help found",
      body: "The help this update asked for was found.",
    },
    tags: [
      ["e", input.updateId],
      [TAG_FOUND, input.updateId],
    ],
  };
}

interface OfferReply {
  id: string;
  author: string;
  at: number;
  note: string;
}

export interface Offer {
  id: string;
  author: string;
  at: number;
  note: string;
  /** The team's replies, oldest first. */
  replies: OfferReply[];
}

export interface HelpRequestView {
  updateId: string;
  ask: HelpAsk;
  /** False once the team marked it "Help found". */
  open: boolean;
  foundAt: number | null;
  /** Newest first, at most {@link OFFERS_SHOWN}. */
  offers: Offer[];
  /** Every offer, including the ones not listed. */
  offerCount: number;
  /** The viewer's own offer, if they made one and did not take it back. */
  mine: Offer | null;
  /** Whether the viewer is on the asking side (the project's team). */
  viewerOnTeam: boolean;
}

/**
 * What a help card shows for one update. Null when the update asks for nothing. `signals` are the project's help
 * records; ones about other updates are ignored.
 */
export function helpRequest(input: {
  update: { id: string; help?: HelpAsk | null };
  signals: readonly HelpSignal[];
  team: ReadonlySet<string>;
  viewer: string | null;
}): HelpRequestView | null {
  const { update, signals, team, viewer } = input;
  if (!update.help) return null;

  let foundAt: number | null = null;
  for (const s of signals) {
    if (s.kind !== "found" || s.target !== update.id || !team.has(s.author))
      continue;
    if (foundAt === null || s.at < foundAt) foundAt = s.at;
  }

  // One offer per person: their newest. The team asked, so its own records are not offers.
  const byAuthor = new Map<string, HelpSignal>();
  for (const s of signals) {
    if (s.kind !== "offer" || s.target !== update.id || team.has(s.author))
      continue;
    const prev = byAuthor.get(s.author);
    if (!prev || s.at > prev.at || (s.at === prev.at && s.id < prev.id))
      byAuthor.set(s.author, s);
  }
  const offerIds = new Set([...byAuthor.values()].map((s) => s.id));
  const replies = new Map<string, OfferReply[]>();
  for (const s of signals) {
    if (s.kind !== "reply" || !offerIds.has(s.target) || !team.has(s.author))
      continue;
    const list = replies.get(s.target) ?? [];
    list.push({ id: s.id, author: s.author, at: s.at, note: s.note });
    replies.set(s.target, list);
  }
  const all: Offer[] = [...byAuthor.values()]
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    .map((s) => ({
      id: s.id,
      author: s.author,
      at: s.at,
      note: s.note,
      replies: (replies.get(s.id) ?? [])
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
        .slice(-REPLIES_SHOWN),
    }));

  return {
    updateId: update.id,
    ask: update.help,
    open: foundAt === null,
    foundAt,
    offers: all.slice(0, OFFERS_SHOWN),
    offerCount: all.length,
    mine: viewer ? (all.find((o) => o.author === viewer) ?? null) : null,
    viewerOnTeam: viewer !== null && team.has(viewer),
  };
}

const DAY = 24 * 60 * 60;

/** "You offered to help 2 days ago." */
export function offeredLine(at: number, now: number): string {
  const n = Math.max(0, Math.floor((now - at) / DAY));
  if (n === 0) return "You offered to help today.";
  if (n === 1) return "You offered to help yesterday.";
  return `You offered to help ${n} days ago.`;
}

/** "3 people offered to help", or null when nobody has. */
export function offerCountLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 person offered to help"
    : `${count} people offered to help`;
}

interface HelpLaunch {
  record: {
    id: string;
    author: string;
    name: string;
    team: ReadonlyArray<{ pubkey: string }>;
  };
  updates: ReadonlyArray<{
    id: string;
    author: string;
    createdAt: number;
    title: string;
    help?: HelpAsk | null;
  }>;
  helpSignals?: readonly HelpSignal[];
}

function teamOf(launch: HelpLaunch): Set<string> {
  return new Set([
    launch.record.author,
    ...launch.record.team.map((m) => m.pubkey),
  ]);
}

export interface OpenHelpRequest {
  project: HelpLaunch["record"];
  updateId: string;
  ask: HelpAsk;
  at: number;
}

/**
 * Requests still open, newest first: each project's newest open one, from its team's updates. A short list for a side
 * panel, never a ranking.
 */
export function openHelpRequests(
  launches: readonly HelpLaunch[],
  limit: number,
): OpenHelpRequest[] {
  const out: OpenHelpRequest[] = [];
  for (const launch of launches) {
    const team = teamOf(launch);
    const found = new Set(
      (launch.helpSignals ?? [])
        .filter((s) => s.kind === "found" && team.has(s.author))
        .map((s) => s.target),
    );
    // Updates are kept newest first, so the first open one is the project's newest.
    const open = launch.updates.find(
      (u) => u.help && team.has(u.author) && !found.has(u.id),
    );
    if (open?.help)
      out.push({
        project: launch.record,
        updateId: open.id,
        ask: open.help,
        at: open.createdAt,
      });
  }
  return out
    .sort((a, b) => b.at - a.at || (a.updateId < b.updateId ? -1 : 1))
    .slice(0, limit);
}

export interface HelpNotice {
  id: string;
  kind: "offer" | "reply";
  actor: string;
  at: number;
  note: string;
  project: HelpLaunch["record"];
  updateId: string;
  updateTitle: string;
}

/**
 * What to tell `viewer`: someone offered to help on a project they are on the team of, or the team replied to an offer
 * they made. Newest first, at most `limit`.
 */
export function helpNotices(
  launches: readonly HelpLaunch[],
  viewer: string,
  limit = 20,
): HelpNotice[] {
  const out: HelpNotice[] = [];
  for (const launch of launches) {
    const signals = launch.helpSignals ?? [];
    if (signals.length === 0) continue;
    const team = teamOf(launch);
    const onTeam = team.has(viewer);
    for (const update of launch.updates) {
      if (!update.help || !team.has(update.author)) continue;
      const view = helpRequest({ update, signals, team, viewer });
      if (!view) continue;
      const base = {
        project: launch.record,
        updateId: update.id,
        updateTitle: update.title,
      };
      if (onTeam) {
        for (const offer of view.offers)
          out.push({
            ...base,
            id: offer.id,
            kind: "offer",
            actor: offer.author,
            at: offer.at,
            note: offer.note,
          });
      } else if (view.mine) {
        for (const reply of view.mine.replies)
          out.push({
            ...base,
            id: reply.id,
            kind: "reply",
            actor: reply.author,
            at: reply.at,
            note: reply.note,
          });
      }
    }
  }
  return out
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}
