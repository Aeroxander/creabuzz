/**
 * "Save your recovery key so you can get back in": one quiet line, always on while this account's key has not been
 * saved, inside the first-week card. The key is the only way back into the account if the browser forgets it, and a
 * founder who has just made a project has the most to lose. "Save it" opens the same dialog the account menu uses, and
 * the line goes away when the key was copied or downloaded. It is an outline button until the first update is posted.
 */

import { useId, useState } from "react";

import {
  hasBackedUp,
  RecoveryKeyDialog,
} from "@/features/identity/ui/RecoveryKeyDialog";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

const RECOVERY_LINE = "Save your recovery key so you can get back in.";

export function RecoveryKeyPrompt({
  firstUpdatePosted,
}: {
  firstUpdatePosted: boolean;
}) {
  const account = existingUserPubkey();
  const lineId = useId();
  const [open, setOpen] = useState(false);
  // Read again after the dialog closes: copying or downloading is what marks the key as saved.
  const [, setSaved] = useState(0);
  if (!account || hasBackedUp()) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="recovery-key-prompt"
    >
      <p className="min-w-0 flex-1 text-sm" id={lineId}>
        {RECOVERY_LINE}
      </p>
      <Button
        aria-describedby={lineId}
        data-testid="recovery-key-save"
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant={firstUpdatePosted ? "default" : "outline"}
      >
        Save it
      </Button>
      {open ? (
        <RecoveryKeyDialog
          account={account}
          onClose={() => {
            setOpen(false);
            setSaved((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}
