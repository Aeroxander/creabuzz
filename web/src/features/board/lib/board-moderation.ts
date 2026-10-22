/**
 * Board moderation as the app sees it (D93): the commands a board's moderators, owners and admins send, the board's state
 * record (rules, pinned and locked threads, appointed moderators) and its public moderation log, both written by the
 * server.
 *
 * The server decides every command; what is here only chooses which controls to offer and how to say what happened.
 * Its standing order mirrors `moderation_authz.rs` (community owner, community admin, board owner, board admin, board
 * moderator, everyone else), and so do the guard rails: nobody acts against someone of equal or higher standing (the
 * community owner excepted), and an undo needs at least the standing of whoever did it.
 *
 * Alias-free; `board-moderation.test.mjs` drives it under `node --test`.
 */

import {
  asSentence,
  restrictionText,
  whenText,
} from "../../../shared/lib/refusal-text.ts";
import type { Draft } from "./board-events.ts";
import type { BoardEvent } from "./board-model.ts";

export const KIND_BOARD_LOCK_THREAD = 9045;
export const KIND_BOARD_UNLOCK_THREAD = 9046;
export const KIND_BOARD_PIN_THREAD = 9047;
export const KIND_BOARD_UNPIN_THREAD = 9048;
export const KIND_BOARD_MUTE = 9049;
export const KIND_BOARD_UNMUTE = 9050;
export const KIND_BOARD_SET_RULES = 9051;
export const KIND_BOARD_APPOINT_MODERATOR = 9052;
export const KIND_BOARD_REMOVE_MODERATOR = 9053;
/** The board's state, written by the server: rules, pinned and locked threads, moderators (`d` and `h` = the board). */
export const KIND_BOARD_STATE = 39008;
/** One entry of the board's public moderation log, written by the server (`h` = the board). */
export const KIND_BOARD_MODERATION_LOG = 45004;

/** The server's numbers, so the app offers only what it will accept. */
export const MODERATOR_MUTE_DAYS = 7;
export const BOARD_MUTE_MAX_DAYS = 30;
export const MODERATOR_TERM_DAYS = 90;
export const BOARD_PIN_LIMIT = 3;
export const BOARD_RULES_MAX_CHARS = 4000;
export const REASON_MAX_CHARS = 280;
/** How long a moderator's request for a longer mute waits for a second moderator. */
export const SECOND_MODERATOR_WINDOW_SECONDS = 24 * 3600;

const DAY = 86_400;

export type ThreadAction = "lock" | "unlock" | "pin" | "unpin";

const THREAD_KINDS: Record<ThreadAction, number> = {
  lock: KIND_BOARD_LOCK_THREAD,
  unlock: KIND_BOARD_UNLOCK_THREAD,
  pin: KIND_BOARD_PIN_THREAD,
  unpin: KIND_BOARD_UNPIN_THREAD,
};

function withReason(tags: string[][], reason: string | undefined): string[][] {
  const text = (reason ?? "").trim().slice(0, REASON_MAX_CHARS);
  return text === "" ? tags : [...tags, ["reason", text]];
}

/** Lock, unlock, pin or unpin a thread (`post` is its post id). */
export function threadDraft(input: {
  boardId: string;
  post: string;
  action: ThreadAction;
  reason?: string;
}): Draft {
  return {
    kind: THREAD_KINDS[input.action],
    tags: withReason(
      [
        ["h", input.boardId],
        ["e", input.post],
      ],
      input.reason,
    ),
    content: "",
  };
}

/** Mute someone on this board only, until `until` (unix seconds). */
export function muteDraft(input: {
  boardId: string;
  person: string;
  until: number;
  reason?: string;
}): Draft {
  return {
    kind: KIND_BOARD_MUTE,
    tags: withReason(
      [
        ["h", input.boardId],
        ["p", input.person],
        ["expiration", String(Math.floor(input.until))],
      ],
      input.reason,
    ),
    content: "",
  };
}

export function unmuteDraft(input: {
  boardId: string;
  person: string;
  reason?: string;
}): Draft {
  return {
    kind: KIND_BOARD_UNMUTE,
    tags: withReason(
      [
        ["h", input.boardId],
        ["p", input.person],
      ],
      input.reason,
    ),
    content: "",
  };
}

/** Set the board's rules; empty text clears them. */
export function rulesDraft(input: { boardId: string; rules: string }): Draft {
  const rules = input.rules.trim();
  if (rules.length > BOARD_RULES_MAX_CHARS)
    throw new Error(
      `Rules can be at most ${BOARD_RULES_MAX_CHARS} characters.`,
    );
  return {
    kind: KIND_BOARD_SET_RULES,
    tags: [["h", input.boardId]],
    content: rules,
  };
}

