/**
 * The one sheet every money press goes through: the numbers it is about (children), the calls those numbers made, and one
 * press. It never sends twice (a press while the step runs does nothing, and a step whose call went out but has not landed
 * is looked up before any other is sent), says what happened when a send fails and keeps the press so the person can try
 * again, and shows the legal line. Escape and the close button close it, and focus goes back to what opened it.
 */
import type { PotCall } from "@creaton/core/pot/pot-calls.ts";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import { OwnershipLine } from "../money/OwnershipLine";
import { type PotAction, potProblem } from "../money/pot-copy";
import { type MoneySendInput, useMoneySend } from "../money/use-money";
import type { MoneyWallet } from "../money/wallet";
import type { PendingSend } from "../money/pending-sends";
import { CAN_TAKE_OUT, PLAY_MONEY_WORDS } from "./pot-words";

export interface PotSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  testId: string;
  /** Names the step: one runs at a time under it, and a call that went out is remembered under it. */
  action: string;
  chainId: number;
  /** The calls this sheet's numbers made. Null while the numbers are being read: the press is off. */
  calls: readonly PotCall[] | null;
  /** What the step is for when the action alone does not say, kept with a call still waiting (at most 80 characters). */
  detail?: string;
  /** Whether a call sent earlier took effect after all, read from the chain. */
  landed?: (
    wallet: MoneyWallet,
    from: string,
    earlier: PendingSend,
  ) => Promise<boolean>;
  /** The press's words. */
  confirmLabel: string;
  /** What a "waiting" call is looked for as: "Look for your backing". */
  lookLabel: string;
  problemAction: PotAction;
  /** The note shown when it landed. */
  done: string;
  /** Runs once it landed, with the hash. */
  onLanded?: (txHash: string) => void;
  /** Say play money under the numbers (a test network). */
  playMoney: boolean;
  /** Something on the sheet makes the press wrong now (a refusal read before sending). */
  blocked?: boolean;
  children: ReactNode;
}

export function PotSheet(props: PotSheetProps) {
  const { open, onOpenChange, calls } = props;
  const send = useMoneySend(props.action);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const press = () => {
    if (!calls || calls.length === 0) return;
    setProblem(null);
    const input: MoneySendInput = {
      chainId: props.chainId,
      // What the sheet showed is what is sent: the calls were made from the same read as the numbers.
      build: () => calls.map((call) => ({ ...call })),
      ...(props.detail === undefined ? {} : { detail: props.detail }),
      ...(props.landed ? { confirm: props.landed } : {}),
    };
    send.send(input, {
      onSuccess: (result) => {
        toast(props.done, "done");
        void queryClient.invalidateQueries({ queryKey: ["pot"] });
        props.onLanded?.(result.txHash);
        onOpenChange(false);
      },
      onError: (error) => setProblem(potProblem(error, props.problemAction)),
    });
  };
  const label = send.isPending
    ? send.words.waiting
    : send.waiting
      ? props.lookLabel
      : props.confirmLabel;
  return (
    <Sheet
      description={`${props.description ? `${props.description}. ` : ""}Nothing is sent until you press the button below and say yes ${send.words.where}.`}
      onOpenChange={(next) => {
        // A step on its way is not abandoned by closing: it is looked up when the sheet is opened again.
        if (!next && send.isPending) return;
        if (!next) setProblem(null);
        onOpenChange(next);
      }}
      open={open}
      testId={props.testId}
      title={props.title}
    >
      {props.children}
      {props.playMoney ? (
        <p className="text-sm text-muted" data-testid="sheet-play-money">
          {PLAY_MONEY_WORDS}
        </p>
      ) : null}
      <p className="text-sm text-muted">{CAN_TAKE_OUT}</p>
      <OwnershipLine />
      {problem ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid="sheet-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <Button
        block
        data-testid="sheet-confirm"
        disabled={
          send.isPending || props.blocked || !calls || calls.length === 0
        }
        onClick={press}
      >
        {label}
      </Button>
    </Sheet>
  );
}
