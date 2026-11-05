/**
 * The two forms of a weekly round (D131): offer Shares at a lowest price, or bid at a highest one. Each says what the
 * price means before anything is sent (what a seller keeps after the treasury's cut, what a bid holds), and allows the
 * round to move the Shares or the money first when it needs to.
 */

import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { bidPlan, offerPlanLine, sellPlan, usdc } from "../lib/rounds-copy";
import {
  encodeBidInRound,
  encodeSellInRound,
  type RoundGrid,
} from "@creaton/core/launchpad/weeklyRounds.ts";
import { encodeApproveBounty } from "@creaton/core/launchpad/workBounty.ts";
import type { RoundsWallet } from "../use-weekly-rounds";

type Send = (key: string, to: string, data: string) => Promise<boolean>;

interface FormProps {
  id: bigint;
  grid: RoundGrid;
  contract: string;
  side: RoundsWallet;
  blocked: boolean;
  busy: string | null;
  onSend: Send;
  onDone: () => void;
}

export function OfferForm({
  id,
  grid,
  contract,
  shares,
  side,
  blocked,
  busy,
  onSend,
  onDone,
  leavingEach,
}: FormProps & {
  shares: string;
  /** What leaving pays a Share now, after the exit fee (D147), or null when it could not be read. */
  leavingEach: bigint | null;
}) {
  const formId = useId();
  const [amountText, setAmountText] = useState("");
  const [priceText, setPriceText] = useState("");
  const plan =
    amountText.trim() && priceText.trim()
      ? sellPlan(grid, amountText, priceText, side.free, false)
      : null;
  const go = async () => {
    if (!plan || "problem" in plan) return;
    if (side.sharesAllowance < plan.amount) {
      const allowed = await onSend(
        "rounds-allow-shares",
        shares,
        encodeApproveBounty(contract, plan.amount),
      );
      if (!allowed) return;
    }
    if (
      await onSend(
        "rounds-offer",
        contract,
        encodeSellInRound(id, plan.amount, plan.step),
      )
    ) {
      onDone();
    }
  };
  return (
    <div className="mt-2 grid gap-2" data-testid="rounds-offer-form">
      <div className="flex flex-wrap items-end gap-2">
        <Field
          id={`${formId}-amount`}
          label="Shares to offer"
          onChange={setAmountText}
          placeholder="50"
          testId="rounds-offer-amount"
          value={amountText}
        />
        <Field
          id={`${formId}-price`}
          label="Lowest price a Share (USDC)"
          onChange={setPriceText}
          placeholder="1.25"
          testId="rounds-offer-price"
          value={priceText}
        />
      </div>
      <PlanLine
        line={
          plan && !("problem" in plan)
            ? offerPlanLine(plan.keepsEach, leavingEach)
            : null
        }
        problem={plan && "problem" in plan ? plan.problem : null}
        testId="rounds-offer-plan"
      />
      <Button
        className="justify-self-start"
        data-testid="rounds-offer-submit"
        disabled={blocked || !plan || "problem" in plan}
        onClick={() => void go()}
        size="sm"
        type="button"
      >
        {busy === "rounds-allow-shares"
          ? "Approving…"
          : busy === "rounds-offer"
            ? "Offering…"
            : "Offer them"}
      </Button>
    </div>
  );
}

export function BidForm({
  id,
  grid,
  contract,
  currency,
  side,
  blocked,
  busy,
  onSend,
  onDone,
  funding = false,
}: FormProps & {
  currency: string;
  /** A funding round: new units for the project, not Shares between holders. */
  funding?: boolean;
}) {
  const formId = useId();
  const [amountText, setAmountText] = useState("");
  const [priceText, setPriceText] = useState("");
  const plan =
    amountText.trim() && priceText.trim()
      ? bidPlan(grid, amountText, priceText, side.usdcBalance)
      : null;
  const go = async () => {
    if (!plan || "problem" in plan) return;
    if (side.usdcAllowance < plan.holds) {
      const allowed = await onSend(
        "rounds-allow-usdc",
        currency,
        encodeApproveBounty(contract, plan.holds),
      );
      if (!allowed) return;
    }
    if (
      await onSend(
        "rounds-bid",
        contract,
        encodeBidInRound(id, plan.amount, plan.step),
      )
    ) {
      onDone();
    }
  };
  return (
    <div className="mt-2 grid gap-2" data-testid="rounds-bid-form">
      <div className="flex flex-wrap items-end gap-2">
        <Field
          id={`${formId}-amount`}
          label={funding ? "New shares to buy" : "Shares to buy"}
          onChange={setAmountText}
          placeholder="30"
          testId="rounds-bid-amount"
          value={amountText}
        />
        <Field
          id={`${formId}-price`}
          label={
            funding
              ? "Highest price a share (USDC)"
              : "Highest price a Share (USDC)"
          }
          onChange={setPriceText}
          placeholder="1.30"
          testId="rounds-bid-price"
          value={priceText}
        />
      </div>
      <PlanLine
        line={
          plan && !("problem" in plan)
            ? `This bid holds ${usdc(plan.holds)} until the round settles. You pay the round's price, never more than yours, and get back the rest.`
            : null
        }
        problem={plan && "problem" in plan ? plan.problem : null}
        testId="rounds-bid-plan"
      />
      <Button
        className="justify-self-start"
        data-testid="rounds-bid-submit"
        disabled={blocked || !plan || "problem" in plan}
        onClick={() => void go()}
        size="sm"
        type="button"
      >
        {busy === "rounds-allow-usdc"
          ? "Approving…"
          : busy === "rounds-bid"
            ? "Bidding…"
            : "Place the bid"}
      </Button>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium" htmlFor={id}>
        {label}
      </label>
      <Input
        className="w-40"
        data-testid={testId}
        id={id}
        inputMode="decimal"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </div>
  );
}

function PlanLine({
  line,
  problem,
  testId,
}: {
  line: string | null;
  problem: string | null;
  testId: string;
}) {
  if (problem) {
    return (
      <p
        className="text-sm text-red-700 dark:text-red-300"
        data-testid={`${testId}-problem`}
        role="alert"
      >
        {problem}
      </p>
    );
  }
  return line ? (
    <p className="text-sm text-muted-foreground" data-testid={testId}>
      {line}
    </p>
  ) : null;
}
