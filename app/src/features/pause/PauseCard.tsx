/**
 * The project page's card about the holder pause: what it is, where it stands (under the line, armed, paused) and what
 * the meter reads, from the signed record. Shown only when the record has a readable pause AND something is parked, or the
 * line is reached, or the person holds Shares here; otherwise the project shows one plain line and no card. A record older
 * than its own promise says so and makes no claim about the pause. No sentence says parking stops a loss.
 */
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { freshnessOf, type ProjectNumbers } from "../money/numbers";
import type { PauseNumbers, VoteNumbers } from "../money/numbers-types";
import { parkedHeld } from "./parked-read";
import { usePotWallet } from "../pot/use-pot";
import { targetOf } from "../pot/target";
import { openerLine } from "../council/vote-words";
import {
  cardIntro,
  infoLine,
  JOIN_LOWERS,
  PAUSE_HEADING,
  meterText,
  pauseStage,
  stateLine,
} from "./pause-words";
import { StartDayButton } from "./StartDayButton";

const StandSheet = lazy(() =>
  import("../council/StandSheet").then((m) => ({ default: m.StandSheet })),
);

/**
 * Whether the record says a replace vote may be opened now (COUNCIL-PLAN.md section 6.3): a vote contract with no ballot
 * open, the parked Shares at or over its floor, and the cooldown after a "kept" result over. The person's own parked Shares
 * are read from the chain beside this, so the line shows only to someone who could press.
 */
export function mayAskHolders(
  vote: VoteNumbers | null | undefined,
  pause: PauseNumbers,
  now: number,
): boolean {
  if (!vote || vote.open !== null) return false;
  if (vote.next.openFloor <= 0n) return false;
  if (pause.parkedTotal < vote.next.openFloor) return false;
  return vote.next.replaceFrom === null || now >= vote.next.replaceFrom;
}

/** The opener's line and one press (section 6.3): shown only to a person with Shares parked, and only when it can open. */
function AskHolders({
  numbers,
  pause,
  now,
  projectCoordinate,
  nameOf,
}: {
  numbers: ProjectNumbers;
  pause: PauseNumbers;
  now: number;
  projectCoordinate: string | null;
  nameOf: (address: string) => string;
}) {
  const pot = usePotWallet(numbers.chainId);
  const ready =
    projectCoordinate !== null &&
    mayAskHolders(numbers.vote ?? null, pause, now);
  const parked = useQuery({
    queryKey: ["pot", "pause-ask", numbers.contracts.treasury, pot.address],
    enabled: ready && pot.address !== null,
    staleTime: 15_000,
    retry: false,
    queryFn: () => parkedHeld(pot.read, numbers, pot.address as string),
  });
  const [open, setOpen] = useState(false);
  if (!ready || !pot.address || (parked.data ?? 0n) === 0n) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="pause-ask">
      <p className="text-sm" data-testid="pause-ask-line">
        {openerLine()}
      </p>
      <Button
        data-testid="pause-ask-press"
        onClick={() => setOpen(true)}
        variant="secondary"
      >
        Ask holders
      </Button>
      {open ? (
        <Suspense fallback={null}>
          <StandSheet
            mode="open"
            nameOf={nameOf}
            now={now}
            numbers={numbers}
            onClose={() => setOpen(false)}
            open
            projectCoordinate={projectCoordinate}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

/** Whether the card shows (and not just the info line): something is parked, the line is reached, or the person holds Shares. */
function showsCard(pause: PauseNumbers, holds: boolean): boolean {
  return (
    pause.parkedTotal > 0n || pause.armedAt !== null || pause.paused || holds
  );
}

export function PauseCard({
  numbers,
  pause,
  now,
  holds,
  projectCoordinate,
  nameOf,
}: {
  numbers: ProjectNumbers;
  pause: PauseNumbers;
  now: number;
  /** The signed-in account holds Shares here, by the record's own list. */
  holds: boolean;
  /** The project's coordinate, for the sheet a replace vote is opened from; absent hides the opener. */
  projectCoordinate?: string | null;
  /** A name for an account, as the page shows accounts (a linked name, else a short address). */
  nameOf?: (address: string) => string;
}) {
  const titleId = useId();
  if (!showsCard(pause, holds))
    return (
      <p className="text-sm text-muted" data-testid="pause-info">
        {infoLine(pause.lineDivisor)}
      </p>
    );
  const old = freshnessOf(numbers, now).level !== "fresh";
  const stage = pauseStage(pause);
  const backers = numbers.shares.backers;
  // The meter fills toward the line: a full meter is the line reached, never more.
  const fill =
    pause.line === 0n
      ? 0
      : Number((pause.parkedTotal * 1000n) / pause.line) / 10;
  const now100 = Math.min(100, Math.max(0, Math.floor(fill)));
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="pause-card"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        {PAUSE_HEADING}
      </h2>
      <p className="text-sm text-muted" data-testid="pause-intro">
        {cardIntro(pause.lineDivisor, pause.dayLength)}
      </p>
      {old ? (
        <p className="text-sm" data-testid="pause-old">
          These numbers are older than the server promises, so nothing is said
          here about where the pause stands now.
        </p>
      ) : (
        <>
          <meter
            aria-label="Parked Shares against the line"
            aria-valuetext={meterText(
              pause.parkedTotal,
              backers,
              pause.lineDivisor,
            )}
            className="h-3 w-full"
            data-testid="pause-meter"
            max={100}
            min={0}
            value={now100}
          />
          <p className="text-sm" data-testid={`pause-state-${stage}`}>
            {stateLine({
              stage,
              parkedTotal: pause.parkedTotal,
              backers,
              lineDivisor: pause.lineDivisor,
              pausesFrom: pause.pausesFrom,
              since: pause.since,
              line: pause.line,
              dayLength: pause.dayLength,
            })}
          </p>
          {stage === "reached" && numbers.contracts.pause ? (
            <StartDayButton target={targetOf(numbers)} />
          ) : null}
          {numbers.vote ? (
            <AskHolders
              nameOf={
                nameOf ??
                ((address: string) =>
                  `${address.slice(0, 6)}…${address.slice(-4)}`)
              }
              now={now}
              numbers={numbers}
              pause={pause}
              projectCoordinate={projectCoordinate ?? null}
            />
          ) : null}
        </>
      )}
      <p className="text-sm text-muted">{JOIN_LOWERS}</p>
    </Card>
  );
}
