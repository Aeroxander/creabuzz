/**
 * What a reader can do about someone else's post or reply: report it to the moderators, and, for the board's owners and
 * admins, remove it; for the community's owners and admins, ban the person. Nobody is offered these on their own words
 * (they have Delete). Each says what it does before it is done.
 */

import { useState } from "react";

import { useBanAuthor } from "@/features/communities/ui/BanAuthor";
import { ReportDialog } from "@/features/moderation/ui/ReportDialog";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

export function BoardModeration({
  kind,
  id,
  author,
  name,
  me,
  canRemove,
  needAccount,
  onRemove,
  disabled = false,
}: {
  kind: "post" | "reply";
  id: string;
  author: string;
  name: string;
  me: string | null;
  /** The reader owns or administers this board. */
  canRemove: boolean;
  /** Tells a signed-out reader to make an account; true when they have one. */
  needAccount: (action: string) => boolean;
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  const [reporting, setReporting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const ban = useBanAuthor(author, name);
  if (me !== null && me === author) return null;
  const noun = kind === "post" ? "post" : "reply";
  const button = "underline disabled:opacity-50";
  return (
    <>
      <button
        className={button}
        data-testid={`board-report-${kind}`}
        disabled={disabled}
        onClick={() => {
          if (needAccount("report")) setReporting(true);
        }}
        type="button"
      >
        Report
      </button>
      {canRemove ? (
        <button
          className={button}
          data-testid={`board-remove-${kind}`}
          disabled={disabled}
          onClick={() => setRemoving(true)}
          type="button"
        >
          Remove
        </button>
      ) : null}
      {ban.allowed ? (
        <button
          className={button}
          data-testid={`board-ban-${kind}`}
          disabled={disabled}
          onClick={ban.start}
          type="button"
        >
          Ban
        </button>
      ) : null}
      {reporting ? (
        <ReportDialog
          onClose={() => setReporting(false)}
          target={{ kind: "message", eventId: id, authorPubkey: author }}
          what={`this ${noun}`}
        />
      ) : null}
      <ConfirmDialog
        confirmLabel="Remove"
        description={`This ${noun} will be removed for everyone on this board.`}
        onCancel={() => setRemoving(false)}
        onConfirm={() => {
          setRemoving(false);
          onRemove(id);
        }}
        open={removing}
        title={`Remove this ${noun}?`}
      />
      {ban.dialog}
    </>
  );
}
