/**
 * What a reader can do about a post or reply: report someone else's words to the moderators, and, in one Moderate menu,
 * whatever the server would let this reader do here. For a thread: pin or unpin it, lock or unlock it (an undo only for
 * someone of at least the standing of whoever did it). For someone else's words: remove them, mute their author on
 * this board, or ban them from the community. Locking and removing ask for an optional public reason first; muting and
 * banning have their own dialogs.
 */

import { useState } from "react";
import { toast } from "sonner";

import { useBanAuthor } from "@/features/communities/ui/BanAuthor";
import { ReportDialog } from "@/features/moderation/ui/ReportDialog";

import type { MuteChoice, ThreadAction } from "../lib/board-moderation";
import { type ModerateItem, ModerateMenu } from "./ModerateMenu";
import { MuteDialog } from "./MuteDialog";
import { ReasonDialog } from "./ReasonDialog";
import { failureWords } from "@/shared/lib/readable-error";

/** What the menu offers for a thread (a post only), as the server decides it for this reader. */
export interface ThreadControls {
  locked: boolean;
  pinned: boolean;
  /** Lock it, or (when locked) unlock it: false when the lock was placed by someone of higher standing. */
  canToggleLock: boolean;
  /** Pin it, or (when pinned) unpin it. */
  canTogglePin: boolean;
  onThread: (action: ThreadAction, reason?: string) => Promise<unknown>;
}

type Dialog = "report" | "remove" | "lock" | "mute" | null;

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
  thread = null,
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
  /** Remove it, with the public reason (empty for none). */
  onRemove: (id: string, reason: string) => Promise<unknown>;
  thread?: ThreadControls | null;
  disabled?: boolean;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const ban = useBanAuthor(author, name);
  const mine = me !== null && me === author;
  const noun = kind === "post" ? "post" : "reply";

  const threadAction = (action: ThreadAction, done: string) => {
    thread
      ?.onThread(action)
      .then(() => toast.success(done))
      .catch((error: unknown) =>
        toast.error("That did not go through", {
          description: failureWords(error).text,
        }),
      );
  };

  const items: ModerateItem[] = [];
  if (thread?.canTogglePin) {
    items.push(
      thread.pinned
        ? {
            label: "Unpin thread",
            testId: "board-thread-pin",
            onSelect: () => threadAction("unpin", "Thread unpinned."),
          }
        : {
            label: "Pin to the top of the board",
            testId: "board-thread-pin",
            onSelect: () =>
              threadAction("pin", "Thread pinned to the top of the board."),
          },
    );
  }
  if (thread?.canToggleLock) {
    items.push(
      thread.locked
        ? {
            label: "Unlock thread",
            testId: "board-thread-lock",
            onSelect: () => threadAction("unlock", "Thread unlocked."),
          }
        : {
            label: "Lock thread…",
            testId: "board-thread-lock",
            onSelect: () => setDialog("lock"),
          },
    );
  }
  if (!mine && canRemove) {
    items.push({
      label: `Remove ${noun}…`,
      testId: `board-remove-${kind}`,
      onSelect: () => setDialog("remove"),
      destructive: true,
    });
  }
  if (!mine && mute) {
    items.push({
      label: `Mute ${name} on this board…`,
      testId: `board-mute-${kind}`,
      onSelect: () => setDialog("mute"),
    });
  }
  if (!mine && ban.allowed) {
    items.push({
      label: `Ban ${name} from the community…`,
      testId: `board-ban-${kind}`,
      onSelect: ban.start,
      destructive: true,
    });
  }

  return (
    <>
      {!mine ? (
        <button
          className="underline disabled:opacity-50"
          data-testid={`board-report-${kind}`}
          disabled={disabled}
          onClick={() => {
            if (needAccount("report")) setDialog("report");
          }}
          type="button"
        >
          Report
        </button>
      ) : null}
      <ModerateMenu
        disabled={disabled}
        items={items}
        testId={`board-moderate-${kind}`}
      />
      {dialog === "report" ? (
        <ReportDialog
          onClose={() => setDialog(null)}
          setting="board"
          target={{ kind: "message", eventId: id, authorPubkey: author }}
          what={`this ${noun}`}
        />
      ) : null}
      {dialog === "remove" ? (
        <ReasonDialog
          confirmLabel="Remove"
          description={`This ${noun} will be removed for everyone on this board. The removal and your reason go in the board's moderation log.`}
          destructive
          onClose={() => setDialog(null)}
          onConfirm={(reason) => onRemove(id, reason)}
          testId="board-remove-dialog"
          title={`Remove this ${noun}?`}
        />
      ) : null}
      {dialog === "lock" && thread ? (
        <ReasonDialog
          confirmLabel="Lock"
          description="Only this board's moderators, owners and admins can reply now; everyone can still read it and vote. It goes in the board's moderation log with your reason."
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            await thread.onThread("lock", reason);
            toast.success(
              "Thread locked. Only moderators, owners and admins can reply.",
            );
          }}
          testId="board-lock-dialog"
          title="Lock this thread?"
        />
      ) : null}
      {dialog === "mute" && mute ? (
        <MuteDialog
          choices={mute.choices}
          name={name}
          onClose={() => setDialog(null)}
          onMute={mute.onMute}
        />
      ) : null}
      {ban.dialog}
    </>
  );
}
