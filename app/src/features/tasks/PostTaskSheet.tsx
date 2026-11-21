import { useState } from "react";
import { Button } from "../../ui/button";
import { Field } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import type { Project } from "../project/project-record";
import { postTaskRecord, TASK_WHAT_MAX } from "./task-record";
import { dollarsProblem, dollarsWords, TASK_PROBLEM } from "./tasks-copy";
import { useTaskWrite } from "./use-tasks";

/**
 * Post a task anyone outside the team can take: what it is, and what it pays. The plan's budget is 2 presses (open
 * this sheet, Post) and 2 boxes. The money moves only when the team accepts the work, from the runner's own wallet.
 */
export function PostTaskSheet({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [what, setWhat] = useState("");
  const [dollars, setDollars] = useState("");
  const [tried, setTried] = useState(false);
  const write = useTaskWrite(project);
  const toast = useToast();
  const whatProblem = what.trim() ? null : "Say what needs doing.";
  const moneyProblem = dollarsProblem(dollars);
  return (
    <Sheet
      description="Anyone outside the team can take it. You pay when you accept the work."
      onOpenChange={onOpenChange}
      open={open}
      testId="post-task-sheet"
      title="Post a task"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (whatProblem || moneyProblem || write.isPending) return;
          const usd = Number(dollars.trim().replace(/,/g, ""));
          write.mutate(
            {
              record: postTaskRecord(project.coordinate, what, usd),
              failure: TASK_PROBLEM.post,
            },
            {
              onSuccess: () => {
                toast(`Posted: a task that pays ${dollarsWords(usd)}.`, "done");
                setWhat("");
                setDollars("");
                setTried(false);
                onOpenChange(false);
              },
              onError: (error) => toast(error.message, "problem"),
            },
          );
        }}
      >
        <Field
          count={{ used: what.length, max: TASK_WHAT_MAX }}
          data-testid="task-what"
          hint="One thing, with its finish line: what will exist when it is done."
          label="What needs doing"
          maxLength={TASK_WHAT_MAX}
          onChange={(e) => setWhat(e.target.value)}
          problem={tried ? whatProblem : null}
          value={what}
        />
        <Field
          data-testid="task-dollars"
          hint="Whole dollars, paid when you accept the work."
          inputMode="numeric"
          label="It pays (dollars)"
          onChange={(e) => setDollars(e.target.value)}
          problem={tried ? moneyProblem : null}
          value={dollars}
        />
        <Button
          block
          data-testid="task-post"
          disabled={write.isPending}
          type="submit"
        >
          {write.isPending ? "Posting…" : "Post"}
        </Button>
      </form>
    </Sheet>
  );
}
