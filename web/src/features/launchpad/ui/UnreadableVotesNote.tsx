import { unreadableVoteNote } from "../lib/proposal-gate";

/**
 * Said once above the suggestions when an open vote to approve a work area could not be read: such a vote is matched to
 * no suggestion, so a suggestion it covers would still offer "Put to a vote". Nothing is shown when every vote was read.
 */
export function UnreadableVotesNote({
  decisions,
}: {
  decisions: Parameters<typeof unreadableVoteNote>[0];
}) {
  const note = unreadableVoteNote(decisions);
  if (!note) return null;
  return (
    <p
      className="text-sm text-muted-foreground"
      data-testid="suggested-unreadable-votes"
      role="status"
    >
      {note}
    </p>
  );
}
