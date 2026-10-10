/**
 * What a reader can do on a board: post, reply, vote, take a vote back and
 * delete their own words. Each is one signed record sent as the reader; the
 * result is merged into the board as soon as the server accepts it.
 */

import { useMemo } from "react";

import { publishAsUser } from "@/shared/lib/publish-as-user";

import {
  commentDraft,
  type Draft,
  deletionDraft,
  postDraft,
  type VoteDirection,
  voteDraft,
} from "./lib/board-events";
import type { BoardEvent } from "./lib/board-model";
import type { ProposalRef } from "./lib/proposal-link";

/** The reader's current vote on something, as the board model reports it. */
export interface VoteState {
  myVote: 1 | -1 | 0;
  myVoteIds: readonly string[];
}

export function useBoardActions(
  boardId: string,
  add: (event: BoardEvent) => void,
) {
  return useMemo(() => {
    const send = async (draft: Draft, failure: string) => {
      const signed = await publishAsUser(draft, failure);
      add(signed);
      return signed;
    };
    return {
      createPost: (input: {
        title: string;
        body: string;
        proposal?: ProposalRef | null;
      }) =>
        send(
          postDraft({ boardId, ...input }),
          "The server didn't accept your post.",
        ),
      comment: (input: { root: string; parent: string; body: string }) =>
        send(
          commentDraft({ boardId, ...input }),
          "The server didn't accept your reply.",
        ),
      /**
       * Vote the way asked. Asking for the vote already cast takes it back, and
       * changing a vote replaces it: either way every earlier vote record of the
       * reader's is deleted, so none of them can count again.
       */
      vote: async (
        target: string,
        wanted: VoteDirection,
        current: VoteState,
      ) => {
        const value = wanted === "up" ? 1 : -1;
        const clearOld = async () => {
          for (const id of current.myVoteIds) {
            await send(
              deletionDraft({ boardId, target: id }),
              "The server didn't take your vote back.",
            );
          }
        };
        if (current.myVote === value) {
          await clearOld();
          return;
        }
        await send(
          voteDraft({ boardId, target, direction: wanted }),
          "The server didn't accept your vote.",
        );
        try {
          await clearOld();
        } catch {
          // The new vote is the newest, so it is what counts; the old record is
          // only clutter. Say so rather than report a vote that did go through
          // as a failure.
          throw new Error(
            "Your vote is in, but your earlier one couldn't be cleared yet.",
          );
        }
      },
      remove: (target: string) =>
        send(
          deletionDraft({ boardId, target }),
          "The server didn't delete that.",
        ),
    };
  }, [boardId, add]);
}

export type BoardActions = ReturnType<typeof useBoardActions>;
