import { useEffect, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { runAgentStopAll } from "../lib/agentStopFlow";
import type { AgentStopReport } from "../lib/agentStopSequence";

/** One agent the dialog is about to stop. */
export type AgentStopTarget = {
  pubkey: string;
  /** Human-readable name shown in the copy. */
  name: string;
};

type AgentStopDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: AgentStopTarget[];
  /** Called after every run so the seat lists re-read. */
  onFinished?: () => void;
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
    const name =
      targets.find((t) => t.pubkey === report.agent)?.name ??
      truncatePubkey(report.agent);
    lines.push(
      `${name}: ${failed.map((s) => STEP_LABELS[s.step] ?? s.step).join(", ")}`,
    );
  }
  return lines;
}

/**
 * The destructive confirm for an emergency stop: names the agent, offers the
 * optional ban, and — on a partial failure — says exactly which step failed
 * and that re-running resumes (the finished steps never run twice). Keyboard
 * and pointer are equal paths: Escape cancels, focus starts on Cancel and is
 * trapped in the dialog, and every control is a real button or checkbox.
 */
export function AgentStopDialog({
  open,
  onOpenChange,
  targets,
  onFinished,
}: AgentStopDialogProps) {
  const [ban, setBan] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const one = targets.length === 1;
  const names = targets.map((t) => t.name).join(", ");

  useEffect(() => {
    if (!open) return;
    setBan(false);
    setFailures([]);
    cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isPending) {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key !== "Tab") return;
      // Keep the keyboard inside the dialog until it closes.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, isPending, onOpenChange]);

  const confirm = async () => {
    setIsPending(true);
    setFailures([]);
    try {
      const reports = await runAgentStopAll(
        targets.map((t) => t.pubkey),
        { ban },
      );
      const lines = failureLines(reports, targets);
      if (lines.length === 0) {
        onOpenChange(false);
        // Refresh only on a full success: a partial failure keeps this dialog
        // (with the failed steps and the re-run button) on screen instead of
        // navigating the recovery affordance away.
        onFinished?.();
      } else {
        setFailures(lines);
      }
    } catch (error) {
      // The run never produced reports (e.g. signing refused): say what
      // happened and keep the dialog open so the button is the resume.
      setFailures([error instanceof Error ? error.message : String(error)]);
    } finally {
      setIsPending(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        aria-describedby="agent-stop-description"
        aria-labelledby="agent-stop-title"
        aria-modal="true"
        className="w-full max-w-sm rounded-lg border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-black"
        ref={panelRef}
        role="alertdialog"
      >
        <h2
          className="text-sm font-semibold text-black dark:text-white"
          id="agent-stop-title"
        >
          {one ? `Stop ${names}?` : `Stop ${targets.length} agents?`}
        </h2>
        <p
          className="mt-1 text-xs text-black/60 dark:text-white/60"
          id="agent-stop-description"
        >
          {names} will be stopped: no budget, no permissions, and removed from
          its seats.
        </p>
        <label className="mt-3 flex items-center gap-2 text-xs text-black dark:text-white">
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
            className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
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
        <div className="mt-4 flex justify-end gap-2">
          <Button
            data-testid="agent-stop-cancel"
            disabled={isPending}
            onClick={() => onOpenChange(false)}
            ref={cancelRef}
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
        </div>
      </div>
    </div>
  );
}
