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
 * team, and the team's own "offers" are not offers. A person takes an offer back by deleting their records, and the
 * team reopens a request by deleting its "Help found" marks.
 *
 * These records are read for one project at a time (`use-help-requests.ts`), never from the list of every project,
 * which is cut at a fixed number of records and would silently drop offers on a busy server.
 *
 * Pure and alias-free: `help-request.test.mjs` drives it under `node --test`.
 */

import {
  type AgentClaim,
  type AgentMark,
  agentClaim,
  verifiedAgent,
} from "./agent-label.ts";
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
  /**
   * Set when the record says an agent signed it (`agent-label.ts`). Not checked here: every record read passes through
   * this, so the owner's proof is checked only for the offers a card shows.
   */
  agent: AgentClaim | null;
}

/** The kind every help record is: an update record. */
const KIND_UPDATE = 47003;

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
    agent: agentClaim(event),
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
  /** Set when an agent made the offer. */
  agent: AgentMark | null;
  /** The team's replies, oldest first. */
  replies: OfferReply[];
}

export interface HelpRequestView {
  updateId: string;
  ask: HelpAsk;
  /** False while a "Help found" mark from the team stands. */
  open: boolean;
  foundAt: number | null;
  /** Who on the team marked it found (each once), for "marked found by". */
  foundBy: string[];
  /** The viewer's own "Help found" marks: deleting all of them is how the viewer reopens the request. */
  myFoundIds: string[];
  /** Newest first, at most {@link OFFERS_SHOWN}. */
  offers: Offer[];
  /** Every offer, including the ones not listed. */
  offerCount: number;
  /** The viewer's own offer (their newest), if they made one and did not take it back. */
  mine: Offer | null;
  /**
   * Every offer record the viewer has on this update, the one shown and any older ones (a send retried after the
   * server had already taken it, or sent from two tabs). Taking the offer back deletes all of them, or an older one
   * would come back in its place.
   */
  myOfferIds: string[];
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
  const foundBy = new Set<string>();
  const myFoundIds: string[] = [];
  for (const s of signals) {
    if (s.kind !== "found" || s.target !== update.id || !team.has(s.author))
      continue;
    if (foundAt === null || s.at < foundAt) foundAt = s.at;
    foundBy.add(s.author);
    if (s.author === viewer) myFoundIds.push(s.id);
  }

