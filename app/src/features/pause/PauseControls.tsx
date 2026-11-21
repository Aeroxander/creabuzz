/**
 * What a holder does about the pause, under their holding on Your Shares: the line "{p} of your {t} Shares are parked", the
 * Park Shares button (only where the record names a pause and the person holds Shares) and Take back (whenever something is
 * parked: never hidden by what a record says). The Park sheet loads when it is first opened.
 */
import { lazy, Suspense, useState } from "react";
import { Button } from "../../ui/button";
import type { PauseNumbers } from "../money/numbers-types";
import type { MoneyTarget } from "../pot/target";
import type { Ready } from "../pot/use-pot";
import { PARK_BUTTON, parkedLine } from "./pause-words";
import { TakeBackButton } from "./TakeBackButton";

const ParkSheet = lazy(() => import("./ParkSheet"));

/** What the project's record says about its pause, handed down from the page. */
export interface PauseInfo {
  /** `contracts.pause`: set when the project has a pause. */
  contract: string | null;
  /** `pause`: the stop's numbers, or null when they could not be read (then nothing can be parked). */
  record: PauseNumbers | null | undefined;
}

export function PauseControls({
  ready,
  target,
  projectName,
  pauseInfo,
  gate,
  wallet,
  parked,
}: {
  ready: Ready;
  target: MoneyTarget;
  projectName: string;
  pauseInfo: PauseInfo | undefined;
  /** The pause contract the Treasury names, or null. */
  gate: string | null;
  /** What the wallet holds and what is parked (both read from the chain). */
  wallet: bigint;
  parked: bigint;
}) {
  const [open, setOpen] = useState(false);
  const total = wallet + parked;
  const canPark = Boolean(pauseInfo?.contract) && total > 0n;
  if (!canPark && !(parked > 0n && gate)) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="pause-controls">
      {parked > 0n ? (
        <p className="text-sm" data-testid="holding-parked">
          {parkedLine(parked, total)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canPark ? (
          <Button
            data-testid="park-open"
            onClick={() => setOpen(true)}
            variant="secondary"
          >
            {PARK_BUTTON}
          </Button>
        ) : null}
        {parked > 0n && gate ? (
          <TakeBackButton
            gate={gate}
            parked={parked}
            ready={ready}
            target={target}
          />
        ) : null}
      </div>
      {canPark && open ? (
        <Suspense fallback={null}>
          <ParkSheet
            onClose={() => setOpen(false)}
            open={open}
            projectName={projectName}
            ready={ready}
            recordReadable={Boolean(pauseInfo?.record)}
            target={target}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
