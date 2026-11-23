/**
 * A member's grants: what each holds, what has unlocked, what can be claimed now (read from the Vester at the moment the
 * card shows), a Claim button, and the member's own exit (announce it: the part not yet unlocked burns after the notice).
 * Team Shares claim only the project's money above what backers put in; the card says so.
 */
import {
  announceForfeitCall,
  claimGrantCall,
  executeForfeitCall,
} from "@creaton/core/pot/pot-calls.ts";
import {
  claimableOf,
  grantIdsOf,
  vestedOf,
} from "@creaton/core/pot/pot-reads.ts";
import { accruedOf, readGrant } from "@creaton/core/pot/pot-state.ts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSenderWords } from "../money/use-money";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { dayText, type ProjectNumbers, timeText } from "../money/numbers";
import type { GrantNumbers } from "../money/numbers-types";
import { PotSheet } from "./PotSheet";
import { sharesWords } from "./pot-words";
import type { Ready } from "./use-pot";

interface MyGrant {
  id: bigint;
  total: bigint;
  claimed: bigint;
  vested: bigint;
  claimable: bigint;
  state: number;
  burnAt: number;
  burn: bigint;
  protectedGrant: boolean;
  /** What the member keeps on their own exit: everything built up so far, no cliff. */
  accrued: bigint;
}

async function readMine(ready: Ready, vester: string): Promise<MyGrant[]> {
  const ids = await grantIdsOf(ready.read, vester, ready.address);
  return Promise.all(
    ids.map(async (id) => {
      const [grant, vested, claimable, accrued] = await Promise.all([
        readGrant(ready.read, vester, id),
        vestedOf(ready.read, vester, id),
        claimableOf(ready.read, vester, id),
        accruedOf(ready.read, vester, id),
      ]);
      return {
        id,
        total: grant.total,
        claimed: grant.claimed,
        vested,
        claimable,
        state: grant.state,
        burnAt: grant.burnAt,
        burn: grant.burn,
        protectedGrant: grant.protectedGrant,
        accrued,
      };
    }),
  );
}

type Step = { kind: "claim" | "exit" | "burn"; grant: MyGrant } | null;

function datesOf(record: GrantNumbers | undefined): string | null {
  if (!record) return null;
  const parts: string[] = [];
  if (record.cliff && !record.cliff.passed && record.cliff.endsAtIfActive)
    parts.push(
      `nothing unlocks before about ${dayText(record.cliff.endsAtIfActive)}`,
    );
  if (record.fullyVestedAtIfActive)
    parts.push(
      `fully unlocked by about ${dayText(record.fullyVestedAtIfActive)} if the team keeps checking in`,
    );
  return parts.length ? `${parts.join("; ")}.` : null;
}

