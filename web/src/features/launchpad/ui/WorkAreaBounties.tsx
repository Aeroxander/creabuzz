import { CalendarClock, Coins, Users } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { Input } from "@/shared/ui/input";
import { formatAtomic } from "../lib/amounts";
import {
  bountyStatusLine,
  deadlineFromDate,
  defaultDeadlineDate,
  waitDays,
} from "../lib/bounty-copy";
import { parseUnits } from "@creaton/core/launchpad/daoActions.ts";
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
} from "@creaton/core/launchpad/workBounty.ts";
import type {
  MandateView,
  ProjectView,
} from "@creaton/core/launchpad/workRead.ts";
import { UnauditedNotice } from "./UnauditedNotice";
import { ForecastPanel } from "./ForecastPanel";
import {
  questionOf,
  workBountyQuestion,
} from "@creaton/core/launchpad/forecast.ts";

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
  // With nothing behind it yet, the button is enough: the form says where the money goes.
  const empty = mine.length === 0;
  return (
    <div
      className={
        empty && !open
          ? "mt-2"
          : "mt-2 rounded-lg border border-black/10 p-2 dark:border-white/10"
      }
      data-testid="work-bounties"
    >
      {empty && !open ? null : (
        <p className="text-xs font-semibold">Money behind this work area</p>
      )}
      {empty ? (
        open ? (
          <p className="text-xs text-muted-foreground">
            Money put here goes to the work the reviewers approve, or back to
            you.
          </p>
        ) : null
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
            className={empty ? undefined : "mt-2"}
            data-testid="work-bounty-open"
            onClick={() => setOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Coins aria-hidden className="h-3.5 w-3.5" />
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
  // Its forecasts close when work for its area is first released after it opened (or a day before its deadline).
  const areaClaims = mandate.claims.filter(
    (c) => c.project?.toLowerCase() === bounty.record.projectId.toLowerCase(),
  );
  const releases = areaClaims
    .map((c) => c.record.releasedAt)
    .filter((at) => at > 0 && at >= bounty.record.openedAt);
  const firstRelease = releases.length > 0 ? Math.min(...releases) : null;
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
      <p className="flex flex-wrap items-center gap-2">
        <span
          className="text-base font-bold tabular-nums"
          data-testid="work-bounty-held"
        >
          {money(stage.kind === "paid" ? bounty.record.total : held)}
        </span>
        <Chip icon={Users}>
          {bounty.funders === 1 ? "1 person" : `${bounty.funders} people`}
        </Chip>
        {bounty.walletFunded > 0n ? (
          <Chip tone="success">You put in {money(bounty.walletFunded)}</Chip>
        ) : null}
      </p>
      <p
        className="mt-1 flex gap-1.5 text-muted-foreground"
        data-testid="work-bounty-status"
      >
        <CalendarClock aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>{line}</span>
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
      {chainId !== null && /^[1-9][0-9]*$/.test(chainId) ? (
        <ForecastPanel
          involved={[
            ...mandate.reviewers.map((r) => r.address),
            ...areaClaims.map((c) => c.record.contributor),
          ]}
          now={chainTime}
          question={questionOf({
            kind: "workbounty",
            chainId: Number(chainId),
            contract,
            id: bounty.id,
          })}
          state={workBountyQuestion(bounty.record, firstRelease, chainTime)}
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
        Paid to the work the reviewers approve in time, after the{" "}
        {waitDays(window)} wait; if none is, it comes back to you. Your wallet
        asks twice: to allow the amount, then to put it in.
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
