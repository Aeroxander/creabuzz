/**
 * The records a board writes: a post, a comment, a vote and a deletion.
 *
 * These mirror `crates/buzz-sdk/src/builders.rs` (`build_forum_post`,
 * `build_forum_comment`, `build_vote`) exactly, so the desktop and mobile apps
 * read what the web writes and the other way round: a post is kind 45001 with
 * an `h` tag for its board; a comment is kind 45003 carrying NIP-10 `e` tags
 * (`reply` straight to the post, `root` + `reply` for a reply to a comment);
 * a vote is kind 45002 whose content is `+` or `-`.
 *
 * Alias-free; `board-events.test.mjs` drives it under `node --test`.
 */

import { composePost } from "./post-text.ts";
import {
  PROPOSAL_TOPIC,
  type ProposalRef,
  proposalTopic,
} from "./proposal-link.ts";

export const KIND_FORUM_POST = 45001;
export const KIND_FORUM_VOTE = 45002;
export const KIND_FORUM_COMMENT = 45003;
export const KIND_DELETION = 5;
/** A board owner's or admin's removal of someone else's post or reply (NIP-29 delete-event). */
export const KIND_MODERATION_DELETE = 9005;

export interface Draft {
  kind: number;
  tags: string[][];
  content: string;
}

export function postDraft(input: {
  boardId: string;
  title: string;
  body: string;
  proposal?: ProposalRef | null;
}): Draft {
  const tags: string[][] = [["h", input.boardId]];
  if (input.proposal) {
    const topic = proposalTopic(input.proposal);
    if (topic === null) throw new Error("That decision can't be linked.");
    tags.push(["t", PROPOSAL_TOPIC], ["t", topic]);
  }
  return {
    kind: KIND_FORUM_POST,
    tags,
    content: composePost(input.title, input.body),
  };
}

export function commentDraft(input: {
  boardId: string;
  /** The post being discussed. */
  root: string;
  /** What this answers: the post itself, or one of its comments. */
  parent: string;
  body: string;
}): Draft {
  const body = input.body.trim();
  if (body === "") throw new Error("Write something first.");
  const tags: string[][] = [["h", input.boardId]];
  if (input.parent === input.root) {
    tags.push(["e", input.root, "", "reply"]);
  } else {
    tags.push(["e", input.root, "", "root"], ["e", input.parent, "", "reply"]);
  }
  return { kind: KIND_FORUM_COMMENT, tags, content: body };
}

export type VoteDirection = "up" | "down";

export function voteDraft(input: {
  boardId: string;
  target: string;
  direction: VoteDirection;
}): Draft {
  return {
    kind: KIND_FORUM_VOTE,
    tags: [
      ["h", input.boardId],
      ["e", input.target],
    ],
    content: input.direction === "up" ? "+" : "-",
  };
}

/**
 * Remove someone else's post or reply. The server stores this only when the sender owns or administers the board (or wrote
 * the record), so a board treats a removal it receives as already checked, and still applies it only to what is on this
 * board (`board-model.ts`).
 */
export function moderationDeletionDraft(input: {
  boardId: string;
  target: string;
}): Draft {
  return {
    kind: KIND_MODERATION_DELETE,
    tags: [
      ["h", input.boardId],
      ["e", input.target],
    ],
    content: "",
  };
}

/** Delete one of the author's own records (same shape the chat uses). */
export function deletionDraft(input: {
  boardId: string;
  target: string;
}): Draft {
  return {
    kind: KIND_DELETION,
    tags: [
      ["h", input.boardId],
      ["e", input.target],
    ],
    content: "",
  };
}
