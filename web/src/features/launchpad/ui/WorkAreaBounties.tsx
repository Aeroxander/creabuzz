import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { formatAtomic } from "../lib/amounts";
import {
  bountyStatusLine,
  deadlineFromDate,
  defaultDeadlineDate,
  waitDays,
} from "../lib/bounty-copy";
import { parseUnits } from "../lib/dao-actions";
import {
  type BountyView,
  type WorkBounties,
  bountyStage,
  bountyTakesMoney,
  encodeApproveBounty,
  encodeFundBounty,
  encodeOpenBounty,
  encodeRefundBounty,
  encodeSettleBounty,
} from "../lib/work-bounty";
import type { MandateView, ProjectView } from "../lib/work-read";
import { UnauditedNotice } from "./UnauditedNotice";

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

type Send = (key: string, to: string, data: string) => Promise<boolean>;

/**
 * Money people put behind one work area (N1), and the one step each bounty needs next: add to it, pay the approved
 * work once its wait is over, or take your money back when nothing was approved in time. The project's reviewers
 * decide, exactly as for Shares; nobody votes here.
 */
export function WorkAreaBounties({
  read,
  mandate,
  project,
  chainId,
  chainTime,
  wallet,
  gate,
  busy,
  onSend,
  labelOf,
}: {
  /** What the bounty contract holds for this DAO; undefined while it is read. */
  read: WorkBounties | undefined;
  mandate: MandateView;
  project: ProjectView;
  chainId: string | null;
  chainTime: number;
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  onSend: Send;
  labelOf: (address: string) => string;
}) {
  const [open, setOpen] = useState(false);
  if (!read) return null;
  const money = (units: bigint) =>
    read.currency.decimalsKnown
      ? `${formatAtomic(units, read.currency.decimals, { maxFractionDigits: 2 })} ${read.currency.symbol}`.trim()
      : `${units.toString()} raw units of ${read.currency.symbol}`;
  const mine = read.bounties.filter(
    (b) =>
      b.record.mandate.toLowerCase() === mandate.address.toLowerCase() &&
      b.record.projectId.toLowerCase() === project.id.toLowerCase(),
  );
  // A bounty can only pay work the manager can still bind to this area, so a new one needs the area and budget open;
  // while one is still taking money, people add to it instead of starting another.
  const canOpen =
    !mandate.closed &&
    chainTime < project.record.expiresAt &&
    read.currency.decimalsKnown &&
    !mine.some((b) => bountyTakesMoney(b.record, chainTime));
  if (mine.length === 0 && !canOpen) return null;
  return (
    <div
      className="mt-1 rounded-lg border border-black/10 p-2 dark:border-white/10"
      data-testid="work-bounties"
    >
      <p className="text-xs font-semibold">Money behind this work area</p>
      {mine.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None yet. Money put here goes to the work the reviewers approve, or
          back to you.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-2">
          {mine.map((bounty) => (
            <BountyRow
              balance={read.walletBalance}
              bounty={bounty}
              busy={busy}
              chainId={chainId}
              chainTime={chainTime}
              mandate={mandate}
              contract={read.contract}
              currency={read.currency}
              gate={gate}
              key={bounty.id.toString()}
              labelOf={labelOf}
              money={money}
              onSend={onSend}
              wallet={wallet}
            />
          ))}
        </ul>
      )}
      {canOpen ? (
        open ? (
          <FundForm
            balance={read.walletBalance}
            busy={busy}
            chainId={chainId}
            contract={read.contract}
            currency={read.currency}
            gate={gate}
            initialDate={defaultDeadlineDate(
              chainTime,
              project.record.expiresAt,
            )}
            money={money}
            onCancel={() => setOpen(false)}
            onDone={() => setOpen(false)}
            onSend={onSend}
            submit={(amount, deadline) =>
              deadline === null
                ? null
                : {
                    key: `bounty-open-${project.id}`,
                    data: encodeOpenBounty(
                      mandate.address,
                      project.id,
                      deadline,
                      amount,
                    ),
                  }
            }
            window={mandate.challengeWindow}
            withDeadline={{
              now: chainTime,
              expiresAt: project.record.expiresAt,
            }}
          />
        ) : (
          <Button
            className="mt-2"
            data-testid="work-bounty-open"
            onClick={() => setOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Put money behind this work area
          </Button>
        )
      ) : null}
    </div>
  );
}

