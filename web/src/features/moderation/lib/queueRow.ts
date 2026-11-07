/**
 * What a row of the community's moderation queue shows, so a moderator can judge a report without leaving the queue:
 * the reported words and who wrote them (or the reported person), with a link to see it in place. Also the queue's
 * filter and paging. The reported words are read from the server by id; a report whose words are not there any more says
 * so, and one whose words could not be read says that instead (never "removed" for a read that failed).
 *
 * Alias-free; `queueRow.test.mjs` drives it under `node --test`.
 */

import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
} from "../../board/lib/board-events.ts";
import { replyTarget } from "../../board/lib/board-model.ts";
import { splitPost } from "../../board/lib/post-text.ts";
import type { ModerationReport, ReportStatus } from "./moderationQueue.ts";

/** A Home post or reply. */
const KIND_HOME_POST = 1;
/** A message in a room, old and new form. */
const KIND_ROOM_MESSAGE = 9;
const KIND_ROOM_MESSAGE_V2 = 40002;

/** The kinds a reported message, post or reply can be: the read of the reported words asks for these. */
export const REPORTED_WORD_KINDS = [
  KIND_HOME_POST,
  KIND_ROOM_MESSAGE,
  KIND_ROOM_MESSAGE_V2,
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
];

/** How many reported ids one read of their words asks for. */
export const WORDS_READ_CHUNK = 100;

/** One page of the queue, and the most "Show older" brings (the server's own cap). */
export const QUEUE_PAGE = 30;
export const QUEUE_MAX = 500;

export type QueueFilter = "all" | "open" | "escalated";

export const QUEUE_FILTERS: readonly { value: QueueFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Needs review" },
  { value: "escalated", label: "Escalated" },
];

/** The queue read for a filter and a page size. */
export function queueUrl(
  httpBase: string,
  filter: QueueFilter,
  limit: number,
): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (filter !== "all") query.set("status", filter);
  return `${httpBase}/moderation/reports?${query.toString()}`;
}

/** The page size after "Show older". */
export function olderLimit(limit: number): number {
  return Math.min(limit + QUEUE_PAGE, QUEUE_MAX);
}

/** Whether there may be older reports than the ones read: the server filled the page, and the cap is not reached. */
export function mayHaveOlder(count: number, limit: number): boolean {
  return limit > 0 && count >= limit && limit < QUEUE_MAX;
}

interface WordsEvent {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
}

/** What a report is about, as the row shows it. */
export type ReportedSubject =
  | {
      type: "words";
      /** "a post on Home", "a message", "a post on a board", "a reply on a board". */
      about: string;
      author: string;
      excerpt: string;
      /** Where to see it in place. */
      href: string;
      linkLabel: string;
    }
  /** A Home post the read covered and did not find: Home posts are readable by every member, so it is gone. */
  | { type: "gone"; about: string }
  /**
   * Words in a room or board the read covered and did not find. The server only returns what this reader may see, so
   * they may be gone, or be in a room or board this moderator is not in: never say they are gone.
   */
  | { type: "notFound"; about: string }
  /** The words could not be read just now: nothing is known about whether they are still there. */
  | { type: "unread"; about: string }
  | { type: "person"; about: string; person: string; href: string }
  | { type: "file"; about: string };

const EXCERPT_CHARS = 200;

function shorten(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= EXCERPT_CHARS
    ? line
    : `${line.slice(0, EXCERPT_CHARS).trimEnd()}…`;
}

/** A board post's title and the start of its body, so what it says can be judged from the queue. */
function postExcerpt(content: string): string {
  const { title, body } = splitPost(content);
  return body ? `${title}: ${body}` : title;
}

function boardOf(report: ModerationReport, event: WordsEvent): string | null {
  return (
    report.channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? null
  );
}

/**
 * What a report is about. `events` are the reported words found on the server; `read` the ids that read covered (an id
 * outside it was not looked up, or the read failed). `roomPath` is the community page a room message opens on.
 */
export function reportedSubject(
  report: ModerationReport,
  events: ReadonlyMap<string, WordsEvent>,
  read: ReadonlySet<string>,
  roomPath: string,
): ReportedSubject {
  if (report.targetKind === "pubkey") {
    return {
      type: "person",
      about: "a member",
      person: report.target,
      href: `/u/${report.target}`,
    };
  }
  if (report.targetKind === "blob") return { type: "file", about: "a file" };
  const event = events.get(report.target);
  const fallbackAbout =
    report.channelId === null ? "a post on Home" : "a message";
  if (!event) {
    if (!read.has(report.target))
      return { type: "unread", about: fallbackAbout };
    return report.channelId === null
      ? { type: "gone", about: fallbackAbout }
      : { type: "notFound", about: fallbackAbout };
  }
  const board = boardOf(report, event);
  if (event.kind === KIND_FORUM_POST && board) {
    return {
      type: "words",
      about: "a post on a board",
      author: event.pubkey,
      excerpt: shorten(postExcerpt(event.content)),
      href: `/b/${board}?post=${event.id}`,
      linkLabel: "See the post",
    };
  }
  if (event.kind === KIND_FORUM_COMMENT && board) {
    const thread = replyTarget(event.tags)?.root ?? null;
    return {
      type: "words",
      about: "a reply on a board",
      author: event.pubkey,
      excerpt: shorten(event.content),
      href: thread ? `/b/${board}?post=${thread}` : `/b/${board}`,
      linkLabel: "See the thread",
    };
  }
  if (report.channelId === null) {
    return {
      type: "words",
      about: "a post on Home",
      author: event.pubkey,
      excerpt: shorten(event.content),
      href: `/social/post/${event.id}`,
      linkLabel: "See the post",
    };
  }
  const query = new URLSearchParams({
    channel: report.channelId,
    message: event.id,
  });
  return {
    type: "words",
    about: "a message",
    author: event.pubkey,
    excerpt: shorten(event.content),
    href: `${roomPath}?${query.toString()}`,
    linkLabel: "See the message",
  };
}

/**
 * What a removal from this row takes down, in the words the board's own Moderate menu uses ("Remove post…"), so the
 * same action has one name on both screens.
 */
export function removedNoun(
  subject: ReportedSubject,
): "post" | "reply" | "message" {
  if (subject.about.includes("reply")) return "reply";
  if (subject.about.includes("post")) return "post";
  return "message";
}

/** Whom a ban or a timeout from this row would be against: the reported person, or whoever wrote the reported words. */
export function personToAct(subject: ReportedSubject): string | null {
  if (subject.type === "person") return subject.person;
  if (subject.type === "words") return subject.author;
  return null;
}

/** The status a row shows: what this reader just decided, until the server's read says it too. */
export function shownStatus(
  report: ModerationReport,
  decided: ReportStatus | undefined,
): ReportStatus {
  return report.status === "open" && decided ? decided : report.status;
}

/** The status a decision leaves a report in. */
export function statusAfter(
  action: "delete" | "timeout" | "ban" | "dismiss" | "escalate",
): ReportStatus {
  if (action === "dismiss") return "dismissed";
  if (action === "escalate") return "escalated";
  return "resolved";
}

/**
 * The rows to list: the server's page, and the reports this reader decided since the filter was chosen that the page no
 * longer has (an escalated report leaves the Open filter's read), so a decision never makes a report vanish from view.
 */
export function withDecided(
  page: readonly ModerationReport[],
  decided: readonly ModerationReport[],
): ModerationReport[] {
  const ids = new Set(page.map((report) => report.id));
  return [...page, ...decided.filter((report) => !ids.has(report.id))];
}