/** Appoint a moderator of this board until `until` (unix seconds), or for the longest term when left out. */
export function appointDraft(input: {
  boardId: string;
  person: string;
  until?: number;
}): Draft {
  const tags = [
    ["h", input.boardId],
    ["p", input.person],
  ];
  if (input.until !== undefined)
    tags.push(["expiration", String(Math.floor(input.until))]);
  return { kind: KIND_BOARD_APPOINT_MODERATOR, tags, content: "" };
}

/** End a moderator's appointment; sent by the moderator themself, it is stepping down. */
export function dismissDraft(input: {
  boardId: string;
  person: string;
}): Draft {
  return {
    kind: KIND_BOARD_REMOVE_MODERATOR,
    tags: [
      ["h", input.boardId],
      ["p", input.person],
    ],
    content: "",
  };
}

export interface BoardState {
  rules: string;
  /** Pinned threads, newest pin first. */
  pinned: string[];
  /** Locked threads (the newest 500; the server enforces older locks too). */
  locked: ReadonlySet<string>;
  /** Who pinned each pinned thread, when the server said. */
  pinnedBy: ReadonlyMap<string, string>;
  /** Who locked each locked thread, when the server said. */
  lockedBy: ReadonlyMap<string, string>;
  /** Appointed moderators and when their term ends (unix seconds). */
  moderators: ReadonlyMap<string, number>;
}

export const EMPTY_BOARD_STATE: BoardState = {
  rules: "",
  pinned: [],
  locked: new Set(),
  pinnedBy: new Map(),
  lockedBy: new Map(),
  moderators: new Map(),
};

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The board's state from its newest state record. Only records the server signed count: `relayPubkey` when known
 * (the server also refuses state records from anyone else, so a record from another key is ignored either way).
 */
export function parseBoardState(
  events: readonly BoardEvent[],
  boardId: string,
  relayPubkey: string | null = null,
): BoardState {
  const newest = events
    .filter(
      (event) =>
        event.kind === KIND_BOARD_STATE &&
        event.tags.some((tag) => tag[0] === "d" && tag[1] === boardId) &&
        (relayPubkey === null || event.pubkey === relayPubkey),
    )
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0];
  if (!newest) return EMPTY_BOARD_STATE;
  const pinned: string[] = [];
  const locked = new Set<string>();
  const pinnedBy = new Map<string, string>();
  const lockedBy = new Map<string, string>();
  const moderators = new Map<string, number>();
  for (const tag of newest.tags) {
    const value = tag[1] ?? "";
    if (!HEX64.test(value)) continue;
    const placer = HEX64.test(tag[3] ?? "") ? tag[3] : null;
    if (tag[0] === "pinned" && !pinned.includes(value)) {
      pinned.push(value);
      if (placer) pinnedBy.set(value, placer);
    } else if (tag[0] === "locked") {
      locked.add(value);
      if (placer) lockedBy.set(value, placer);
    } else if (tag[0] === "moderator") {
      const until = Number(tag[2]);
      if (Number.isFinite(until)) moderators.set(value, until);
    }
  }
  return {
    rules: newest.content,
    pinned,
    locked,
    pinnedBy,
    lockedBy,
    moderators,
  };
}

/** Moderators whose term has not ended at `now` (unix seconds). */
export function activeModerators(
  state: BoardState,
  now: number,
): ReadonlySet<string> {
  return new Set(
    [...state.moderators]
      .filter(([, until]) => until > now)
      .map(([pubkey]) => pubkey),
  );
}

export type LogAction =
  | "lock"
  | "unlock"
  | "pin"
  | "unpin"
  | "mute"
  | "unmute"
  | "rules"
  | "appoint"
  | "dismiss"
  | "remove";

const LOG_ACTIONS = new Set<string>([
  "lock",
  "unlock",
  "pin",
  "unpin",
  "mute",
  "unmute",
  "rules",
  "appoint",
  "dismiss",
  "remove",
]);

export interface LogEntry {
  id: string;
  at: number;
  action: LogAction;
  actor: string;
  /** The standing the actor acted with: `moderator`, `board_owner`, `community_admin`, … */
  role: string;
  /** The post acted on. */
  post: string | null;
  /** For a removed reply: the thread it was in. */
  thread: string | null;
  /** The person acted on. */
  person: string | null;
  /** When a mute or a term ends (unix seconds). */
  until: number | null;
  /** `awaiting_second_moderator` or `confirmed_by_second_moderator` for a long mute. */
  status: string | null;
  /** For a longer mute waiting for a second moderator: the end asked for (unix seconds). */
  askedUntil: number | null;
  reason: string;
}

