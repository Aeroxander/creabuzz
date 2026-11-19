/**
 * Who runs the project's money, and what a person can do about it: for anyone, who it is now and what that means; for a person
 * the seat is offered to, taking it (alone, or as the second of a pair); for the runner (or a pair's signer), offering the seat
 * to one person, asking one person to run it together, withdrawing an offer, and winding the project down; for anyone, winding it
 * down once the team has been quiet long enough. Everything that sends reads the chain when its sheet opens.
 */
import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { quietStateAt, type ProjectNumbers } from "../money/numbers";
import { quietWaitWords } from "../pot/pot-words";
import { runnerRole } from "../money/runner";
import type { GrantMember } from "../pot/GrantSheet";
import { recordFitsBuild, type Ready, usePotWallet } from "../pot/use-pot";
import { OfferSheet, type OfferMode } from "./OfferSheet";
import { TakeSeatSheet, WithdrawSheet } from "./SeatSheets";
import { WindDownSheet, type WindDownMode } from "./WindDownSheet";
import {
  offerLeftWords,
  offeredToYouWords,
  pairOfferedToYouWords,
  PAIR_MEANING,
  runsWords,
} from "./seat-words";
import { useSeat } from "./use-seat";

type Open =
  | null
  | "hand-over"
  | "pair"
  | "withdraw"
  | "take"
  | "accept"
  | "wind-down";

interface Props {
  numbers: ProjectNumbers;
  members: GrantMember[];
  nameOf: (address: string) => string;
  projectName: string;
  now: number;
}

export function SeatSection(props: Props) {
  const { numbers, nameOf } = props;
  const titleId = useId();
  const pot = usePotWallet(numbers.chainId);
  // A person's own account is looked at only when the wallet already shows one on this network: nobody is asked to connect to
  // read who runs a project.
  const ready: Ready | null =
    pot.address && pot.onChain === true && recordFitsBuild(numbers)
      ? { address: pot.address, read: pot.read, wallet: pot.wallet }
      : null;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="seat-section"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        Who runs the money
      </h2>
      <p className="text-sm" data-testid="seat-runs">
        {runsWords(numbers, nameOf)}
      </p>
      {numbers.runner.isPair && !numbers.windDown ? (
        <p className="text-sm text-muted" data-testid="seat-pair-meaning">
          {PAIR_MEANING}
        </p>
      ) : null}
      {ready && !numbers.windDown ? <Actions {...props} ready={ready} /> : null}
    </Card>
  );
}

