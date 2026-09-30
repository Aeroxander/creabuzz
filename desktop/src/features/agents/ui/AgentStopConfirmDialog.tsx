import { useState } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import { truncatePubkey } from "@/shared/lib/pubkey";
import type { AgentStopReport } from "../lib/agentStopSequence";

/** One agent the dialog is about to stop. */
export type AgentStopTarget = {
  pubkey: string;
  /** Human-readable name shown in the copy. */
  name: string;
};

type AgentStopConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: AgentStopTarget[];
  /** Runs the stop sequence; per-step failures come back in the reports. */
  run: (ban: boolean) => Promise<AgentStopReport[]>;
  /** Called after every run so surfaces re-read agents and seats. */
  onFinished: () => void | Promise<void>;
};

const STEP_LABELS: Record<string, string> = {
  budget: "Setting the stop budget",
  ban: "Banning",
  seats: "Removing its seats",
  grants: "Revoking its permissions",
};

function failureLines(
  reports: AgentStopReport[],
  targets: AgentStopTarget[],
): string[] {
  const lines: string[] = [];
  for (const report of reports) {
    const failed = report.steps.filter((s) => !s.ok);
    if (failed.length === 0) continue;
    const labels = failed.map((s) => STEP_LABELS[s.step] ?? s.step).join(", ");
    const name =
      targets.find((t) => t.pubkey === report.agent)?.name ??
      truncatePubkey(report.agent);
    lines.push(`${name}: ${labels}`);
  }
  return lines;
}

/**
 * The destructive confirm for an emergency stop: names the agent, offers the
 * optional ban, and — on a partial failure — says exactly which step failed
 * and that re-running resumes (the finished steps never run twice).
 */
export function AgentStopConfirmDialog({
  open,
  onOpenChange,
  targets,
  run,
  onFinished,
}: AgentStopConfirmDialogProps) {
  const [ban, setBan] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);

  const one = targets.length === 1;
  const names = targets.map((t) => t.name).join(", ");

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setBan(false);
      setFailures([]);
    }
    onOpenChange(next);
  };

  const confirm = async () => {
    setIsPending(true);
    setFailures([]);
    try {
      const reports = await run(ban);
      await onFinished();
      const lines = failureLines(reports, targets);
      if (lines.length === 0) {
        onOpenChange(false);
      } else {
        setFailures(lines);
      }
    } catch (error) {
      // A throw means the run never produced reports (e.g. signing refused);
      // say what happened and keep the dialog open so the button is the resume.
      setFailures([error instanceof Error ? error.message : String(error)]);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <AlertDialog onOpenChange={handleOpenChange} open={open}>
      <AlertDialogContent data-testid="agent-stop-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {one ? `Stop ${names}?` : `Stop ${targets.length} agents?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {one ? names : names} will be stopped: no budget, no permissions,
            and removed from its seats.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <input
            checked={ban}
            className="size-4"
            data-testid="agent-stop-ban-toggle"
            disabled={isPending}
            onChange={(e) => setBan(e.target.checked)}
            type="checkbox"
          />
          {one ? "Also ban this agent" : "Also ban these agents"}
        </label>
        {failures.length > 0 ? (
          <div
            aria-live="polite"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive"
            data-testid="agent-stop-failure"
            role="status"
          >
            <p className="font-medium">
              Stopping didn't finish. Try again — the steps that already
              finished won't run twice.
            </p>
            <ul className="mt-1 list-disc pl-4">
              {failures.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <AlertDialogFooter>
          <Button
            autoFocus
            data-testid="agent-stop-cancel"
            disabled={isPending}
            onClick={() => handleOpenChange(false)}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            data-testid="agent-stop-confirm"
            disabled={isPending}
            onClick={() => {
              void confirm();
            }}
            size="sm"
            type="button"
            variant="destructive"
          >
            {one ? "Stop agent" : "Stop agents"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
