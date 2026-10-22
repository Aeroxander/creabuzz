/**
 * Mute someone on this board only. They can still read it and post everywhere else; the mute ends by itself. A moderator
 * sets up to seven days alone; a longer one starts at seven days and becomes the longer length only when a second
 * moderator asks for it too, within a day. The reason is public: it goes in the board's moderation log.
 */

import { useState } from "react";

import { Modal } from "@/features/launchpad/ui/Modal";
import { Button } from "@/shared/ui/button";

import {
  MODERATOR_MUTE_DAYS,
  type MuteChoice,
  REASON_MAX_CHARS,
} from "../lib/board-moderation";

export function MuteDialog({
  name,
  choices,
  onMute,
  onClose,
}: {
  name: string;
  choices: MuteChoice[];
  onMute: (days: number, reason: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [days, setDays] = useState<number>(1);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = choices.find((choice) => choice.days === days);

  const send = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onMute(days, reason);
      onClose();
    } catch (error) {
      setProblem(
        error instanceof Error && error.message
          ? error.message
          : "The mute did not go through. Try again.",
      );
      setBusy(false);
    }
  };

  return (
    <Modal label={`Mute ${name} on this board`} onClose={onClose}>
      <h2 className="text-lg font-bold">Mute {name} on this board</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        They can still read this board and post everywhere else. The mute ends
        by itself, and it is shown in this board's moderation log with your
        reason.
      </p>
      <form
        className="mt-4 flex flex-col gap-3"
        data-testid="board-mute-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">For how long?</legend>
          {choices.map((choice) => (
            <label
              className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-black/10 p-2 has-[:checked]:border-black/40 dark:border-white/10 dark:has-[:checked]:border-white/40"
              key={choice.days}
            >
              <input
                checked={days === choice.days}
                data-testid={`board-mute-days-${choice.days}`}
                name="board-mute-days"
                onChange={() => setDays(choice.days)}
                type="radio"
                value={choice.days}
              />
              <span className="text-sm">
                {choice.label}
                {choice.needsSecond ? (
                  <span className="block text-xs text-muted-foreground">
                    Needs a second moderator
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
        {chosen?.needsSecond ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="board-mute-second"
          >
            This starts as a {MODERATOR_MUTE_DAYS}-day mute. It becomes{" "}
            {chosen.label} only if another moderator also mutes them for that
            long within a day.
          </p>
        ) : null}
        <div>
          <label className="text-sm font-medium" htmlFor="board-mute-reason">
            Reason (public)
          </label>
          <input
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            data-testid="board-mute-reason"
            id="board-mute-reason"
            maxLength={REASON_MAX_CHARS}
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
        </div>
        {problem ? (
          <p
            className="text-sm text-red-600 dark:text-red-400"
            data-testid="board-mute-error"
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
            data-testid="board-mute-submit"
            disabled={busy}
            size="sm"
            type="submit"
          >
            {busy ? "Muting…" : "Mute"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