function Actions({
  numbers,
  members,
  nameOf,
  projectName,
  now,
  ready,
}: Props & { ready: Ready }) {
  const [open, setOpen] = useState<Open>(null);
  const memberAddresses = members.flatMap((m) =>
    m.address ? [m.address] : [],
  );
  const view = useSeat(numbers, ready, memberAddresses);
  const role = runnerRole(numbers, ready.address).kind;
  const close = () => setOpen(null);
  if (view.isPending) return <Card className="h-12 animate-pulse" />;
  if (view.isError || !view.data)
    return (
      <div className="flex flex-col gap-2" data-testid="seat-read-failed">
        <p className="text-sm">
          The seat could not be read from the network, so nothing can be sent
          now. Nothing changed.
        </p>
        <Button onClick={() => void view.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  const { seat, offerIsFor, offeredPairWith } = view.data;
  // The chain says it is wound down even if the record has not caught up: nothing more to do here.
  if (seat.windDownKind !== 0)
    return (
      <p className="text-sm" data-testid="seat-wound-down">
        This project has wound down.
      </p>
    );
  const endsAt = seat.offeredAt + seat.offerLasts;
  const live = seat.offeredTo !== null && now <= endsAt;
  const offeredName = offeredPairWith
    ? `${nameOf(offeredPairWith)}, to run it together with you`
    : seat.offeredTo
      ? nameOf(seat.offeredTo)
      : "";
  const canQuietWindDown =
    role === "none" && quietStateAt(numbers, now) === "may_wind_down";
  return (
    <>
      {offerIsFor === "me" && live ? (
        <div className="flex flex-col gap-2" data-testid="seat-offered-to-me">
          <p className="text-sm font-semibold">
            {
              offeredToYouWords(
                nameOf(seat.runner),
                projectName,
                seat.founderLeaves,
              )[0]
            }
          </p>
          <p className="text-sm text-muted">{offerLeftWords(endsAt, now)}</p>
          <Button block data-testid="seat-take" onClick={() => setOpen("take")}>
            Take the seat
          </Button>
        </div>
      ) : null}
      {offerIsFor === "pair-with-me" && live ? (
        <div className="flex flex-col gap-2" data-testid="seat-offered-pair">
          <p className="text-sm font-semibold">
            {pairOfferedToYouWords(nameOf(seat.runner), projectName)[0]}
          </p>
          <p className="text-sm text-muted">{offerLeftWords(endsAt, now)}</p>
          <Button
            block
            data-testid="seat-accept"
            onClick={() => setOpen("accept")}
          >
            Accept the second seat
          </Button>
        </div>
      ) : null}
      {role !== "none" ? (
        <div className="flex flex-col gap-2" data-testid="seat-runner">
          {seat.offeredTo ? (
            <p className="text-sm" data-testid="seat-offer-open">
              The seat is offered to {offeredName}.{" "}
              {offerLeftWords(endsAt, now)}
              {live ? " Until it is taken you still run the money." : ""}
            </p>
          ) : null}
          {live ? (
            <Button
              block
              data-testid="seat-withdraw"
              onClick={() => setOpen("withdraw")}
              variant="secondary"
            >
              Withdraw the offer
            </Button>
          ) : (
            <>
              <Button
                block
                data-testid="seat-hand-over"
                onClick={() => setOpen("hand-over")}
                variant="secondary"
              >
                Hand over the seat
              </Button>
              {role === "alone" ? (
                <Button
                  block
                  data-testid="seat-pair"
                  onClick={() => setOpen("pair")}
                  variant="secondary"
                >
                  Run it together with someone
                </Button>
              ) : null}
            </>
          )}
          <Button
            block
            data-testid="seat-wind-down"
            onClick={() => setOpen("wind-down")}
            variant="secondary"
          >
            Wind down
          </Button>
        </div>
      ) : null}
      {canQuietWindDown ? (
        <div className="flex flex-col gap-2" data-testid="seat-quiet">
          <p className="text-sm">
            The team has been quiet for {quietWaitWords(numbers)}, so anyone can
            wind the project down. Taking out stays open.
          </p>
          <Button
            block
            data-testid="seat-wind-down"
            onClick={() => setOpen("wind-down")}
            variant="secondary"
          >
            Wind down
          </Button>
        </div>
      ) : null}
      {(["hand-over", "pair"] as const).map((mode: OfferMode) => (
        <OfferSheet
          key={mode}
          members={members}
          mode={mode}
          numbers={numbers}
          onClose={close}
          open={open === mode}
          ready={ready}
        />
      ))}
      <WithdrawSheet
        numbers={numbers}
        onClose={close}
        open={open === "withdraw"}
        ready={ready}
        toName={offeredName || "The person"}
      />
      {(offerIsFor === "me" || offerIsFor === "pair-with-me") && live ? (
        <TakeSeatSheet
          fromName={nameOf(seat.runner)}
          mode={offerIsFor === "me" ? "seat" : "pair"}
          numbers={numbers}
          onClose={close}
          open={open === "take" || open === "accept"}
          projectName={projectName}
          ready={ready}
          view={view.data}
        />
      ) : null}
      <WindDownSheet
        mode={(role === "none" ? "quiet" : "runner") satisfies WindDownMode}
        numbers={numbers}
        onClose={close}
        open={open === "wind-down"}
        projectName={projectName}
        ready={ready}
      />
    </>
  );
}
