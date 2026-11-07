/**
 * A person's score for their profile, from their newest 200 short posts and 200 board posts.
 */

import { useQuery } from "@tanstack/react-query";

import { KIND_REACTION, KIND_TEXT_NOTE } from "@/shared/constants/kinds";

import { KIND_FORUM_POST, KIND_FORUM_VOTE } from "../board/lib/board-events";
import { authorScore } from "./lib/author-score";
import { readEvents } from "./read";
import { socialKeys } from "./use-social-data";

/** How many of a person's newest posts of each kind the score covers. */
export const SCORE_POSTS = 200;

export function useAuthorScore(pubkey: string) {
  return useQuery({
    queryKey: [...socialKeys.all, "author-score", pubkey],
    staleTime: 60_000,
    queryFn: async () => {
      const [notes, boardPosts] = await Promise.all([
        readEvents({
          kinds: [KIND_TEXT_NOTE],
          authors: [pubkey],
          limit: SCORE_POSTS,
        }),
        readEvents({
          kinds: [KIND_FORUM_POST],
          authors: [pubkey],
          limit: SCORE_POSTS,
        }),
      ]);
      const noteIds = notes.map((e) => e.id);
      const boardIds = boardPosts.map((e) => e.id);
      const [reactions, boardVotes] = await Promise.all([
        noteIds.length
          ? readEvents({ kinds: [KIND_REACTION], "#e": noteIds, limit: 5000 })
          : Promise.resolve([]),
        boardIds.length
          ? readEvents({
              kinds: [KIND_FORUM_VOTE],
              "#e": boardIds,
              limit: 5000,
            })
          : Promise.resolve([]),
      ]);
      return authorScore(pubkey, new Set([...noteIds, ...boardIds]), [
        ...reactions,
        ...boardVotes,
      ]);
    },
  });
}
