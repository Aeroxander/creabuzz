/**
 * The Take out sheet: one press and one signature. It reads the chain when it opens and shows the cash now, what stays
 * behind (outside money still arriving is not paid yet) and what is kept; the guard on the cash comes from that same
 * quote. It is open to anyone who holds Shares whatever the door, the allowance or the project's state is.
 */
import { balanceOf } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { potProblem } from "../money/pot-copy";
import { rememberStep } from "./own-history";
import { PotSheet } from "./PotSheet";
import { trackNotes } from "./take-out-notes";
import {
  NOT_A_RETURN,
  sharesWords,
  smallDollarsText,
  takeOutTaskWords,
  WHERE_TO_CLAIM,
} from "./pot-words";
import {
  PORTION_WORDS,
  type Portion,
  readTakeOut,
  type TakeOutRead,
} from "./takeout-read";
import type { MoneyTarget } from "./target";
import type { Ready } from "./use-pot";

const PORTIONS: Portion[] = ["all", "half", "quarter"];

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

function Line({
  label,
  value,
  testId,
  strong,
}: {
  label: string;
  value: string;
  testId: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd
        className={`num text-right ${strong ? "font-semibold" : ""}`}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
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
  const [portion, setPortion] = useState<Portion>("all");
  const team = kind === "team";
  const reading = useQuery({
    queryKey: [
      "pot",
      "take-out",
      target.treasury,
      kind,
      portion,
      ready.address,
    ],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () =>
      readTakeOut(ready.read, target, kind, portion, ready.address),
  });
  const data: TakeOutRead | undefined = reading.data;
  const good = data?.ok ? data : null;
  const word = team ? "Team Shares" : "Shares";
  const detail = good ? `${good.shares}:${good.held}`.slice(0, 80) : undefined;

  // Once something was seen to be held, the choice stays on the sheet even while a new part is read (focus stays on it).
  const sawHeld = useRef(false);
  if (data && !(!data.ok && data.why === "none")) sawHeld.current = true;
  // The choice stays on the sheet whenever something is held, so a part that gives nothing can be changed without closing it.
  const portions = (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-semibold">How much to take out</legend>
      <div className="flex flex-wrap gap-2">
        {PORTIONS.map((p) => (
          <label
            className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
            key={p}
          >
            <input
              checked={portion === p}
              className="size-5 accent-current"
              data-testid={`takeout-portion-${p}`}
              name={`portion-${kind}`}
              onChange={() => setPortion(p)}
              type="radio"
              value={p}
            />
            {PORTION_WORDS[p]}
          </label>
        ))}
      </div>
    </fieldset>
  );

  // Closing forgets the choice, so the next opening starts from "All of it".
  const close = () => {
    sawHeld.current = false;
    setPortion("all");
    onClose();
  };

  let body: React.ReactNode;
  if (reading.isPending)
    body = (
      <>
        {sawHeld.current ? portions : null}
        <Card className="h-32 animate-pulse" data-testid="takeout-reading" />
      </>
    );
  else if (reading.isError)
    body = (
      <div className="flex flex-col gap-3" data-testid="takeout-read-failed">
        <p className="text-sm">
          What taking out gives could not be read from the network, so nothing
          can be sent now. Nothing was taken.{" "}
          {potProblem(reading.error, "take-out")}
        </p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  else if (data && !data.ok)
    body = (
      <>
        {data.why === "none" ? null : portions}
        <p className="text-sm" data-testid={`takeout-${data.why}`}>
          {data.why === "none"
            ? `You hold no ${word} in this project, so there is nothing to take out.`
            : data.why === "tiny"
              ? "That part is too small to take out. Choose a bigger part."
              : team
                ? "Team Shares pay only what the project's money holds above what backers put in, and that is nothing now. Nothing was taken."
                : "Taking these out would give nothing right now, so nothing was taken."}
        </p>
      </>
    );
  else if (good)
    body = (
      <>
        {portions}
        <dl className="divide-y divide-white/10">
          <Line
            label={`You hold`}
            testId="takeout-held"
            value={`${sharesWords(good.held)} ${word}`}
          />
          <Line
            label={`You take out`}
            testId="takeout-shares"
            value={`${sharesWords(good.shares)} ${word}`}
          />
          <Line
            label={team ? "Taking out now gives about" : "Taking out now gives"}
            strong
            testId="takeout-cash"
            value={`${smallDollarsText(good.cash)} dollars`}
          />
          <Line
            label="You keep"
            testId="takeout-kept"
            value={`${sharesWords(good.held - good.shares)} ${word}`}
          />
        </dl>
        <p className="text-sm text-muted">{NOT_A_RETURN}</p>
        {team ? (
          <p className="text-sm text-muted" data-testid="takeout-team-words">
            Team Shares pay only the project's money above what backers put in.
            This figure is an estimate, and it can be nothing.
          </p>
        ) : null}
        {good.arrivingLeftBehind > 0n ? (
          <p className="text-sm" data-testid="takeout-arriving">
            {smallDollarsText(good.arrivingLeftBehind)} dollars of outside money
            is still arriving. It is not paid out now: taking out now leaves it
            for the people who stay.
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
                data-testid="takeout-where-to-claim"
                onClick={() => {
                  close();
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
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer font-semibold">
            Details
          </summary>
          <p className="mt-1 text-muted" data-testid="takeout-guard">
            If what you are paid would be less than{" "}
            {smallDollarsText(good.minCash)} dollars when this lands, nothing is
            taken. There is no fee for taking out.
          </p>
        </details>
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
      description={`Taking out of ${projectName}`}
      detail={detail}
      done="Taken out. The money is in your wallet."
      landed={async (wallet, from, earlier) => {
        // A call replaced in the wallet may have landed under another hash: fewer Shares held now say so.
        const [shares, before] = (earlier.detail ?? "").split(":");
        if (!shares || !before || !/^\d+$/.test(before)) return false;
        const now = await balanceOf(
          (to, data) => wallet.readCall(to, data),
          team ? target.team : target.shares,
          from,
        );
        return now < BigInt(before);
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
        if (!next) close();
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
