/**
 * The two boards most projects start with: an open one for supporters and a
 * private one for the people making the thing. A project made from a template
 * gets them from the template; this is the same pair for a community that was
 * not, offered once and only while it has no boards at all.
 *
 * Alias-free; `starter-boards.test.mjs` drives it under `node --test`.
 */

import { buildCreateChannelEvent } from "../../channels/lib/channel-create-events.ts";
import { type Draft, postDraft } from "./board-events.ts";

export interface StarterBoard {
  name: string;
  purpose: string;
  visibility: "open" | "private";
  /** The board's first post. */
  title: string;
  body: string;
}

export const STARTER_BOARDS: readonly StarterBoard[] = [
  {
    name: "supporters",
    purpose:
      "Questions, ideas and updates for everyone who follows or backs this project. Vote posts up to show what matters.",
    visibility: "open",
    title: "Welcome, supporters",
    body: [
      "This is the board for everyone who follows or backs this project. Anyone in the community can read it and post.",
      "",
      "- **Ask** anything: how it is going, what is next, how you can help.",
      "- **Suggest** ideas. Vote up the posts you like and vote down the ones you don't, so the team can see what matters most.",
      "- **Follow along.** The team will post updates here, and you can reply to any of them.",
      "",
      "A vote on this board shows interest. It does not decide anything: decisions that need a vote are made by the DAO, and they get their own thread here.",
      "",
      "To start, say hello and tell us what brought you here.",
    ].join("\n"),
  },
  {
    name: "founders",
    purpose:
      "Planning and decisions for the people making this. Only people you add can read it.",
    visibility: "private",
    title: "The founders' board",
    body: [
      "This board is for the people making this project. Only people who are added can read it, so plan openly here.",
      "",
      "Use it for things that are too long or too slow for chat: the roadmap, who owns what, and what you want to settle before the next release. Chat is for the quick back-and-forth; this is where a decision gets written down and stays easy to find.",
      "",
      "Good first posts:",
      "",
      "1. What we are making, in two sentences.",
      "2. What we need to decide this week.",
      "3. What we can show supporters, even if it is only a first version.",
      "",
      'To bring someone in, press "People" at the top of this board.',
    ].join("\n"),
  },
];

/** The starter boards a community lacks, by name. */
export function missingStarterBoards(
  existingNames: readonly string[],
): StarterBoard[] {
  const have = new Set(existingNames.map((name) => name.toLowerCase()));
  return STARTER_BOARDS.filter((board) => !have.has(board.name));
}

/** Offered only to a community with no boards at all, so it never nags one that chose none. */
export function offerStarterBoards(boardCount: number): boolean {
  return boardCount === 0;
}

/** The two records that make one board: its creation and its first post. */
export function starterDrafts(
  board: StarterBoard,
  id: string,
): { create: Draft; seed: Draft } {
  return {
    create: buildCreateChannelEvent({
      id,
      name: board.name,
      visibility: board.visibility,
      channelType: "forum",
      about: board.purpose,
    }),
    seed: postDraft({ boardId: id, title: board.title, body: board.body }),
  };
}
