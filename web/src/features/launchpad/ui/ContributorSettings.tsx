/**
 * The founder's settings for a contributor project (D111), and for an idea in a build without raises: what people read
 * about it, and taking it off Discover.
 *
 * The sale's checklist and auction set-up do not apply, so they are not here. The rest of the record (its DAO, Shares,
 * work areas and how it is funded) is kept exactly as published: an edit republishes it with only these words changed.
 */

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { NAME_MAX, PITCH_MAX } from "@/features/start/lib/contributor-project";
import { recordToInput } from "../lib/record-input";
import type { Launch } from "../models";
import { useCreateLaunch } from "../use-launches";
import { TextAreaField, TextField } from "./decision-fields";

/** Why these words cannot be saved, or null when they can. */
export function settingsProblem(name: string, pitch: string): string | null {
  if (name.trim() === "") return "Give the project a name.";
  if (name.trim().length > NAME_MAX)
    return `Keep the name to ${NAME_MAX} characters.`;
  if (pitch.trim() === "") return "Say in one sentence what it is.";
  if (pitch.trim().length > PITCH_MAX)
    return `Keep the sentence to ${PITCH_MAX} characters.`;
  return null;
}

export function ContributorSettings({
  launch,
  idea = false,
  isDeleting,
  onDelete,
}: {
  launch: Launch;
  /** An idea has no DAO or Shares yet: nothing about it is fixed on the network. */
  idea?: boolean;
  isDeleting: boolean;
  onDelete: () => Promise<void>;
}) {
  const { record } = launch;
  const save = useCreateLaunch();
  const [name, setName] = useState(record.name);
  const [pitch, setPitch] = useState(record.pitch);
  const [about, setAbout] = useState(record.longPitch ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const problem = settingsProblem(name, pitch);
  const changed =
    name.trim() !== record.name ||
    pitch.trim() !== record.pitch ||
    about.trim() !== (record.longPitch ?? "");

  const submit = async () => {
    if (problem || !changed) return;
    try {
      await save.mutateAsync(
        recordToInput(record, {
          name: name.trim(),
          pitch: pitch.trim(),
          longPitch: about.trim(),
        }),
      );
      toast.success("Saved.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't save. Try again.",
      );
    }
  };

  return (
    <div
      className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start"
      data-testid="contributor-settings"
    >
      <Card className="p-4">
        <h2 className="text-base font-semibold">
          {idea ? "About this idea" : "About this project"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {idea
            ? "What people read on Discover and on this page."
            : "What people read on Discover and on this page. The Shares' name and the work areas' words are fixed on the network and stay as they are."}
        </p>
        <div className="mt-3 grid gap-3">
          <TextField
            label="Name"
            onChange={setName}
            testId="settings-name"
            value={name}
          />
          <TextField
            hint="One sentence: what it is and who it is for."
            label="What it is"
            onChange={setPitch}
            testId="settings-pitch"
            value={pitch}
          />
          <TextAreaField
            label="More about it (optional)"
            onChange={setAbout}
            rows={4}
            testId="settings-about"
            value={about}
          />
        </div>
        {problem && changed ? (
          <p
            className="mt-2 text-sm text-red-700 dark:text-red-300"
            data-testid="settings-problem"
            role="alert"
          >
            {problem}
          </p>
        ) : null}
        <Button
          className="mt-3"
          data-testid="settings-save"
          disabled={!changed || problem !== null || save.isPending}
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </Card>

      <Card className="border-red-500/30 p-4">
        <h2 className="text-base font-semibold text-red-600">
          Take it off Discover
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {idea
            ? "The idea stops being listed."
            : "The project stops being listed. Its DAO, its Shares and everything already decided stay on the network."}
        </p>
        {confirmRemove ? (
          <div className="mt-2 flex gap-2">
            <Button
              data-testid="settings-remove-confirm"
              disabled={isDeleting}
              onClick={() => void onDelete()}
              size="sm"
              variant="destructive"
            >
              {isDeleting ? "Removing…" : "Take it off"}
            </Button>
            <Button
              onClick={() => setConfirmRemove(false)}
              size="sm"
              variant="outline"
            >
              Keep it listed
            </Button>
          </div>
        ) : (
          <Button
            className="mt-2"
            data-testid="settings-remove"
            onClick={() => setConfirmRemove(true)}
            size="sm"
            variant="destructive"
          >
            Take it off Discover
          </Button>
        )}
      </Card>
    </div>
  );
}
