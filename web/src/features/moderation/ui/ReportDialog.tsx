/**
 * Report a message, a post or a person to this community's moderators.
 *
 * What it promises is what the server does: the report goes to the moderators' queue and nowhere else, and nothing is
 * removed because of it. The reason is chosen, never guessed; the note is optional. The server's own words are shown
 * if it refuses.
 */

import { useState } from "react";
import { toast } from "sonner";

import { Modal } from "@/features/launchpad/ui/Modal";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { Button } from "@/shared/ui/button";

import {
  MAX_NOTE_LENGTH,
  REPORT_REASONS,
  type ReportTarget,
  type ReportType,
  reportRecord,
} from "../lib/report";

export function ReportDialog({
  target,
  what,
  onClose,
}: {
  target: ReportTarget;
  /** What is being reported, in the words the dialog's title uses: "this message", "this post", "Alex". */
  what: string;
  onClose: () => void;
}) {
  const [type, setType] = useState<ReportType | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (type === null) return;
    setBusy(true);
    setError(null);
    try {
      await publishAsUser(
        reportRecord({ target, type, note }),
        "The server did not accept the report.",
      );
      toast.success("Thanks. The moderators have been told.");
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "The report did not go through. Try again.",
      );
      setBusy(false);
    }
  };

  return (
    <Modal label={`Report ${what}`} onClose={onClose}>
      <h2 className="text-lg font-bold">Report {what}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Only this community's moderators will see this. Nothing is removed
        because you reported it; they decide what to do.
      </p>
      <form
        className="mt-4 flex flex-col gap-3"
        data-testid="report-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">
            What is wrong with it?
          </legend>
          {REPORT_REASONS.map((reason) => (
            <label
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-black/10 p-2 has-[:checked]:border-black/40 dark:border-white/10 dark:has-[:checked]:border-white/40"
              key={reason.value}
            >
              <input
                checked={type === reason.value}
                className="mt-1"
                data-testid={`report-reason-${reason.value}`}
                name="report-reason"
                onChange={() => setType(reason.value)}
                type="radio"
                value={reason.value}
              />
              <span>
                <span className="block text-sm font-medium">
                  {reason.label}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {reason.hint}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <label className="text-sm font-medium" htmlFor="report-note">
            Anything the moderators should know? (optional)
          </label>
          <textarea
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            data-testid="report-note"
            id="report-note"
            maxLength={MAX_NOTE_LENGTH}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            value={note}
          />
        </div>
        {error ? (
          <p
            className="text-sm text-red-600 dark:text-red-400"
            data-testid="report-error"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            data-testid="report-submit"
            disabled={type === null || busy}
            size="sm"
            type="submit"
          >
            {busy ? "Sending…" : "Send report"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
