/**
 * The founder's next steps while a project has no Shares and no sale: say something, gather supporters, then set up
 * what comes later. The later steps are the heavy part, so they wait until people have shown up.
 *
 * Setting up Shares for people who help is always here. It is the founder's one way to it from the project page, so
 * no other card or tab may take its place (a guard must not hide the only way back). A build that offers raises
 * (`raisesOffered`) also offers to prepare a sale.
 */

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { launchCoord } from "@/features/feed/ui/LaunchVoteCard";
import { PostComposer } from "@/features/social/ui/PostComposer";
import { useLaunchNotes } from "@/features/feed/use-feed";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { handOffIdea } from "@/features/start/lib/from-idea";

import { gateProgress } from "../lib/idea";
import { raisesOffered } from "../lib/raises-offered";
import { recordToInput } from "../lib/record-input";
import type { Launch } from "../models";
import { ensureRooms, setupNotice } from "../use-launch-chat";
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
  const raises = raisesOffered();
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
      const notice = setupNotice(ensured);
      toast.success(notice ? `Sale prepared. ${notice}` : "Sale prepared.");
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
      <h2 className="text-sm font-bold">Next steps</h2>
      <p className="text-xs text-muted-foreground">
        {raises
          ? "No token or price yet. Build interest first; set up the sale when you are ready."
          : "Your project is live. Post an update each week, and do these when you are ready."}
      </p>
      <ul className="mt-2 divide-y divide-border/60">
        <Step done={announced} title="Announce it">
          {writing ? (
            <div className="mt-1.5">
              <PostComposer
                initialText={`I'm starting ${record.name}: ${record.pitch}\n\n${raises ? "Say you'd back it and join the chat." : "Follow it to see how it goes."}`}
                onPosted={() => setWriting(false)}
                teamUpdateFor={{
                  author: record.author,
                  id: record.id,
                  name: record.name,
                }}
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
        {raises ? (
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
        ) : null}
        <Step done={false} title="Set up Shares for people who help">
          <p className="mt-0.5 text-xs text-muted-foreground">
            Set up the work and who reviews it. People who help get Shares,
            which are votes in the project, when the project votes to award
            them. It stays the same project, with its goal and updates.
          </p>
          <Button
            asChild
            className="mt-1.5"
            data-testid="idea-start-contributor"
            size="sm"
            variant={raises ? "outline" : "default"}
          >
            <Link
              onClick={() =>
                handOffIdea(localStorage, {
                  server: relayWsUrl(),
                  id: record.id,
                  author: record.author,
                  name: record.name,
                  pitch: record.pitch,
                })
              }
              to="/start/contributor"
            >
              Set up Shares
            </Link>
          </Button>
        </Step>
      </ul>
      {raises && preparing ? (
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
