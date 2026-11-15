/**
 * "Save your recovery key": asked once on a founder's first project page, until this account's key has been saved. The
 * key is the only way back into the account if the browser forgets it, and a founder who has just made a project has
 * the most to lose. It opens the same dialog the account menu uses, and goes away when the key was copied or
 * downloaded. "Not now" puts it away for this visit only.
 */

import { useState } from "react";

import {
  hasBackedUp,
  RecoveryKeyDialog,
} from "@/features/identity/ui/RecoveryKeyDialog";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

export function RecoveryKeyPrompt() {
  const account = existingUserPubkey();
  const [open, setOpen] = useState(false);
  const [away, setAway] = useState(false);
  // Read again after the dialog closes: copying or downloading is what marks the key as saved.
  const [, setSaved] = useState(0);
  if (!account || away || hasBackedUp()) return null;
  return (
    <section
      aria-label="Save your recovery key"
      className="glass rounded-2xl border border-amber-500/50 p-4"
      data-testid="recovery-key-prompt"
    >
      <h2 className="text-sm font-bold">Save your recovery key</h2>
      <p className="text-xs text-muted-foreground">
        It is the only way back into your account if this browser forgets you.
        Keep it private.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          data-testid="recovery-key-save"
          onClick={() => setOpen(true)}
          size="sm"
          type="button"
        >
          Save it now
        </Button>
        <Button
          data-testid="recovery-key-later"
          onClick={() => setAway(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Not now
        </Button>
      </div>
      {open ? (
        <RecoveryKeyDialog
          account={account}
          onClose={() => {
            setOpen(false);
            setSaved((n) => n + 1);
          }}
        />
      ) : null}
    </section>
  );
}