function tagOf(tags: readonly string[][], name: string): string | null {
  return tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

/** The board's log, newest first, from records the server signed (`relayPubkey` when known). */
export function parseLog(
  events: readonly BoardEvent[],
  boardId: string,
  relayPubkey: string | null = null,
): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const event of events) {
    if (event.kind !== KIND_BOARD_MODERATION_LOG) continue;
    if (relayPubkey !== null && event.pubkey !== relayPubkey) continue;
    if (tagOf(event.tags, "h") !== boardId) continue;
    const action = tagOf(event.tags, "action");
    const actor = tagOf(event.tags, "actor");
    if (action === null || !LOG_ACTIONS.has(action)) continue;
    if (actor === null || !HEX64.test(actor)) continue;
    const until = Number(tagOf(event.tags, "until"));
    const asked = Number(tagOf(event.tags, "asked_until"));
    entries.push({
      id: event.id,
      at: event.created_at,
      action: action as LogAction,
      actor,
      role: tagOf(event.tags, "role") ?? "",
      post: tagOf(event.tags, "e"),
      thread: tagOf(event.tags, "thread"),
      person: tagOf(event.tags, "p"),
      until:
        tagOf(event.tags, "until") !== null && Number.isFinite(until)
          ? until
          : null,
      status: tagOf(event.tags, "status"),
      askedUntil:
        tagOf(event.tags, "asked_until") !== null && Number.isFinite(asked)
          ? asked
          : null,
      reason: event.content,
    });
  }
  return entries.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
}

const ROLE_WORDS: Record<string, string> = {
  moderator: "moderator",
  board_admin: "board admin",
  board_owner: "board owner",
  community_admin: "community admin",
  community_owner: "community owner",
};