export function MyGrants({
  numbers,
  ready,
}: {
  numbers: ProjectNumbers;
  ready: Ready;
}) {
  const vester = numbers.contracts.vester;
  const words = useSenderWords();
  const [step, setStep] = useState<Step>(null);
  const reading = useQuery({
    queryKey: ["pot", "grants", vester, ready.address],
    staleTime: 10_000,
    retry: false,
    queryFn: () => readMine(ready, vester),
  });
  if (reading.isPending) return <Card className="h-20 animate-pulse" />;
  if (reading.isError)
    return (
      <div className="flex flex-col gap-2" data-testid="grants-read-failed">
        <p className="text-sm">
          Your grants could not be read from the network. Nothing changed.
        </p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  const mine = reading.data;
  if (mine.length === 0) return null;
  const now = Math.floor(Date.now() / 1000);
  const grant = step?.grant ?? null;
  const call =
    step && grant
      ? step.kind === "claim"
        ? claimGrantCall(vester, grant.id)
        : step.kind === "exit"
          ? announceForfeitCall(vester, grant.id)
          : executeForfeitCall(vester, grant.id)
      : null;
  return (
    <div className="flex flex-col gap-3" data-testid="my-grants">
      <h3 className="text-sm font-semibold">Your Team Share grants</h3>
      <ul className="flex flex-col gap-3">
        {mine.map((g) => {
          const record = numbers.team.grants.find((r) => BigInt(r.id) === g.id);
          return (
            <li
              className="flex flex-col gap-2"
              data-testid="my-grant"
              key={g.id.toString()}
            >
              <dl className="divide-y divide-white/10 text-sm">
                <div className="flex justify-between gap-3 py-1">
                  <dt className="text-muted">Granted</dt>
                  <dd className="num" data-testid="grant-total">
                    {sharesWords(g.total)} Team Shares
                  </dd>
                </div>
                <div className="flex justify-between gap-3 py-1">
                  <dt className="text-muted">Unlocked so far</dt>
                  <dd className="num" data-testid="grant-vested">
                    {sharesWords(g.vested)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 py-1">
                  <dt className="text-muted">Ready to claim</dt>
                  <dd className="num" data-testid="grant-claimable">
                    {sharesWords(g.claimable)}
                  </dd>
                </div>
              </dl>
              {g.state === 0 ? (
                <p className="text-xs text-muted">{datesOf(record)}</p>
              ) : null}
              {g.state === 1 ? (
                <p className="text-sm" data-testid="grant-announced">
                  You gave up {sharesWords(g.burn)} Team Shares that had not
                  unlocked. They are removed from {timeText(g.burnAt)}.
                </p>
              ) : null}
              {g.state === 2 ? (
                <p className="text-xs text-muted">This grant is closed.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  data-testid="grant-claim"
                  disabled={g.claimable === 0n}
                  onClick={() => setStep({ kind: "claim", grant: g })}
                  size="sm"
                >
                  Claim
                </Button>
                {g.state === 0 && !g.protectedGrant ? (
                  <Button
                    data-testid="grant-exit"
                    onClick={() => setStep({ kind: "exit", grant: g })}
                    size="sm"
                    variant="secondary"
                  >
                    Give up what has not built up yet
                  </Button>
                ) : null}
                {g.state === 1 && g.burnAt <= now ? (
                  <Button
                    data-testid="grant-burn"
                    onClick={() => setStep({ kind: "burn", grant: g })}
                    size="sm"
                    variant="secondary"
                  >
                    Finish giving up
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted">
        Team Shares claim only the project's money above what backers put in. If
        there is none, they are worth nothing.
      </p>
      <PotSheet
        account={ready.address}
        action={`grant-${step?.kind ?? "claim"}:${numbers.chainId}:${vester}:${grant?.id ?? ""}`}
        calls={call ? [call] : null}
        chainId={numbers.chainId}
        confirmLabel={
          step?.kind === "exit"
            ? "Give up what has not built up yet"
            : step?.kind === "burn"
              ? "Finish giving up"
              : "Claim"
        }
        done={
          step?.kind === "exit"
            ? "Announced. The notice has started."
            : step?.kind === "burn"
              ? "Done."
              : (own: string) => `Claimed. The Team Shares are in ${own}.`
        }
        lookLabel="Look for your step"
        onOpenChange={(next) => {
          if (!next) setStep(null);
        }}
        open={step !== null}
        playMoney={numbers.playMoney}
        problemAction={step?.kind === "claim" ? "claim" : "forfeit"}
        testId="grant-step-sheet"
        title={
          step?.kind === "exit"
            ? "Give up what has not built up yet?"
            : step?.kind === "burn"
              ? "Finish giving up"
              : "Claim your Team Shares"
        }
      >
        {grant && step?.kind === "claim" ? (
          <p className="text-sm" data-testid="claim-words">
            {sharesWords(grant.claimable)} Team Shares have unlocked and not
            been claimed. Claiming sends them to {words.own}.
          </p>
        ) : null}
        {grant && step?.kind === "exit" ? (
          <p className="text-sm" data-testid="exit-words">
            You keep {sharesWords(grant.accrued)} Team Shares: everything that
            has built up so far, even before the first unlock date. The other{" "}
            {sharesWords(grant.total - grant.accrued)} are removed after a
            public notice of {Math.max(1, Math.round(numbers.unit / 86_400))}{" "}
            days. This cannot be undone.
          </p>
        ) : null}
        {grant && step?.kind === "burn" ? (
          <p className="text-sm">
            The notice is over. This removes {sharesWords(grant.burn)} Team
            Shares that had not unlocked.
          </p>
        ) : null}
      </PotSheet>
    </div>
  );
}
