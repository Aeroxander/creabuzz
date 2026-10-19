import { Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { needAccountTo } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import { useMyBoards } from "../use-my-boards";

/**
 * Join or leave an open board. Joining puts it in "Your boards" on Home; anyone can read and post on an open board
 * either way. The person who started a board (or runs it) is on it for good, so they get no Leave.
 */
export function JoinBoardButton({
  boardId,
  boardName,
}: {
  boardId: string;
  boardName: string;
}) {
  const mine = useMyBoards();
  const [busy, setBusy] = useState(false);
  const role = mine.joined.get(boardId);
  const runsIt = role === "owner" || role === "admin";

  if (runsIt) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs text-muted-foreground"
        data-testid="board-join-state"
      >
        <Check aria-hidden className="h-3.5 w-3.5" />
        {role === "owner" ? "Yours" : "You run it"}
      </span>
    );
  }

  const joined = role !== undefined;
  return (
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
            description: error instanceof Error ? error.message : String(error),
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
}
