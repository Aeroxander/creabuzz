import { useReactionVote } from "@/features/social/use-reaction-vote";
import { VoteControl } from "@/features/social/ui/VoteControl";

import type { LaunchRef, SignedEventLike } from "../lib/feed-events";
import { EMPTY_TALLY, type VoteTally } from "../lib/ranking";

/**
 * Up/down voting on a note or a project, drawn and behaving like a post's vote on Home (`PostVotes`). The number is
 * the plain headcount (people up minus people down); how much each vote counts toward *ranking* is a separate,
 * internal matter (`trust-weight.ts`), so no decimal ever appears and the same like reads the same everywhere.
 */
export function VoteButtons({
  target,
  launch,
  tally = EMPTY_TALLY,
  label,
  testId = "vote",
}: {
  target: SignedEventLike;
  launch?: LaunchRef | null;
  tally?: VoteTally;
  /** What is being voted on, for the buttons' accessible names. */
  label: string;
  testId?: string;
}) {
  const { mine, score, busy, vote } = useReactionVote({
    target,
    launch,
    myVote: tally.mine,
    myVoteIds: tally.mineIds,
    score: tally.up - tally.down,
  });
  return (
    <VoteControl
      busy={busy}
      label={label}
      mine={mine}
      onVote={(direction) => void vote(direction)}
      score={score}
      testId={testId}
    />
  );
}