function dateWords(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** One log entry in plain words: who did what, to whom, until when, and why. */
export function logSentence(
  entry: LogEntry,
  nameOf: (pubkey: string) => string,
  titleOf: (post: string) => string | null = () => null,
): string {
  const who = `${nameOf(entry.actor)}${ROLE_WORDS[entry.role] ? ` (${ROLE_WORDS[entry.role]})` : ""}`;
  const person = entry.person ? nameOf(entry.person) : "someone";
  const until = entry.until !== null ? ` until ${dateWords(entry.until)}` : "";
  const named = (post: string | null) => {
    const title = post ? titleOf(post) : null;
    return title ? `the thread "${title}"` : "a thread";
  };
  const done = (() => {
    switch (entry.action) {
      case "lock":
        return `locked ${named(entry.post)}`;
      case "unlock":
        return `unlocked ${named(entry.post)}`;
      case "pin":
        return `pinned ${named(entry.post)}`;
      case "unpin":
        return `unpinned ${named(entry.post)}`;
      case "mute":
        return `muted ${person} on this board${until}`;
      case "unmute":
        return `lifted ${person}'s mute`;
      case "rules":
        return "changed the board's rules";
      case "appoint":
        return `made ${person} a moderator${until}`;
      case "dismiss":
        return entry.person === entry.actor
          ? "stepped down as a moderator"
          : `ended ${person}'s time as a moderator`;
      case "remove": {
        if (!entry.thread) return "removed a post";
        const title = titleOf(entry.thread);
        return title
          ? `removed a reply in the thread "${title}"`
          : "removed a reply";
      }
    }
  })();
  const second =
    entry.status === "awaiting_second_moderator"
      ? ". A longer mute waits for a second moderator"
      : entry.status === "confirmed_by_second_moderator"
        ? ", confirmed by a second moderator"
        : "";
  const reason = entry.reason.trim() ? `. Reason: ${entry.reason.trim()}` : "";
  const sentence = `${who} ${done}${second}${reason}.`;
  // "you" opens a sentence with a capital; a name is left as it is written (a short key must not change case).
  return sentence.startsWith("you ") ? `Y${sentence.slice(1)}` : sentence;
}

/** Mutes that are still in force at `now`, by person: the newest mute or unmute of each decides. */
export function activeMutes(
  log: readonly LogEntry[],
  now: number,
): ReadonlyMap<string, LogEntry> {
  const seen = new Set<string>();
  const active = new Map<string, LogEntry>();
  for (const entry of log) {
    if (entry.person === null) continue;
    if (entry.action !== "mute" && entry.action !== "unmute") continue;
    if (seen.has(entry.person)) continue;
    seen.add(entry.person);
    if (entry.action === "mute" && entry.until !== null && entry.until > now)
      active.set(entry.person, entry);
  }
  return active;
}

/** Replies removed from one thread, newest first, from the log. */
export function removedReplies(
  log: readonly LogEntry[],
  thread: string,
): LogEntry[] {
  return log.filter(
    (entry) => entry.action === "remove" && entry.thread === thread,
  );
}

/** Standing on a board, lowest first, as the server orders it. */
export const STANDING = {
  none: 0,
  moderator: 1,
  boardAdmin: 2,
  boardOwner: 3,
  communityAdmin: 4,
  communityOwner: 5,
} as const;

export type Standing = (typeof STANDING)[keyof typeof STANDING];

/** Someone's standing on a board from the community's roles, the board's roles and its appointed moderators. */
export function standingOf(
  pubkey: string | null,
  input: {
    communityRoles: ReadonlyMap<string, string>;
    boardRoles: ReadonlyMap<string, string>;
    moderators: ReadonlySet<string>;
  },
): Standing {
  if (pubkey === null) return STANDING.none;
  const community = input.communityRoles.get(pubkey);
  if (community === "owner") return STANDING.communityOwner;
  if (community === "admin") return STANDING.communityAdmin;
  const board = input.boardRoles.get(pubkey);
  if (board === "owner") return STANDING.boardOwner;
  if (board === "admin") return STANDING.boardAdmin;
  if (input.moderators.has(pubkey)) return STANDING.moderator;
  return STANDING.none;
}

/** May someone of `actor` standing act against someone of `target` standing (mute them, lock or remove their post)? */
export function mayActAgainst(actor: Standing, target: Standing): boolean {
  return actor === STANDING.communityOwner || actor > target;
}

/** May someone of `actor` standing undo (unlock, unpin, unmute) what someone of `placer` standing did? */
export function mayUndo(actor: Standing, placer: Standing): boolean {
  return actor >= placer;
}

/**
 * Longer mutes waiting for a second moderator: the newest mute of each person, still in force at `now`, asked for less
 * than a day ago, with the longer end it asked for. Another moderator confirms one by muting until that end.
 */
export function pendingLongerMutes(
  log: readonly LogEntry[],
  now: number,
): LogEntry[] {
  const current = activeMutes(log, now);
  return [...current.values()].filter(
    (entry) =>
      entry.status === "awaiting_second_moderator" &&
      entry.askedUntil !== null &&
      entry.askedUntil > now &&
      entry.at > now - SECOND_MODERATOR_WINDOW_SECONDS,
  );
}

export interface MuteChoice {
  days: number;
  label: string;
  /** A moderator's longer mute: one moderator sets seven days, a second one within a day makes it this long. */
  needsSecond: boolean;
}

/** The mute lengths to offer someone of `standing`. */
export function muteChoices(standing: Standing): MuteChoice[] {
  return [1, 3, 7, 14, BOARD_MUTE_MAX_DAYS].map((days) => ({
    days,
    label: days === 1 ? "1 day" : `${days} days`,
    needsSecond: standing === STANDING.moderator && days > MODERATOR_MUTE_DAYS,
  }));
}

/** When a mute of `days` chosen at `now` ends (unix seconds). */
export function muteEnd(now: number, days: number): number {
  return Math.floor(now) + days * DAY;
}

/** Pinned posts first, in pin order; the rest keep the order they had. */
export function pinnedFirst<T extends { id: string }>(
  posts: readonly T[],
  pinned: readonly string[],
): T[] {
  const rank = new Map(pinned.map((id, index) => [id, index]));
  const top = posts
    .filter((post) => rank.has(post.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return [...top, ...posts.filter((post) => !rank.has(post.id))];
}

/**
 * A refusal of a moderation command in plain words: a restriction on the reader as `refusalText` says it; otherwise
 * without the server's `restricted:`/`invalid:` prefix, and with a date and time where the server gave a unix time.
 */
export function boardRefusalText(message: string): string {
  if (/^error:/.test(message.trim())) return message;
  const restricted = restrictionText(message);
  if (restricted !== null) return restricted;
  const words = message
    .trim()
    .replace(/^(restricted|invalid|rate-limited|blocked|duplicate):\s*/, "")
    .replace(
      /\buntil (\d{9,11})\b/g,
      (_, unix: string) => `until ${whenText(Number(unix))}`,
    );
  return words === "" ? message : asSentence(words);
}
