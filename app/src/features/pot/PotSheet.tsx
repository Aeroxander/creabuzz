/**
 * The one sheet every money press goes through: the numbers it is about (children), the calls those numbers made, and one
 * press. It never sends twice (a press while the step runs does nothing, and a step whose call went out but has not landed
 * is looked up before any other is sent), says what happened when a send fails and keeps the press so the person can try
 * again, and shows the legal line. Escape and the close button always close it (even while a wallet has not answered), and focus goes back to what opened it.
 */
import type { PotCall } from "@creaton/core/pot/pot-calls.ts";
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useWallet } from "../money/use-money";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import { OwnershipLine } from "../money/OwnershipLine";
import { type PotAction, potProblem } from "../money/pot-copy";
import { type MoneySendInput, useMoneySend } from "../money/use-money";
import type { MoneyWallet } from "../money/wallet";
import type { PendingSend } from "../money/pending-sends";
import { PLAY_MONEY_WORDS, TAKE_OUT_BANNER } from "./pot-words";

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
  /** Runs once it landed, with the hash and the `detail` of the press that landed (an earlier press's when it was looked up). */
  onLanded?: (txHash: string, detail: string | undefined) => void;
  /** The account the sheet's numbers were read for: the press is refused if the wallet shows another by then. */
  account: string;
  /** The note shown when what landed was an earlier press of the same step (looked up, not sent again). */
  doneEarlier?: string;
  /**
   * The record's own flag for play money. The words are said all the same until real money is switched on (it is not, in
   * step 1): a record that says `false` never takes the line off a money sheet.
   */
  playMoney: boolean;
  /** Something on the sheet makes the press wrong now (a refusal read before sending). */
  blocked?: boolean;
  /**
   * Run once more right before the send, after the account check: it reads what the sheet's numbers stand on again and
   * says, in a sentence, if that moved (then nothing is sent and the sentence is shown); null means go on. A read that
   * fails stops the press too, with words: a step is never sent on numbers that could not be checked.
   */
  recheck?: () => Promise<string | null>;
  children: ReactNode;
}

export function PotSheet(props: PotSheetProps) {
  const { open, onOpenChange, calls } = props;
  const send = useMoneySend(props.action);
  const wallet = useWallet();
  const [checking, setChecking] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const press = async () => {
    if (!calls || calls.length === 0 || checking) return;
    setProblem(null);
    // The numbers were read for one account; money must not move for another one that the wallet shows now.
    setChecking(true);
    let shown: string | null = null;
    try {
      shown = await wallet.connectedAddress();
    } catch {
      shown = null;
    }
    if (shown !== props.account.toLowerCase()) {
      setChecking(false);
      return setProblem(
        "Your wallet now shows a different account than the one these numbers were read for. Nothing was sent. Close this and open it again.",
      );
    }
    if (props.recheck) {
      let moved: string | null;
      try {
        moved = await props.recheck();
      } catch {
        moved =
          "The network could not be asked to check these numbers again, so nothing was sent. Press again in a moment.";
      }
      if (moved) {
        setChecking(false);
        return setProblem(moved);
      }
    }
    setChecking(false);
    const input: MoneySendInput = {
      chainId: props.chainId,
      // What the sheet showed is what is sent: the calls were made from the same read as the numbers.
      build: () => calls.map((call) => ({ ...call })),
      ...(props.detail === undefined ? {} : { detail: props.detail }),
      ...(props.landed ? { confirm: props.landed } : {}),
    };
    send.send(input, {
      onSuccess: (result) => {
        toast(
          result.detail !== props.detail
            ? (props.doneEarlier ??
                "Your earlier step landed. Nothing new was sent.")
            : props.done,
          "done",
        );
        void queryClient.invalidateQueries({ queryKey: ["pot"] });
        props.onLanded?.(result.txHash, result.detail);
        onOpenChange(false);
      },
      onError: (error) => setProblem(potProblem(error, props.problemAction)),
    });
  };
  // A step sent earlier and not found yet may be for something else than what is on this sheet: say so.
  const earlierWaiting =
    send.waiting !== null && send.waiting.detail !== props.detail;
  const label =
    send.isPending || checking
      ? send.words.waiting
      : send.waiting
        ? props.lookLabel
        : props.confirmLabel;
  return (
    <Sheet
      description={`${props.description ? `${props.description}. ` : ""}Nothing is sent until you press the button below and say yes ${send.words.where}.`}
      onOpenChange={(next) => {
        // A wallet that never answers must not lock the sheet: closing is always possible. A step that went out is not
        // abandoned by it: it is looked up (never sent twice) when the sheet is opened again.
        if (!next) setProblem(null);
        onOpenChange(next);
      }}
      open={open}
      testId={props.testId}
      title={props.title}
    >
      {/* The numbers and the choice cannot be edited from the press until it ends: what is shown is what is signed. */}
      <fieldset
        className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
        data-testid="sheet-inputs"
        disabled={checking || send.isPending}
      >
        {props.children}
      </fieldset>
      {mustSayPlayMoney(props.playMoney) ? (
        <p className="text-sm text-muted" data-testid="sheet-play-money">
          {PLAY_MONEY_WORDS}
        </p>
      ) : null}
      <p className="text-sm text-muted" data-testid="sheet-banner">
        {TAKE_OUT_BANNER}
      </p>
      <OwnershipLine />
      {earlierWaiting ? (
        <p className="text-sm" data-testid="sheet-earlier-waiting">
          A step you sent earlier has not been found on the network yet.
          Pressing looks for it first; nothing new is sent while it may still
          land.
        </p>
      ) : null}
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
          send.isPending ||
          checking ||
          props.blocked ||
          !calls ||
          calls.length === 0
        }
        onClick={() => void press()}
      >
        {label}
      </Button>
    </Sheet>
  );
}
