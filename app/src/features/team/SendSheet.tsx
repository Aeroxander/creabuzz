import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import type { MoneyCall } from "../money/calls-v1";
import { useMoneySend } from "../money/use-money";
import type { MoneyWallet } from "../money/wallet";
import { type TeamAction, teamProblem } from "./team-copy";

/**
 * The second press of every Team and market step: a sheet that says what will happen, then one press that asks the
 * wallet. One step runs at a time per action and sending account (`useMoneySend`), and a call that went out but has not
 * landed is looked up on the next press instead of being sent twice.
 */
export function SendSheet({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  testId,
  action,
  copy,
  chainId,
  build,
  done,
  disabled,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  testId: string;
  /** The step's name for the waiting-call memory: what, on which chain, for which contract. */
  action: string;
  copy: TeamAction;
  chainId: number;
  build: (wallet: MoneyWallet) => Promise<MoneyCall[]> | MoneyCall[];
  done: string;
  disabled?: boolean;
  onSent?: () => void;
}) {
  const send = useMoneySend(action);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Sheet
      description={`Nothing is sent until you say so here and ${send.words.where}.`}
      onOpenChange={(next) => {
        if (!send.isPending) {
          setProblem(null);
          onOpenChange(next);
        }
      }}
      open={open}
      testId={testId}
      title={title}
    >
      <div className="flex flex-col gap-2 text-sm">{children}</div>
      {problem ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid={`${testId}-problem`}
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <Button
        block
        data-testid={`${testId}-confirm`}
        disabled={send.isPending || disabled}
        onClick={() => {
          setProblem(null);
          send.send(
            { chainId, build },
            {
              onSuccess: () => {
                // Team's own reads (the Pair's waiting calls, an offered seat) are read again too.
                void queryClient.invalidateQueries({ queryKey: ["team"] });
                // The market's own reads (the sale's stage, this wallet's bids) are read again too.
                void queryClient.invalidateQueries({ queryKey: ["market"] });
                toast(done, "done");
                onSent?.();
                onOpenChange(false);
              },
              onError: (error) => setProblem(teamProblem(error, copy)),
            },
          );
        }}
      >
        {send.isPending
          ? send.words.waiting
          : send.waiting
            ? send.words.lookFor
            : confirmLabel}
      </Button>
    </Sheet>
  );
}

/**
 * One press that asks the wallet, for a step whose card already says what it does (the plan's 1-press budgets: open
 * backing, confirm a co-signer's call). Same guard and waiting-call memory as the sheet.
 */
export function SendButton({
  label,
  testId,
  action,
  copy,
  chainId,
  build,
  done,
  variant = "primary",
  block,
  disabled,
}: {
  label: string;
  testId: string;
  action: string;
  copy: TeamAction;
  chainId: number;
  build: (wallet: MoneyWallet) => Promise<MoneyCall[]> | MoneyCall[];
  done: string;
  variant?: "primary" | "secondary" | "ghost";
  block?: boolean;
  /** Held back until the card's own condition holds (a box ticked, a wallet typed). */
  disabled?: boolean;
}) {
  const send = useMoneySend(action);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-stretch gap-1.5">
      <Button
        block={block}
        data-testid={testId}
        disabled={send.isPending || disabled}
        onClick={() => {
          setProblem(null);
          send.send(
            { chainId, build },
            {
              onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: ["team"] });
                void queryClient.invalidateQueries({ queryKey: ["market"] });
                toast(done, "done");
              },
              onError: (error) => setProblem(teamProblem(error, copy)),
            },
          );
        }}
        size={block ? "md" : "sm"}
        variant={variant}
      >
        {send.isPending
          ? send.words.waiting
          : send.waiting
            ? send.words.lookFor
            : label}
      </Button>
      {problem ? (
        <p
          className="text-sm text-danger"
          data-testid={`${testId}-problem`}
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}
