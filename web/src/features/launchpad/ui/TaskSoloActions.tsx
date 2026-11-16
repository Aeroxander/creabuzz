/**
 * What a founder with nobody else on the project does on their own task: "I did it". Two places use it. A task not
 * yet handed in opens the "What did you get done?" box (`SoloWinDialog`, in finish mode). Work already handed in and
 * waiting for a check is checked by the founder in one press, here. Either way the work shows as done, checked by the
 * founder, and is counted apart from work someone else accepted.
 *
 * A task for someone else keeps its two steps and its own buttons.
 */

import type { UseMutationResult } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";

import { AGENT_NEEDS_PERSON } from "../use-account-agent";
import { withReason } from "../lib/removals";
import type { TaskEvidence, TaskView } from "../lib/tasks";
import type { TaskSent } from "../use-tasks";
import { SendFailed } from "./TaskParts";

const SOLO_CHECK_LINE =
  "You are the only person here, so you check it yourself.";
export const DID_IT = "I did it";
/** The same check, of work an agent the founder runs did: the founder did not do it, so it is not "I did it". */
const MARK_DONE = "Mark as done";
const AGENT_CHECK_LINE =
  "Nobody else is on this project yet, so you check this work yourself.";

/** The founder's own check of work already handed in: one "I did it" per piece waiting. */
export function SoloCheckAlone({
  own,
  task,
  waiting,
  pieceName,
  agentViewer,
  confirm,
  onChecked,
  notAsRead,
  expected,
}: {
  /** The founder did the work themself ("I did it"), not an agent they run ("Mark as done"). */
  own: boolean;
  task: Pick<TaskView, "id" | "helper" | "madeBy" | "evidence">;
  waiting: readonly TaskEvidence[];
  pieceName: (piece: TaskEvidence) => string;
  agentViewer: boolean;
  confirm: UseMutationResult<
    TaskSent,
    Error,
    {
      task: { id: string; helper: string; madeBy: string };
      evidenceId: string;
      seen: readonly string[];
    }
  >;
  onChecked: (sent: TaskSent) => void;
  notAsRead: (gone: string) => (error: unknown) => void;
  expected: (error: unknown) => boolean;
}) {
  const sayId = useId();
  const [marking, setMarking] = useState<string | null>(null);
  const mark = (piece: TaskEvidence) =>
    confirm.mutate(
      {
        task: { id: task.id, helper: task.helper, madeBy: task.madeBy },
        evidenceId: piece.id,
        seen: task.evidence.map((p) => p.id),
      },
      {
        onSuccess: onChecked,
        onError: notAsRead(
          "That work was removed before you checked it, so nothing was saved.",
        ),
      },
    );
  return (
    <div className="mt-2" data-testid="task-check-alone">
      <p className="text-sm" id={`${sayId}-says`}>
        {own ? SOLO_CHECK_LINE : AGENT_CHECK_LINE}
      </p>
      {agentViewer ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="task-agent-no-confirm"
        >
          {AGENT_NEEDS_PERSON}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {waiting.map((piece) => (
            <li key={piece.id}>
              <Button
                aria-describedby={`${sayId}-says`}
                data-task-focus={`done-alone-${piece.id}`}
                data-testid="task-mark-done"
                disabled={confirm.isPending}
                onClick={() => {
                  setMarking(piece.id);
                  mark(piece);
                }}
                size="sm"
                type="button"
              >
                {confirm.isPending && marking === piece.id
                  ? "Saving…"
                  : `${own ? DID_IT : MARK_DONE}${pieceName(piece)}`}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {confirm.isError && !expected(confirm.error) ? (
        <SendFailed
          onRetry={() => {
            const piece = waiting.find((p) => p.id === marking);
            if (piece) mark(piece);
          }}
          testId="task-mark-done-failed"
        >
          {withReason("The work was not saved as done.", confirm.error)}
        </SendFailed>
      ) : null}
    </div>
  );
}
