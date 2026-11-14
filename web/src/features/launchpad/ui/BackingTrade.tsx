/**
 * What a backer does with a live pool: put money in, sell, and leave at a milestone. Each is one real form (Enter sends,
 * Cancel closes), each shows what it will do from the pool's own quote before anything is signed, and each sends a price
 * limit and a deadline with it (the pool's own note: a buy sent with no limit can be sandwiched).
 *
 * A problem is said once the person has left the field or pressed the button, never while they are still typing an
 * unfinished number; the field it belongs to is marked and takes the cursor.
 */

import {
  exactDecimal,
  type LeaveQuote,
  parseAmount,
  type PoolView,
  withSlippage,
} from "@creaton/core/launchpad/backing.ts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  DEFAULT_SLIPPAGE_BPS,
  buyCalls,
  buyIssue,
  leaveCalls,
  SLIPPAGE_CHOICES,
  sellCalls,
} from "../lib/backing-orders";
import { money, unitsPhrase, whenWords } from "../lib/backing-copy";
import { useBuyQuote, useLeaveQuote, useSellQuote } from "../use-backing";
import type { Place } from "./TradingOrderForms";

/** What every form is given. */
export interface TradeProps {
  view: PoolView;
  place: Place;
  blocked: boolean;
  busy: string | null;
  gateNoteId?: string;
  onDone: () => void;
  onCancel: () => void;
}

/** A value that follows `value` after the person has stopped changing it for `ms`. */
function useSettled<T>(value: T, ms = 350): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const clocks = (view: PoolView) => ({
  chainNow: view.now,
  browserNow: Math.floor(Date.now() / 1000),
});

