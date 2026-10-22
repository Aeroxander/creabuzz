/**
 * What a reader can do about someone else's post or reply: report it to the moderators; for the board's moderators,
 * owners and admins, remove it or mute its author on this board; for the community's owners and admins, ban the person.
 * Nobody is offered these on their own words (they have Delete). Each says what it does before it is done.
 */

import { useState } from "react";

import { useBanAuthor } from "@/features/communities/ui/BanAuthor";
import { ReportDialog } from "@/features/moderation/ui/ReportDialog";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

import type { MuteChoice } from "../lib/board-moderation";
import { MuteDialog } from "./MuteDialog";

export function BoardModeration({
  kind,
  id,
  author,
  name,
  me,
  canRemove,
  needAccount,
  onRemove,
  mute,
  disabled = false,
}: {
  kind: "post" | "reply";
  id: string;
  author: string;
  name: string;
  me: string | null;
  /** The reader may remove this: they own or administer the board, or moderate it and outrank the author. */
  canRemove: boolean;
  /** Offered when the reader may mute the author on this board. */
  mute?: {
    choices: MuteChoice[];
    onMute: (days: number, reason: string) => Promise<unknown>;
  } | null;
  /** Tells a signed-out reader to make an account; true when they have one. */
  needAccount: (action: string) => boolean;
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  const [reporting, setReporting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [muting, setMuting] = useState(false);
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
      {mute ? (
        <button
          className={button}
          data-testid={`board-mute-${kind}`}
          disabled={disabled}
          onClick={() => setMuting(true)}
          type="button"
        >
          Mute here
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
      {muting && mute ? (
        <MuteDialog
          choices={mute.choices}
          name={name}
          onClose={() => setMuting(false)}
          onMute={mute.onMute}
        />
      ) : null}
      {ban.dialog}
    </>
  );
}
