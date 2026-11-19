import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { useState } from "react";
import { nameOf, type ProfileMetadata } from "../../lib/profiles";
import { useRequireAccount } from "../../lib/use-require-account";
import { Button } from "../../ui/button";
import { TextArea } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import type { ProjectNumbers } from "../money/numbers";
import { useConnectWallet } from "../money/use-money";
import type { Project } from "../project/project-record";
import { AcceptAndPay } from "./AcceptAndPay";
import {
  handInRecord,
  nextFor,
  type ProjectTask,
  takeRecord,
} from "./task-record";
import {
  dollarsWords,
  payProblem,
  STATE_WORDS,
  TASK_PROBLEM,
} from "./tasks-copy";
import { useTaskWrite } from "./use-tasks";

/** One task: what it is, what it pays, who has it, and the one thing this person can do on it. */
export function TaskCard({
  project,
  task,
  me,
  team,
  agents,
  operators,
  profiles,
  numbers,
  address,
}: {
  project: Project;
  task: ProjectTask;
  me: string | null;
  team: ReadonlySet<string>;
  agents: ReadonlySet<string>;
  /** Each agent account and the person who runs it. */
  operators: ReadonlyMap<string, string>;
  profiles: Record<string, ProfileMetadata> | undefined;
  /** The project's numbers where the server turns money on; null where it does not (nothing about money shows). */
  numbers: ProjectNumbers | null;
  address: string | null;
}) {
  const money = numbers !== null;
  const next = nextFor(task, me, team, {
    founder: project.author,
    agents,
    operators,
  });
  // An agent account checks no work: it is never offered the press.
  const mayAccept = next === "accept" && !(me && agents.has(me));
  return (
    <article
      className="plain flex flex-col gap-2 rounded-2xl p-4"
      data-state={task.state}
      data-testid="task-card"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span data-testid="task-state">{STATE_WORDS[task.state]}</span>
        <span>{relativeTime(task.at)}</span>
      </div>
      <h3 className="font-semibold">{task.what}</h3>
      {money && task.usd !== null ? (
        <p className="num text-sm font-semibold" data-testid="task-pays">
          Pays {dollarsWords(task.usd)} on accept
        </p>
      ) : null}
      {task.worker ? (
        <p className="text-sm text-muted" data-testid="task-worker">
          {task.worker === me ? "You" : nameOf(profiles, task.worker)}
          {agents.has(task.worker) ? (
            <span
              className="ml-2 rounded-full bg-white/10 px-2 py-0.5 text-2xs font-semibold text-ink"
              data-testid="agent-label"
            >
              Agent
            </span>
          ) : null}
          {task.state === "accepted" ? " did this." : " has it."}
        </p>
      ) : null}
      {task.handIn && task.state !== "open" ? (
        <p className="whitespace-pre-wrap break-words text-sm">
          {task.handIn.note}
        </p>
      ) : null}
      {next === "take" ? (
        <TakeButton money={money} project={project} task={task} />
      ) : null}
      {next === "hand-in" ? <HandIn project={project} task={task} /> : null}
      {next === "own-work" ? (
        <p className="text-sm text-muted" data-testid="task-own-work">
          {TASK_PROBLEM.ownWork}
        </p>
      ) : null}
      {mayAccept ? (
        <AcceptAndPay
          address={address}
          numbers={numbers}
          project={project}
          task={task}
        />
      ) : null}
    </article>
  );
}

/**
 * Take an open task: one press. Where money is on, the wallet is asked for its account first, so the team knows where
 * to pay; a person without one is told before anything is signed.
 */
function TakeButton({
  project,
  task,
  money,
}: {
  project: Project;
  task: ProjectTask;
  money: boolean;
}) {
  const write = useTaskWrite(project);
  const connect = useConnectWallet();
  const requireAccount = useRequireAccount();
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const take = async () => {
    setProblem(null);
    let payTo: string | null = null;
    if (money) {
      try {
        payTo = await connect.mutateAsync();
      } catch (error) {
        setProblem(payProblem(error));
        return;
      }
    }
    write.mutate(
      {
        record: takeRecord(project.coordinate, task, payTo),
        failure: TASK_PROBLEM.take,
      },
      {
        onSuccess: () => toast("It's yours. Hand the work in here.", "done"),
        onError: (error) => setProblem(error.message),
      },
    );
  };
  return (
    <div className="flex flex-col gap-2">
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
      <Button
        block
        data-testid="task-take"
        disabled={write.isPending || connect.isPending}
        onClick={() => requireAccount(() => void take())}
        variant="secondary"
      >
        {write.isPending ? "Taking…" : "Take this task"}
      </Button>
    </div>
  );
}

/** Hand work in: a few words of what was done and where to look. */
function HandIn({ project, task }: { project: Project; task: ProjectTask }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const write = useTaskWrite(project);
  const toast = useToast();
  return (
    <>
      <Button
        block
        data-testid="task-hand-in"
        onClick={() => setOpen(true)}
        variant="secondary"
      >
        Hand in the work
      </Button>
      <Sheet
        description="Someone on the team checks it."
        onOpenChange={setOpen}
        open={open}
        testId="hand-in-sheet"
        title="Hand in the work"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim() || write.isPending) return;
            write.mutate(
              {
                record: handInRecord(project.coordinate, task, note),
                failure: TASK_PROBLEM.handIn,
              },
              {
                onSuccess: () => {
                  toast("Handed in. The team checks it next.", "done");
                  setOpen(false);
                  setNote("");
                },
                onError: (error) => toast(error.message, "problem"),
              },
            );
          }}
        >
          <TextArea
            data-testid="task-note"
            hint="What you did, and a link to it."
            label="What you did"
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            value={note}
          />
          <Button
            block
            data-testid="task-hand-in-send"
            disabled={write.isPending || !note.trim()}
            type="submit"
          >
            {write.isPending ? "Sending…" : "Hand in"}
          </Button>
        </form>
      </Sheet>
    </>
  );
}