function Slippage({
  bps,
  onChange,
  idPrefix,
}: {
  bps: number;
  onChange: (bps: number) => void;
  idPrefix: string;
}) {
  const id = `${idPrefix}-move`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={id}>Allow the price to move by up to</label>
      <select
        className="h-9 rounded-md border border-input bg-background px-2 text-sm max-sm:h-11"
        data-testid="backing-move"
        id={id}
        onChange={(event) => onChange(Number(event.target.value))}
        value={bps}
      >
        {SLIPPAGE_CHOICES.map((choice) => (
          <option key={choice.bps} value={choice.bps}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** "Back this project": the amount, what it buys, and the one step that approves and buys. */
export function BackForm({
  view,
  place,
  blocked,
  busy,
  gateNoteId,
  onDone,
  onCancel,
}: TradeProps) {
  const base = useId();
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [bps, setBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [tried, setTried] = useState(false);
  const { quote: token } = view;
  const parsed = text.trim() === "" ? null : parseAmount(text, token.decimals);
  const asked = useSettled(parsed);
  const priced = useBuyQuote(view.pool, asked);
  const quote =
    asked !== null && asked === parsed ? (priced.data ?? null) : null;
  const issue =
    text.trim() !== "" && parsed === null
      ? `Use a number with at most ${token.decimals} decimals.`
      : buyIssue({
          quoteIn: parsed,
          quote,
          balance: view.walletMoney?.balance ?? null,
          snapshot: view.snapshot,
          token,
        });
  useEffect(() => field.current?.focus(), []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (issue !== null || parsed === null || quote === null) {
      field.current?.focus();
      return;
    }
    const placed = await place("backing-buy", () =>
      buyCalls({
        pool: view.pool,
        token: token.address,
        quoteIn: parsed,
        quote,
        allowance: view.walletMoney?.allowance ?? 0n,
        slippageBps: bps,
        clocks: clocks(view),
      }),
    );
    if (placed) onDone();
  };
  // A problem is said once the person pressed the button, or when the text is not a number at all.
  const unparsable = text.trim() !== "" && parsed === null;
  const problem = tried || unparsable ? issue : null;
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      data-testid="backing-back-form"
      onSubmit={submit}
    >
      <label className="text-sm font-medium" htmlFor={`${base}-amount`}>
        How much to put in{token.symbol ? ` (${token.symbol})` : ""}
      </label>
      <Input
        aria-describedby={`${base}-plan${gateNoteId ? ` ${gateNoteId}` : ""}`}
        aria-invalid={problem !== null}
        autoComplete="off"
        className="max-sm:h-11"
        data-testid="backing-amount"
        id={`${base}-amount`}
        inputMode="decimal"
        onChange={(event) => setText(event.target.value)}
        placeholder="10"
        ref={field}
        value={text}
      />
      {view.walletMoney ? (
        <p className="text-xs text-muted-foreground">
          You hold {money(view.walletMoney.balance, token)}.
        </p>
      ) : null}
      <p
        aria-live="polite"
        className="min-h-5 text-sm"
        data-testid="backing-plan"
        id={`${base}-plan`}
        role="status"
      >
        {quote && parsed !== null
          ? `You get about ${unitsPhrase(quote.unitsOut)}, and at least ${unitsPhrase(withSlippage(quote.unitsOut, bps))} or nothing happens. ${money(quote.fee, token)} is a fee and ${money(quote.toEscrow, token)} is held for the project until a milestone.`
          : priced.isError && asked !== null
            ? "Couldn't work out what that buys. Try again in a moment."
            : parsed !== null && issue === null
              ? "Working out what that buys…"
              : ""}
        {problem ? (
          <span
            className="block text-destructive"
            data-testid="backing-problem"
          >
            {problem}
          </span>
        ) : null}
      </p>
      <Slippage bps={bps} idPrefix={base} onChange={setBps} />
      <div className="flex flex-wrap gap-2">
        <Button
          className="max-sm:h-11"
          data-testid="backing-confirm-back"
          disabled={blocked}
          type="submit"
        >
          {busy === "backing-buy" ? "Putting in…" : "Back this project"}
        </Button>
        <Button
          className="max-sm:h-11"
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** "Sell": some or all of the wallet's units, at the price the pool quotes now. */
export function SellForm({
  view,
  place,
  blocked,
  busy,
  gateNoteId,
  onDone,
  onCancel,
}: TradeProps) {
  const base = useId();
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [bps, setBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [tried, setTried] = useState(false);
  const { quote: token, snapshot } = view;
  const holder = view.holder;
  const parsed = text.trim() === "" ? null : parseAmount(text, 18);
  const asked = useSettled(parsed);
  const priced = useSellQuote(view.pool, holder, asked);
  const quote =
    asked !== null && asked === parsed ? (priced.data ?? null) : null;
  const issue =
    parsed === null
      ? text.trim() === ""
        ? "Enter how many units to sell, or press All."
        : "Use a number with at most 18 decimals."
      : parsed === 0n
        ? "Enter an amount above zero to sell."
        : parsed > snapshot.holderUnits
          ? `You hold ${unitsPhrase(snapshot.holderUnits)}, which is less than that.`
          : null;
  useEffect(() => field.current?.focus(), []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (issue !== null || parsed === null || quote === null) {
      field.current?.focus();
      return;
    }
    const placed = await place("backing-sell", () =>
      sellCalls({
        pool: view.pool,
        units: parsed,
        quote,
        slippageBps: bps,
        clocks: clocks(view),
      }),
    );
    if (placed) onDone();
  };
  const abandoned = view.phase === "abandoned";
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      data-testid="backing-sell-form"
      onSubmit={submit}
    >
      <label className="text-sm font-medium" htmlFor={`${base}-units`}>
        Units to sell (you hold {unitsPhrase(snapshot.holderUnits)})
      </label>
      <div className="flex gap-2">
        <Input
          aria-describedby={`${base}-plan${gateNoteId ? ` ${gateNoteId}` : ""}`}
          aria-invalid={tried && issue !== null}
          autoComplete="off"
          className="max-sm:h-11"
          data-testid="backing-units"
          id={`${base}-units`}
          inputMode="decimal"
          onChange={(event) => setText(event.target.value)}
          ref={field}
          value={text}
        />
        <Button
          className="max-sm:h-11"
          data-testid="backing-sell-all"
          onClick={() => setText(exactDecimal(snapshot.holderUnits, 18))}
          type="button"
          variant="outline"
        >
          All
        </Button>
      </div>
      <p
        aria-live="polite"
        className="min-h-5 text-sm"
        data-testid="backing-sell-plan"
        id={`${base}-plan`}
        role="status"
      >
        {quote
          ? `You get about ${money(quote.quoteOut, token)}${
              quote.refund > 0n
                ? `, which includes ${money(quote.refund, token)} of your held money`
                : abandoned
                  ? ""
                  : `, after a fee of ${money(quote.fee, token)}`
            }, and at least ${money(withSlippage(quote.quoteOut, bps), token)} or nothing happens.`
          : priced.isError && asked !== null
            ? "Couldn't work out what that sells for. Try again in a moment."
            : parsed !== null && issue === null
              ? "Working out what that sells for…"
              : ""}
        {tried && issue ? (
          <span
            className="block text-destructive"
            data-testid="backing-problem"
          >
            {issue}
          </span>
        ) : null}
      </p>
      {abandoned ? null : (
        <p className="text-xs text-muted-foreground">
          Selling now gives up the part of your money that is held for the
          project to the backers who stay.
        </p>
      )}
      <Slippage bps={bps} idPrefix={base} onChange={setBps} />
      <div className="flex flex-wrap gap-2">
        <Button
          className="max-sm:h-11"
          data-testid="backing-confirm-sell"
          disabled={blocked}
          type="submit"
        >
          {busy === "backing-sell"
            ? "Selling…"
            : abandoned
              ? "Sell and take my held money back"
              : "Sell"}
        </Button>
        <Button
          className="max-sm:h-11"
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** "Leave at this milestone": all the wallet's units sold and all of its held money back, before the date shown. */
export function LeavePanel({
  view,
  place,
  blocked,
  busy,
  gateNoteId,
  onDone,
  onCancel,
}: TradeProps) {
  const base = useId();
  const [bps, setBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const { quote: token, snapshot } = view;
  const priced = useLeaveQuote(view.pool, view.holder, true);
  const quote: LeaveQuote | null = priced.data ?? null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (quote === null) return;
    const placed = await place("backing-leave", () =>
      leaveCalls({
        pool: view.pool,
        quote,
        slippageBps: bps,
        clocks: clocks(view),
      }),
    );
    if (placed) onDone();
  };
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      data-testid="backing-leave-form"
      onSubmit={submit}
    >
      <p className="text-sm font-medium">Leave at this milestone</p>
      <p
        aria-live="polite"
        className="text-sm"
        data-testid="backing-leave-plan"
        id={`${base}-plan`}
        role="status"
      >
        {quote
          ? `Leaving sells all ${unitsPhrase(snapshot.holderUnits)} and hands back all of your held money. You get about ${money(quote.quoteOut, token)}: ${money(quote.fromCurve, token)} from selling, after a fee of ${money(quote.fee, token)}, and ${money(quote.fromEscrow, token)} of held money. Nothing is taken for this milestone.`
          : priced.isError
            ? "Couldn't work out what leaving pays. Try again in a moment."
            : "Working out what leaving pays…"}
      </p>
      <p className="text-xs text-muted-foreground">
        You can leave until {whenWords(snapshot.milestone.windowEndsAt)}. If you
        stay, a part of your held money goes to the project.
      </p>
      <Slippage bps={bps} idPrefix={base} onChange={setBps} />
      <div className="flex flex-wrap gap-2">
        <Button
          aria-describedby={`${base}-plan${gateNoteId ? ` ${gateNoteId}` : ""}`}
          className="max-sm:h-11"
          data-testid="backing-confirm-leave"
          disabled={blocked || quote === null}
          type="submit"
        >
          {busy === "backing-leave"
            ? "Leaving…"
            : "Leave and take my money back"}
        </Button>
        <Button
          className="max-sm:h-11"
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Stay
        </Button>
      </div>
    </form>
  );
}
