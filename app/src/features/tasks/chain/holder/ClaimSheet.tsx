/**
 * The Claim sheet (plan section 5.9): the money a person is owed from a task they took out of while money was set aside for
 * it. It reads the task and the connected account's claim when it opens, says what was set aside, what came back and what is
 * owed now, and sends the one call, for the connected account only: the sheet has no way to name another. The network is
 * asked again right before the send, and a send that may have landed is looked for before another is made. A task that ran
 * out and that nobody has settled is not blocked: the claim settles it first.
 */
import { claimNoteCall } from "@creaton/core/pot/pot-calls.ts";
import { readNoteOf } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../../../ui/button";
import { Card } from "../../../../ui/card";
import type { ProjectNumbers } from "../../../money/numbers";
import { pendingSend, sendKey } from "../../../money/pending-sends";
import { PotSheet } from "../../../pot/PotSheet";
import type { Ready } from "../../../pot/use-pot";
import { nowOf, phaseOf } from "../state";
import { SheetLine } from "../team/SheetLine";
import { changedWhileLooking, dollarsPhrase } from "../words";
import { type ClaimRead, claimFigure, readClaim } from "./claim-read";
import {
  CLAIM_LOOK,
  CLAIM_READ_FAILED,
  CLAIM_TO_YOU,
  CLAIMED,
  claimEndedWords,
  claimOverdueWords,
  claimPress,
  claimTitle,
  claimTitleOf,
} from "./notes-words";

/** What the claim stood on moved between two reads: the task's result, or the claim itself. */
function moved(shown: ClaimRead, fresh: ClaimRead): boolean {
  const a = shown.task;
  const b = fresh.task;
  return (
    shown.face !== fresh.face ||
    a.state !== b.state ||
    a.setAside !== b.setAside ||
    a.returned !== b.returned ||
    a.deadline !== b.deadline
  );
}

export function ClaimSheet({
  numbers,
  serial,
  what,
  ready,
  open,
  onClose,
}: {
  numbers: ProjectNumbers;
  serial: bigint;
  /** The team's words for the task when it is one of this project's task records, else null. */
  what: string | null;
  ready: Ready;
  open: boolean;
  onClose: () => void;
}) {
  const treasury = numbers.contracts.treasury;
  const clock = nowOf(numbers.asOf.time);
  const windDownAt = numbers.windDown?.at ?? null;
  const reading = useQuery({
    queryKey: ["pot", "claim-note", treasury, String(serial), ready.address],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readClaim(ready, treasury, serial, clock),
  });
  const data = reading.data;
  const now = data ? Math.max(data.time, clock) : clock;
  const figure = data ? claimFigure(data, now) : null;
  const action = `claim-note:${numbers.chainId}:${treasury}:${serial}:${ready.address.toLowerCase()}`;
  // A send of this claim that may have landed: the claim is then gone (zero), which is the send having landed, not a reason
  // to stop the look for it (nothing new is sent while it is waiting).
  const waiting = pendingSend(sendKey(action, ready.address)) !== null;
  const landedAlready = waiting && data !== undefined && data.face === 0n;
  const stopped = figure && !landedAlready ? figure.block : null;
  // The holder is always the connected account: there is no way to name another from here. The call is the same whatever the
  // figure; what stops the press is `stopped`.
  const call = data
    ? claimNoteCall({ treasury, serial, holder: ready.address })
    : null;
  const detail = data ? `${serial}:${data.face}` : undefined;

  let body: React.ReactNode;
  if (reading.isPending)
    body = <Card className="h-32 animate-pulse" data-testid="claim-reading" />;
  else if (reading.isError)
    body = (
      <div className="flex flex-col gap-3" data-testid="claim-read-failed">
        <p className="text-sm">{CLAIM_READ_FAILED}</p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  else if (data && figure)
    body = (
      <>
        <dl className="divide-y divide-white/10">
          <SheetLine
            label="Set aside when you took out"
            testId="claim-set-aside"
          >
            {dollarsPhrase(data.task.setAside)}
          </SheetLine>
          {figure.overdue ? null : (
            <SheetLine label="Came back from it" testId="claim-returned">
              {dollarsPhrase(data.task.returned)}
            </SheetLine>
          )}
          <SheetLine
            label={
              figure.overdue
                ? "You are owed now"
                : "Your part of what came back"
            }
            testId="claim-owed"
          >
            {dollarsPhrase(figure.claimable)}
          </SheetLine>
        </dl>
        {figure.claimable > 0n ? (
          <p className="text-sm" data-testid="claim-words">
            {figure.overdue
              ? claimOverdueWords({
                  setAside: data.task.setAside,
                  face: data.face,
                  deadline: data.task.deadline ?? data.task.expiresAt,
                })
              : claimEndedWords({
                  setAside: data.task.setAside,
                  returned: data.task.returned,
                  claimable: figure.claimable,
                })}{" "}
            {CLAIM_TO_YOU}
          </p>
        ) : null}
        {stopped ? (
          <p
            className="rounded-xl bg-white/8 px-3 py-2 text-sm"
            data-testid="claim-blocked"
            role="alert"
          >
            {stopped}
          </p>
        ) : null}
      </>
    );
  else body = null;

  return (
    <PotSheet
      account={ready.address}
      action={action}
      blocked={!call || stopped !== null}
      calls={call ? [call] : null}
      chainId={numbers.chainId}
      confirmLabel={
        figure && figure.claimable > 0n ? claimPress(figure.claimable) : "Claim"
      }
      description="The money goes to your account"
      detail={detail}
      done={CLAIMED}
      landed={async (wallet, from) => {
        // A call replaced in the wallet may have landed under another hash: the claim is gone.
        if (!data) return false;
        return (
          (await readNoteOf(
            (to, call) => wallet.readCall(to, call),
            data.book,
            serial,
            from,
          )) === 0n
        );
      }}
      lookLabel={CLAIM_LOOK}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="claim-note"
      recheck={async () => {
        // The network is asked again: the claim and the task must be what the sheet showed, and the claim still payable.
        if (!data) return null;
        const again = await readClaim(ready, treasury, serial, clock);
        const stillWaiting =
          pendingSend(sendKey(action, ready.address)) !== null;
        // A claim that is gone while a send of this one waits is that send having landed: look for it, send nothing.
        if (stillWaiting && again.face === 0n) return null;
        // What the sheet stood on is compared (the claim, the task's result and dates), and the clock only goes forward: if
        // nothing moved, the press is as payable now as when the sheet opened.
        return moved(data, again)
          ? changedWhileLooking(
              phaseOf(again.task, Math.max(again.time, clock), windDownAt),
            )
          : null;
      }}
      testId="claim-sheet"
      title={
        figure && figure.claimable > 0n
          ? claimTitle(figure.claimable, what)
          : claimTitleOf(what)
      }
    >
      {/* What arrives after the sheet opened is read out. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {body}
      </div>
    </PotSheet>
  );
}
