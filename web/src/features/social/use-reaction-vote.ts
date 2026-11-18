import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { needAccountTo } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { failureWords } from "@/shared/lib/readable-error";

import {
  buildVote,
  type LaunchRef,
  type SignedEventLike,
} from "../feed/lib/feed-events";
import { buildUndo } from "./lib/post-events";
import { useSocialPublish } from "./use-social-actions";

type Vote = "+" | "-" | null;

/**
 * An up or down vote as a standard `+` or `-` reaction (kind 7), so other apps read an up vote as a like: on a post, or
 * on a project when `launch` is given. Pressing the vote already cast takes it back, and changing it replaces it; either
 * way every earlier vote record of the reader's is deleted, so none can count again. The new state shows at once and
 * is undone if the server refuses.
 */
export function useReactionVote({
  target,
  launch = null,
  myVote,
  myVoteIds,
  score: counted,
}: {
  target: SignedEventLike;
  launch?: LaunchRef | null;
  /** The reader's vote as the server's count has it. */
  myVote: Vote;
  /** Every vote record of the reader's on the target. */
  myVoteIds: readonly string[];
  /** The plain score as counted, with the reader's own vote in it. */
  score: number;
}) {
  const publish = useSocialPublish();
  const [pending, setPending] = useState<{ vote: Vote } | null>(null);
  // The vote records this page sent and deleted, so a quick change of mind does not wait for the server's count to
  // learn about the newest one (a take-back that missed it would leave it counting).
  const sent = useRef<string[]>([]);
  const gone = useRef<Set<string>>(new Set());
  // A control reused for another post or project (a list re-rendered for someone else's page) starts afresh: the
  // records it sent belong to the old target, and deleting them would take back a vote there.
  // A project vote counts by the project, so a newer version of its record is the same subject.
  const subject = launch ? `${launch.pubkey}:${launch.id}` : target.id;
  useEffect(() => {
    void subject;
    sent.current = [];
    gone.current = new Set();
    setPending(null);
  }, [subject]);
  // Once the server's count says what the reader did, the local guess is dropped.
  useEffect(() => {
    if (pending && pending.vote === myVote) setPending(null);
  }, [myVote, pending]);

  const mine: Vote = pending ? pending.vote : myVote;
  const shift = (vote: Vote) => (vote === "+" ? 1 : vote === "-" ? -1 : 0);
  const score = counted - shift(myVote) + shift(mine);

  const vote = async (wanted: "+" | "-") => {
    if (existingUserPubkey() === null) {
      toast.error(needAccountTo("vote"));
      return;
    }
    if (publish.isPending) return;
    const next: Vote = mine === wanted ? null : wanted;
    setPending({ vote: next });
    try {
      const earlier = [...new Set([...myVoteIds, ...sent.current])].filter(
        (id) => !gone.current.has(id),
      );
      if (next !== null) {
        const signed = await publish.mutateAsync(
          buildVote({ target, direction: next, launch }),
        );
        sent.current.push(signed.id);
      }
      for (const id of earlier) {
        await publish.mutateAsync(buildUndo(id, 7));
        gone.current.add(id);
      }
    } catch (error) {
      setPending(null);
      toast.error("Your vote was not saved", {
        description: failureWords(error).text,
      });
    }
  };

  return { mine, score, busy: publish.isPending, vote };
}