function BountyRow({
  bounty,
  mandate,
  balance,
  chainId,
  chainTime,
  contract,
  currency,
  wallet,
  gate,
  busy,
  onSend,
  labelOf,
  money,
}: {
  bounty: BountyView;
  mandate: MandateView;
  balance: bigint | null;
  chainId: string | null;
  chainTime: number;
  contract: string;
  currency: WorkBounties["currency"];
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  onSend: Send;
  labelOf: (address: string) => string;
  money: (units: bigint) => string;
}) {
  const [adding, setAdding] = useState(false);
  const stage = bountyStage(bounty.record, mandate.claims, chainTime);
  const held = bounty.record.total - bounty.record.refunded;
  const key = bounty.id.toString();
  const blocked = busy !== null || gate !== null;
  const line = bountyStatusLine(stage, bounty.record, {
    money,
    date,
    who: labelOf,
  });
  return (
    <li className="text-xs" data-testid="work-bounty">
      <p>
        <span className="font-medium" data-testid="work-bounty-held">
          {money(stage.kind === "paid" ? bounty.record.total : held)}
        </span>
        <span className="text-muted-foreground">
          {" "}
          from {bounty.funders === 1 ? "1 person" : `${bounty.funders} people`}
          {bounty.walletFunded > 0n
            ? ` · you put in ${money(bounty.walletFunded)}`
            : ""}
        </span>
      </p>
      <p className="text-muted-foreground" data-testid="work-bounty-status">
        {line}
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        {stage.kind === "payable" ? (
          <Button
            data-testid="work-bounty-pay"
            disabled={blocked}
            onClick={() =>
              void onSend(
                `bounty-pay-${key}`,
                contract,
                encodeSettleBounty(bounty.id, stage.claimId),
              )
            }
            size="sm"
            type="button"
          >
            Pay {labelOf(stage.contributor)}
          </Button>
        ) : null}
        {stage.kind === "refunds" && wallet && bounty.walletFunded > 0n ? (
          <Button
            data-testid="work-bounty-refund"
            disabled={blocked}
            onClick={() =>
              void onSend(
                `bounty-refund-${key}`,
                contract,
                encodeRefundBounty(bounty.id, wallet),
              )
            }
            size="sm"
            type="button"
          >
            Take back my {money(bounty.walletFunded)}
          </Button>
        ) : null}
        {bountyTakesMoney(bounty.record, chainTime) && !adding ? (
          <Button
            data-testid="work-bounty-add"
            onClick={() => setAdding(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Add money
          </Button>
        ) : null}
      </div>
      {adding ? (
        <FundForm
          balance={balance}
          busy={busy}
          chainId={chainId}
          contract={contract}
          currency={currency}
          gate={gate}
          money={money}
          onCancel={() => setAdding(false)}
          onDone={() => setAdding(false)}
          onSend={onSend}
          submit={(amount) => ({
            key: `bounty-fund-${key}`,
            data: encodeFundBounty(bounty.id, amount),
          })}
          window={bounty.record.window}
        />
      ) : null}
    </li>
  );
}

/** An amount (and, for a new bounty, a deadline), then the two wallet steps: allow the amount, then put it in. */
function FundForm({
  contract,
  currency,
  balance,
  chainId,
  gate,
  busy,
  onSend,
  submit,
  onCancel,
  onDone,
  money,
  window,
  withDeadline,
  initialDate,
}: {
  contract: string;
  currency: WorkBounties["currency"];
  balance: bigint | null;
  chainId: string | null;
  gate: string | null;
  busy: string | null;
  onSend: Send;
  submit: (
    amount: bigint,
    deadline: number | null,
  ) => { key: string; data: string } | null;
  onCancel: () => void;
  onDone: () => void;
  money: (units: bigint) => string;
  window: number;
  withDeadline?: { now: number; expiresAt: number };
  initialDate?: string;
}) {
  const id = useId();
  // The button that opened this form is gone now, so the keyboard lands on the amount instead of the page.
  const amountInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    amountInput.current?.focus({ preventScroll: true });
  }, []);
  const [amountText, setAmountText] = useState("");
  const [dateText, setDateText] = useState(initialDate ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    setProblem(null);
    let amount: bigint;
    try {
      amount = parseUnits(
        amountText,
        currency.decimals,
        "amount",
        "The amount",
      );
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    if (amount === 0n) {
      setProblem("Put in more than zero.");
      return;
    }
    if (balance !== null && amount > balance) {
      setProblem(`Your wallet holds ${money(balance)}, less than that.`);
      return;
    }
    const deadline = withDeadline
      ? deadlineFromDate(dateText, withDeadline.now, withDeadline.expiresAt)
      : null;
    if (withDeadline && deadline === null) {
      setProblem("Pick a date after today.");
      return;
    }
    const step = submit(amount, deadline);
    if (!step) return;
    // The allowance first; the money only if it went through.
    const allowed = await onSend(
      `${step.key}-allow`,
      currency.address,
      encodeApproveBounty(contract, amount),
    );
    if (!allowed) return;
    if (await onSend(step.key, contract, step.data)) onDone();
  };
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="work-bounty-form">
      <div className="flex flex-col gap-1 text-sm">
        <label className="font-medium" htmlFor={`${id}-amount`}>
          How much ({currency.symbol})
        </label>
        <Input
          data-testid="work-bounty-amount"
          id={`${id}-amount`}
          inputMode="decimal"
          ref={amountInput}
          onChange={(e) => setAmountText(e.target.value)}
          placeholder="25"
          value={amountText}
        />
        {balance !== null ? (
          <span className="text-xs text-muted-foreground">
            Your wallet holds {money(balance)}.
          </span>
        ) : null}
      </div>
      {withDeadline ? (
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor={`${id}-deadline`}>
            Work must be approved by
          </label>
          <Input
            data-testid="work-bounty-deadline"
            id={`${id}-deadline`}
            onChange={(e) => setDateText(e.target.value)}
            type="date"
            value={dateText}
          />
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        It goes to whoever's work for this area the reviewers approve in time,
        after the {waitDays(window)} wait. If nobody's is, you get it back. It
        stays in until then. Your wallet asks twice: once to allow the amount,
        once to put it in.
      </p>
      <UnauditedNotice chainId={chainId} />
      {gate ? <p className="text-xs text-muted-foreground">{gate}</p> : null}
      {problem ? (
        <p className="text-xs text-red-700 dark:text-red-300" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid="work-bounty-submit"
          disabled={busy !== null || gate !== null}
          onClick={() => void go()}
          size="sm"
          type="button"
        >
          {busy?.startsWith("bounty-")
            ? "Waiting for your wallet…"
            : "Put it in"}
        </Button>
        <Button onClick={onCancel} size="sm" type="button" variant="outline">
          Cancel
        </Button>
      </div>
    </div>
  );
}
