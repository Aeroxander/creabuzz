/**
 * The sheets of the person the seat is offered to (take it, or accept the second seat of a pair) and of the runner who
 * withdraws an offer. Each says what it does before the press and sends exactly one call. Taking the seat and accepting go
 * from the person's own account straight to the contracts; withdrawing is a runner's call (a proposal with a Pair).
 */
import {
  handOverCall,
  makePairCall,
  takeSeatCall,
  ZERO_ADDRESS,
} from "@creaton/core/pot/pot-calls.ts";
import { readSeatState } from "@creaton/core/pot/pot-state.ts";
import type { ProjectNumbers } from "../money/numbers";
import { PotSheet } from "../pot/PotSheet";
import { RunnerAskNote } from "../pot/RunnerAskNote";
import { doneWords, runnerSend } from "../pot/runner-calls";
import type { Ready } from "../pot/use-pot";
import type { SeatView } from "./use-seat";
import {
  offerLastsWords,
  offeredToYouWords,
  pairOfferedToYouWords,
} from "./seat-words";

interface TakeProps {
  mode: "seat" | "pair";
  numbers: ProjectNumbers;
  ready: Ready;
  view: SeatView;
  projectName: string;
  /** Who made the offer, by name. */
  fromName: string;
  open: boolean;
  onClose: () => void;
}

export function TakeSeatSheet({
  mode,
  numbers,
  ready,
  view,
  projectName,
  fromName,
  open,
  onClose,
}: TakeProps) {
  const { seat } = view;
  const call =
    mode === "seat"
      ? takeSeatCall(numbers.contracts.treasury)
      : makePairCall(numbers.launcher, numbers.key, seat.runner);
  const lines =
    mode === "seat"
      ? offeredToYouWords(fromName, projectName, seat.founderLeaves)
      : pairOfferedToYouWords(fromName, projectName);
  const ends = seat.offeredAt + seat.offerLasts;
  const me = ready.address.toLowerCase();
  return (
    <PotSheet
      account={ready.address}
      action={`seat-${mode}:${numbers.chainId}:${numbers.contracts.treasury}`}
      calls={[call]}
      chainId={numbers.chainId}
      confirmLabel={
        mode === "seat" ? "Take the seat" : `Run ${projectName} together`
      }
      description={
        mode === "seat"
          ? "Take the seat that runs the project's money"
          : "Accept the second seat that runs the project's money"
      }
      done={
        mode === "seat"
          ? "You run the project's money now."
          : "You and the other signer run the project's money now."
      }
      landed={async (wallet) => {
        const now = await readSeatState(
          (to, data) => wallet.readCall(to, data),
          numbers.contracts.treasury,
        );
        return mode === "seat"
          ? now.runner === me
          : seat.offeredTo !== null && now.runner === seat.offeredTo;
      }}
      lookLabel="Look for your seat"
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction={mode === "seat" ? "seat" : "pair"}
      testId="take-seat-sheet"
      title={mode === "seat" ? "Take the seat" : "Accept the second seat"}
    >
      <ul
        className="flex list-disc flex-col gap-1.5 pl-5 text-sm"
        data-testid="take-seat-terms"
      >
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
        <li data-testid="take-seat-ends">
          {offerLastsWords(seat.offerLasts, ends)}
        </li>
      </ul>
    </PotSheet>
  );
}

interface WithdrawProps {
  numbers: ProjectNumbers;
  ready: Ready;
  /** Who the offer is for, by name. */
  toName: string;
  open: boolean;
  onClose: () => void;
}

export function WithdrawSheet({
  numbers,
  ready,
  toName,
  open,
  onClose,
}: WithdrawProps) {
  const send = runnerSend(
    numbers,
    ready.address,
    handOverCall({
      treasury: numbers.contracts.treasury,
      next: ZERO_ADDRESS,
      founderLeaves: false,
    }),
  );
  const through = send?.through ?? "alone";
  return (
    <PotSheet
      account={ready.address}
      action={`seat-withdraw:${numbers.chainId}:${numbers.contracts.treasury}`}
      blocked={!send}
      calls={send?.calls ?? null}
      chainId={numbers.chainId}
      confirmLabel="Withdraw the offer"
      description="Take back the offer of the seat"
      done={doneWords(through, "The offer is withdrawn.")}
      landed={
        through === "alone"
          ? async (wallet) =>
              (
                await readSeatState(
                  (to, data) => wallet.readCall(to, data),
                  numbers.contracts.treasury,
                )
              ).offeredTo === null
          : undefined
      }
      lookLabel="Look for your withdrawal"
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="seat"
      testId="withdraw-sheet"
      title="Withdraw the offer"
    >
      <p className="text-sm" data-testid="withdraw-terms">
        {toName} can no longer take the seat. Nothing else changes: you keep
        running the project's money.
      </p>
      <RunnerAskNote numbers={numbers} through={send?.through} />
    </PotSheet>
  );
}
