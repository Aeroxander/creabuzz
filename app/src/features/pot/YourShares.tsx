/**
 * Your Shares in a project: what you hold, what taking out would give now (read from the chain, not the server's record),
 * what you paid in from this browser, a Take out button while you hold any, and the history of your own Backs and
 * Take outs. Reachable whatever the door, the allowance or the project's state is: it stands on the chain alone.
 */
import { balanceOf, quoteTakeOut } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { dayText } from "../money/numbers";
import { potProblem } from "../money/pot-copy";
import { rememberSendTargets } from "../money/send-targets";
import { FaucetCard } from "./FaucetCard";
import { ownSteps, paidInFromHere } from "./own-history";
import {
  exactDollarsText,
  NOT_A_RETURN,
  sharesWords,
  smallDollarsText,
} from "./pot-words";
import { TakeOutSheet, type TakeOutTaskInfo } from "./TakeOutSheet";
import type { MoneyTarget } from "./target";
import { type Ready, WalletGate } from "./use-pot";

/**
 * What an account holds in a project, with what taking all of it out would give now. Only the Shares balance is needed to
 * offer Take out: the Team Shares, the play dollars and the quote are extras, so one that cannot be read comes back as null
 * and never removes the way out. The contracts are remembered as send targets here (every Take out goes through this read,
 * whether the numbers came from the server's record or from the Launcher), so a passkey account can send to them.
 */
export async function readHolding(ready: Ready, target: MoneyTarget) {
  rememberSendTargets([
    target.treasury,
    target.shares,
    target.team,
    target.vester,
    target.dollar,
  ]);
  const shares = await balanceOf(ready.read, target.shares, ready.address);
  const [teamShares, dollars, quote] = await Promise.all([
    balanceOf(ready.read, target.team, ready.address).catch(() => null),
    target.dollar
      ? balanceOf(ready.read, target.dollar, ready.address).catch(() => null)
      : Promise.resolve(null),
    shares > 0n
      ? quoteTakeOut(ready.read, target.treasury, ready.address, shares).catch(
          () => null,
        )
      : Promise.resolve(null),
  ]);
  return { shares, teamShares, dollars, quote };
}

/** Your Shares behind the sender's gate: connect, switch network, then the holding. */
export function YourShares({
  target,
  projectName,
  taskInfo,
}: {
  target: MoneyTarget;
  projectName: string;
  /** What the project page holds about tasks, for the Take out sheet's line (never read by the sheet). */
  taskInfo?: TakeOutTaskInfo;
}) {
  const titleId = useId();
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="your-shares"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        Your Shares
      </h2>
      <WalletGate chainId={target.chainId} what="see your Shares">
        {(ready) => (
          <Holding
            projectName={projectName}
            ready={ready}
            target={target}
            taskInfo={taskInfo}
          />
        )}
      </WalletGate>
    </Card>
  );
}

/** The holding itself, for an account that is ready. */
export function Holding({
  target,
  projectName,
  ready,
  taskInfo,
}: {
  target: MoneyTarget;
  projectName: string;
  ready: Ready;
  taskInfo?: TakeOutTaskInfo;
}) {
  const [sheet, setSheet] = useState<"backer" | "team" | null>(null);
  const reading = useQuery({
    queryKey: ["pot", "holding", target.treasury, ready.address],
    staleTime: 10_000,
    retry: false,
    queryFn: () => readHolding(ready, target),
  });
  if (reading.isPending)
    return (
      <Card className="h-24 animate-pulse" data-testid="holding-reading" />
    );
  if (reading.isError)
    return (
      <div className="flex flex-col gap-2" data-testid="holding-read-failed">
        <p className="text-sm">
          What you hold could not be read from the network. Your money is not
          affected. {potProblem(reading.error, "take-out")}
        </p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  const { shares, teamShares, dollars, quote } = reading.data;
  const paidIn = paidInFromHere(ready.address, target.key);
  const steps = ownSteps(ready.address, target.key);
  return (
    <div className="flex flex-col gap-3">
      <dl className="divide-y divide-white/10">
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="text-sm text-muted">You hold</dt>
          <dd
            className="num text-right font-semibold"
            data-testid="holding-shares"
          >
            {sharesWords(shares)} Shares
          </dd>
        </div>
        {shares > 0n && quote ? (
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="text-sm text-muted">
              What you would get if you took out now
            </dt>
            <dd className="num text-right" data-testid="holding-cash">
              {smallDollarsText(quote.cashNow)} dollars
            </dd>
          </div>
        ) : null}
        {paidIn > 0n ? (
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="text-sm text-muted">
              You paid in, from this browser
            </dt>
            <dd className="num text-right" data-testid="holding-paid-in">
              {smallDollarsText(paidIn)} dollars
            </dd>
          </div>
        ) : null}
        {dollars !== null ? (
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="text-sm text-muted">Play dollars you hold</dt>
            <dd className="num text-right" data-testid="holding-dollars">
              {smallDollarsText(dollars)}
            </dd>
          </div>
        ) : null}
        {teamShares !== null && teamShares > 0n ? (
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="text-sm text-muted">Team Shares you hold</dt>
            <dd className="num text-right" data-testid="holding-team">
              {sharesWords(teamShares)}
            </dd>
          </div>
        ) : null}
      </dl>
      {shares > 0n ? (
        <>
          <p className="text-sm text-muted">{NOT_A_RETURN}</p>
          <Button
            block
            data-testid="holding-take-out"
            onClick={() => setSheet("backer")}
          >
            Take out
          </Button>
        </>
      ) : (
        <p className="text-sm" data-testid="holding-none">
          You hold no Shares in this project yet. Back it to get some.
        </p>
      )}
      {teamShares !== null && teamShares > 0n ? (
        <div className="flex flex-col gap-2" data-testid="holding-team-words">
          <p className="text-sm text-muted">
            Team Shares pay only the project's money above what backers put in,
            so they can be worth nothing.
          </p>
          <Button
            block
            data-testid="holding-take-out-team"
            onClick={() => setSheet("team")}
            variant="secondary"
          >
            Take out Team Shares
          </Button>
        </div>
      ) : null}
      <FaucetCard ready={ready} target={target} />
      {steps.length > 0 ? (
        <section aria-label="Your Backs and Take outs" data-testid="history">
          <h3 className="text-sm font-semibold">Your Backs and Take outs</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {steps.slice(0, 10).map((step) => (
              <li data-testid="history-step" key={step.txHash}>
                {dayText(step.at)}:{" "}
                {step.kind === "back"
                  ? `backed with ${exactDollarsText(BigInt(step.dollars))} dollars and got about ${sharesWords(BigInt(step.shares))} Shares`
                  : `took out ${sharesWords(BigInt(step.shares))} ${step.kind === "take-out-team" ? "Team Shares" : "Shares"} and got about ${smallDollarsText(BigInt(step.dollars))} dollars`}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">Kept in this browser.</p>
        </section>
      ) : null}
      <TakeOutSheet
        kind={sheet === "team" ? "team" : "backer"}
        onClose={() => setSheet(null)}
        open={sheet !== null}
        projectName={projectName}
        ready={ready}
        target={target}
        taskInfo={taskInfo}
      />
    </div>
  );
}
