/**
 * The reports about one board's posts and replies, as its moderators see them (D99): what was reported, why, and what the
 * reader may do about it. Never who reported it: the server leaves that out of a board's read.
 *
 * A board's moderators may remove what was reported (the board's own removal, with its reason in the public log) and then
 * close the report, close a report about words that are already gone, or dismiss a report. The server allows each only
 * against someone of lower standing, never about the reader's own words, and leaves anything more (a ban, a timeout) to
 * the community's moderators, who see every report. This file decides what to offer the same way, so nothing is offered
 * that the server would refuse.
 *
 * Alias-free; `board-reports.test.mjs` drives it under `node --test`.
 */

import type { ModerationReport } from "../../moderation/lib/moderationQueue.ts";
import { KIND_FORUM_POST } from "./board-events.ts";
import { replyTarget } from "./board-model.ts";
import { splitPost } from "./post-text.ts";

/** How many open reports one read brings. */
export const BOARD_REPORTS_LIMIT = 30;

/** The server's report queue narrowed to one board's open reports. */
export function boardReportsUrl(httpBase: string, boardId: string): string {
  const query = new URLSearchParams({
    channel: boardId,
    status: "open",
    limit: String(BOARD_REPORTS_LIMIT),
  });
  return `${httpBase}/moderation/reports?${query.toString()}`;
}

/** The reported post or reply, while it is still on the board. */
export interface ReportedWords {
  what: "post" | "reply";
  author: string;
  /** The title of a post, or the start of a reply. */
  excerpt: string;
  /** The thread to open: the post itself, or the post a reply is in. */
  thread: string;
}

interface WordsEvent {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
}

const EXCERPT_CHARS = 120;

function shorten(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= EXCERPT_CHARS
    ? line
    : `${line.slice(0, EXCERPT_CHARS).trimEnd()}…`;
}

/** The reported words from the board's records, or null when they are not there (removed, or deleted by their author). */
export function reportedWords(
  report: ModerationReport,
  events: readonly WordsEvent[],
): ReportedWords | null {
  if (report.targetKind !== "event") return null;
  const event = events.find((e) => e.id === report.target);
  if (!event) return null;
  if (event.kind === KIND_FORUM_POST) {
    return {
      what: "post",
      author: event.pubkey,
      excerpt: shorten(splitPost(event.content).title),
      thread: event.id,
    };
  }
  const target = replyTarget(event.tags);
  if (!target) return null;
  return {
    what: "reply",
    author: event.pubkey,
    excerpt: shorten(event.content),
    thread: target.root,
  };
}

/** What the reader may do with one report. */
export interface ReportChoices {
  /** Remove the reported words with a public reason, then close the report. */
  remove: boolean;
  /** The words are gone already: close the report as dealt with. */
  close: boolean;
  dismiss: boolean;
  /** Why none of it is offered, when that is so. */
  leftFor: string | null;
}

export function reportChoices(
  report: ModerationReport,
  words: ReportedWords | null,
  me: string | null,
  outranks: (author: string) => boolean,
): ReportChoices {
  const none = (leftFor: string | null): ReportChoices => ({
    remove: false,
    close: false,
    dismiss: false,
    leftFor,
  });
  if (me === null || report.status !== "open") return none(null);
  if (report.targetKind !== "event")
    return none(
      "It is about a person, not a post: the community's moderators decide it.",
    );
  // Gone already: who wrote it is no longer known here, so the server decides whether the reader may close it.
  if (words === null)
    return { remove: false, close: true, dismiss: true, leftFor: null };
  if (words.author === me)
    return none("It is about your own words, so someone else decides it.");
  if (!outranks(words.author))
    return none(
      "It is about someone of the same or higher standing, so someone above them decides it.",
    );
  return { remove: true, close: false, dismiss: true, leftFor: null };
}
