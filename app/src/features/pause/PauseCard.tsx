/**
 * The project page's card about the holder pause: what it is, where it stands (under the line, armed, paused) and what
 * the meter reads, from the signed record. Shown only when the record has a readable pause AND something is parked, or the
 * line is reached, or the person holds Shares here; otherwise the project shows one plain line and no card. A record older
 * than its own promise says so and makes no claim about the pause. No sentence says parking stops a loss.
 */
import { useId } from "react";
import { Card } from "../../ui/card";
import { freshnessOf, type ProjectNumbers } from "../money/numbers";
import type { PauseNumbers } from "../money/numbers-types";
import {
  cardIntro,
  infoLine,
  JOIN_LOWERS,
  PAUSE_HEADING,
  meterText,
  pauseStage,
  stateLine,
} from "./pause-words";

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
}: {
  numbers: ProjectNumbers;
  pause: PauseNumbers;
  now: number;
  /** The signed-in account holds Shares here, by the record's own list. */
  holds: boolean;
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
            })}
          </p>
        </>
      )}
      <p className="text-sm text-muted">{JOIN_LOWERS}</p>
    </Card>
  );
}
