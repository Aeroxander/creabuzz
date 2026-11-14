import { useId, useRef, useState } from "react";

import type { PasskeyAccountKeys } from "@/features/identity/lib/passkey-account";
import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";

import {
  REASON_MAX_CHARS,
  REASON_CAUSES,
  type ReasonCause,
  reasonProblem,
  reviewReasonContent,
} from "../lib/review-reasons";
import { encodeAttest } from "@creaton/core/launchpad/work.ts";
import type { Launch } from "../models";
import { usePublishMirror } from "../use-launches";
import { useReasonShown } from "../use-review-reasons";
import { AccountNameLink } from "./AccountNameLink";

/**
 * A reviewer's two answers on a claim. Approve sends at once (it needs the evidence, which the caller checks). Turning
 * work down opens a short form first: the verdict cannot be taken back, and the contributor deserves to know why. The
 * reason is optional; when there is one it is published first (`lib/review-reasons.ts`), so a turn-down that fails to
 * send never leaves a reason that looks like a verdict, and pressing the button again finishes it. A reason is shown
 * only when the reviewer's account is linked to their name, so the form checks that first: when it is not, it says so,
 * offers the link, and publishes no reason (turning it down without one still works).
 */
export function ReviewActions({
  launch,
  claimId,
  label,
  mandate,
  verifiers,
  reviewer,
  passkeyKeys,
  canApprove,
  blocked,
  onSend,
}: {
  launch: Launch;
  claimId: string;
  /** The claim's name, for the reason's title. */
  label: string;
  /** The work budget, so the reason names the claim the way the evidence does. */
  mandate: string;
  verifiers: string;
  /** The acting wallet: the one the turn-down is sent from, named in the reason so it can be checked against it. */
  reviewer: string;
  /** The acting passkey account's public details, so it can be linked to the reviewer's name here; null for a wallet. */
  passkeyKeys: PasskeyAccountKeys | null;
  canApprove: boolean;
  blocked: boolean;
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
}) {
  const publish = usePublishMirror();
  const reasonShown = useReasonShown(reviewer);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [cause, setCause] = useState<ReasonCause | "">("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // The reason already published for this claim in this visit, so a retry after a failed send does not post it twice.
  const published = useRef<string | null>(null);
  const reasonId = useId();
  const causeId = useId();
  const objectButton = useRef<HTMLButtonElement | null>(null);
  const form = useRef<HTMLFieldSetElement | null>(null);

  const close = () => {
    setOpen(false);
    setProblem(null);
    requestAnimationFrame(() => objectButton.current?.focus());
  };

  const turnDown = async () => {
    setProblem(null);
    const text = reason.trim();
    const tooLong = reasonProblem(text);
    if (tooLong) {
      setProblem(tooLong);
      return;
    }
    setSending(true);
    // What is published: the words and the cause together, so changing either publishes again.
    const said = `${cause}|${text}`;
    try {
      if ((text || cause) && published.current !== said) {
        // Read again now: a reason the contributor would never be shown is not published.
        const shown = await reasonShown.check();
        if (shown === null) {
          setProblem(
            "Couldn't check that the contributor can see your reason, so nothing was sent. Try again, or leave the reason and what was missing empty to turn it down without one.",
          );
          return;
        }
        if (!shown) {
          setProblem(
            "This account isn't linked to your name, so the contributor would not see your reason. Nothing was sent. Link it first, or leave the reason and what was missing empty to turn it down without one.",
          );
          return;
        }
        try {
          await publish.mutateAsync({
            kind: KIND_LAUNCH_UPDATE,
            author: launch.record.author,
            launchId: launch.record.id,
            content: reviewReasonContent({
              name: label,
              claimId,
              mandate,
              reviewer,
              reason: text,
              cause: cause || null,
            }),
          });
          published.current = said;
        } catch {
          setProblem(
            "Your reason could not be published, so nothing was sent. Try again, or leave the reason and what was missing empty to turn it down without one.",
          );
          return;
        }
      }
      // The claim this is about, found now: once the verdict lands the page reads the work again, and this form may be
      // gone before the send resolves.
      const card = form.current?.closest<HTMLElement>(
        '[data-testid="work-claim"]',
      );
      if (
        await onSend(
          `object-${claimId}`,
          verifiers,
          encodeAttest(claimId, false),
        )
      ) {
        // The form and the button that opened it both go away (the verdict is given), so focus moves to the claim it
        // was about rather than falling to the page.
        setOpen(false);
        setReason("");
        setCause("");
        requestAnimationFrame(() => card?.focus());
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {canApprove ? (
        <Button
          data-testid="work-approve"
          disabled={blocked || sending}
          onClick={() =>
            void onSend(
              `approve-${claimId}`,
              verifiers,
              encodeAttest(claimId, true),
            )
          }
          size="sm"
          type="button"
        >
          Approve
        </Button>
      ) : null}
      {open ? null : (
        <Button
          data-testid="work-object"
          disabled={blocked}
          onClick={() => setOpen(true)}
          ref={objectButton}
          size="sm"
          type="button"
          variant="outline"
        >
          Turn it down
        </Button>
      )}
      {open ? (
        <fieldset
          className="mt-1 grid w-full gap-2 rounded-md border border-border/60 p-2"
          data-testid="work-object-form"
          // Escape cancels from anywhere in the form, not only the reason box.
          onKeyDown={(event) => {
            if (event.key === "Escape" && !sending) {
              event.preventDefault();
              close();
            }
          }}
          ref={form}
        >
          <legend className="px-1 text-xs font-medium">Turn it down</legend>
          <label className="grid gap-1 text-xs" htmlFor={reasonId}>
            Why? The contributor reads this. You cannot change your answer
            later.
            <textarea
              // A form the person just opened: the reason is what they came to write.
              // biome-ignore lint/a11y/noAutofocus: opened by the person's own press
              autoFocus
              className="min-h-16 rounded-md border border-black/10 bg-white p-1.5 text-sm text-black dark:border-white/10 dark:bg-white/5 dark:text-white"
              data-testid="work-object-reason"
              id={reasonId}
              maxLength={REASON_MAX_CHARS}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What is missing, or what would make it pass"
              value={reason}
            />
          </label>
          <label className="grid gap-1 text-xs" htmlFor={causeId}>
            What was missing? Counted across the project, so the team can see
            what to fix in how work is set up.
            <select
              className="h-8 w-fit rounded-md border border-black/10 bg-white px-2 text-sm text-black dark:border-white/10 dark:bg-white/5 dark:text-white"
              data-testid="work-object-cause"
              id={causeId}
              onChange={(event) =>
                setCause(event.target.value as ReasonCause | "")
              }
              value={cause}
            >
              <option value="">Choose one (optional)</option>
              {REASON_CAUSES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {reasonShown.shown === false ? (
            <div
              className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
              data-testid="work-object-unlinked"
            >
              <p>
                The contributor can&apos;t see a reason from this account yet:
                it isn&apos;t linked to your name.{" "}
                {passkeyKeys
                  ? "Link it here, or turn it down without a reason."
                  : "Link this wallet to your name under Payment wallet on your profile, or turn it down without a reason."}
              </p>
              {passkeyKeys ? (
                <AccountNameLink
                  account={reviewer}
                  keys={passkeyKeys}
                  testIdPrefix="work-object"
                />
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="work-object-confirm"
              disabled={blocked || sending}
              onClick={() => void turnDown()}
              size="sm"
              type="button"
              variant="destructive"
            >
              {sending ? "Sending…" : "Turn it down"}
            </Button>
            <Button
              data-testid="work-object-cancel"
              disabled={sending}
              onClick={close}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
          {problem ? (
            <p
              className="text-xs text-red-700 dark:text-red-300"
              data-testid="work-object-problem"
              role="alert"
            >
              {problem}
            </p>
          ) : null}
        </fieldset>
      ) : null}
    </>
  );
}
