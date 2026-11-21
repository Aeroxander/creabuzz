/**
 * "Start the day": the way back in when the share parked is at the line but no warning day is running (a join cleared the
 * day, or other holders took out, and the contract only looks again when someone parks, takes back or joins). Anyone may
 * press it: the call only makes the pause contract look at the share parked now. It moves no money and costs no fee beyond
 * the network's. The pause contract is the one the Treasury names, never one a record says.
 */
import { pokeCall } from "@creaton/core/pot/pot-calls.ts";
import { pauseGateOf, pauseState } from "@creaton/core/pot/pot-reads.ts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import { potProblem } from "../money/pot-copy";
import { useMoneySend, useSenderWords } from "../money/use-money";
import type { MoneyTarget } from "../pot/target";
import { START_DAY, START_DAY_DONE } from "./pause-words";

export function StartDayButton({ target }: { target: MoneyTarget }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const words = useSenderWords();
  const send = useMoneySend(`start-day:${target.chainId}:${target.treasury}`);
  const toast = useToast();
  const queryClient = useQueryClient();
  if (started) return null;
  const press = () => {
    setProblem(null);
    send.send(
      {
        chainId: target.chainId,
        build: async (wallet) => {
          const read = (to: string, data: string) => wallet.readCall(to, data);
          const gate = await pauseGateOf(read, target.treasury);
          if (!gate || (target.pauseHint && target.pauseHint !== gate))
            throw new Error(
              "The project's pause is not the one this page names.",
            );
          return [{ ...pokeCall(gate) }];
        },
        detail: "start-day",
        // A call replaced in the wallet may have landed under another hash: a day that is running now says so.
        confirm: async (w, _from, _earlier) => {
          const read = (to: string, data: string) => w.readCall(to, data);
          const gate = await pauseGateOf(read, target.treasury);
          if (!gate) return false;
          return (await pauseState(read, gate)).armedAt > 0;
        },
      },
      {
        onSuccess: () => {
          toast(START_DAY_DONE, "done");
          setStarted(true);
          void queryClient.invalidateQueries({ queryKey: ["pot"] });
        },
        onError: (error) => setProblem(potProblem(error, "start-day")),
      },
    );
  };
  return (
    <div className="flex flex-col gap-2">
      {problem ? (
        <p
          className="text-sm text-danger"
          data-testid="start-day-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <div>
        <Button
          data-testid="start-day"
          disabled={send.isPending}
          onClick={press}
          variant="secondary"
        >
          {send.isPending ? words.waiting : START_DAY}
        </Button>
      </div>
    </div>
  );
}