  // One offer per person: their newest. The team asked, so its own records are not offers. An offer dated after the
  // request was closed came too late to be one.
  const byAuthor = new Map<string, HelpSignal>();
  const myOfferIds: string[] = [];
  for (const s of signals) {
    if (s.kind !== "offer" || s.target !== update.id || team.has(s.author))
      continue;
    // Every record of the viewer's, late or not: taking an offer back must leave none behind.
    if (s.author === viewer) myOfferIds.push(s.id);
    if (foundAt !== null && s.at > foundAt) continue;
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
  const all: Array<Offer & { claim: AgentClaim | null }> = [
    ...byAuthor.values(),
  ]
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    .map((s) => ({
      id: s.id,
      author: s.author,
      at: s.at,
      note: s.note,
      agent: null as AgentMark | null,
      claim: s.agent,
      replies: (replies.get(s.id) ?? [])
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
        .slice(-REPLIES_SHOWN),
    }));

  return {
    updateId: update.id,
    ask: update.help,
    open: foundAt === null,
    foundAt,
    foundBy: [...foundBy],
    myFoundIds,
    // The owner's proof is checked for the offers listed and no others: at most one signature each.
    offers: all.slice(0, OFFERS_SHOWN).map(({ claim, ...offer }) => ({
      ...offer,
      agent: claim ? shownAgent(claim) : null,
    })),
    offerCount: all.length,
    mine: viewer
      ? (all
          .map(({ claim: _, ...offer }) => offer)
          .find((o) => o.author === viewer) ?? null)
      : null,
    myOfferIds,
    viewerOnTeam: viewer !== null && team.has(viewer),
  };
}

/** An agent's offer as the card labels it: with its owner when proven, and unlabelled when it never said "agent". */
function shownAgent(claim: AgentClaim): AgentMark | null {
  const mark = verifiedAgent(claim, KIND_UPDATE);
  // A record carrying only a proof that does not hold never called itself an agent: it gets no label.
  return mark.owner || claim.says ? mark : null;
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
}

/** The asking side of a project: its founder and the people on its record. */
export function teamOf(record: HelpLaunch["record"]): Set<string> {
  return new Set([record.author, ...record.team.map((m) => m.pubkey)]);
}

export interface OpenHelpRequest {
  project: HelpLaunch["record"];
  updateId: string;
  ask: HelpAsk;
  at: number;
}

/**
 * Requests that may still be open: each project's newest team update that asks for help, newest first, at most
 * `limit`. Whether each was since marked found is a second read ({@link stillOpen}).
 */
export function helpCandidates(
  launches: readonly HelpLaunch[],
  limit: number,
): OpenHelpRequest[] {
  const out: OpenHelpRequest[] = [];
  for (const launch of launches) {
    const team = teamOf(launch.record);
    // Updates are kept newest first, so the first that asks is the project's newest request.
    const asking = launch.updates.find((u) => u.help && team.has(u.author));
    if (asking?.help)
      out.push({
        project: launch.record,
        updateId: asking.id,
        ask: asking.help,
        at: asking.createdAt,
      });
  }
  return out
    .sort((a, b) => b.at - a.at || (a.updateId < b.updateId ? -1 : 1))
    .slice(0, limit);
}

/** The candidates no team member has marked found, in the same order, at most `limit`. */
export function stillOpen(
  candidates: readonly OpenHelpRequest[],
  signals: readonly HelpSignal[],
  limit: number,
): OpenHelpRequest[] {
  return candidates
    .filter((candidate) => {
      const team = teamOf(candidate.project);
      return !signals.some(
        (s) =>
          s.kind === "found" &&
          s.target === candidate.updateId &&
          team.has(s.author),
      );
    })
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
 * What to tell `viewer`, from the help records that name them: someone offered to help on an update they wrote, or a
 * project's team replied to an offer they made. `mine` are the viewer's own offers, which say which update a reply is
 * about. People the viewer muted are left out before the list is cut to `limit`, so a muted person's offers never
 * push a real one off the end. Newest first.
 */
export function helpNotices(input: {
  /** Help records that name the viewer (`p`), with the project each names (`a`). */
  naming: ReadonlyArray<{ signal: HelpSignal; coordinate: string }>;
  /** The viewer's own offers. */
  mine: readonly HelpSignal[];
  launches: readonly HelpLaunch[];
  viewer: string;
  muted?: ReadonlySet<string>;
  limit?: number;
}): HelpNotice[] {
  const { naming, mine, launches, viewer, muted, limit = 20 } = input;
  const projects = new Map(
    launches.map((l) => [`37001:${l.record.author}:${l.record.id}`, l]),
  );
  const myOffers = new Map(mine.map((s) => [s.id, s]));
  const seen = new Set<string>();
  // One offer per person and update: their newest, as the card shows it.
  const newestOffer = new Map<string, HelpNotice>();
  const out: HelpNotice[] = [];
  for (const { signal, coordinate } of naming) {
    if (seen.has(signal.id) || signal.author === viewer) continue;
    seen.add(signal.id);
    if (muted?.has(signal.author.toLowerCase())) continue;
    const launch = projects.get(coordinate);
    if (!launch) continue;
    const team = teamOf(launch.record);
    const updateId =
      signal.kind === "offer"
        ? signal.target
        : signal.kind === "reply"
          ? myOffers.get(signal.target)?.target
          : undefined;
    if (!updateId) continue;
    // The update may be older than the newest records the project list holds: the notice still stands, without its
    // title. One that is held must be a request from the team.
    const update = launch.updates.find((u) => u.id === updateId);
    if (update && (!update.help || !team.has(update.author))) continue;
    const notice: HelpNotice = {
      id: signal.id,
      kind: signal.kind === "offer" ? "offer" : "reply",
      actor: signal.author,
      at: signal.at,
      note: signal.note,
      project: launch.record,
      updateId,
      updateTitle: update?.title ?? "",
    };
    if (signal.kind === "offer") {
      // To the person who asked, from someone who is not on the asking side.
      if ((update && update.author !== viewer) || team.has(signal.author))
        continue;
      const key = `${updateId}:${signal.author}`;
      const prev = newestOffer.get(key);
      if (!prev || notice.at > prev.at) newestOffer.set(key, notice);
    } else if (signal.kind === "reply" && team.has(signal.author)) {
      out.push(notice);
    }
  }
  return [...out, ...newestOffer.values()]
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}
