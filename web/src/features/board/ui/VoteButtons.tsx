/**
 * A board post's or reply's vote, in the board's words (`up`/`down`, `1`/`-1`/`0`), drawn by the one vote control the
 * rest of the app uses. A signed-in reader's own vote is shown pressed; pressing it again takes it back.
 */

import { VoteControl } from "@/features/social/ui/VoteControl";

export function VoteButtons({
  score,
  myVote,
  onVote,
  subject,
  disabledReason = null,
}: {
  score: number;
  myVote: 1 | -1 | 0;
  onVote: (direction: "up" | "down") => void;
  /** What is being voted on, for screen readers: `post "Which editor?"`, `reply by Bob`. */
  subject: string;
  /** Why the reader cannot vote here (muted on this board); the arrows are off and say why. */
  disabledReason?: string | null;
}) {
  return (
    <VoteControl
      disabledReason={disabledReason}
      label={subject}
      mine={myVote === 1 ? "+" : myVote === -1 ? "-" : null}
      onVote={(direction) => onVote(direction === "+" ? "up" : "down")}
      orientation="column"
      score={score}
      testId="board-vote"
    />
  );
}
