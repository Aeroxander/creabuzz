/**
 * The two order forms of the Trading card: an offer (whole lots at a lowest price) and a bid (whole lots at a highest
 * one). Both are one real form, so Enter sends from any field, and they share what a keyboard and a screen reader
 * need: the cursor lands in the first field when the form opens, a Cancel closes it, the plan and the problem are
 * said in one polite region that is in the page before it has anything to say, a problem waits until the person has
 * left a field (an unfinished "1." is not a mistake yet), and each field names the room line and that region.
 */

import { type Ref, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import type { RoundView } from "@creaton/core/launchpad/secondary.ts";

import {
  bidPlan,
  bidPlanLine,
  quoteHeldLine,
  sellPlan,
  sellPlanLine,
  sellRoomLine,
  type WalletFunds,
} from "../lib/trading-copy";
import type { SecondaryMarketFacts } from "../lib/secondary-read";
import { bidCalls, sellCalls } from "../lib/trading-orders";
import type { SenderCall } from "@/features/identity/lib/sponsoredSender";

/** Put one order on the network as one step: every call built first, then sent together (`lib/trading-orders.ts`). */
export type Place = (
  key: string,
  build: () => SenderCall[],
) => Promise<boolean>;

interface FormProps {
  round: RoundView;
  market: string;
  facts: SecondaryMarketFacts;
  funds: WalletFunds;
  id: bigint;
  /** The element id the form carries, so its trigger can name it in `aria-controls`. */
  domId: string;
  blocked: boolean;
  busy: string | null;
  /** The note saying why sending is off (a wrong network), when there is one. */
  gateNoteId?: string;
  onPlace: Place;
  onDone: () => void;
  onCancel: () => void;
}

/**
 * The offer form: whole lots at a lowest price, held to what the wallet can
 * offer now. The Shares are approved to the market and the offer escrows exactly
 * those lots, as one step.
 */
export function SellForm({
  round,
  market,
  facts,
  funds,
  id,
  domId,
  blocked,
  busy,
  gateNoteId,
  onPlace,
  onDone,
  onCancel,
}: FormProps) {
  return (
    <OrderForm
      blocked={blocked}
      busyLabel="Offering…"
      domId={domId}
      gateNoteId={gateNoteId}
      isBusy={busy === "trading-sell"}
      lotsLabel="Lots to offer"
      onCancel={onCancel}
      onSend={async (plan) => {
        const placed = await onPlace("trading-sell", () =>
          sellCalls({
            market,
            roundId: id,
            lots: plan.lots,
            level: plan.level,
            facts,
          }),
        );
        if (placed) onDone();
      }}
      planFor={(lots, price) => sellPlan(round, lots, price, facts, funds)}
      planLine={(plan) => sellPlanLine(round, plan, facts)}
      priceLabel={`Lowest price a lot (${facts.quoteSymbol})`}
      pricePlaceholder="1.02"
      room={sellRoomLine(funds, facts.lotSize)}
      submitLabel="Offer them"
      testPrefix="trading-sell"
    />
  );
}

/**
 * The bid form: whole lots at a highest price, held to the money the wallet
 * holds. The money the bid holds is approved to the market (unless it already
 * is) and escrowed by the bid, as one step.
 */
export function BidForm({
  round,
  market,
  facts,
  funds,
  id,
  domId,
  blocked,
  busy,
  gateNoteId,
  onPlace,
  onDone,
  onCancel,
}: FormProps) {
  return (
    <OrderForm
      blocked={blocked}
      busyLabel="Bidding…"
      domId={domId}
      gateNoteId={gateNoteId}
      isBusy={busy === "trading-bid"}
      lotsLabel="Lots to buy"
      onCancel={onCancel}
      onSend={async (plan) => {
        const placed = await onPlace("trading-bid", () =>
          bidCalls({
            market,
            roundId: id,
            round,
            lots: plan.lots,
            level: plan.level,
            allowance: funds.quoteAllowance,
            facts,
          }),
        );
        if (placed) onDone();
      }}
      planFor={(lots, price) => bidPlan(round, lots, price, facts, funds)}
      planLine={(plan) => bidPlanLine(round, plan, facts)}
      priceLabel={`Highest price a lot (${facts.quoteSymbol})`}
      pricePlaceholder="1.05"
      room={quoteHeldLine(funds, facts)}
      submitLabel="Place the bid"
      testPrefix="trading-bid"
    />
  );
}

type Planned = { lots: bigint; level: number };

function OrderForm({
  domId,
  testPrefix,
  room,
  lotsLabel: lotsFieldLabel,
  priceLabel,
  pricePlaceholder,
  planFor,
  planLine,
  submitLabel,
  busyLabel,
  isBusy,
  blocked,
  gateNoteId,
  onSend,
  onCancel,
}: {
  domId: string;
  testPrefix: string;
  room: string;
  lotsLabel: string;
  priceLabel: string;
  pricePlaceholder: string;
  planFor: (lots: string, price: string) => Planned | { problem: string };
  planLine: (plan: Planned) => string;
  submitLabel: string;
  busyLabel: string;
  isBusy: boolean;
  blocked: boolean;
  gateNoteId?: string;
  onSend: (plan: Planned) => Promise<void>;
  onCancel: () => void;
}) {
  const fieldId = useId();
  const roomId = `${fieldId}-room`;
  const statusId = `${fieldId}-status`;
  const lotsRef = useRef<HTMLInputElement>(null);
  const [lotsInput, setLotsInput] = useState("");
  const [priceText, setPriceText] = useState("");
  // A problem is told once both fields have been left (or a send was tried): "1." on the way to "1.05" is not a
  // mistake yet, and tabbing on from the first field must not announce the second one's unfinished text.
  const [left, setLeft] = useState({ lots: false, price: false });
  // The person opened this form to fill it in: the cursor starts in its first field.
  useEffect(() => {
    lotsRef.current?.focus();
  }, []);
  const plan =
    lotsInput.trim() && priceText.trim() ? planFor(lotsInput, priceText) : null;
  const ok = plan !== null && !("problem" in plan);
  const problem =
    plan && "problem" in plan && left.lots && left.price ? plan.problem : null;
  const line = ok ? planLine(plan) : null;
  const describedBy = `${roomId} ${statusId}`;
  const field = { describedBy, invalid: problem !== null };
  return (
    <form
      className="mt-2 grid gap-2"
      data-testid={`${testPrefix}-form`}
      id={domId}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        // Enter with a plan that does not hold says why instead of doing nothing.
        if (!ok) {
          setLeft({ lots: true, price: true });
          return;
        }
        void onSend(plan);
      }}
    >
      <p
        className="text-sm text-muted-foreground"
        data-testid={`${testPrefix}-room`}
        id={roomId}
      >
        {room}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field
          {...field}
          id={`${fieldId}-lots`}
          inputMode="numeric"
          inputRef={lotsRef}
          label={lotsFieldLabel}
          onChange={setLotsInput}
          onLeave={() => setLeft((was) => ({ ...was, lots: true }))}
          placeholder="2"
          testId={`${testPrefix}-lots`}
          value={lotsInput}
        />
        <Field
          {...field}
          id={`${fieldId}-price`}
          label={priceLabel}
          onChange={setPriceText}
          onLeave={() => setLeft((was) => ({ ...was, price: true }))}
          placeholder={pricePlaceholder}
          testId={`${testPrefix}-price`}
          value={priceText}
        />
      </div>
      <div
        aria-live="polite"
        className="text-sm"
        data-testid={`${testPrefix}-plan-live`}
        id={statusId}
        role="status"
      >
        {problem ? (
          <span
            className="text-red-700 dark:text-red-300"
            data-testid={`${testPrefix}-plan-problem`}
          >
            {problem}
          </span>
        ) : line ? (
          <span
            className="text-muted-foreground"
            data-testid={`${testPrefix}-plan`}
          >
            {line}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-describedby={gateNoteId}
          data-testid={`${testPrefix}-submit`}
          disabled={blocked || !ok}
          size="sm"
          type="submit"
        >
          {isBusy ? busyLabel : submitLabel}
        </Button>
        <Button
          data-testid={`${testPrefix}-cancel`}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  testId,
  describedBy,
  invalid,
  onLeave,
  inputRef,
  inputMode = "decimal",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  testId: string;
  describedBy: string;
  invalid: boolean;
  onLeave: () => void;
  inputRef?: Ref<HTMLInputElement>;
  inputMode?: "decimal" | "numeric";
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium" htmlFor={id}>
        {label}
      </label>
      <Input
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className="w-40"
        data-testid={testId}
        id={id}
        inputMode={inputMode}
        onBlur={onLeave}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        ref={inputRef}
        value={value}
      />
    </div>
  );
}
