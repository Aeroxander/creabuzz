/**
 * The Take out sheet: one press and one signature. It reads the chain when it opens and shows the cash now, what stays
 * behind (outside money still arriving is not paid yet) and what is kept; the guard on the cash comes from that same
 * quote. It is open to anyone who holds Shares whatever the door, the allowance or the project's state is.
 */
import { balanceOf } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../ui/button";
import { Row } from "../../ui/row";
import { Card } from "../../ui/card";
import { rememberStep } from "./own-history";
import { PotSheet } from "./PotSheet";
import { trackNotes } from "./take-out-notes";
import {
  NOT_A_RETURN,
  sharesWords,
  smallDollarsText,
  takeOutTaskWords,
  WHERE_TO_CLAIM,
} from "../money/copy";
import { readTakeOut, type TakeOutRead } from "./takeout-read";
import type { MoneyTarget } from "./target";
import type { Ready } from "./use-pot";

/**
 * What the project page already holds about tasks, handed to the sheet as plain values (never read by the sheet): how long a
 * task's money can stay set aside, and where a person goes to claim what they are owed. The press never waits for either.
 */
export interface TakeOutTaskInfo {
  /** The record's limit, or null when the page has none. */
  dueSecs: number | null;
  /** Goes to the claims; the link is drawn only when the page can go there. */
  onWhereToClaim?: () => void;
}

export function TakeOutSheet({
  target,
  projectName,
  kind,
  open,
  ready,
  onClose,
  taskInfo,
}: {
  target: MoneyTarget;
  projectName: string;
  kind: "backer" | "team";
  open: boolean;
  ready: Ready;
  onClose: () => void;
  taskInfo?: TakeOutTaskInfo;
}) {
  const team = kind === "team";
  const reading = useQuery({
    queryKey: ["pot", "take-out", target.treasury, kind, ready.address],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readTakeOut(ready.read, target, kind, ready.address),
  });
  const data: TakeOutRead | undefined = reading.data;
  const good = data?.ok ? data : null;
  const word = team ? "Team Shares" : "Shares";
  const detail = good ? good.shares.toString().slice(0, 80) : undefined;

  let body: React.ReactNode;
  if (reading.isPending)
    body = (
      <Card className="h-32 animate-pulse" data-testid="takeout-reading" />
    );
  else if (reading.isError)
    body = (
      <div className="flex flex-col gap-3" data-testid="takeout-read-failed">
        <p className="text-sm">
          What you would get could not be read, so nothing was taken.
        </p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  else if (data && !data.ok)
    body = (
      <p className="text-sm" data-testid={`takeout-${data.why}`}>
        {data.why === "none"
          ? `You hold no ${word} here.`
          : team
            ? "Team Shares pay only what is above what backers put in, and that is nothing now."
            : "Taking out would give nothing right now, so nothing was taken."}
      </p>
    );
  else if (good)
    body = (
      <>
        <dl className="divide-y divide-white/10">
          <Row
            label="You take out"
            testId="takeout-shares"
            value={`${sharesWords(good.shares)} ${word}`}
          />
          <Row
            label={team ? "You get about" : "You get"}
            strong
            testId="takeout-cash"
            value={`${smallDollarsText(good.cash)} dollars`}
          />
        </dl>
        <p className="text-sm text-muted">{NOT_A_RETURN}</p>
        {good.arrivingLeftBehind > 0n ? (
          <p className="text-sm" data-testid="takeout-arriving">
            {smallDollarsText(good.arrivingLeftBehind)} dollars still arriving
            stay for the people who hold on.
          </p>
        ) : null}
        {good.note > 0n ? (
          <div className="flex flex-col items-start gap-1">
            <p className="text-sm" data-testid="takeout-note">
              {takeOutTaskWords({
                cash: good.cash,
                note: good.note,
                dueSecs: taskInfo?.dueSecs ?? null,
              })}
            </p>
            {taskInfo?.onWhereToClaim ? (
              <Button
                className="-ml-[15px]"
                data-testid="takeout-where-to-claim"
                onClick={() => {
                  onClose();
                  taskInfo.onWhereToClaim?.();
                }}
                size="sm"
                variant="ghost"
              >
                {WHERE_TO_CLAIM}
              </Button>
            ) : null}
          </div>
        ) : null}
      </>
    );
  else body = null;

  return (
    <PotSheet
      account={ready.address}
      action={`${team ? "take-out-team" : "take-out"}:${target.chainId}:${target.treasury}`}
      calls={good ? [good.call] : null}
      chainId={target.chainId}
      confirmLabel={
        good ? `Take out ${sharesWords(good.shares)} ${word}` : "Take out"
      }
      detail={detail}
      done={(own) => `Taken out. The money is in ${own}.`}
      landed={async (wallet, from, earlier) => {
        // A call replaced in the wallet may have landed under another hash: fewer Shares held than were taken out say so.
        if (!earlier.detail || !/^\d+$/.test(earlier.detail)) return false;
        const readNow = (to: string, data: string) => wallet.readCall(to, data);
        const held = await balanceOf(
          readNow,
          team ? target.team : target.shares,
          from,
        );
        return held < BigInt(earlier.detail);
      }}
      lookLabel="Look for your take-out"
      onLanded={(txHash, landed) => {
        // An earlier press that was looked up is not this amount: it is not written down as if it were.
        if (good && landed === detail) {
          rememberStep(ready.address, {
            kind: team ? "take-out-team" : "take-out",
            project: target.key,
            at: Math.floor(Date.now() / 1000),
            dollars: good.cash.toString(),
            shares: good.shares.toString(),
            txHash,
          });
          // A take out that left money owed for a task: keep which tasks, best effort, in the background. It never gates,
          // delays or fails the take out.
          if (good.note > 0n) void trackNotes(ready, target.treasury, txHash);
        }
      }}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      playMoney={target.playMoney}
      problemAction={team ? "take-out-team" : "take-out"}
      testId={team ? "takeout-team-sheet" : "takeout-sheet"}
      title={`Take out of ${projectName}`}
    >
      {/* What arrives after the sheet opened (the quote, a refusal) is read out. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {body}
      </div>
    </PotSheet>
  );
}
