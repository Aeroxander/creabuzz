/**
 * Your Shares in a project, on the Money tab: what you paid in from this browser, the play dollars and Team Shares you hold
 * (read from the chain, not the server's record), how long you have held, Take out for Team Shares, and the history of your
 * own Backs and Take outs. What you hold and its Take out are in the top of the page (`HoldingTop`). Reachable whatever the
 * door, the allowance or the project's state is: it stands on the chain alone.
 */
import { balanceOf, quoteTakeOut } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { dayText } from "../money/numbers";
import { potProblem } from "../money/problems";
import { rememberSendTargets } from "../money/send-targets";
import { heldLine } from "./held-since";
import { ownSteps, paidInFromHere } from "./own-history";
import { exactDollarsText, sharesWords, smallDollarsText } from "../money/copy";
import { TakeOutSheet } from "./TakeOutSheet";
import type { MoneyTarget } from "./target";
import { useHeldSince } from "./use-held-since";
import { type Ready, useSignedOutPhone, WalletGate } from "./use-pot";

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

/** What an account holds in a project, read from the chain: one query for the whole page, so every part of it shares one read. */
export function useHolding(ready: Ready, target: MoneyTarget) {
  return useQuery({
    queryKey: ["pot", "holding", target.treasury, ready.address],
    staleTime: 10_000,
    retry: false,
    queryFn: () => readHolding(ready, target),
  });
}

/** Your Shares behind the sender's gate: connect, switch network, then the holding. */
export function YourShares({
  target,
  projectName,
}: {
  target: MoneyTarget;
  projectName: string;
}) {
  const titleId = useId();
  // Someone with no account yet holds nothing here, and the card would only tell them to sign in on a phone they never used.
  const signedOut = useSignedOutPhone(target.chainId);
  if (signedOut) return null;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="your-shares"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId} tabIndex={-1}>
        Your Shares
      </h2>
      <WalletGate chainId={target.chainId} what="see your Shares">
        {(ready) => (
          <Holding projectName={projectName} ready={ready} target={target} />
        )}
      </WalletGate>
    </Card>
  );
}

/** The rest of the holding, for an account that is ready (the Shares and their Take out are in the top of the page). */
export function Holding({
  target,
  projectName,
  ready,
}: {
  target: MoneyTarget;
  projectName: string;
  ready: Ready;
}) {
  const [teamOpen, setTeamOpen] = useState(false);
  const reading = useHolding(ready, target);
  const held = useHeldSince(ready, target, reading.data?.shares ?? 0n);
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
  const { shares, teamShares, dollars } = reading.data;
  const paidIn = paidInFromHere(ready.address, target.key);
  const steps = ownSteps(ready.address, target.key);
  return (
    <div className="flex flex-col gap-3">
      <dl className="divide-y divide-white/10">
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
      {/* How long the holding has lasted: from the person's own transfers, on this device; drawn only when it could be read. */}
      {shares > 0n && held.data ? (
        <p className="text-sm" data-testid="holding-held-since">
          {heldLine(held.data)}
        </p>
      ) : null}
      {teamShares !== null && teamShares > 0n ? (
        <div className="flex flex-col gap-2" data-testid="holding-team-words">
          <p className="text-sm text-muted">
            Team Shares pay only the project's money above what backers put in,
            so they can be worth nothing.
          </p>
          <Button
            block
            data-testid="holding-take-out-team"
            onClick={() => setTeamOpen(true)}
            variant="secondary"
          >
            Take out Team Shares
          </Button>
        </div>
      ) : null}
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
        kind="team"
        onClose={() => setTeamOpen(false)}
        open={teamOpen}
        projectName={projectName}
        ready={ready}
        target={target}
      />
    </div>
  );
}
