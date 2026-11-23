/**
 * Wind the project down, for good. It says first what it does to backers (taking out stays open), what it does to the allowance
 * and to Team Shares, and that it cannot be undone; then one press. The runner winds it down by choice through the Launcher
 * (with a Pair, a proposal the other signer confirms); anyone may wind it down on the Treasury once the team has been quiet
 * long enough. The call is exactly the one named on the sheet.
 */
import {
  treasuryWindDownCall,
  windDownCall,
} from "@creaton/core/pot/pot-calls.ts";
import { readSeatState } from "@creaton/core/pot/pot-state.ts";
import type { ProjectNumbers } from "../money/numbers";
import { PotSheet } from "../pot/PotSheet";
import { RunnerAskNote } from "../pot/RunnerAskNote";
import { doneWords, runnerSend } from "../pot/runner-calls";
import type { Ready } from "../pot/use-pot";
import { quietWindDownWhy, windDownWords } from "./seat-words";

export type WindDownMode = "runner" | "quiet";

export function WindDownSheet({
  mode,
  numbers,
  ready,
  projectName,
  open,
  onClose,
}: {
  mode: WindDownMode;
  numbers: ProjectNumbers;
  ready: Ready;
  projectName: string;
  open: boolean;
  onClose: () => void;
}) {
  const send =
    mode === "runner"
      ? runnerSend(
          numbers,
          ready.address,
          windDownCall(numbers.launcher, numbers.key),
        )
      : {
          calls: [treasuryWindDownCall(numbers.contracts.treasury)],
          through: "alone" as const,
        };
  const through = send?.through ?? "alone";
  return (
    <PotSheet
      account={ready.address}
      action={`wind-down:${numbers.chainId}:${numbers.contracts.treasury}`}
      blocked={!send}
      calls={send?.calls ?? null}
      chainId={numbers.chainId}
      confirmLabel={`Wind down ${projectName} for good`}
      description="This cannot be undone"
      done={doneWords(through, "The project is wound down.")}
      landed={
        through === "alone"
          ? async (wallet) =>
              (
                await readSeatState(
                  (to, data) => wallet.readCall(to, data),
                  numbers.contracts.treasury,
                )
              ).windDownKind !== 0
          : undefined
      }
      lookLabel="Look for your wind-down"
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="wind-down"
      testId="wind-down-sheet"
      title={`Wind down ${projectName}`}
    >
      {mode === "quiet" ? (
        <p className="text-sm" data-testid="wind-down-why">
          {quietWindDownWhy(numbers)}
        </p>
      ) : null}
      <ul
        className="flex list-disc flex-col gap-1.5 pl-5 text-sm"
        data-testid="wind-down-terms"
      >
        {windDownWords(mode, numbers.unit).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <RunnerAskNote numbers={numbers} through={send?.through} />
    </PotSheet>
  );
}
