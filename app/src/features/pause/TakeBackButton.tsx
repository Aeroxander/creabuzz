/**
 * Take parked Shares back, inline: no sheet of its own. One press shows what will happen ("Take back 40 Shares to your
 * wallet. Nothing is charged.") with Take back and Cancel; the second press sends `unpark`. Nothing here is ever held back
 * by the pause, a wind-down or the door: the call has no condition, and the button is shown whenever Shares are parked,
 * whatever the record says.
 */
import { unparkCall } from "@creaton/core/pot/pot-calls.ts";
import { parkedOf } from "@creaton/core/pot/pot-reads.ts";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import { potProblem } from "../money/pot-copy";
import { useMoneySend, useSenderWords, useWallet } from "../money/use-money";
import type { MoneyTarget } from "../pot/target";
import type { Ready } from "../pot/use-pot";
import {
  TAKE_BACK,
  TAKE_BACK_DONE,
  takeBackAsk,
  takeBackAskAccount,
} from "./pause-words";

export function TakeBackButton({
  ready,
  target,
  gate,
  parked,
}: {
  ready: Ready;
  target: MoneyTarget;
  /** The pause contract the Treasury names (read from the chain, never from a record). */
  gate: string;
  /** What this account has parked, as just read. */
  parked: bigint;
}) {
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const wallet = useWallet();
  const words = useSenderWords();
  const send = useMoneySend(`take-back:${target.chainId}:${target.treasury}`);
  const toast = useToast();
  const queryClient = useQueryClient();
  const askId = useId();

  const press = async () => {
    if (checking || send.isPending) return;
    setProblem(null);
    setChecking(true);
    let shown: string | null = null;
    try {
      shown = await wallet.connectedAddress();
    } catch {
      shown = null;
    }
    setChecking(false);
    // The amount was read for one account; it is never sent for another one the wallet shows now.
    if (shown !== ready.address.toLowerCase())
      return setProblem(
        words.kind === "passkey"
          ? "The account behind your passkey is not the one these numbers were read for. Nothing was sent. Close this and open it again."
          : "Your wallet now shows a different account than the one these numbers were read for. Nothing was sent. Close this and open it again.",
      );
    send.send(
      {
        chainId: target.chainId,
        build: () => [{ ...unparkCall(gate, parked) }],
        detail: parked.toString().slice(0, 80),
        // A call replaced in the wallet may have landed under another hash: fewer Shares parked now say so.
        confirm: async (w, from, earlier) => {
          if (!earlier.detail || !/^\d+$/.test(earlier.detail)) return false;
          const now = await parkedOf(
            (to, data) => w.readCall(to, data),
            gate,
            from,
          );
          return now < BigInt(earlier.detail);
        },
      },
      {
        onSuccess: () => {
          toast(TAKE_BACK_DONE, "done");
          setAsking(false);
          void queryClient.invalidateQueries({ queryKey: ["pot"] });
        },
        onError: (error) => setProblem(potProblem(error, "take-back")),
      },
    );
  };

  if (!asking)
    return (
      <div className="flex flex-col gap-2">
        <Button
          data-testid="take-back"
          onClick={() => {
            setProblem(null);
            setAsking(true);
          }}
          variant="secondary"
        >
          {TAKE_BACK}
        </Button>
      </div>
    );
  return (
    <div
      className="flex flex-col gap-2 rounded-xl bg-white/5 p-3"
      data-testid="take-back-ask"
    >
      <p className="text-sm" id={askId}>
        {words.kind === "passkey"
          ? takeBackAskAccount(parked)
          : takeBackAsk(parked)}
      </p>
      {problem ? (
        <p
          className="text-sm text-danger"
          data-testid="take-back-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          aria-describedby={askId}
          autoFocus
          data-testid="take-back-confirm"
          disabled={checking || send.isPending}
          onClick={() => void press()}
        >
          {checking || send.isPending ? words.waiting : TAKE_BACK}
        </Button>
        <Button
          data-testid="take-back-cancel"
          disabled={send.isPending}
          onClick={() => setAsking(false)}
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
