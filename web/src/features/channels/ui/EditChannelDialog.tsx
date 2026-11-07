/**
 * Change a room or board after it is made: its name, its description, and who can read it. Offered to its owners and
 * admins, the only people the server lets change it; only what was changed is sent. Changing who can read it says
 * plainly what that does before it is saved.
 *
 * The form starts from the room as it is when the dialog is made: mount it only while it is open, so each opening
 * starts afresh and a change arriving from elsewhere does not overwrite what is being typed.
 */

import * as React from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";

import { canAddMembers } from "@/features/board/lib/members";
import { useBoardMembers } from "@/features/board/use-board-members";
import { existingUserPubkey } from "@/shared/lib/identity";

import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import { FailureNote } from "@/shared/ui/failure-note";
import { Input } from "@/shared/ui/input";

import {
  type ChannelVisibilityChoice,
  canonicalChannelName,
  channelEdits,
} from "../lib/channel-create-events";
import type { Channel } from "../lib/channel-records";
import { useEditChannel } from "../use-edit-channel";

const FORM_ID = "edit-channel-form";

export function EditChannelDialog({
  channel,
  open,
  onOpenChange,
  fixedVisibility = false,
}: {
  channel: Channel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A project's board (D156) stays open to everyone in the community: who can read it is not offered. */
  fixedVisibility?: boolean;
}) {
  const noun = channel.type === "forum" ? "board" : "room";
  const current: ChannelVisibilityChoice =
    channel.visibility === "private" ? "private" : "open";
  const [name, setName] = React.useState(channel.name);
  const [description, setDescription] = React.useState(channel.description);
  const [visibility, setVisibility] = React.useState(current);
  const [error, setError] = React.useState<FailureWords | null>(null);
  const edit = useEditChannel(channel.id);
  // Who keeps it when it is made private: the people on its list now.
  const listed = useBoardMembers(channel.id, true).members.length;

  const nameMissing = canonicalChannelName(name) === "";
  const edits = nameMissing
    ? null
    : channelEdits(channel, { name, description, visibility });
  const why = nameMissing
    ? "Give it a name first."
    : edits === null
      ? "Nothing has changed yet."
      : null;

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (edits === null || edit.isPending) return;
    setError(null);
    edit.mutate(edits, {
      onSuccess: () => {
        toast.success(`The ${noun} was updated.`);
        onOpenChange(false);
      },
      onError: (cause) => {
        const words = failureWords(
          cause,
          "The server did not save the changes. Try again in a moment.",
        );
        // The server's refusal for someone who may not edit names its tags ("actor not authorized for name/about/…").
        setError(
          /not authori[sz]ed/i.test(words.text)
            ? {
                text: `The server did not save the changes: only the ${noun}'s owners and admins can change it.`,
                detail: words.detail ?? words.text,
              }
            : words,
        );
      },
    });
  };

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next && edit.isPending) return;
        onOpenChange(next);
      }}
      open={open}
    >
      <AlertDialogContent
        className="max-w-lg"
        data-testid="edit-channel-dialog"
        // A form, not a question: start in the name field rather than on Cancel.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById("edit-channel-name")?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Edit #{channel.name}</AlertDialogTitle>
          <AlertDialogDescription>
            {fixedVisibility
              ? "Change its name or what it is for. Everyone who can read it sees the change."
              : "Change its name, what it is for, or who can read it. Everyone who can read it sees the change."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form className="space-y-4" id={FORM_ID} onSubmit={save}>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="edit-channel-name">
              Name
            </label>
            <Input
              autoComplete="off"
              data-testid="edit-channel-name"
              id="edit-channel-name"
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              required
              value={name}
            />
          </div>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="edit-channel-description"
            >
              What it is for
            </label>
            <Input
              autoComplete="off"
              data-testid="edit-channel-description"
              id="edit-channel-description"
              maxLength={300}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={`What this ${noun} is about`}
              value={description}
            />
          </div>
          {fixedVisibility ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="edit-channel-visibility-fixed"
            >
              A project's board stays open to everyone in the community, so
              anyone can join the discussion.
            </p>
          ) : (
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium"
                htmlFor="edit-channel-visibility"
              >
                Who can read it
              </label>
              <select
                aria-describedby={
                  visibility !== current
                    ? "edit-channel-visibility-note"
                    : undefined
                }
                className="h-9 w-full rounded-md border border-black/15 bg-white px-2 text-sm dark:border-white/15 dark:bg-white/5"
                data-testid="edit-channel-visibility"
                id="edit-channel-visibility"
                onChange={(e) =>
                  setVisibility(e.target.value as ChannelVisibilityChoice)
                }
                value={visibility}
              >
                <option value="open">Anyone in the community</option>
                <option value="private">Only people on its list</option>
              </select>
              {visibility !== current ? (
                <p
                  className="text-xs text-amber-800 dark:text-amber-300"
                  data-testid="edit-channel-visibility-note"
                  id="edit-channel-visibility-note"
                >
                  {visibility === "private"
                    ? `Only the people on its list will be able to read it, from the moment you save: ${listed === 1 ? "1 person is" : `${listed} people are`} on it now. Anyone else, including someone reading it now, loses it. You can add people from People on the ${noun}.`
                    : `Everyone in the community will be able to read it, including everything already said in it.`}
                </p>
              ) : null}
            </div>
          )}
          {error ? (
            <FailureNote failure={error} testId="edit-channel-error" />
          ) : null}
        </form>

        <AlertDialogFooter className="sm:items-center">
          {why !== null && !edit.isPending ? (
            <p
              className="text-xs text-black/60 sm:mr-auto dark:text-white/60"
              data-testid="edit-channel-why"
              id="edit-channel-why"
            >
              {why}
            </p>
          ) : null}
          <AlertDialogCancel disabled={edit.isPending}>
            Cancel
          </AlertDialogCancel>
          <Button
            aria-describedby={
              why !== null && !edit.isPending ? "edit-channel-why" : undefined
            }
            data-testid="edit-channel-save"
            disabled={why !== null || edit.isPending}
            form={FORM_ID}
            type="submit"
          >
            {edit.isPending ? "Saving…" : "Save changes"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * A chat room's "Edit room" button and its dialog, shown only to the room's owners and admins (read from its roster).
 * Not for a direct-message thread, which has nothing to edit.
 */
export function EditRoomButton({ channel }: { channel: Channel }) {
  const roster = useBoardMembers(channel.id, true);
  const [editing, setEditing] = React.useState(false);
  if (!canAddMembers(roster.members, existingUserPubkey())) return null;
  return (
    <>
      <button
        aria-haspopup="dialog"
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        data-testid="room-edit"
        onClick={() => setEditing(true)}
        type="button"
      >
        <Pencil className="h-3.5 w-3.5" />
        Edit room
      </button>
      {editing ? (
        <EditChannelDialog channel={channel} onOpenChange={setEditing} open />
      ) : null}
    </>
  );
}
