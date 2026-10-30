import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { needAccountTo } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";

import { buildVote, type SignedEventLike } from "../../feed/lib/feed-events";
import { type Engagement, netScore } from "../lib/engagement";
import { buildUndo } from "../lib/post-events";
import { useSocialPublish } from "../use-social-actions";
import { VoteControl } from "./VoteControl";
import { failureWords } from "@/shared/lib/readable-error";

type Vote = "+" | "-" | null;

/**
 * Up and down votes on a post, with the score between them: the Reddit vote in the timeline's action bar.
 *
 * A vote is the standard `+` or `-` reaction, so other apps read an up vote as a like. Pressing the vote already cast
 * takes it back, and changing it replaces it; either way every earlier vote record of the reader's is deleted, so none
 * can count again. The new state shows at once and is undone if the server refuses.
 */
export function PostVotes({
  target,
  engagement,
  label,
}: {
  target: SignedEventLike;
  engagement: Engagement;
  /** What is voted on, for screen readers: `post by Ann`. */
  label: string;
}) {
  const publish = useSocialPublish();
  const [pending, setPending] = useState<{ vote: Vote } | null>(null);
  // The vote records this page sent and deleted, so a quick change of mind does not wait for the server's count to
  // learn about the newest one (a take-back that missed it would leave it counting).
  const sent = useRef<string[]>([]);
  const gone = useRef<Set<string>>(new Set());
  // Once the server's count says what the reader did, the local guess is dropped.
  useEffect(() => {
    if (pending && pending.vote === engagement.myVote) setPending(null);
  }, [engagement.myVote, pending]);

  const mine: Vote = pending ? pending.vote : engagement.myVote;
  const shift = (vote: Vote) => (vote === "+" ? 1 : vote === "-" ? -1 : 0);
  const score = netScore(engagement) - shift(engagement.myVote) + shift(mine);

  const vote = async (wanted: "+" | "-") => {
    if (existingUserPubkey() === null) {
      toast.error(needAccountTo("vote"));
      return;
    }
    if (publish.isPending) return;
    const next: Vote = mine === wanted ? null : wanted;
    setPending({ vote: next });
    try {
      const earlier = [
        ...new Set([...engagement.myVoteIds, ...sent.current]),
      ].filter((id) => !gone.current.has(id));
      if (next !== null) {
        const signed = await publish.mutateAsync(
          buildVote({ target, direction: next }),
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

  return (
    <VoteControl
      busy={publish.isPending}
      label={label}
      mine={mine}
      onVote={(direction) => void vote(direction)}
      score={score}
      testId="social-vote"
    />
  );
}
