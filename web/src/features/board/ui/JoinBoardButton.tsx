import { Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { needAccountTo } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import { useMyBoards } from "../use-my-boards";
import { failureWords } from "@/shared/lib/readable-error";

/**
 * Join or leave an open board. Joining puts it in "Your boards" on Home; anyone can read and post on an open board
 * either way. The person who started a board (or runs it) is on it for good, so they get no Leave: their role is shown
 * instead. An appointed moderator who has not joined is told they moderate it, beside Join.
 */
export function JoinBoardButton({
  boardId,
  boardName,
  moderator = false,
}: {
  boardId: string;
  boardName: string;
  /** The reader is one of the board's appointed moderators. */
  moderator?: boolean;
}) {
  const mine = useMyBoards();
  const [busy, setBusy] = useState(false);
  const role = mine.joined.get(boardId);
  const runsIt = role === "owner" || role === "admin";

  // Unknown is not "not joined": an owner would otherwise be offered Join on their own board.
  if (mine.failed) {
    return (
      <Button
        data-testid="board-join-retry"
        onClick={mine.retry}
        size="sm"
        title="Your boards couldn't be checked"
        variant="outline"
      >
        Check again
      </Button>
    );
  }

  if (runsIt) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs text-muted-foreground"
        data-testid="board-join-state"
      >
        <Check aria-hidden className="h-3.5 w-3.5" />
        {role === "owner" ? "Owner" : "Admin"}
      </span>
    );
  }

  const joined = role !== undefined;
  const button = (
    <Button
      aria-label={joined ? `Leave ${boardName}` : `Join ${boardName}`}
      aria-pressed={joined}
      data-testid="board-join"
      disabled={busy || mine.isLoading}
      onClick={async () => {
        if (existingUserPubkey() === null) {
          toast.error(needAccountTo("join boards"));
          return;
        }
        setBusy(true);
        try {
          await mine.setJoined(boardId, !joined);
        } catch (error) {
          toast.error(joined ? "Couldn't leave" : "Couldn't join", {
            description: failureWords(error).text,
          });
        } finally {
          setBusy(false);
        }
      }}
      size="sm"
      variant={joined ? "outline" : "default"}
    >
      {joined ? (
        <>
          <Check aria-hidden className="mr-1 h-3.5 w-3.5" /> Joined
        </>
      ) : (
        "Join"
      )}
    </Button>
  );
  if (!moderator) return button;
  return (
    <>
      <span
        className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs text-muted-foreground"
        data-testid="board-moderator-state"
      >
        <Check aria-hidden className="h-3.5 w-3.5" />
        Moderator
      </span>
      {button}
    </>
  );
}
