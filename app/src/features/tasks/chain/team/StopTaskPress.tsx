/**
 * After a plan was withdrawn on the network (plan section 5.7): offers, and never forces, to stop the task on the team's list
 * too. The server accepts that step only once the network no longer holds the task, so the order is always network first.
 */
import { useState } from "react";
import { Button } from "../../../../ui/button";
import { useToast } from "../../../../ui/toast";
import { cancelRecord } from "../../task-record";
import { useTaskWrite } from "../../use-tasks";
import type { TaskSlotProps } from "../slot-props";
import { STOP_DONE, STOP_NOTE, STOP_OPEN, STOP_WORDS } from "./pay-words";

export function StopTaskPress({ project, task }: TaskSlotProps) {
  const write = useTaskWrite(project);
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2" data-testid="stop-task">
      <p className="text-sm">{STOP_WORDS}</p>
      {problem ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid="stop-task-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <Button
        data-testid="stop-task-press"
        disabled={write.isPending}
        onClick={() => {
          setProblem(null);
          write.mutate(
            {
              record: cancelRecord(project.coordinate, task, STOP_NOTE),
              failure:
                "The task was not stopped. Check your connection and try again.",
            },
            {
              onSuccess: () => toast(STOP_DONE, "done"),
              onError: (error) => setProblem(error.message),
            },
          );
        }}
        variant="secondary"
      >
        {write.isPending ? "Stopping…" : STOP_OPEN}
      </Button>
    </div>
  );
}
