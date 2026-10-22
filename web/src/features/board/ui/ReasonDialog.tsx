/**
 * Confirm a moderation action and, optionally, say why. The reason is public: it goes in the board's moderation log
 * and, for a removed reply, in the note left in its thread. The server's reason is shown if it refuses.
 */

import { useState } from "react";

import { Modal } from "@/features/launchpad/ui/Modal";
import { Button } from "@/shared/ui/button";

import { REASON_MAX_CHARS } from "../lib/board-moderation";

export function ReasonDialog({
  title,
  description,
  confirmLabel,
  destructive = false,
  testId,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  testId: string;
  onConfirm: (reason: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = `${testId}-reason`;

  const send = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (error) {
      setProblem(
        error instanceof Error && error.message
          ? error.message
          : "That did not go through. Try again.",
      );
      setBusy(false);
    }
  };

  return (
    <Modal label={title} onClose={onClose}>
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      <form
        className="mt-4 flex flex-col gap-3"
        data-testid={testId}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div>
          <label className="text-sm font-medium" htmlFor={inputId}>
            Reason (public, optional)
          </label>
          <input
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            data-testid={inputId}
            id={inputId}
            maxLength={REASON_MAX_CHARS}
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
        </div>
        {problem ? (
          <p
            className="text-sm text-red-600 dark:text-red-400"
            data-testid={`${testId}-error`}
            role="alert"
          >
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            data-testid={`${testId}-submit`}
            disabled={busy}
            size="sm"
            type="submit"
            variant={destructive ? "destructive" : "default"}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
