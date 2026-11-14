import { useId, useRef, useState } from "react";

import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";

import { encodeRequestCorrections } from "@creaton/core/launchpad/agreements.ts";
import { hashText } from "@creaton/core/launchpad/work.ts";
import type { SenderCall } from "@/features/identity/lib/sponsoredSender";
import { agreedCorrectionsContent } from "../lib/agreed-lane";
import { REASON_MAX_CHARS, reasonProblem } from "../lib/review-reasons";
import type { Launch } from "../models";
import { usePublishMirror } from "../use-launches";

/**
 * A reviewer's request for changes on agreed work: the non-final route. It
 * asks for a corrected attempt and is never a vote against the work, so the
 * panel's verdict counts stay untouched. The words are published first, so the
 * person who must correct it can read why; only then does the request go to
 * the chain.
 */
export function AgreedCorrectionsForm({
  launch,
  mandate,
  agreementId,
  claimId,
  verifiers,
  onSendBatch,
  onSent,
}: {
  launch: Launch;
  mandate: string;
  agreementId: string;
  claimId: string;
  /** The mandate's reviewer set, where `requestCorrections` lives. */
  verifiers: string;
  onSendBatch: (key: string, calls: SenderCall[]) => Promise<boolean>;
  onSent: () => void;
}) {
  const publish = usePublishMirror();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const reasonId = useId();
  const noteId = useId();
  const opener = useRef<HTMLButtonElement | null>(null);

  const close = () => {
    setOpen(false);
    setProblem(null);
    requestAnimationFrame(() => opener.current?.focus());
  };

  const ask = async () => {
    setProblem(null);
    const text = reason.trim();
    if (text === "") {
      setProblem("Say what would make this work pass.");
      return;
    }
    const tooLong = reasonProblem(text);
    if (tooLong) {
      setProblem(tooLong);
      return;
    }
    setSending(true);
    try {
      try {
        await publish.mutateAsync({
          kind: KIND_LAUNCH_UPDATE,
          author: launch.record.author,
          launchId: launch.record.id,
          content: agreedCorrectionsContent({
            claimId,
            mandate,
            agreementId,
            reason: text,
          }),
        });
      } catch {
        setProblem(
          "Your words could not be published, so nothing was sent. Try again.",
        );
        return;
      }
      const sent = await onSendBatch(`corrections-${claimId}`, [
        {
          to: verifiers,
          data: encodeRequestCorrections(claimId, hashText(text)),
        },
      ]);
      if (!sent) {
        setProblem(
          "Your words are published, but the request did not reach the network. Press again to send it.",
        );
        return;
      }
      setOpen(false);
      setReason("");
      onSent();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-2">
      {open ? (
        <fieldset
          className="grid gap-2 rounded-md border border-border/60 p-2"
          data-testid="agreed-corrections-form"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !sending) {
              event.preventDefault();
              close();
            }
          }}
        >
          <legend className="px-1 text-xs font-medium">Ask for changes</legend>
          <p className="text-xs text-muted-foreground" id={noteId}>
            This asks for a corrected attempt. It is not a vote against the
            work, and it does not count toward turning it down.
          </p>
          <label className="grid gap-1 text-xs" htmlFor={reasonId}>
            What would make it pass? The person correcting it reads this.
            <textarea
              // The person opened this form to write the reason.
              // biome-ignore lint/a11y/noAutofocus: opened by the person's own press
              autoFocus
              aria-describedby={noteId}
              className="min-h-16 rounded-md border border-input bg-transparent p-1.5 text-sm"
              data-testid="agreed-corrections-reason"
              id={reasonId}
              maxLength={REASON_MAX_CHARS}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What is missing, or what would make it pass"
              value={reason}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="agreed-corrections-send"
              disabled={sending}
              onClick={() => void ask()}
              size="sm"
              type="button"
            >
              {sending ? "Sending…" : "Send the request"}
            </Button>
            <Button
              data-testid="agreed-corrections-cancel"
              disabled={sending}
              onClick={close}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </fieldset>
      ) : (
        <Button
          data-testid="agreed-corrections-open"
          onClick={() => setOpen(true)}
          ref={opener}
          size="sm"
          type="button"
          variant="outline"
        >
          Ask for changes (not a vote)
        </Button>
      )}
      {problem ? (
        <p
          className="mt-2 text-xs text-red-700 dark:text-red-300"
          data-testid="agreed-corrections-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}
