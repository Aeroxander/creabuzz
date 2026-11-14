import type { SignedEventLike } from "../../feed/lib/feed-events";
import { type Engagement, netScore } from "../lib/engagement";
import { useReactionVote } from "../use-reaction-vote";
import { VoteControl } from "./VoteControl";

/** Up and down votes on a post, with the score between them: the Reddit vote in the timeline's action bar. */
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
  const { mine, score, busy, vote } = useReactionVote({
    target,
    myVote: engagement.myVote,
    myVoteIds: engagement.myVoteIds,
    score: netScore(engagement),
  });
  return (
    <VoteControl
      busy={busy}
      label={label}
      mine={mine}
      onVote={(direction) => void vote(direction)}
      score={score}
      testId="social-vote"
    />
  );
}
