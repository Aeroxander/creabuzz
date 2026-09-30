/**
 * The feed's event vocabulary, built on standard Nostr so any client (nostter,
 * Damus, Primal) can read and reply:
 *
 * - A post is a kind 1 note. Topics ride as `t` tags; a post about a launch
 *   carries the launch's `a` coordinate and a `nostr:naddr…` reference in the
 *   text, so other clients render a link.
 * - Launch discussion is the same kind 1 note carrying the launch's `a`
 *   coordinate. Replies use NIP-10 marked `e` tags (`root`, `reply`) and keep
 *   the `a` tag, so a whole thread is one `#a` query.
 * - A vote is a NIP-25 kind 7 reaction, `+` or `-`, naming the target's event
 *   id (`e`, which the relay requires), author (`p`) and kind (`k`); a launch
 *   vote also names its `a` coordinate so votes survive record edits.
 *
 * Pure and alias-free: `feed-events.test.mjs` drives it under `node --test`.
 */

import { naddrEncode } from "nostr-tools/nip19";

import {
  KIND_LAUNCH_RECORD,
  KIND_REACTION,
  KIND_TEXT_NOTE,
} from "../../../shared/constants/kinds.ts";

export interface EventTemplate {
  kind: number;
  tags: string[][];
  content: string;
}

export interface SignedEventLike {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** A launch by its addressable coordinate parts. */
export interface LaunchRef {
  pubkey: string;
  /** The record's `d` tag. */
  id: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
/** Posts are short; the relay enforces its own ceiling too. */
export const MAX_POST_CHARS = 2000;
const MAX_TOPICS = 5;

export function launchCoordinate(launch: LaunchRef): string {
  return `${KIND_LAUNCH_RECORD}:${launch.pubkey.toLowerCase()}:${launch.id}`;
}

/** The `launch` part of a `37001:<pubkey>:<d>` coordinate, or null. */
export function parseLaunchCoordinate(coord: string): LaunchRef | null {
  const parts = coord.split(":");
  if (parts.length < 3 || parts[0] !== String(KIND_LAUNCH_RECORD)) return null;
  const pubkey = parts[1].toLowerCase();
  const id = parts.slice(2).join(":");
  if (!HEX64.test(pubkey) || id === "") return null;
  return { pubkey, id };
}

/** Lowercase `#topic` words in the text, deduplicated, at most five. */
export function extractTopics(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,32})/gu)) {
    found.add(match[1].toLowerCase());
    if (found.size >= MAX_TOPICS) break;
  }
  return [...found];
}

function cleanText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Write something first.");
  if ([...trimmed].length > MAX_POST_CHARS) {
    throw new Error(`Keep it under ${MAX_POST_CHARS} characters.`);
  }
  return trimmed;
}

/** A top-level post, optionally about one launch. */
export function buildPost(input: {
  text: string;
  launch?: LaunchRef | null;
}): EventTemplate {
  let content = cleanText(input.text);
  const tags: string[][] = extractTopics(content).map((t) => ["t", t]);
  if (input.launch) {
    const coord = launchCoordinate(input.launch);
    tags.push(["a", coord]);
    const naddr = naddrEncode({
      kind: KIND_LAUNCH_RECORD,
      pubkey: input.launch.pubkey.toLowerCase(),
      identifier: input.launch.id,
    });
    if (!content.includes(naddr)) content = `${content}\n\nnostr:${naddr}`;
  }
  return { kind: KIND_TEXT_NOTE, tags, content };
}

/**
 * A reply in a thread. `root` is the thread's first note; `parent` the note
 * being answered (the root itself for a direct reply). The launch coordinate,
 * when the thread is about one, is carried forward.
 */
export function buildReply(input: {
  text: string;
  root: SignedEventLike;
  parent: SignedEventLike;
}): EventTemplate {
  const content = cleanText(input.text);
  const tags: string[][] = [
    ["e", input.root.id, "", "root"],
    ...(input.parent.id !== input.root.id
      ? [["e", input.parent.id, "", "reply"]]
      : []),
  ];
  const mentioned = new Set([input.parent.pubkey, input.root.pubkey]);
  for (const pubkey of mentioned) tags.push(["p", pubkey]);
  for (const coord of launchCoordinates(input.root)) tags.push(["a", coord]);
  for (const topic of extractTopics(content)) tags.push(["t", topic]);
  return { kind: KIND_TEXT_NOTE, tags, content };
}

export type VoteDirection = "+" | "-";

/** A vote on a note, or on a launch record (then `launch` is required). */
export function buildVote(input: {
  target: SignedEventLike;
  direction: VoteDirection;
  launch?: LaunchRef | null;
}): EventTemplate {
  const tags: string[][] = [
    ["e", input.target.id],
    ["p", input.target.pubkey],
    ["k", String(input.target.kind)],
  ];
  if (input.launch) tags.push(["a", launchCoordinate(input.launch)]);
  return { kind: KIND_REACTION, tags, content: input.direction };
}

/** Every launch coordinate a note is about. */
export function launchCoordinates(event: SignedEventLike): string[] {
  return event.tags
    .filter((t) => t[0] === "a" && typeof t[1] === "string")
    .map((t) => t[1])
    .filter((coord) => parseLaunchCoordinate(coord) !== null);
}

export interface FeedNote {
  id: string;
  author: string;
  createdAt: number;
  text: string;
  topics: string[];
  /** Launches the note is about. */
  launches: string[];
  /** The thread root this note replies into, or null for a top-level post. */
  rootId: string | null;
  /** The note this one answers directly, or null. */
  replyToId: string | null;
  /** Signed by an agent on its owner's behalf (NIP-OA `auth` tag). */
  byAgent: boolean;
  event: SignedEventLike;
}

/**
 * Read a kind 1 note's thread position (NIP-10: marked tags first; the old
 * positional form — first `e` root, last `e` reply — as the fallback).
 */
export function parseNote(event: SignedEventLike): FeedNote | null {
  if (event.kind !== KIND_TEXT_NOTE) return null;
  const eTags = event.tags.filter(
    (t) => t[0] === "e" && typeof t[1] === "string" && HEX64.test(t[1]),
  );
  const marked = (marker: string) =>
    eTags.find((t) => t[3] === marker)?.[1] ?? null;
  let rootId = marked("root");
  let replyToId = marked("reply");
  if (!rootId && !replyToId && eTags.length > 0) {
    rootId = eTags[0][1];
    replyToId = eTags.length > 1 ? eTags[eTags.length - 1][1] : null;
  }
  if (rootId && !replyToId) replyToId = rootId;
  return {
    id: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    text: event.content,
    topics: event.tags
      .filter((t) => t[0] === "t" && typeof t[1] === "string")
      .map((t) => t[1].toLowerCase()),
    launches: launchCoordinates(event),
    rootId,
    replyToId,
    byAgent: event.tags.some((t) => t[0] === "auth"),
    event,
  };
}

/** The text with the machine `nostr:naddr…` references removed for display. */
export function displayText(text: string): string {
  return text.replace(/\n*nostr:naddr1[0-9a-z]+/g, "").trim();
}
