/**
 * The founder's next steps while a launch is still just an idea: say something,
 * gather supporters, then prepare the sale. The sale (token, split, price) is
 * the heavy part, so it waits until people have shown up.
 */

import { useState } from "react";
import { toast } from "sonner";

import { Composer } from "@/features/feed/ui/Composer";
import { launchCoord, launchRef } from "@/features/feed/ui/LaunchVoteCard";
import { useLaunchNotes } from "@/features/feed/use-feed";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { gateProgress } from "../lib/idea";
import { recordToInput } from "../lib/record-input";
import type { Launch } from "../models";
import { ensureRooms } from "../use-launch-chat";
import { useCreateLaunch, type CreateLaunchInput } from "../use-launches";
import { useSupporters } from "../use-supporters";
import { CreateLaunchDialog } from "./CreateLaunchDialog";
import { ProgressStep as Step } from "./ProgressStep";

export function IdeaProgressCard({ launch }: { launch: Launch }) {
  const { record } = launch;
  const coord = launchCoord(record);
  const supporters = useSupporters([coord]);
  const count = supporters.data?.get(coord) ?? null;
  const progress = gateProgress(count ?? 0);
  const notes = useLaunchNotes(coord);
  const [writing, setWriting] = useState(false);
  const announced =
    launch.updates.length > 0 ||
    (notes.data ?? []).some((note) => note.author === record.author);
  const save = useCreateLaunch();
  const [preparing, setPreparing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const prepare = async (input: CreateLaunchInput) => {
    setPublishError(null);
    try {
      // The backers room only matters once there is a sale to back; it is
      // created here, so an idea nobody backs never pays for it.
      const ensured = await ensureRooms({
        launchName: record.name,
        chat: record.chat,
        team: record.team.map((member) => member.pubkey),
        sale: true,
      });
      await save.mutateAsync({ ...input, chat: ensured.chat });
      toast.success(
        ensured.incomplete
          ? "Sale prepared. Some chat rooms can be added from this page."
          : "Sale prepared.",
      );
      setPreparing(false);
    } catch (error) {
      setPublishError(
        error instanceof Error
          ? error.message
          : "Could not publish. Try again.",
      );
    }
  };

  return (
    <Card className="p-4" data-testid="idea-progress">
      <h2 className="text-sm font-bold">Your idea is live</h2>
      <p className="text-xs text-muted-foreground">
        No token or price yet. Build interest first; set up the sale when you
        are ready.
      </p>
      <ul className="mt-2 divide-y divide-border/60">
        <Step done={announced} title="Announce it">
          {writing ? (
            <div className="mt-1.5">
              <Composer
                initialText={`I'm starting ${record.name}: ${record.pitch}\n\nSay you'd back it and join the chat.`}
                launch={launchRef(record)}
                onPosted={() => setWriting(false)}
                testId="idea-share"
              />
            </div>
          ) : (
            <Button
              className="mt-1.5"
              data-testid="idea-announce"
              onClick={() => setWriting(true)}
              size="sm"
              variant="outline"
            >
              Write the announcement
            </Button>
          )}
        </Step>
        <Step done={progress.open} title="Gather supporters">
          <div className="mt-1.5 flex items-center gap-3">
            <div
              aria-hidden
              className="h-2 w-40 overflow-hidden rounded-full bg-foreground/10"
            >
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <span
              className="text-xs tabular-nums text-muted-foreground"
              data-testid="idea-supporters"
            >
              {count === null ? "…" : count} of {progress.needed}
            </span>
          </div>
        </Step>
        <Step done={false} title="Prepare the sale">
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <Button
              data-testid="idea-prepare-sale"
              disabled={!progress.open}
              onClick={() => setPreparing(true)}
              size="sm"
            >
              Prepare the sale
            </Button>
            {!progress.open ? (
              <button
                className="text-xs text-muted-foreground underline"
                data-testid="idea-prepare-anyway"
                onClick={() => setPreparing(true)}
                type="button"
              >
                I already have backers elsewhere. Prepare anyway.
              </button>
            ) : null}
          </div>
        </Step>
      </ul>
      {preparing ? (
        <CreateLaunchDialog
          idea={recordToInput(record)}
          isCreating={save.isPending}
          onClose={() => setPreparing(false)}
          onCreate={prepare}
          publishError={publishError}
        />
      ) : null}
    </Card>
  );
}
