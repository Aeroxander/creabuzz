/**
 * Under one offer to help, for the team: "Accept and make a task". The request's words become the task, the team
 * writes what "done" means, and the person who offered is told. Once a task stands for the offer, the button gives
 * way to a line saying so.
 *
 * And for the person who offered: a line saying their offer became a task.
 *
 * Tasks are read on their own (`useProjectTasks`). Until that read answers, the button is not offered: making a
 * second task for the same offer is what it would risk.
 */

import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/shared/ui/button";

import type { Offer } from "../lib/help-request";
import { isOpenTask } from "../lib/tasks";
import type { HelpAsk } from "../lib/weekly-update";
import type { Launch } from "../models";
import { useProjectTasks, useTaskActions } from "../use-tasks";
import { TaskForm } from "./TaskForm";

/** The task that stands for an offer: an open or finished one, never one that was cancelled or given up. */
function useOfferTask(launch: Launch, offerId: string) {
  const read = useProjectTasks(launch.record);
  const task =
    read.tasks?.find(
      (t) =>
        t.offerId === offerId && (isOpenTask(t) || t.state === "confirmed"),
    ) ?? null;
  return { read, task };
}

function TaskLink({ launch, id }: { launch: Launch; id: string }) {
  return (
    <Link
      className="text-foreground underline"
      hash={`task-${id}`}
      params={{ launchId: launch.record.id }}
      search={{ author: launch.record.author }}
      to="/launchpad/$launchId"
    >
      See the task
    </Link>
  );
}

export function OfferTask({
  launch,
  updateId,
  ask,
  offer,
  helperName,
}: {
  launch: Launch;
  updateId: string;
  ask: HelpAsk;
  offer: Offer;
  helperName: string;
}) {
  const { read, task } = useOfferTask(launch, offer.id);
  const { make } = useTaskActions(launch.record);
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  if (task)
    return (
      <p className="mt-1 text-sm" data-testid="offer-task-made" role="status">
        {said ?? "This offer is now a task."}{" "}
        {task.state === "confirmed" ? (
          "The work was accepted."
        ) : (
          <TaskLink id={task.id} launch={launch} />
        )}
      </p>
    );
  if (read.failed)
    return (
      <p className="mt-1 text-sm" role="alert">
        Couldn't check this project's tasks.{" "}
        <Button onClick={read.retry} size="sm" type="button" variant="outline">
          Try again
        </Button>
      </p>
    );
  if (!read.tasks) return null;
  if (!open)
    return (
      <Button
        aria-label={`Accept ${helperName}'s offer and make a task`}
        className="mr-2 mt-1"
        data-testid="offer-accept"
        onClick={() => {
          make.reset();
          setOpen(true);
        }}
        size="sm"
        type="button"
      >
        Accept and make a task
      </Button>
    );
  return (
    <TaskForm
      busy={make.isPending}
      failed={make.isError ? "The task was not made." : null}
      fixed={{ what: ask.text, size: ask.size }}
      onCancel={() => setOpen(false)}
      onSend={(draft) =>
        make.mutate(
          {
            helper: offer.author,
            what: draft.what,
            done: draft.done,
            size: draft.size,
            due: draft.due,
            updateId,
            offerId: offer.id,
          },
          {
            onSuccess: (sent) => {
              setOpen(false);
              setSaid(
                sent.adopted && sent.changed
                  ? "An earlier try had already gone through, so the task was saved as it was then."
                  : `Task made. ${helperName} is told.`,
              );
            },
          },
        )
      }
      testId="offer-task-form"
      title={`Make a task for ${helperName}`}
    />
  );
}

/** For the person who offered: their offer became a task. */
export function MyOfferTask({
  launch,
  offerId,
}: {
  launch: Launch;
  offerId: string;
}) {
  const { task } = useOfferTask(launch, offerId);
  if (!task) return null;
  return (
    <p className="mt-1 text-sm" data-testid="my-offer-task">
      The team accepted your offer and made it a task.{" "}
      {task.state === "confirmed" ? (
        "Your work was accepted."
      ) : (
        <TaskLink id={task.id} launch={launch} />
      )}
    </p>
  );
}
