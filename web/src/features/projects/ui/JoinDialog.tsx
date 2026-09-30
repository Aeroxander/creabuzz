/**
 * Join a role: the requester states the role and the stake they are asking
 * for, plus a short note saying why them.
 *
 * One signed kind:37016 is the whole write — pending, declined, and
 * superseded all resolve from it later (`lib/state.ts`). The disclaimer sits
 * in the dialog because this is the moment a percentage gets typed: what the
 * platform records is revocable and not a legal contract (§9 compliance
 * stance — the platform records, the project owns the legal act).
 */

import { useState } from "react";

import { userPubkey } from "@/shared/lib/identity";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import {
  JoinRequestValidationError,
  buildJoinRequestTemplate,
} from "../lib/join-request";
import type { RoleDeclaration } from "../lib/manifest";
import type { ProjectState } from "../lib/state";
import { usePublishProjectEvent } from "../use-projects";

/** The non-binding stance, verbatim, shown wherever a stake is recorded. */
export const STAKE_DISCLAIMER =
  "Recorded and revocable until the project's DAO adopts the map — not a legal contract.";

export function JoinDialog({
  project,
  role,
  open,
  onOpenChange,
}: {
  project: ProjectState;
  role: RoleDeclaration;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const publish = usePublishProjectEvent();
  const [pct, setPct] = useState(String(role.pct));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    const requester = userPubkey();
    let template: ReturnType<typeof buildJoinRequestTemplate>;
    try {
      template = buildJoinRequestTemplate({
        projectId: project.manifest.nodeId,
        owner: project.founder,
        requester,
        role: role.slug,
        pct: Number(pct),
        note,
      });
    } catch (err) {
      setError(
        err instanceof JoinRequestValidationError
          ? err.message
          : "That request could not be prepared.",
      );
      return;
    }
    publish.mutate(template, {
      onSuccess: () => {
        setNote("");
        onOpenChange(false);
      },
      onError: (err) =>
        setError(
          err instanceof Error
            ? err.message
            : "The relay rejected the request.",
        ),
    });
  }

  const parsedPct = Number(pct);
  const pctInvalid =
    !Number.isInteger(parsedPct) || parsedPct < 1 || parsedPct > role.pct;

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Request {role.label} for {pct || "?"}%
          </AlertDialogTitle>
          <AlertDialogDescription>
            {project.manifest.name} declares this role at up to {role.pct}%. The
            founder approves — then the stake is recorded as an ownership grant.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div>
          <label
            className="text-sm font-medium text-black dark:text-white"
            htmlFor="join-pct"
          >
            Stake you are asking for (%)
          </label>
          <div className="mt-1 flex items-center gap-2">
            <Input
              className="w-24"
              id="join-pct"
              inputMode="numeric"
              max={role.pct}
              min={1}
              onChange={(e) => setPct(e.target.value)}
              type="number"
              value={pct}
            />
            <span className="text-xs text-black/60 dark:text-white/60">
              of {role.pct}% declared · {project.remainingPct}% of the pool
              still unrecorded
            </span>
          </div>
          {pctInvalid ? (
            <p
              className="mt-1 text-xs text-red-600 dark:text-red-400"
              data-testid="join-pct-error"
            >
              Ask for a whole percentage between 1 and {role.pct}.
            </p>
          ) : null}
        </div>

        <div>
          <label
            className="text-sm font-medium text-black dark:text-white"
            htmlFor="join-note"
          >
            Why you
          </label>
          <textarea
            className="mt-1 flex min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            id="join-note"
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="One or two lines the founder will read first."
            value={note}
          />
          <p className="mt-1 text-2xs text-black/50 dark:text-white/50">
            {note.length}/500
          </p>
        </div>

        <p
          className="rounded-xl bg-black/5 px-3 py-2 text-xs text-black/60 dark:bg-white/10 dark:text-white/60"
          data-testid="join-disclaimer"
        >
          {STAKE_DISCLAIMER}
        </p>

        <SignRecovery
          className="text-xs"
          message={error}
          messageTestId="join-error"
          onUnlocked={submit}
          testId="join-sign-recovery"
        />

        <AlertDialogFooter>
          <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
          <Button
            disabled={publish.isPending || pctInvalid}
            onClick={submit}
            type="button"
          >
            {publish.isPending ? "Sending…" : "Send request"}
          </Button>
        </AlertDialogFooter>
        <p className="text-2xs text-black/40 dark:text-white/40">
          Signed as {truncatePubkey(userPubkey())}
        </p>
      </AlertDialogContent>
    </AlertDialog>
  );
}
