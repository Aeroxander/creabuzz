/**
 * On a project's record, right after someone on the team accepts a piece of work: the picture of that accepted work to
 * share (`ShareRecordButton`, card "accepted"). Offered to the person who just accepted it, in the same visit; the
 * words and picture say the work was accepted and never a price or Shares.
 */

import { Button } from "@/shared/ui/button";

import type { Launch } from "../models";
import { useJustAccepted } from "../use-just-accepted";
import { ShareRecordButton } from "./ShareRecordButton";

export function JustAcceptedShare({ launch }: { launch: Launch }) {
  const { accepted, dismiss } = useJustAccepted(launch.record);
  if (!accepted) return null;
  return (
    <div
      className="mt-3 rounded-lg border border-border bg-background/70 p-3"
      data-testid="task-share"
    >
      <p className="text-sm font-semibold">You accepted this work</p>
      <p className="break-words text-xs text-muted-foreground">
        “{accepted.what}” is on the record now. Share it as a picture.
      </p>
      <div className="mt-2">
        <ShareRecordButton
          answered={null}
          card="accepted"
          kept={null}
          label="Share this accepted work"
          project={launch.record}
          streak={null}
          variant="outline"
          withImage
          workTitle={accepted.what}
        />
      </div>
      <Button
        className="mt-2"
        data-testid="task-share-dismiss"
        onClick={dismiss}
        size="sm"
        type="button"
        variant="outline"
      >
        Not now
      </Button>
    </div>
  );
}
